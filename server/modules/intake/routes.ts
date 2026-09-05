import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { requireFeature } from '../../lib/entitlements';
import { requirePermission } from '../../lib/permissions';
import { assertBranchAccess } from '../../lib/scope';
import { enterTenantContext } from '../../lib/tenantContext';
import { resolveIngressTenant } from '../../lib/tenantIngressResolvers';
import {
  generateIntakePacket, issueIntakeToken, submitSection, submitPacketMutation, emitPacketSubmissionEffects, reviewPacket,
  packetView, publicView, hashIntakeToken, hashValue, SECTION_TYPES,
} from '../../lib/intake';

// ===========================================================================
// Patient Intake routes. Authenticated staff surface (feature-gated by
// patient_crm + RBAC) and a separate hashed-token public surface for patients.
// ===========================================================================

const uuid = z.string().uuid();
const intakeRead = requirePermission('intake:read');
const intakeWrite = requirePermission('intake:write');
const sectionEnum = z.enum(SECTION_TYPES);

type IntakeTarget = {
  appointmentId?: string | null;
  appointmentRequestId?: string | null;
  patientId?: string | null;
  leadId?: string | null;
};

async function resolveTargetContext(tenantId: string, target: IntakeTarget) {
  // Keep these sequential: tenant-context execution may pin one connection,
  // where concurrent client.query calls are unsafe with the pg adapter.
  const appointment = target.appointmentId ? await db.appointment.findFirst({ where: { id: target.appointmentId, tenantId }, select: { id: true, branchId: true, patientId: true } }) : null;
  const appointmentRequest = target.appointmentRequestId ? await db.appointmentRequest.findFirst({ where: { id: target.appointmentRequestId, tenantId }, select: { id: true, branchId: true, patientId: true, leadId: true, patient: { select: { branchId: true } } } }) : null;
  const patient = target.patientId ? await db.patient.findFirst({ where: { id: target.patientId, tenantId, deletedAt: null }, select: { id: true, branchId: true } }) : null;
  const lead = target.leadId ? await db.lead.findFirst({ where: { id: target.leadId, tenantId }, select: { id: true, patientId: true, patient: { select: { branchId: true } } } }) : null;
  const branchIds = [appointment?.branchId, appointmentRequest?.branchId, appointmentRequest?.patient?.branchId, patient?.branchId, lead?.patient?.branchId]
    .filter((value): value is string => Boolean(value));
  return { appointment, appointmentRequest, patient, lead, branchIds: [...new Set(branchIds)] };
}

function assertResolvedBranchAccess(request: FastifyRequest, branchIds: string[]) {
  if (!request.auth.branchId) return;
  // A branch-restricted user may act only when every resolvable target belongs
  // to exactly their branch. Unscoped lead-only packets stay tenant-wide only.
  if (branchIds.length !== 1) throw request.server.httpErrors.forbidden('This intake packet is not scoped to your branch');
  assertBranchAccess(request, branchIds[0]);
}

async function assertPacketAccess(request: FastifyRequest, target: IntakeTarget) {
  const context = await resolveTargetContext(request.auth.tenantId, target);
  assertResolvedBranchAccess(request, context.branchIds);
}

async function filterPacketsForBranch<T extends IntakeTarget>(request: FastifyRequest, rows: T[]): Promise<T[]> {
  if (!request.auth.branchId) return rows;
  const tenantId = request.auth.tenantId;
  const appointmentIds = rows.flatMap(row => row.appointmentId ? [row.appointmentId] : []);
  const requestIds = rows.flatMap(row => row.appointmentRequestId ? [row.appointmentRequestId] : []);
  const patientIds = rows.flatMap(row => row.patientId ? [row.patientId] : []);
  const leadIds = rows.flatMap(row => row.leadId ? [row.leadId] : []);
  // Four bounded bulk reads avoid an N+1 query pattern for the 200-row queue.
  const appointments = appointmentIds.length ? await db.appointment.findMany({ where: { tenantId, id: { in: appointmentIds } }, select: { id: true, branchId: true } }) : [];
  const requests = requestIds.length ? await db.appointmentRequest.findMany({ where: { tenantId, id: { in: requestIds } }, select: { id: true, branchId: true, patient: { select: { branchId: true } } } }) : [];
  const patients = patientIds.length ? await db.patient.findMany({ where: { tenantId, id: { in: patientIds }, deletedAt: null }, select: { id: true, branchId: true } }) : [];
  const leads = leadIds.length ? await db.lead.findMany({ where: { tenantId, id: { in: leadIds } }, select: { id: true, patient: { select: { branchId: true } } } }) : [];
  const appointmentBranches = new Map(appointments.map(row => [row.id, row.branchId]));
  const requestBranches = new Map(requests.map(row => [row.id, [row.branchId, row.patient?.branchId].filter((value): value is string => Boolean(value))]));
  const patientBranches = new Map(patients.map(row => [row.id, row.branchId]));
  const leadBranches = new Map(leads.map(row => [row.id, row.patient?.branchId ?? null]));
  return rows.filter(row => {
    const branches = new Set<string>();
    if (row.appointmentId && appointmentBranches.get(row.appointmentId)) branches.add(appointmentBranches.get(row.appointmentId)!);
    if (row.appointmentRequestId) for (const branchId of requestBranches.get(row.appointmentRequestId) ?? []) branches.add(branchId);
    if (row.patientId && patientBranches.get(row.patientId)) branches.add(patientBranches.get(row.patientId)!);
    if (row.leadId && leadBranches.get(row.leadId)) branches.add(leadBranches.get(row.leadId)!);
    return branches.size === 1 && branches.has(request.auth.branchId!);
  });
}

