import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { requireRoles } from '../../plugins/roles';
import { requireFeature } from '../../lib/entitlements';
import {
  generateIntakePacket, issueIntakeToken, submitSection, submitPacket, reviewPacket,
  packetView, publicView, hashIntakeToken, hashValue, SECTION_TYPES,
} from '../../lib/intake';

// ===========================================================================
// Patient Intake routes. Authenticated staff surface (feature-gated by
// patient_crm + RBAC) and a separate hashed-token public surface for patients.
// ===========================================================================

const uuid = z.string().uuid();
const writeRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK', 'BILLING');
const sectionEnum = z.enum(SECTION_TYPES);

export const intakeRoutes: FastifyPluginAsync = async app => {
  app.addHook('preHandler', requireFeature('patient_crm'));

  // ----- Create a packet (idempotent per appointment/request) -------------
  app.post('/packets', { preHandler: writeRoles }, async (request, reply) => {
    const body = z.object({
      appointmentId: uuid.optional(), appointmentRequestId: uuid.optional(),
      patientId: uuid.optional(), leadId: uuid.optional(),
      source: z.enum(['staff', 'campaign', 'appointment_request', 'ai_receptionist']).default('staff'),
      force: z.boolean().default(false), issueToken: z.boolean().default(true),
    }).parse(request.body);
    if (!body.appointmentId && !body.appointmentRequestId && !body.patientId && !body.leadId) {
      throw app.httpErrors.badRequest('An appointment, request, patient, or lead is required');
    }
    // Validate referenced entities belong to this tenant (IDOR guard).
    if (body.appointmentId && !(await db.appointment.findFirst({ where: { id: body.appointmentId, tenantId: request.auth.tenantId }, select: { id: true } }))) throw app.httpErrors.notFound('Appointment not found');
    if (body.patientId && !(await db.patient.findFirst({ where: { id: body.patientId, tenantId: request.auth.tenantId }, select: { id: true } }))) throw app.httpErrors.notFound('Patient not found');

    const { packet, created } = await generateIntakePacket(request.auth.tenantId, body, { source: body.source, actorUserId: request.auth.userId, force: body.force });
    let token: string | null = null;
    if (created && body.issueToken) token = await issueIntakeToken(request.auth.tenantId, packet.id, request.auth.userId);
    const full = await db.patientIntakePacket.findUniqueOrThrow({ where: { id: packet.id }, include: { sections: true } });
    return reply.code(created ? 201 : 200).send({ ...packetView(full), created, publicToken: token, publicUrl: token ? `${process.env.PUBLIC_APP_URL ?? ''}/intake/${token}` : null });
  });

  // ----- List / queue -----------------------------------------------------
  app.get('/packets', async request => {
    const q = z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(request.query);
    const rows = await db.patientIntakePacket.findMany({ where: { tenantId: request.auth.tenantId, ...(q.status ? { status: q.status } : {}) }, orderBy: { createdAt: 'desc' }, take: q.limit, include: { sections: true } });
    return rows.map(packetView);
  });

  app.get('/queue', async request => {
    const rows = await db.patientIntakePacket.findMany({ where: { tenantId: request.auth.tenantId, status: { in: ['submitted', 'needs_review'] } }, orderBy: { submittedAt: 'desc' }, take: 200, include: { sections: true } });
    return rows.map(packetView);
  });

  app.get('/packets/:id', async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const packet = await db.patientIntakePacket.findFirst({ where: { id, tenantId: request.auth.tenantId }, include: { sections: true, documents: true, consentRecords: { orderBy: { createdAt: 'desc' } } } });
    if (!packet) throw app.httpErrors.notFound('Intake packet not found');
    return {
      ...packetView(packet),
      sections: packet.sections.map(s => ({ sectionType: s.sectionType, status: s.status, data: s.data, completedAt: s.completedAt?.toISOString() ?? null })),
      documents: packet.documents.map(d => ({ documentType: d.documentType, status: d.status, fileName: d.fileName })),
      consentRecords: packet.consentRecords.map(c => ({ consentType: c.consentType, status: c.status, acceptedAt: c.acceptedAt?.toISOString() ?? null })),
    };
  });

  app.get('/appointment/:appointmentId', async request => {
    const { appointmentId } = z.object({ appointmentId: uuid }).parse(request.params);
    const packet = await db.patientIntakePacket.findFirst({ where: { tenantId: request.auth.tenantId, appointmentId }, orderBy: { createdAt: 'desc' }, include: { sections: true } });
    return packet ? packetView(packet) : { exists: false, appointmentId };
  });

  app.get('/request/:appointmentRequestId', async request => {
    const { appointmentRequestId } = z.object({ appointmentRequestId: uuid }).parse(request.params);
    const packet = await db.patientIntakePacket.findFirst({ where: { tenantId: request.auth.tenantId, appointmentRequestId }, orderBy: { createdAt: 'desc' }, include: { sections: true } });
    return packet ? packetView(packet) : { exists: false, appointmentRequestId };
  });

  // ----- Review + resend --------------------------------------------------
  app.patch('/packets/:id/review', { preHandler: writeRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const input = z.object({ action: z.enum(['approve', 'needs_review']) }).parse(request.body);
    const existing = await db.patientIntakePacket.findFirst({ where: { id, tenantId: request.auth.tenantId }, select: { id: true } });
    if (!existing) throw app.httpErrors.notFound('Intake packet not found');
    const row = await reviewPacket(request.auth.tenantId, id, input.action, request.auth.userId);
    await audit(request, { action: 'intake.packet.reviewed', resource: 'patientIntake', resourceId: id, metadata: { action: input.action } });
    return packetView({ ...row, sections: [] });
  });

  app.post('/packets/:id/resend', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const existing = await db.patientIntakePacket.findFirst({ where: { id, tenantId: request.auth.tenantId }, select: { id: true, status: true } });
    if (!existing) throw app.httpErrors.notFound('Intake packet not found');
    if (['approved', 'cancelled', 'expired'].includes(existing.status)) throw app.httpErrors.conflict('Packet is not resendable');
    const token = await issueIntakeToken(request.auth.tenantId, id, request.auth.userId);
    await audit(request, { action: 'intake.packet.sent', resource: 'patientIntake', resourceId: id, metadata: {} });
    return reply.send({ resent: true, publicToken: token, publicUrl: `${process.env.PUBLIC_APP_URL ?? ''}/intake/${token}` });
  });
};

