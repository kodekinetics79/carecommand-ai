import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { requireRoles } from '../../plugins/roles';
import { requireFeature } from '../../lib/entitlements';
import { assertBranchAccess, branchScope } from '../../lib/scope';
import { eligibilityProviderStatus, computeDenialRisk, runDenialPreventionForAppointment } from '../../lib/insuranceIntelligence';
import { emitBusinessEvent } from '../../lib/intelligence';

const uuid = z.string().uuid();
const adminRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER');
const deskRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER', 'BILLING', 'FRONT_DESK');

export const insuranceRoutes: FastifyPluginAsync = async app => {
  // Entire insurance surface requires the insurance_eligibility entitlement.
  app.addHook('preHandler', requireFeature('insurance_eligibility'));

  // Eligibility provider configuration status (no secrets exposed).
  app.get('/provider-status', async () => {
    const s = eligibilityProviderStatus();
    return { provider: s.provider, configured: s.configured, mock: s.mock, setupRequired: s.setupRequired, missing: s.missing };
  });

  // Appointment intake insurance summary + rule-based denial risk (view-only;
  // PROVIDER may read). Mobile-ready fields.
  app.get('/intake/:appointmentId', async request => {
    const { appointmentId } = z.object({ appointmentId: uuid }).parse(request.params);
    const appointment = await db.appointment.findFirst({ where: { id: appointmentId, tenantId: request.auth.tenantId, deletedAt: null }, select: { id: true, patientId: true, branchId: true } });
    if (!appointment) throw app.httpErrors.notFound('Appointment not found');
    const assessment = await computeDenialRisk({ tenantId: request.auth.tenantId, appointmentId });
    return assessment;
  });

  // Run rule-based denial prevention for an appointment (creates signals/tasks/
  // alerts/recommendations where warranted). Write roles only.
  app.post('/denial-prevention/:appointmentId', { preHandler: deskRoles }, async (request, reply) => {
    const { appointmentId } = z.object({ appointmentId: uuid }).parse(request.params);
    const appointment = await db.appointment.findFirst({ where: { id: appointmentId, tenantId: request.auth.tenantId, deletedAt: null }, select: { id: true, branchId: true } });
    if (!appointment) throw app.httpErrors.notFound('Appointment not found');
    const assessment = await runDenialPreventionForAppointment(request.auth.tenantId, appointmentId, { actorUserId: request.auth.userId, branchId: appointment.branchId });
    return reply.send({ ...assessment, requiresHumanReview: true });
  });

  // Snapshot of accepted insurances + policy coverage for the practice.
  app.get('/overview', async request => {
    const tenantId = request.auth.tenantId;
    const [payers, totalPolicies, verifiedPolicies] = await Promise.all([
      db.insurancePayer.findMany({
        where: { tenantId },
        orderBy: [{ active: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
        include: { _count: { select: { policies: true } } },
      }),
      db.patientInsurancePolicy.count({ where: { tenantId, active: true } }),
      db.patientInsurancePolicy.count({ where: { tenantId, active: true, verificationStatus: 'verified' } }),
    ]);

    return {
      summary: {
        acceptedPayers: payers.filter(p => p.active).length,
        totalPayers: payers.length,
        totalPolicies,
        verifiedPolicies,
        verifiedPct: totalPolicies > 0 ? Math.round((verifiedPolicies / totalPolicies) * 100) : 0,
      },
      payers: payers.map(p => ({
        id: p.id,
        name: p.name,
        tradingPartnerServiceId: p.tradingPartnerServiceId,
        sourceProvider: p.sourceProvider,
        active: p.active,
        sortOrder: p.sortOrder,
        policyCount: p._count.policies,
      })),
    };
  });

  // Public-safe list of accepted insurances (active only) — for booking widget / marketing.
  app.get('/accepted', async request => {
    const payers = await db.insurancePayer.findMany({
      where: { tenantId: request.auth.tenantId, active: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, sourceProvider: true },
    });
    return payers;
  });

  const payerInput = z.object({
    name: z.string().trim().min(2).max(160),
    tradingPartnerServiceId: z.string().trim().max(60).optional(),
    sourceProvider: z.enum(['stedi', 'mock', 'availity', 'pverify', 'optum']).default('mock'),
    sortOrder: z.number().int().min(0).optional(),
  });

  app.post('/payers', { preHandler: adminRoles }, async (request, reply) => {
    const input = payerInput.parse(request.body);
    const existing = await db.insurancePayer.findFirst({ where: { tenantId: request.auth.tenantId, name: input.name } });
    if (existing) {
      // Re-accepting a previously removed payer simply re-activates it.
      const row = await db.insurancePayer.update({ where: { id: existing.id }, data: { active: true, ...input } });
      await audit(request, { action: 'insurance.payer.reactivated', resource: 'insurancePayer', resourceId: row.id });
      return reply.code(200).send(row);
    }
    const row = await db.insurancePayer.create({ data: { tenantId: request.auth.tenantId, ...input } });
    await audit(request, { action: 'insurance.payer.created', resource: 'insurancePayer', resourceId: row.id, metadata: { name: input.name } });
    return reply.code(201).send(row);
  });

  app.patch('/payers/:id', { preHandler: adminRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const input = z.object({
      name: z.string().trim().min(2).max(160).optional(),
      tradingPartnerServiceId: z.string().trim().max(60).optional(),
      active: z.boolean().optional(),
      sortOrder: z.number().int().min(0).optional(),
    }).parse(request.body);
    const existing = await db.insurancePayer.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Payer not found');
    const row = await db.insurancePayer.update({ where: { id }, data: input });
    await audit(request, { action: 'insurance.payer.updated', resource: 'insurancePayer', resourceId: id, metadata: input });
    return row;
  });

  // Patient insurance policies (capture at front desk / patient profile).
  app.get('/policies', async request => {
    const query = z.object({ patientId: uuid.optional() }).parse(request.query);
    return db.patientInsurancePolicy.findMany({
      where: { tenantId: request.auth.tenantId, ...branchScope(request), patientId: query.patientId },
      orderBy: { updatedAt: 'desc' },
      include: {
        payer: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
        verifications: { orderBy: { checkedAt: 'desc' }, take: 1 },
      },
    });
  });

  app.post('/policies', { preHandler: deskRoles }, async (request, reply) => {
    const input = z.object({
      patientId: uuid,
      payerId: uuid.optional(),
      planName: z.string().trim().min(2).max(160),
      memberId: z.string().trim().min(2).max(80),
      groupNumber: z.string().trim().max(80).optional(),
      relationship: z.string().trim().max(40).optional(),
      subscriberName: z.string().trim().max(160).optional(),
    }).parse(request.body);

    const patient = await db.patient.findFirst({
      where: { id: input.patientId, tenantId: request.auth.tenantId, deletedAt: null, ...branchScope(request) },
    });
    if (!patient) throw app.httpErrors.notFound('Patient not found');
    assertBranchAccess(request, patient.branchId);

    if (input.payerId) {
      const payer = await db.insurancePayer.findFirst({ where: { id: input.payerId, tenantId: request.auth.tenantId } });
      if (!payer) throw app.httpErrors.badRequest('Payer does not belong to this practice');
    }

    // A patient's existing active policies are superseded by the newly captured one.
    await db.patientInsurancePolicy.updateMany({
      where: { tenantId: request.auth.tenantId, patientId: input.patientId, active: true },
      data: { active: false },
    });

    const row = await db.patientInsurancePolicy.create({
      data: {
        tenantId: request.auth.tenantId,
        branchId: patient.branchId,
        patientId: input.patientId,
        payerId: input.payerId,
        planName: input.planName,
        memberId: input.memberId,
        groupNumber: input.groupNumber,
        relationship: input.relationship,
        subscriberName: input.subscriberName,
        payerReference: input.memberId,
        verificationStatus: 'pending',
        active: true,
      },
      include: { payer: { select: { name: true } } },
    });
    await audit(request, { action: 'insurance.profile.created', resource: 'patientInsurancePolicy', resourceId: row.id, metadata: { patientId: input.patientId } });
    await emitBusinessEvent(request.auth.tenantId, { eventType: 'insurance.profile.created', entityType: 'patientInsurancePolicy', entityId: row.id, sourceModule: 'insurance', payload: { patientId: input.patientId } }).catch(() => {});
    return reply.code(201).send(row);
  });
};
