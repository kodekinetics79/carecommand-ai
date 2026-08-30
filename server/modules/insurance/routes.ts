import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '../../generated/prisma/client';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { requireRoles } from '../../plugins/roles';
import { requireFeature } from '../../lib/entitlements';
import { assertBranchAccess, branchScope } from '../../lib/scope';
import { computeDenialRisk, runDenialPreventionForAppointment } from '../../lib/insuranceIntelligence';
import { emitBusinessEvent } from '../../lib/intelligence';
import { encryptSecret } from '../../lib/security';
import { INSURANCE_PROVIDERS, maskMemberId } from '../../lib/connectedCare/catalog';
import { runStediEligibility, type NormalizedEligibility } from '../../lib/connectedCare/eligibilityService';
import { env } from '../../config/env';
import { createInsuranceProvider, eligibilityProviderReconciliationCapability } from '../revenue-protection';
import { getRequestPermissions, requirePermission } from '../../lib/permissions';
import {
  EligibilityExecutionConflictError,
  eligibilityIdempotencyKey,
  runEligibilityExecution,
} from '../../lib/eligibilityExecution';

function insStatus(def: { supportsSandbox: boolean }, mode: string, hasRequired: boolean): string {
  if (mode === 'sandbox' && def.supportsSandbox) return 'SANDBOX';
  if (hasRequired) return 'ACTIVE';
  return 'NOT_CONFIGURED';
}

function providerRuntimeCapability(providerKey: string, mode: string) {
  if (providerKey !== 'stedi') return { enabled: false, simulated: false, reason: 'Adapter is not implemented' };
  if (mode === 'sandbox') return { enabled: true, simulated: true, reason: null };
  const enabled = env.INSURANCE_PROVIDER === 'stedi' && Boolean(env.STEDI_API_KEY) && !env.STEDI_TEST_MODE;
  return { enabled, simulated: false, reason: enabled ? null : 'Live Stedi adapter credentials and live mode are not enabled on this deployment' };
}

function isPolicyRangeConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2004' || error.code === 'P2034')) return true;
  return error instanceof Error && error.message.includes('PatientInsurancePolicy_active_order_range_excl');
}

const uuid = z.string().uuid();
const adminRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER');
const deskRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER', 'BILLING', 'FRONT_DESK');
const insuranceReconcile = requirePermission('insurance:reconcile');
const insuranceRead = requirePermission('billing:read');