type PacketViewInput = Parameters<typeof packetView>[0];

/**
 * Human-readable context for the authenticated staff queue. Internal UUIDs are
 * not enough to make an approval decision safely. Keep this enrichment on the
 * permissioned staff routes only; the public token view remains deliberately
 * minimal and never receives these fields.
 */
async function staffPacketViews(tenantId: string, rows: PacketViewInput[]) {
  const patientIds = rows.flatMap(row => row.patientId ? [row.patientId] : []);
  const appointmentIds = rows.flatMap(row => row.appointmentId ? [row.appointmentId] : []);
  const requestIds = rows.flatMap(row => row.appointmentRequestId ? [row.appointmentRequestId] : []);
  const leadIds = rows.flatMap(row => row.leadId ? [row.leadId] : []);
  const [patients, appointments, requests, leads] = await Promise.all([
    patientIds.length ? db.patient.findMany({
      where: { tenantId, id: { in: patientIds }, deletedAt: null },
      select: { id: true, firstName: true, lastName: true, branch: { select: { id: true, name: true, timezone: true } } },
    }) : [],
    appointmentIds.length ? db.appointment.findMany({
      where: { tenantId, id: { in: appointmentIds }, deletedAt: null },
      select: {
        id: true, service: true, startsAt: true,
        patient: { select: { firstName: true, lastName: true } },
        branch: { select: { id: true, name: true, timezone: true } },
      },
    }) : [],
    requestIds.length ? db.appointmentRequest.findMany({
      where: { tenantId, id: { in: requestIds } },
      select: {
        id: true, requestedService: true, requestedDateTime: true, collectedName: true,
        patient: { select: { firstName: true, lastName: true } }, lead: { select: { name: true } },
        branch: { select: { id: true, name: true, timezone: true } },
      },
    }) : [],
    leadIds.length ? db.lead.findMany({
      where: { tenantId, id: { in: leadIds }, deletedAt: null },
      select: { id: true, name: true, patient: { select: { branch: { select: { id: true, name: true, timezone: true } } } } },
    }) : [],
  ]);
  const patientById = new Map(patients.map(row => [row.id, row]));
  const appointmentById = new Map(appointments.map(row => [row.id, row]));
  const requestById = new Map(requests.map(row => [row.id, row]));
  const leadById = new Map(leads.map(row => [row.id, row]));

  return rows.map(row => {
    const patient = row.patientId ? patientById.get(row.patientId) : null;
    const appointment = row.appointmentId ? appointmentById.get(row.appointmentId) : null;
    const appointmentRequest = row.appointmentRequestId ? requestById.get(row.appointmentRequestId) : null;
    const lead = row.leadId ? leadById.get(row.leadId) : null;
    const subjectName = patient ? `${patient.firstName} ${patient.lastName}`.trim()
      : appointment?.patient ? `${appointment.patient.firstName} ${appointment.patient.lastName}`.trim()
        : appointmentRequest?.patient ? `${appointmentRequest.patient.firstName} ${appointmentRequest.patient.lastName}`.trim()
          : appointmentRequest?.lead?.name ?? appointmentRequest?.collectedName ?? lead?.name ?? null;
    const clinic = appointment?.branch ?? appointmentRequest?.branch ?? patient?.branch ?? lead?.patient?.branch ?? null;
    const visit = appointment
      ? { service: appointment.service, startsAt: appointment.startsAt.toISOString() }
      : appointmentRequest && (appointmentRequest.requestedService || appointmentRequest.requestedDateTime)
        ? { service: appointmentRequest.requestedService, startsAt: appointmentRequest.requestedDateTime?.toISOString() ?? null }
        : null;
    return {
      ...packetView(row),
      subject: { kind: row.patientId || appointment?.patient || appointmentRequest?.patient ? 'patient' : row.leadId || appointmentRequest?.lead ? 'lead' : 'unknown', name: subjectName },
      clinic,
      visit,
    };
  });
}