// ===== Public, hashed-token, packet-scoped patient surface =================
async function resolvePacketByToken(app: import('fastify').FastifyInstance, token: string) {
  const hash = hashIntakeToken(token);
  const packet = await db.patientIntakePacket.findFirst({ where: { publicTokenHash: hash }, include: { sections: true } });
  if (!packet || !packet.tokenExpiresAt || packet.tokenExpiresAt.getTime() < Date.now()) throw app.httpErrors.notFound('This intake link is invalid or has expired');
  if (['cancelled', 'expired', 'approved'].includes(packet.status)) throw app.httpErrors.conflict('This intake is no longer open');
  return packet;
}

export const intakePublicRoutes: FastifyPluginAsync = async app => {
  const tokenParam = z.object({ token: z.string().min(20).max(80) });
  const rate = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  app.get('/public/:token', rate, async request => {
    const { token } = tokenParam.parse(request.params);
    const packet = await resolvePacketByToken(app, token);
    await db.auditEvent.create({ data: { tenantId: packet.tenantId, action: 'intake.public_token.used', resource: 'patientIntake', resourceId: packet.id, ipAddress: request.ip, metadata: { op: 'view' } } }).catch(() => {});
    return publicView(packet.tenantId, packet, packet.sections);
  });

  app.post('/public/:token/sections', rate, async (request, reply) => {
    const { token } = tokenParam.parse(request.params);
    const body = z.object({ sectionType: sectionEnum, data: z.record(z.string(), z.unknown()).default({}) }).parse(request.body);
    const packet = await resolvePacketByToken(app, token);
    const ctx = { ipHash: hashValue(request.ip), uaHash: hashValue(typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null), source: 'intake_public' };
    await submitSection(packet.tenantId, packet.id, body.sectionType, body.data, ctx).catch((e: Error) => { throw app.httpErrors.badRequest(e.message); });
    const refreshed = await db.patientIntakePacket.findUniqueOrThrow({ where: { id: packet.id }, include: { sections: true } });
    return reply.send(await publicView(refreshed.tenantId, refreshed, refreshed.sections));
  });

  app.post('/public/:token/submit', rate, async (request, reply) => {
    const { token } = tokenParam.parse(request.params);
    const packet = await resolvePacketByToken(app, token);
    const result = await submitPacket(packet.tenantId, packet.id);
    await db.auditEvent.create({ data: { tenantId: packet.tenantId, action: 'intake.packet.submitted', resource: 'patientIntake', resourceId: packet.id, ipAddress: request.ip, metadata: { idempotent: result.alreadySubmitted } } }).catch(() => {});
    return reply.send({ submitted: true, status: result.packet.status, alreadySubmitted: result.alreadySubmitted, message: 'Thank you — your information has been submitted to the clinic for review.' });
  });
};