export const insuranceRoutes: FastifyPluginAsync = async app => {
  // Entire insurance surface requires the insurance_eligibility entitlement.
  app.addHook('preHandler', requireFeature('insurance_eligibility'));

  // Eligibility provider configuration status (no secrets exposed).
  app.get('/provider-status', async request => {
    const selected = await db.insuranceProvider.findFirst({
      where: { tenantId: request.auth.tenantId, active: true, status: { in: ['SANDBOX', 'ACTIVE'] } },
      orderBy: { updatedAt: 'desc' },
    });
    if (!selected) return { provider: null, configured: false, mock: false, setupRequired: true, missing: ['tenant_provider_configuration'], mode: 'unconfigured' };
    const capability = providerRuntimeCapability(selected.providerKey, selected.mode);
    return {
      provider: selected.providerKey,
      configured: capability.enabled,
      mock: capability.simulated,
      setupRequired: !capability.enabled,
      missing: capability.enabled ? [] : ['runtime_adapter_capability'],
      mode: capability.simulated ? 'sandbox' : capability.enabled ? 'live' : 'unconfigured',
    };
  });

  // Appointment intake insurance summary + rule-based denial risk (view-only;
  // PROVIDER may read). Mobile-ready fields.
  app.get('/intake/:appointmentId', { preHandler: insuranceRead }, async request => {
    const { appointmentId } = z.object({ appointmentId: uuid }).parse(request.params);
    const appointment = await db.appointment.findFirst({ where: { id: appointmentId, tenantId: request.auth.tenantId, deletedAt: null }, select: { id: true, patientId: true, branchId: true } });
    if (!appointment) throw app.httpErrors.notFound('Appointment not found');
    assertBranchAccess(request, appointment.branchId);
    const assessment = await computeDenialRisk({ tenantId: request.auth.tenantId, appointmentId });
    await audit(request, { action: 'insurance.intake.read', resource: 'appointment', resourceId: appointmentId });
    return assessment;
  });

  // Run rule-based denial prevention for an appointment (creates signals/tasks/
  // alerts/recommendations where warranted). Write roles only.
  app.post('/denial-prevention/:appointmentId', { preHandler: deskRoles }, async (request, reply) => {
    const { appointmentId } = z.object({ appointmentId: uuid }).parse(request.params);
    const appointment = await db.appointment.findFirst({ where: { id: appointmentId, tenantId: request.auth.tenantId, deletedAt: null }, select: { id: true, branchId: true } });
    if (!appointment) throw app.httpErrors.notFound('Appointment not found');
    assertBranchAccess(request, appointment.branchId);
    const assessment = await runDenialPreventionForAppointment(request.auth.tenantId, appointmentId, { actorUserId: request.auth.userId, branchId: appointment.branchId });
    return reply.send({ ...assessment, requiresHumanReview: true });
  });

  // Snapshot of accepted insurances + policy coverage for the practice.
  app.get('/overview', { preHandler: insuranceRead }, async request => {
    const tenantId = request.auth.tenantId;
    const [payers, totalPolicies, verifiedPolicies] = await Promise.all([
      db.insurancePayer.findMany({
        where: { tenantId },
        orderBy: [{ active: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
        include: { _count: { select: { policies: { where: branchScope(request) } } } },
      }),
      db.patientInsurancePolicy.count({ where: { tenantId, ...branchScope(request), active: true } }),
      db.patientInsurancePolicy.count({ where: { tenantId, ...branchScope(request), active: true, verificationStatus: 'verified' } }),
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
        // The tenant-safe rendering of the line above. `sourceProvider` is a
        // clearinghouse key: useful to the eligibility engine, meaningless to a
        // practice manager, and a supplier name on their screen if printed. The
        // clinic is recording HOW a payer is verified, not who we buy it from.
        verificationLabel: p.sourceProvider === 'mock' ? 'Not verified electronically' : 'Verified through CareCommand',
        electronicVerification: p.sourceProvider !== 'mock',
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

  // `sourceProvider` stays accepted for API callers that already send a
  // clearinghouse key. The UI sends `electronicVerification` instead, and the
  // SERVER resolves which clearinghouse that means — the clinic never has to
  // know, and cannot pick one we have no adapter for.
  const payerInput = z.object({
    name: z.string().trim().min(2).max(160),
    tradingPartnerServiceId: z.string().trim().max(60).optional(),
    sourceProvider: z.enum(['stedi', 'mock', 'availity', 'pverify', 'optum']).optional(),
    electronicVerification: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
  }).transform(input => ({
    ...input,
    sourceProvider: input.sourceProvider
      ?? (input.electronicVerification ? (env.INSURANCE_PROVIDER === 'mock' ? 'stedi' : env.INSURANCE_PROVIDER) : 'mock'),
  }));

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
  app.get('/policies', { preHandler: insuranceRead }, async request => {
    const query = z.object({ patientId: uuid.optional() }).parse(request.query);
    const rows = await db.patientInsurancePolicy.findMany({
      where: { tenantId: request.auth.tenantId, ...branchScope(request), patientId: query.patientId },
      orderBy: { updatedAt: 'desc' },
      include: {
        payer: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
        verifications: { orderBy: { checkedAt: 'desc' }, take: 1 },
      },
    });
    await audit(request, { action: 'insurance.policy.list', resource: 'patientInsurancePolicy', metadata: { count: rows.length, patientScoped: Boolean(query.patientId) } });
    return rows;
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
      branchId: uuid.optional(),
      coverageOrder: z.number().int().min(1).max(9).default(1),
      effectiveFrom: z.coerce.date().default(() => new Date()),
      effectiveTo: z.coerce.date().optional(),
    }).parse(request.body);

    if (input.effectiveTo && input.effectiveTo <= input.effectiveFrom) {
      throw app.httpErrors.badRequest('effectiveTo must be later than effectiveFrom');
    }

    const patient = await db.patient.findFirst({
      where: { id: input.patientId, tenantId: request.auth.tenantId, deletedAt: null, ...branchScope(request) },
    });
    if (!patient) throw app.httpErrors.notFound('Patient not found');
    assertBranchAccess(request, patient.branchId);
    if (input.branchId && input.branchId !== patient.branchId) throw app.httpErrors.badRequest('Policy branch must match the patient branch');

    let row;
    try {
      row = await db.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${request.auth.tenantId}), hashtext(${input.patientId}))`;
        if (input.payerId) {
          const payer = await tx.insurancePayer.findFirst({ where: { id: input.payerId, tenantId: request.auth.tenantId, active: true } });
          if (!payer) throw app.httpErrors.badRequest('Payer is not active for this practice');
        }
        return tx.patientInsurancePolicy.create({
          data: {
            tenantId: request.auth.tenantId, branchId: patient.branchId, patientId: input.patientId,
            payerId: input.payerId, planName: input.planName, memberId: input.memberId,
            groupNumber: input.groupNumber, relationship: input.relationship,
            subscriberName: input.subscriberName, payerReference: input.memberId,
            coverageOrder: input.coverageOrder, effectiveFrom: input.effectiveFrom,
            effectiveTo: input.effectiveTo, verificationStatus: 'pending', active: true,
          },
          include: { payer: { select: { name: true } } },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isPolicyRangeConflict(error)) {
        throw app.httpErrors.conflict('Coverage at this order overlaps an existing active policy; refresh and retry');
      }
      throw error;
    }
    await audit(request, { action: 'insurance.profile.created', resource: 'patientInsurancePolicy', resourceId: row.id, metadata: { coverageOrder: row.coverageOrder } });
    await emitBusinessEvent(request.auth.tenantId, { eventType: 'insurance.profile.created', entityType: 'patientInsurancePolicy', entityId: row.id, sourceModule: 'insurance', payload: { coverageOrder: row.coverageOrder } }).catch(() => {});
    return reply.code(201).send(row);
  });

  app.patch('/policies/:id', { preHandler: deskRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const input = z.object({
      payerId: uuid.nullable().optional(), planName: z.string().trim().min(2).max(160).optional(),
      memberId: z.string().trim().min(2).max(80).optional(), groupNumber: z.string().trim().max(80).nullable().optional(),
      relationship: z.string().trim().max(40).nullable().optional(), subscriberName: z.string().trim().max(160).nullable().optional(),
      coverageOrder: z.number().int().min(1).max(9).optional(), effectiveFrom: z.coerce.date().optional(),
      effectiveTo: z.coerce.date().nullable().optional(), active: z.boolean().optional(),
    }).parse(request.body);
    const existing = await db.patientInsurancePolicy.findFirst({ where: { id, tenantId: request.auth.tenantId, ...branchScope(request) } });
    if (!existing) throw app.httpErrors.notFound('Policy not found');
    assertBranchAccess(request, existing.branchId);
    const effectiveFrom = input.effectiveFrom ?? existing.effectiveFrom;
    const effectiveTo = input.effectiveTo === undefined ? existing.effectiveTo : input.effectiveTo;
    if (effectiveTo && effectiveTo <= effectiveFrom) throw app.httpErrors.badRequest('effectiveTo must be later than effectiveFrom');
    let row;
    try {
      row = await db.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${request.auth.tenantId}), hashtext(${existing.patientId}))`;
        if (input.payerId) {
          const payer = await tx.insurancePayer.findFirst({ where: { id: input.payerId, tenantId: request.auth.tenantId, active: true } });
          if (!payer) throw app.httpErrors.badRequest('Payer is not active for this practice');
        }
        return tx.patientInsurancePolicy.update({ where: { id }, data: { ...input, effectiveFrom, effectiveTo, ...(input.memberId ? { payerReference: input.memberId, verificationStatus: 'pending', verifiedAt: null } : {}) }, include: { payer: { select: { name: true } } } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isPolicyRangeConflict(error)) throw app.httpErrors.conflict('Coverage at this order overlaps an existing active policy; refresh and retry');
      throw error;
    }
    await audit(request, { action: 'insurance.profile.updated', resource: 'patientInsurancePolicy', resourceId: row.id, metadata: { coverageOrder: row.coverageOrder, active: row.active } });
    return row;
  });

  // ════════════════════════════════════════════════════════════════════════
  // PROVIDER REGISTRY — real configurable eligibility providers (no env flags)
  // ════════════════════════════════════════════════════════════════════════
  const providerKeySchema = z.enum(['stedi', 'optum', 'availity']);

  // List providers (catalog merged with per-tenant DB status). Never returns config.
  app.get('/providers', async request => {
    const rows = await db.insuranceProvider.findMany({ where: { tenantId: request.auth.tenantId } });
    const byKey = new Map(rows.map(r => [r.providerKey, r]));
    return INSURANCE_PROVIDERS.map(def => {
      const row = byKey.get(def.key);
      return {
        key: def.key, displayName: def.displayName, category: def.category, supportsSandbox: def.supportsSandbox, note: def.note,
        configFields: def.configFields.map(f => ({ key: f.key, label: f.label, secret: f.secret, required: f.required })),
        status: row?.status ?? 'NOT_CONFIGURED', mode: row?.mode ?? 'sandbox',
        configured: !!row && (row.status === 'SANDBOX' || row.status === 'ACTIVE') && providerRuntimeCapability(def.key, row.mode).enabled,
        simulated: row?.mode === 'sandbox',
        runtimeAvailable: !!row && providerRuntimeCapability(def.key, row.mode).enabled,
        runtimeReason: row ? providerRuntimeCapability(def.key, row.mode).reason : 'Tenant has not authorized this provider',
        lastHealthCheckAt: row?.lastHealthCheckAt ?? null, lastHealthStatus: row?.lastHealthStatus ?? null, healthMessage: row?.healthMessage ?? null,
      };
    });
  });

  // Configure a provider (encrypted config). Admin only; audited (no secrets logged).
  app.post('/providers/:key/configure', { preHandler: adminRoles }, async (request, reply) => {
    const { key } = z.object({ key: providerKeySchema }).parse(request.params);
    const def = INSURANCE_PROVIDERS.find(p => p.key === key)!;
    const { mode, config } = z.object({ mode: z.enum(['sandbox', 'production']).default('sandbox'), config: z.record(z.string(), z.string()).default({}) }).parse(request.body ?? {});
    const required = def.configFields.filter(f => f.required).map(f => f.key);
    const hasRequired = required.every(k => (config[k] ?? '').trim().length > 0);
    if (mode === 'production' && !hasRequired) throw app.httpErrors.badRequest(`Missing required config: ${required.join(', ')}`);
    const status = insStatus(def, mode, hasRequired);
    const encryptedConfig = Object.keys(config).length ? encryptSecret(JSON.stringify(config)) : null;
    const row = await db.insuranceProvider.upsert({
      where: { tenantId_providerKey: { tenantId: request.auth.tenantId, providerKey: key } },
      create: { tenantId: request.auth.tenantId, providerKey: key, displayName: def.displayName, category: 'INSURANCE', mode, status, encryptedConfig },
      update: { mode, status, ...(encryptedConfig ? { encryptedConfig } : {}) },
      select: { id: true, providerKey: true, status: true, mode: true },
    });
    await audit(request, { action: 'insurance.provider.configured', resource: 'insuranceProvider', resourceId: row.id, metadata: { providerKey: key, mode, status } });
    return reply.send(row);
  });

  // Health check (rate-limited). Verifies configured state; sandbox runs a dry probe.
  app.post('/providers/:key/health-check', { preHandler: deskRoles, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async request => {
    const { key } = z.object({ key: providerKeySchema }).parse(request.params);
    const def = INSURANCE_PROVIDERS.find(p => p.key === key)!;
    const row = await db.insuranceProvider.findFirst({ where: { tenantId: request.auth.tenantId, providerKey: key } });
    let healthStatus = 'error';
    let message = 'Provider is not configured.';
    const capability = row ? providerRuntimeCapability(key, row.mode) : null;
    if (row && (row.status === 'SANDBOX' || row.status === 'ACTIVE') && capability?.enabled) {
      healthStatus = 'healthy';
      message = key === 'stedi'
        ? (row.mode === 'sandbox' ? 'Sandbox reachable — simulated 271 response OK.' : 'Production credentials present.')
        : 'Adapter ready.';
    } else if (capability?.reason) {
      message = capability.reason;
    }
    const updated = await db.insuranceProvider.upsert({
      where: { tenantId_providerKey: { tenantId: request.auth.tenantId, providerKey: key } },
      create: { tenantId: request.auth.tenantId, providerKey: key, displayName: def.displayName, category: 'INSURANCE', status: 'NOT_CONFIGURED', lastHealthCheckAt: new Date(), lastHealthStatus: healthStatus, healthMessage: message },
      update: { lastHealthCheckAt: new Date(), lastHealthStatus: healthStatus, healthMessage: message },
      select: { providerKey: true, status: true, lastHealthStatus: true, healthMessage: true, lastHealthCheckAt: true },
    });
    await audit(request, { action: 'insurance.provider.health_check', resource: 'insuranceProvider', resourceId: row?.id ?? key, metadata: { providerKey: key, healthStatus } });
    return updated;
  });

  // ════════════════════════════════════════════════════════════════════════
  // ELIGIBILITY — backend service abstraction (frontend never decides coverage)
  // ════════════════════════════════════════════════════════════════════════
  app.post('/eligibility/check', { preHandler: deskRoles, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const input = z.object({
      patientId: uuid,
      payerName: z.string().trim().min(2).max(120),
      memberId: z.string().trim().min(2).max(60),
      planName: z.string().trim().max(120).optional(),
      serviceType: z.string().trim().max(80).optional(),
      serviceDate: z.coerce.date().optional(),
      appointmentId: uuid.optional(),
      providerKey: z.enum(['stedi']).default('stedi'),
      policyId: uuid.optional(),
    }).parse(request.body);
    const tenantId = request.auth.tenantId;
    const provider = await db.insuranceProvider.findFirst({ where: { tenantId, providerKey: input.providerKey } });
    if (!provider || (provider.status !== 'SANDBOX' && provider.status !== 'ACTIVE')) {
      throw app.httpErrors.badRequest('Eligibility provider is not configured. Configure Stedi (sandbox is available) first.');
    }
    const capability = providerRuntimeCapability(input.providerKey, provider.mode);
    if (!capability.enabled) throw app.httpErrors.serviceUnavailable(capability.reason ?? 'Eligibility adapter is unavailable');
    const patient = await db.patient.findFirst({ where: { id: input.patientId, tenantId, deletedAt: null }, select: { id: true, branchId: true } });
    if (!patient) throw app.httpErrors.notFound('Patient not found');
    assertBranchAccess(request, patient.branchId);

    const now = new Date();
    const appointment = input.appointmentId
      ? await db.appointment.findFirst({
        where: {
          id: input.appointmentId, tenantId, patientId: patient.id, branchId: patient.branchId, deletedAt: null,
        },
        select: { id: true, startsAt: true, service: true },
      })
      : null;
    if (input.appointmentId && !appointment) throw app.httpErrors.badRequest('Appointment does not belong to the selected patient and branch');
    const requestedServiceAt = appointment?.startsAt ?? input.serviceDate ?? now;
    const requestedServiceType = input.serviceType?.trim() || appointment?.service || null;
    const policies = await db.patientInsurancePolicy.findMany({
      where: {
        tenantId, patientId: patient.id, branchId: patient.branchId, active: true,
        effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
        ...(input.policyId ? { id: input.policyId } : { memberId: input.memberId, payer: { name: input.payerName } }),
      },
      include: { payer: { select: { id: true, name: true, tradingPartnerServiceId: true, sourceProvider: true } } },
      take: 2,
    });
    if (policies.length !== 1 || !policies[0].payer) throw app.httpErrors.badRequest('Select one active tenant policy with a configured payer');
    const policy = policies[0];
    const policyPayer = policy.payer;
    if (!policyPayer || policy.memberId !== input.memberId || policyPayer.name !== input.payerName) throw app.httpErrors.badRequest('Policy, payer, and member details do not match');

    // Split-brain honesty: /v1/revenue-protection/eligibility/check makes a REAL
    // Stedi call when a live key is configured, while this route historically ran a
    // deterministic sandbox SIMULATOR — and mislabelled it 'production' when the
    // per-tenant provider row was in production mode without a live key. Route to the
    // SAME real Stedi adapter revenue-protection uses when it is genuinely live-
    // configured; otherwise return an explicitly SIMULATED sandbox result so invented
    // copay/deductible is never presented as a real payer (271) response. connectedCare/*
    // is owned elsewhere and is NOT modified — we reuse revenue-protection's provider.
    const liveConfigured = providerRuntimeCapability('stedi', 'production').enabled;
    const rawIdempotencyKey = eligibilityIdempotencyKey(request);
    const responseFromVerification = async (verificationId: string) => {
      const row = await db.eligibilityVerification.findFirst({ where: { id: verificationId, tenantId } });
      if (!row) throw app.httpErrors.internalServerError('Eligibility result is unavailable');
      const normalized = row.normalizedResponse as Record<string, unknown>;
      const simulated = normalized.simulated === true;
      return {
        verificationId: row.id,
        status: row.coverageStatus,
        coverageActive: row.coverageActive,
        planName: row.planName,
        payerName: row.payerName,
        copay: row.copay === null ? null : Number(row.copay),
        deductibleRemaining: row.deductibleRemaining === null ? null : Number(row.deductibleRemaining),
        coinsurance: row.coinsurance === null ? null : Number(row.coinsurance),
        message: row.eligibilityMessage,
        payerReference: row.payerReference,
        maskedMemberId: maskMemberId(input.memberId),
        providerMode: row.providerMode,
        mode: row.providerMode,
        simulated,
        decisionSource: row.decisionSource,
        checkedAt: row.checkedAt,
        effectiveFrom: row.effectiveFrom,
        expiresAt: row.expiresAt,
      };
    };

    try {
      const execution = await runEligibilityExecution({
        context: {
          tenantId,
          branchId: patient.branchId,
          patientId: patient.id,
          appointmentId: appointment?.id ?? null,
          payerId: policyPayer.id,
          policyId: policy.id,
          actorUserId: request.auth.userId,
          requestedServiceType,
          requestedServiceAt,
          requestId: request.id,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
        },
        rawIdempotencyKey,
        fingerprintParts: {
          contract: 'insurance_v1',
          branchId: patient.branchId,
          patientId: patient.id,
          appointmentId: appointment?.id ?? null,
          policyId: policy.id,
          payerId: policyPayer.id,
          memberId: input.memberId,
          providerKey: input.providerKey,
          serviceType: requestedServiceType,
          // The date of service is the logical request boundary. Do not put a
          // wall-clock request timestamp into the fingerprint: a lost response
          // followed by a browser restart would otherwise look like a new payer
          // transaction and could be submitted twice.
          requestedServiceAt: requestedServiceAt.toISOString().slice(0, 10),
        },
        requestContract: 'insurance_v1',
        providerKey: input.providerKey,
        providerMode: provider.mode,
        executeProvider: async providerExecutionKey => {
          if (input.providerKey === 'stedi' && provider.mode === 'production' && liveConfigured) {
            const outcome = await createInsuranceProvider().runEligibilityCheck({
              tenantId,
              branchId: patient.branchId,
              providerExecutionKey,
              payer: policyPayer,
              policy: { id: policy.id, planName: policy.planName, memberId: policy.memberId },
              serviceType: requestedServiceType ?? undefined,
            });
            const n: NormalizedEligibility = {
              status: outcome.coverageActive ? (outcome.coverageStatus === 'uncertain' ? 'NEEDS_REVIEW' : 'ACTIVE') : 'INACTIVE',
              coverageActive: outcome.coverageActive,
              planName: outcome.planName,
              payerName: outcome.payerName,
              copay: outcome.copay,
              deductibleRemaining: outcome.deductibleRemaining,
              coinsurance: outcome.coinsurance,
              message: outcome.eligibilityMessage,
              payerReference: outcome.payerReference,
              checkedAt: outcome.checkedAt,
              effectiveFrom: outcome.effectiveFrom,
              expiresAt: outcome.expiresAt,
            };
            return {
              n,
              providerMode: outcome.providerMode,
              simulated: outcome.providerMode !== 'live',
              raw: outcome.storeRawResponse && outcome.rawResponse ? outcome.rawResponse : { note: 'raw payer response withheld' },
            };
          }
          const result = runStediEligibility(
            { memberId: input.memberId, payerName: input.payerName, planName: input.planName, serviceType: requestedServiceType ?? undefined },
            'sandbox',
          );
          return { n: result.normalized, providerMode: 'sandbox', simulated: true, raw: result.raw };
        },
        finalize: async (tx, outcome, executionId) => {
          const verifiedAt = new Date();
          const created = await tx.eligibilityVerification.create({
            data: {
              tenantId,
              branchId: patient.branchId,
              patientId: patient.id,
              appointmentId: appointment?.id ?? undefined,
              providerMode: outcome.providerMode,
              payerId: policy.payerId,
              policyId: policy.id,
              coverageStatus: outcome.n.status,
              coverageActive: outcome.n.coverageActive,
              planName: outcome.n.planName,
              payerName: outcome.n.payerName,
              copay: outcome.n.copay,
              deductibleRemaining: outcome.n.deductibleRemaining,
              coinsurance: outcome.n.coinsurance,
              eligibilityMessage: outcome.n.message,
              payerReference: outcome.n.payerReference,
              decisionSource: outcome.simulated ? 'SIMULATED' : 'PAYER_RESPONSE',
              effectiveFrom: outcome.n.effectiveFrom ? new Date(outcome.n.effectiveFrom) : null,
              expiresAt: outcome.n.expiresAt ? new Date(outcome.n.expiresAt) : null,
              normalizedResponse: { ...outcome.n, simulated: outcome.simulated } as unknown as Prisma.InputJsonValue,
            },
          });
          const verificationStatus = outcome.n.status === 'NEEDS_REVIEW'
            ? 'needs_review'
            : outcome.n.coverageActive ? 'verified' : 'inactive';
          const eligibilityStatus = outcome.n.status === 'NEEDS_REVIEW'
            ? 'NEEDS_REVIEW'
            : outcome.n.coverageActive ? 'ACTIVE' : 'INACTIVE';
          await tx.patientInsurancePolicy.update({ where: { id: policy.id }, data: { verificationStatus, verifiedAt } });
          if (policy.coverageOrder === 1) {
            await tx.patient.update({ where: { id: patient.id }, data: { eligibilityStatus, eligibilityLastVerifiedAt: verifiedAt } });
          }
          if (appointment) {
            await tx.appointment.update({ where: { id: appointment.id }, data: { eligibilityStatus, eligibilityLastVerifiedAt: verifiedAt } });
          }
          await tx.businessEvent.create({
            data: {
              tenantId,
              eventType: 'insurance.eligibility.completed',
              entityType: 'eligibilityVerification',
              entityId: created.id,
              sourceModule: 'insurance',
              payload: { status: outcome.n.status, executionId },
            },
          });
          return {
            verificationId: created.id,
            result: {
              verificationId: created.id,
              status: outcome.n.status,
              coverageActive: outcome.n.coverageActive,
              planName: outcome.n.planName,
              payerName: outcome.n.payerName,
              copay: outcome.n.copay,
              deductibleRemaining: outcome.n.deductibleRemaining,
              coinsurance: outcome.n.coinsurance,
              message: outcome.n.message,
              payerReference: outcome.n.payerReference,
              maskedMemberId: maskMemberId(input.memberId),
              providerMode: outcome.providerMode,
              mode: outcome.providerMode,
              simulated: outcome.simulated,
              decisionSource: outcome.simulated ? 'SIMULATED' : 'PAYER_RESPONSE',
              checkedAt: created.checkedAt,
              effectiveFrom: created.effectiveFrom,
              expiresAt: created.expiresAt,
            },
            auditMetadata: { mode: outcome.providerMode, status: outcome.n.status, simulated: outcome.simulated },
          };
        },
        replay: responseFromVerification,
      });
      return reply.code(execution.replayed ? 200 : 201).send({ ...execution.result, executionId: execution.executionId, replayed: execution.replayed });
    } catch (error) {
      if (!(error instanceof EligibilityExecutionConflictError)) throw error;
      const statusCode = error.code === 'idempotency_key_reused' ? 409 : 409;
      return reply.code(statusCode).send({
        status: error.code,
        executionId: error.executionId,
        retryable: false,
        message: error.code === 'reconciliation_required'
          ? 'The payer outcome is ambiguous and requires staff reconciliation. The provider was not called again.'
          : 'This eligibility execution cannot be repeated with the supplied idempotency key.',
      });
    }
  });

  // Eligibility history (no member IDs are persisted; PHI-minimal).
  app.get('/eligibility/history', { preHandler: insuranceRead }, async request => {
    const q = z.object({ patientId: uuid.optional(), limit: z.coerce.number().min(1).max(100).default(25) }).parse(request.query);
    const rows = await db.eligibilityVerification.findMany({
      where: { tenantId: request.auth.tenantId, ...branchScope(request), ...(q.patientId ? { patientId: q.patientId } : {}) },
      orderBy: { checkedAt: 'desc' }, take: q.limit,
      select: { id: true, patientId: true, coverageStatus: true, coverageActive: true, planName: true, payerName: true, copay: true, deductibleRemaining: true, coinsurance: true, eligibilityMessage: true, providerMode: true, decisionSource: true, checkedAt: true, effectiveFrom: true, expiresAt: true },
    });
    const pIds = [...new Set(rows.map(r => r.patientId))];
    const patients = pIds.length ? await db.patient.findMany({ where: { id: { in: pIds }, tenantId: request.auth.tenantId }, select: { id: true, firstName: true, lastName: true } }) : [];
    const pmap = new Map(patients.map(p => [p.id, `${p.firstName} ${p.lastName}`]));
    await audit(request, { action: 'insurance.eligibility.history.read', resource: 'eligibilityVerification', metadata: { count: rows.length, patientScoped: Boolean(q.patientId) } });
    return rows.map(r => ({
      ...r,
      copay: r.copay === null ? null : Number(r.copay),
      deductibleRemaining: r.deductibleRemaining === null ? null : Number(r.deductibleRemaining),
      coinsurance: r.coinsurance === null ? null : Number(r.coinsurance),
      patientName: pmap.get(r.patientId) ?? 'Unknown',
    }));
  });

  app.get('/eligibility/executions/reconciliation', { preHandler: insuranceRead }, async request => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), state: z.enum(['unresolved', 'in_flight', 'manual_pending', 'reconciled', 'terminal', 'all']).default('unresolved') }).parse(request.query);
    const canReconcile = (await getRequestPermissions(request)).has('insurance:reconcile');
    const requestedState = canReconcile ? q.state : 'unresolved';
    const statusByState = {
      unresolved: ['READY', 'PROVIDER_IN_FLIGHT', 'RECONCILIATION_REQUIRED', 'MANUAL_EVIDENCE_PENDING'],
      in_flight: ['PROVIDER_IN_FLIGHT'], manual_pending: ['MANUAL_EVIDENCE_PENDING'], reconciled: ['MANUALLY_RECONCILED'],
      terminal: ['SUCCEEDED', 'FAILED_DEFINITIVE', 'MANUALLY_RECONCILED'],
      all: ['READY', 'PROVIDER_IN_FLIGHT', 'RECONCILIATION_REQUIRED', 'MANUAL_EVIDENCE_PENDING', 'SUCCEEDED', 'FAILED_DEFINITIVE', 'MANUALLY_RECONCILED'],
    } as const;
    const rows = await db.eligibilityExecution.findMany({
      where: {
        tenantId: request.auth.tenantId,
        ...branchScope(request),
        status: { in: [...statusByState[requestedState]] },
      },
      orderBy: { updatedAt: 'asc' },
      take: q.limit,
      select: {
        id: true,
        branchId: true,
        patientId: true,
        appointmentId: true,
        payerId: true,
        policyId: true,
        providerKey: true,
        providerMode: true,
        requestContract: true,
        status: true,
        reconciliationReason: true,
        reconciliationGeneration: true,
        reconciliationTaskId: true,
        reconciliationTask: { select: { status: true, assignedToId: true, assignedTo: { select: { displayName: true } } } },
        manualEvidenceOutcome: true,
        manualEvidenceSource: true,
        manualEvidenceReference: true,
        manualEvidenceVerifiedAt: true,
        manualCopay: true,
        manualDeductibleRemaining: true,
        manualCoinsurance: true,
        requestedServiceType: true,
        requestedServiceAt: true,
        providerStartedAt: true,
        providerCompletedAt: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
        patient: { select: { firstName: true, lastName: true } },
        payer: { select: { name: true } },
        policy: { select: { planName: true } },
        appointment: { select: { service: true, startsAt: true } },
        resultVerification: {
          select: { decisionSource: true, coverageStatus: true, checkedAt: true, eligibilityMessage: true },
        },
      },
    });
    const rowIds = rows.map(row => row.id);
    const auditRows = rowIds.length ? await db.auditEvent.findMany({
      where: {
        tenantId: request.auth.tenantId,
        resource: 'eligibilityExecution',
        resourceId: { in: rowIds },
      },
      orderBy: { occurredAt: 'desc' },
      take: Math.min(500, rowIds.length * 10),
      select: { resourceId: true, action: true, occurredAt: true, actorUser: { select: { displayName: true } } },
    }) : [];
    const auditsByExecution = new Map<string, Array<{ action: string; occurredAt: Date; actorName: string | null }>>();
    for (const auditRow of auditRows) {
      if (!auditRow.resourceId) continue;
      const bucket = auditsByExecution.get(auditRow.resourceId) ?? [];
      if (bucket.length >= 10) continue;
      bucket.push({ action: auditRow.action, occurredAt: auditRow.occurredAt, actorName: auditRow.actorUser?.displayName ?? null });
      auditsByExecution.set(auditRow.resourceId, bucket);
    }
    await audit(request, { action: 'eligibility.execution.reconciliation.list', resource: 'eligibilityExecution', metadata: { count: rows.length } });
    return rows.map(({ patient, payer, policy, appointment, resultVerification, ...row }) => {
      const capability = eligibilityProviderReconciliationCapability(row.providerKey);
      const staleBefore = Date.now() - env.ELIGIBILITY_RECONCILIATION_STALE_SECONDS * 1000;
      const stale = row.status === 'READY'
        ? row.createdAt.getTime() < staleBefore
        : row.status === 'PROVIDER_IN_FLIGHT' && Boolean(row.providerStartedAt && row.providerStartedAt.getTime() < staleBefore);
      return {
        ...row,
        manualCopay: row.manualCopay === null ? null : Number(row.manualCopay),
        manualDeductibleRemaining: row.manualDeductibleRemaining === null ? null : Number(row.manualDeductibleRemaining),
        manualCoinsurance: row.manualCoinsurance === null ? null : Number(row.manualCoinsurance),
        patientName: `${patient.firstName} ${patient.lastName}`,
        payerName: payer?.name ?? 'Payer unavailable',
        planName: policy?.planName ?? 'Plan unavailable',
        requestedServiceType: row.requestedServiceType ?? appointment?.service ?? 'Not specified',
        requestedServiceAt: row.requestedServiceAt ?? appointment?.startsAt ?? null,
        requestTime: row.createdAt,
        lastAttemptAt: row.providerStartedAt ?? row.updatedAt,
        resultSource: resultVerification?.decisionSource ?? null,
        resultStatus: resultVerification?.coverageStatus ?? null,
        resultCheckedAt: resultVerification?.checkedAt ?? null,
        resultMessage: resultVerification?.eligibilityMessage ?? null,
        auditTrail: auditsByExecution.get(row.id) ?? [],
        operatorState: row.status === 'MANUALLY_RECONCILED' ? 'reconciled'
          : row.status === 'FAILED_DEFINITIVE' || row.status === 'SUCCEEDED' ? 'terminal'
            : row.status === 'PROVIDER_IN_FLIGHT' ? stale ? 'stale_provider_in_flight' : 'provider_in_flight'
              : row.status === 'RECONCILIATION_REQUIRED' ? 'reconciliation_required'
                : row.status === 'READY' ? stale ? 'stale_ready' : 'retryable_ready'
                  : row.reconciliationTask?.assignedToId ? 'manual_claimed' : 'manual_pending',
        providerCallMayHaveOccurred: row.providerStartedAt !== null,
        providerRetrievalSupported: capability.verifiedResponseLookupSupported,
        resolutionPath: capability.resolutionPath,
        noAutomaticPayerRetry: true,
        stale,
        canReconcile,
        ageSeconds: Math.max(0, Math.floor((Date.now() - row.createdAt.getTime()) / 1000)),
      };
    });
  });

  app.post('/eligibility/executions/:id/claim', { preHandler: insuranceReconcile }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { expectedGeneration } = z.object({ expectedGeneration: z.number().int().nonnegative() }).parse(request.body);
    return db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`eligibility-reconciliation:${request.auth.tenantId}:${id}`}, 0))`;
      const execution = await tx.eligibilityExecution.findFirst({ where: { id, tenantId: request.auth.tenantId }, include: { reconciliationTask: true } });
      if (!execution) throw app.httpErrors.notFound('Eligibility execution not found');
      assertBranchAccess(request, execution.branchId);
      if (execution.reconciliationGeneration !== expectedGeneration) throw app.httpErrors.conflict('Eligibility reconciliation changed; reload before claiming');
      if (execution.status !== 'MANUAL_EVIDENCE_PENDING' || !execution.reconciliationTask) throw app.httpErrors.conflict('Eligibility reconciliation is not claimable');
      if (execution.reconciliationTask.assignedToId === request.auth.userId && execution.reconciliationTask.status === 'IN_PROGRESS') {
        return { executionId: id, taskId: execution.reconciliationTask.id, claimed: true, replayed: true };
      }
      const claimed = await tx.staffTask.updateMany({ where: {
        id: execution.reconciliationTask.id, tenantId: request.auth.tenantId, status: 'OPEN', assignedToId: null,
      }, data: { status: 'IN_PROGRESS', assignedToId: request.auth.userId } });
      if (claimed.count !== 1) throw app.httpErrors.conflict('Eligibility reconciliation is already claimed');
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'eligibility.execution.reconciliation.claimed', resource: 'eligibilityExecution', resourceId: id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
        metadata: { taskId: execution.reconciliationTask.id, generation: expectedGeneration },
      } });
      return { executionId: id, taskId: execution.reconciliationTask.id, claimed: true, replayed: false };
    });
  });

  app.post('/eligibility/executions/:id/reconcile', { preHandler: insuranceReconcile }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const evidence = z.object({
      outcome: z.enum(['ACTIVE', 'INACTIVE', 'UNCERTAIN']),
      source: z.enum(['PAYER_PORTAL', 'PAYER_PHONE', 'PAYER_DOCUMENT']),
      reference: z.string().trim().regex(/^[A-Za-z0-9._:/-]{3,100}$/),
      verifiedAt: z.coerce.date(), effectiveFrom: z.coerce.date().nullable().optional(), expiresAt: z.coerce.date().nullable().optional(),
      copay: z.coerce.number().nonnegative().max(1_000_000).nullable().optional(),
      deductibleRemaining: z.coerce.number().nonnegative().max(1_000_000).nullable().optional(),
      coinsurance: z.coerce.number().min(0).max(1).nullable().optional(), notes: z.string().trim().min(3).max(500).optional(),
      attestation: z.object({
        patientMatches: z.literal(true), policyMatches: z.literal(true), payerMatches: z.literal(true), serviceAndDateMatch: z.literal(true),
      }),
    }).refine(value => value.verifiedAt <= new Date(Date.now() + 5 * 60_000), { message: 'Evidence time cannot be in the future' })
      .refine(value => !value.effectiveFrom || !value.expiresAt || value.expiresAt > value.effectiveFrom, { message: 'Coverage end must be after coverage effective date' });
    const body = z.discriminatedUnion('resolution', [
      z.object({ resolution: z.literal('confirmed_not_submitted'), expectedGeneration: z.number().int().nonnegative(), reason: z.string().trim().min(8).max(500) }),
      z.object({ resolution: z.literal('confirmed_failed'), expectedGeneration: z.number().int().nonnegative(), reason: z.string().trim().min(8).max(500) }),
      z.object({ resolution: z.literal('confirmed_succeeded'), expectedGeneration: z.number().int().nonnegative(), reason: z.string().trim().min(8).max(500), evidence }),
    ]).parse(request.body);
    const execution = await db.eligibilityExecution.findFirst({ where: { id, tenantId: request.auth.tenantId }, include: { reconciliationTask: true } });
    if (!execution) throw app.httpErrors.notFound('Eligibility execution not found');
    assertBranchAccess(request, execution.branchId);
    if (execution.reconciliationGeneration !== body.expectedGeneration) throw app.httpErrors.conflict('Eligibility reconciliation changed; reload before resolving');
    if (execution.status !== 'MANUAL_EVIDENCE_PENDING' || !execution.reconciliationTask) throw app.httpErrors.conflict('Only manual-evidence-pending executions may be resolved');
    if (execution.reconciliationTask.assignedToId !== request.auth.userId || execution.reconciliationTask.status !== 'IN_PROGRESS') throw app.httpErrors.conflict('Claim this reconciliation task before resolving it');
    const nextStatus = body.resolution === 'confirmed_not_submitted' ? 'READY' : 'FAILED_DEFINITIVE';
    const resolved = await db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`eligibility-execution:${execution.id}`}, 0))`;
      const current = await tx.eligibilityExecution.findFirstOrThrow({
        where: { id: execution.id, tenantId: request.auth.tenantId },
        include: { policy: true, payer: true, reconciliationTask: true, appointment: true },
      });
      if (current.status !== 'MANUAL_EVIDENCE_PENDING' || current.reconciliationGeneration !== body.expectedGeneration) throw app.httpErrors.conflict('Eligibility reconciliation changed; reload before resolving');
      if (body.resolution === 'confirmed_succeeded') {
        const serviceAt = current.requestedServiceAt ?? current.appointment?.startsAt ?? current.createdAt;
        const outsideCoverageDates = Boolean(
          (body.evidence.effectiveFrom && serviceAt < body.evidence.effectiveFrom)
          || (body.evidence.expiresAt && serviceAt >= body.evidence.expiresAt),
        );
        const effectiveOutcome = outsideCoverageDates ? 'UNCERTAIN' : body.evidence.outcome;
        const active = effectiveOutcome === 'ACTIVE';
        const coverageStatus = effectiveOutcome === 'UNCERTAIN' ? 'NEEDS_REVIEW' : effectiveOutcome;
        const verification = await tx.eligibilityVerification.create({ data: {
          tenantId: current.tenantId, branchId: current.branchId, patientId: current.patientId,
          appointmentId: current.appointmentId, payerId: current.payerId, policyId: current.policyId,
          providerMode: 'manual_evidence', coverageStatus, coverageActive: active,
          planName: current.policy?.planName ?? 'Unknown plan', payerName: current.payer?.name ?? 'Unknown payer',
          copay: body.evidence.copay ?? null, deductibleRemaining: body.evidence.deductibleRemaining ?? null, coinsurance: body.evidence.coinsurance ?? null,
          eligibilityMessage: 'Coverage status was manually reconciled from recorded payer evidence. This is not a payment guarantee.',
          payerReference: body.evidence.reference, decisionSource: 'MANUAL_PAYER_EVIDENCE',
          effectiveFrom: body.evidence.effectiveFrom ?? null, expiresAt: body.evidence.expiresAt ?? null, checkedAt: body.evidence.verifiedAt,
          normalizedResponse: {
            coverageStatus, coverageActive: active, evidenceSource: body.evidence.source, evidenceReference: body.evidence.reference,
            verifiedAt: body.evidence.verifiedAt.toISOString(), effectiveFrom: body.evidence.effectiveFrom?.toISOString() ?? null,
            expiresAt: body.evidence.expiresAt?.toISOString() ?? null, copay: body.evidence.copay ?? null,
            deductibleRemaining: body.evidence.deductibleRemaining ?? null, coinsurance: body.evidence.coinsurance ?? null,
            benefitDataIncomplete: body.evidence.copay == null || body.evidence.deductibleRemaining == null || body.evidence.coinsurance == null,
            noPaymentGuarantee: true, dateApplicable: !outsideCoverageDates, attestation: body.evidence.attestation,
          },
        } });
        const updated = await tx.eligibilityExecution.updateMany({
          where: { id: current.id, tenantId: current.tenantId, status: 'MANUAL_EVIDENCE_PENDING', reconciliationGeneration: current.reconciliationGeneration },
          data: {
            status: 'MANUALLY_RECONCILED', resultVerificationId: verification.id, completedAt: new Date(), providerCompletedAt: current.providerCompletedAt ?? new Date(),
            reconciliationGeneration: { increment: 1 }, reconciliationLeaseOwner: null, reconciliationLeaseExpiresAt: null,
            manualEvidenceOutcome: effectiveOutcome, manualEvidenceSource: body.evidence.source, manualEvidenceReference: body.evidence.reference,
            manualEvidenceVerifiedAt: body.evidence.verifiedAt, manualEvidenceVerifiedByUserId: request.auth.userId,
            manualCoverageEffectiveFrom: body.evidence.effectiveFrom ?? null, manualCoverageExpiresAt: body.evidence.expiresAt ?? null,
            manualCopay: body.evidence.copay ?? null, manualDeductibleRemaining: body.evidence.deductibleRemaining ?? null,
            manualCoinsurance: body.evidence.coinsurance ?? null, manualEvidenceNotes: body.evidence.notes ?? body.reason,
          },
        });
        if (updated.count !== 1) throw app.httpErrors.conflict('Eligibility reconciliation changed; reload before resolving');
        if (current.policyId) await tx.patientInsurancePolicy.updateMany({ where: { id: current.policyId, tenantId: current.tenantId }, data: { verificationStatus: active ? 'verified' : effectiveOutcome === 'INACTIVE' ? 'inactive' : 'needs_review', verifiedAt: body.evidence.verifiedAt } });
        await tx.patient.updateMany({ where: { id: current.patientId, tenantId: current.tenantId }, data: { eligibilityStatus: active ? 'ACTIVE' : effectiveOutcome === 'INACTIVE' ? 'INACTIVE' : 'NEEDS_REVIEW', eligibilityLastVerifiedAt: body.evidence.verifiedAt } });
        if (current.appointmentId) await tx.appointment.updateMany({ where: { id: current.appointmentId, tenantId: current.tenantId }, data: { eligibilityStatus: active ? 'ACTIVE' : effectiveOutcome === 'INACTIVE' ? 'INACTIVE' : 'NEEDS_REVIEW', eligibilityLastVerifiedAt: body.evidence.verifiedAt } });
        await tx.staffTask.update({ where: { id: current.reconciliationTaskId! }, data: { status: 'COMPLETED' } });
        await tx.businessEvent.create({ data: { tenantId: current.tenantId, eventType: 'insurance.eligibility.manually_reconciled', entityType: 'eligibilityVerification', entityId: verification.id, sourceModule: 'insurance', payload: { executionId: current.id, coverageStatus, noPaymentGuarantee: true } } });
        await tx.auditEvent.create({ data: {
          tenantId: current.tenantId, actorUserId: request.auth.userId, action: 'eligibility.execution.manually_reconciled', resource: 'eligibilityExecution', resourceId: current.id,
          requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
          metadata: { resolution: body.resolution, evidenceSource: body.evidence.source, evidenceReference: body.evidence.reference, coverageStatus, noPaymentGuarantee: true },
        } });
        return { executionId: current.id, status: 'MANUALLY_RECONCILED', verificationId: verification.id, providerCalled: false };
      }
      const updated = await tx.eligibilityExecution.updateMany({
        where: { id: execution.id, tenantId: request.auth.tenantId, status: 'MANUAL_EVIDENCE_PENDING', reconciliationGeneration: current.reconciliationGeneration },
        data: {
          status: nextStatus,
          reconciliationGeneration: { increment: 1 },
          failureCode: body.resolution === 'confirmed_failed' ? 'provider_failure_confirmed' : null,
          reconciliationReason: body.reason,
          reconciliationTaskId: body.resolution === 'confirmed_not_submitted' ? null : current.reconciliationTaskId,
          providerStartedAt: body.resolution === 'confirmed_not_submitted' ? null : execution.providerStartedAt,
          providerCompletedAt: body.resolution === 'confirmed_not_submitted' ? null : new Date(),
          completedAt: body.resolution === 'confirmed_failed' ? new Date() : null,
        },
      });
      if (updated.count !== 1) throw app.httpErrors.conflict('Eligibility execution was already reconciled');
      await tx.staffTask.update({ where: { id: current.reconciliationTaskId! }, data: { status: 'COMPLETED' } });
      await tx.auditEvent.create({
        data: {
          tenantId: request.auth.tenantId,
          actorUserId: request.auth.userId,
          action: 'eligibility.execution.reconciled',
          resource: 'eligibilityExecution',
          resourceId: execution.id,
          requestId: request.id,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
          metadata: { resolution: body.resolution, reason: body.reason },
        },
      });
      return { executionId: execution.id, status: nextStatus, providerCalled: false };
    });
    return reply.send(resolved);
  });
};