// A shareable link only exists if PUBLIC_APP_URL names the deployment. Returning
// `${'' }/intake/<token>` produced a bare path — a string no patient can open, and
// the only honest sharing route the module has. Answer null instead, so the
// client can build the link from its own origin rather than pasting a dead one.
function publicIntakeUrl(token: string | null | undefined): string | null {
  const base = process.env.PUBLIC_APP_URL?.trim();
  if (!token || !base) return null;
  return `${base.replace(/\/+$/, '')}/intake/${token}`;
}

export const intakeRoutes: FastifyPluginAsync = async app => {
  app.addHook('preHandler', requireFeature('patient_crm'));

  // ----- Create a packet (idempotent per appointment/request) -------------
  app.post('/packets', { preHandler: intakeWrite }, async (request, reply) => {
    const body = z.object({
      appointmentId: uuid.optional(), appointmentRequestId: uuid.optional(),
      patientId: uuid.optional(), leadId: uuid.optional(),
      source: z.enum(['staff', 'campaign', 'appointment_request', 'ai_receptionist']).default('staff'),
      force: z.boolean().default(false), issueToken: z.boolean().default(true),
    }).parse(request.body);
    if (!body.appointmentId && !body.appointmentRequestId && !body.patientId && !body.leadId) {
      throw app.httpErrors.badRequest('An appointment, request, patient, or lead is required');
    }
    // Resolve every supplied reference before mutation. Besides tenant/branch
    // isolation, reject a mixed target that could bind one patient's intake to
    // another patient's appointment or request.
    const target = await resolveTargetContext(request.auth.tenantId, body);
    if (body.appointmentId && !target.appointment) throw app.httpErrors.notFound('Appointment not found');
    if (body.appointmentRequestId && !target.appointmentRequest) throw app.httpErrors.notFound('Appointment request not found');
    if (body.patientId && !target.patient) throw app.httpErrors.notFound('Patient not found');
    if (body.leadId && !target.lead) throw app.httpErrors.notFound('Lead not found');
    if (body.patientId && target.appointment && target.appointment.patientId !== body.patientId) throw app.httpErrors.badRequest('Patient does not match the appointment');
    if (body.patientId && target.appointmentRequest?.patientId && target.appointmentRequest.patientId !== body.patientId) throw app.httpErrors.badRequest('Patient does not match the appointment request');
    if (body.leadId && target.appointmentRequest?.leadId && target.appointmentRequest.leadId !== body.leadId) throw app.httpErrors.badRequest('Lead does not match the appointment request');
    if (body.patientId && target.lead?.patientId && target.lead.patientId !== body.patientId) throw app.httpErrors.badRequest('Patient does not match the lead');
    if (target.branchIds.length > 1) throw app.httpErrors.badRequest('Intake targets belong to different branches');
    assertResolvedBranchAccess(request, target.branchIds);

    const { packet, created } = await generateIntakePacket(request.auth.tenantId, body, { source: body.source, actorUserId: request.auth.userId, force: body.force });
    let token: string | null = null;
    if (created && body.issueToken) token = await issueIntakeToken(request.auth.tenantId, packet.id, request.auth.userId);
    const full = await db.patientIntakePacket.findUniqueOrThrow({ where: { id: packet.id }, include: { sections: true } });
    const [staffView] = await staffPacketViews(request.auth.tenantId, [full]);
    return reply.code(created ? 201 : 200).send({ ...staffView, created, publicToken: token, publicUrl: publicIntakeUrl(token) });
  });

  // ----- List / queue -----------------------------------------------------
  app.get('/packets', { preHandler: intakeRead }, async request => {
    const q = z.object({ status: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(request.query);
    const rows = await db.patientIntakePacket.findMany({ where: { tenantId: request.auth.tenantId, ...(q.status ? { status: q.status } : {}) }, orderBy: { createdAt: 'desc' }, take: q.limit, include: { sections: true } });
    const visible = await filterPacketsForBranch(request, rows);
    await audit(request, { action: 'intake.packets.read', resource: 'patientIntake', metadata: { count: visible.length, status: q.status ?? null } });
    return staffPacketViews(request.auth.tenantId, visible);
  });

  app.get('/queue', { preHandler: intakeRead }, async request => {
    const rows = await db.patientIntakePacket.findMany({ where: { tenantId: request.auth.tenantId, status: { in: ['submitted', 'needs_review'] } }, orderBy: { submittedAt: 'desc' }, take: 200, include: { sections: true } });
    const visible = await filterPacketsForBranch(request, rows);
    await audit(request, { action: 'intake.queue.read', resource: 'patientIntake', metadata: { count: visible.length } });
    return staffPacketViews(request.auth.tenantId, visible);
  });

  app.get('/packets/:id', { preHandler: intakeRead }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const packet = await db.patientIntakePacket.findFirst({ where: { id, tenantId: request.auth.tenantId }, include: { sections: true, documents: true, consentRecords: { orderBy: { createdAt: 'desc' } } } });
    if (!packet) throw app.httpErrors.notFound('Intake packet not found');
    await assertPacketAccess(request, packet);
    await audit(request, { action: 'intake.packet.read', resource: 'patientIntake', resourceId: id });
    const [staffView] = await staffPacketViews(request.auth.tenantId, [packet]);
    return {
      ...staffView,
      sections: packet.sections.map(s => ({ sectionType: s.sectionType, status: s.status, data: s.data, completedAt: s.completedAt?.toISOString() ?? null })),
      documents: packet.documents.map(d => ({ documentType: d.documentType, status: d.status, fileName: d.fileName })),
      consentRecords: packet.consentRecords.map(c => ({ consentType: c.consentType, status: c.status, acceptedAt: c.acceptedAt?.toISOString() ?? null })),
    };
  });

  app.get('/appointment/:appointmentId', { preHandler: intakeRead }, async request => {
    const { appointmentId } = z.object({ appointmentId: uuid }).parse(request.params);
    const appointment = await db.appointment.findFirst({ where: { id: appointmentId, tenantId: request.auth.tenantId }, select: { branchId: true } });
    if (!appointment) throw app.httpErrors.notFound('Appointment not found');
    assertBranchAccess(request, appointment.branchId);
    const packet = await db.patientIntakePacket.findFirst({ where: { tenantId: request.auth.tenantId, appointmentId }, orderBy: { createdAt: 'desc' }, include: { sections: true } });
    await audit(request, { action: 'intake.appointment.read', resource: 'appointment', resourceId: appointmentId, metadata: { packetFound: Boolean(packet) } });
    if (!packet) return { exists: false, appointmentId };
    return (await staffPacketViews(request.auth.tenantId, [packet]))[0];
  });

  app.get('/request/:appointmentRequestId', { preHandler: intakeRead }, async request => {
    const { appointmentRequestId } = z.object({ appointmentRequestId: uuid }).parse(request.params);
    const appointmentRequest = await db.appointmentRequest.findFirst({ where: { id: appointmentRequestId, tenantId: request.auth.tenantId }, select: { branchId: true, patient: { select: { branchId: true } } } });
    if (!appointmentRequest) throw app.httpErrors.notFound('Appointment request not found');
    assertResolvedBranchAccess(request, [...new Set([appointmentRequest.branchId, appointmentRequest.patient?.branchId].filter((value): value is string => Boolean(value)))]);
    const packet = await db.patientIntakePacket.findFirst({ where: { tenantId: request.auth.tenantId, appointmentRequestId }, orderBy: { createdAt: 'desc' }, include: { sections: true } });
    await audit(request, { action: 'intake.appointment_request.read', resource: 'appointmentRequest', resourceId: appointmentRequestId, metadata: { packetFound: Boolean(packet) } });
    if (!packet) return { exists: false, appointmentRequestId };
    return (await staffPacketViews(request.auth.tenantId, [packet]))[0];
  });

  // ----- Review + resend --------------------------------------------------
  app.patch('/packets/:id/review', { preHandler: intakeWrite }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const input = z.object({ action: z.enum(['approve', 'needs_review']) }).parse(request.body);
    const existing = await db.patientIntakePacket.findFirst({ where: { id, tenantId: request.auth.tenantId }, include: { sections: true } });
    if (!existing) throw app.httpErrors.notFound('Intake packet not found');
    await assertPacketAccess(request, existing);
    const [context] = await staffPacketViews(request.auth.tenantId, [existing]);
    if (input.action === 'approve' && !context.subject.name) {
      throw app.httpErrors.conflict('Resolve the patient or lead identity before approving this intake packet');
    }
    const row = await reviewPacket(request.auth.tenantId, id, input.action, request.auth.userId);
    await audit(request, { action: 'intake.packet.reviewed', resource: 'patientIntake', resourceId: id, metadata: { action: input.action } });
    const [reviewed] = await staffPacketViews(request.auth.tenantId, [{ ...row, sections: [] }]);
    return reviewed;
  });

  app.post('/packets/:id/resend', { preHandler: intakeWrite }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const existing = await db.patientIntakePacket.findFirst({ where: { id, tenantId: request.auth.tenantId }, select: { id: true, status: true, appointmentId: true, appointmentRequestId: true, patientId: true, leadId: true } });
    if (!existing) throw app.httpErrors.notFound('Intake packet not found');
    await assertPacketAccess(request, existing);
    if (['approved', 'cancelled', 'expired'].includes(existing.status)) throw app.httpErrors.conflict('Packet is not resendable');
    const token = await issueIntakeToken(request.auth.tenantId, id, request.auth.userId);
    // The module sends nothing; it mints a link. Record that.
    await audit(request, { action: 'intake.packet.link_issued', resource: 'patientIntake', resourceId: id, metadata: {} });
    return reply.send({ resent: true, publicToken: token, publicUrl: publicIntakeUrl(token) });
  });
};

// ===== Public, hashed-token, packet-scoped patient surface =================
async function resolvePacketByToken(app: import('fastify').FastifyInstance, token: string, requestId: string) {
  const hash = hashIntakeToken(token);
  const resolved = await resolveIngressTenant('intake_token_hash', hash);
  if (!resolved) throw app.httpErrors.notFound('This intake link is invalid or has expired');
  enterTenantContext({ tenantId: resolved.tenantId, actorId: resolved.resourceId, actorRole: 'PUBLIC_INTAKE', source: 'portal', requestId });
  const packet = await db.patientIntakePacket.findFirst({ where: { id: resolved.resourceId, publicTokenHash: hash }, include: { sections: true } });
  if (!packet || !packet.tokenExpiresAt || packet.tokenExpiresAt.getTime() < Date.now()) throw app.httpErrors.notFound('This intake link is invalid or has expired');
  if (['cancelled', 'expired', 'approved'].includes(packet.status)) throw app.httpErrors.conflict('This intake is no longer open');
  return packet;
}

export const intakePublicRoutes: FastifyPluginAsync = async app => {
  const tokenParam = z.object({ token: z.string().min(20).max(80) });
  const rate = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

  app.get('/public/:token', rate, async request => {
    const { token } = tokenParam.parse(request.params);
    const packet = await resolvePacketByToken(app, token, request.id);
    await db.auditEvent.create({ data: { tenantId: packet.tenantId, action: 'intake.public_token.used', resource: 'patientIntake', resourceId: packet.id, ipAddress: request.ip, metadata: { op: 'view' } } });
    return publicView(packet.tenantId, packet, packet.sections);
  });

  app.post('/public/:token/sections', rate, async (request, reply) => {
    const { token } = tokenParam.parse(request.params);
    const body = z.object({ sectionType: sectionEnum, data: z.record(z.string(), z.unknown()).default({}) }).parse(request.body);
    const packet = await resolvePacketByToken(app, token, request.id);
    if (packet.status === 'submitted') throw app.httpErrors.conflict('This intake has already been submitted');
    const ctx = { ipHash: hashValue(request.ip), uaHash: hashValue(typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null), source: 'intake_public' };
    await submitSection(packet.tenantId, packet.id, body.sectionType, body.data, ctx).catch((e: Error) => { throw app.httpErrors.badRequest(e.message); });
    const refreshed = await db.patientIntakePacket.findUniqueOrThrow({ where: { id: packet.id }, include: { sections: true } });
    return reply.send(await publicView(refreshed.tenantId, refreshed, refreshed.sections));
  });

  app.post('/public/:token/submit', rate, async (request, reply) => {
    const { token } = tokenParam.parse(request.params);
    const packet = await resolvePacketByToken(app, token, request.id);
    const result = await db.$transaction(async tx => {
      const outcome = await submitPacketMutation(tx, packet.tenantId, packet.id);
      await tx.auditEvent.create({ data: { tenantId: packet.tenantId, action: 'intake.packet.submitted', resource: 'patientIntake', resourceId: packet.id, ipAddress: request.ip, metadata: { idempotent: outcome.alreadySubmitted, source: 'public_token' } } });
      return outcome;
    });
    await emitPacketSubmissionEffects(packet.tenantId, result);
    return reply.send({ submitted: true, status: result.packet.status, alreadySubmitted: result.alreadySubmitted, message: 'Thank you — your information has been submitted to the clinic for review.' });
  });
};
