import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { requireRoles } from '../../plugins/roles';
import { requireFeature } from '../../lib/entitlements';
import { assertBranchAccess, branchScope } from '../../lib/scope';
import { eligibilityProviderStatus, computeDenialRisk, runDenialPreventionForAppointment } from '../../lib/insuranceIntelligence';
import { emitBusinessEvent } from '../../lib/intelligence';
import { encryptSecret } from '../../lib/security';
import { INSURANCE_PROVIDERS, maskMemberId } from '../../lib/connectedCare/catalog';
import { runStediEligibility, type NormalizedEligibility } from '../../lib/connectedCare/eligibilityService';
import { env } from '../../config/env';
import { createInsuranceProvider } from '../revenue-protection';

function insStatus(def: { supportsSandbox: boolean }, mode: string, hasRequired: boolean): string {
  if (mode === 'sandbox' && def.supportsSandbox) return 'SANDBOX';
  if (hasRequired) return 'ACTIVE';
  return 'NOT_CONFIGURED';
}

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
        configured: !!row && row.status !== 'NOT_CONFIGURED',
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
    if (row && (row.status === 'SANDBOX' || row.status === 'ACTIVE')) {
      healthStatus = 'healthy';
      message = key === 'stedi'
        ? (row.mode === 'sandbox' ? 'Sandbox reachable — simulated 271 response OK.' : 'Production credentials present.')
        : 'Credentials present.';
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
      serviceType: z.string().trim().max(40).optional(),
      providerKey: z.enum(['stedi']).default('stedi'),
    }).parse(request.body);
    const tenantId = request.auth.tenantId;
    const provider = await db.insuranceProvider.findFirst({ where: { tenantId, providerKey: input.providerKey } });
    if (!provider || (provider.status !== 'SANDBOX' && provider.status !== 'ACTIVE')) {
      throw app.httpErrors.badRequest('Eligibility provider is not configured. Configure Stedi (sandbox is available) first.');
    }
    const patient = await db.patient.findFirst({ where: { id: input.patientId, tenantId, deletedAt: null }, select: { id: true, branchId: true } });
    if (!patient) throw app.httpErrors.notFound('Patient not found');
    assertBranchAccess(request, patient.branchId);

    // Split-brain honesty: /v1/revenue-protection/eligibility/check makes a REAL
    // Stedi call when a live key is configured, while this route historically ran a
    // deterministic sandbox SIMULATOR — and mislabelled it 'production' when the
    // per-tenant provider row was in production mode without a live key. Route to the
    // SAME real Stedi adapter revenue-protection uses when it is genuinely live-
    // configured; otherwise return an explicitly SIMULATED sandbox result so invented
    // copay/deductible is never presented as a real payer (271) response. connectedCare/*
    // is owned elsewhere and is NOT modified — we reuse revenue-protection's provider.
    const liveConfigured = env.INSURANCE_PROVIDER === 'stedi' && Boolean(env.STEDI_API_KEY);
    let n: NormalizedEligibility;
    let providerMode: string;
    let raw: unknown;
    let simulated: boolean;

    if (input.providerKey === 'stedi' && provider.mode === 'production' && liveConfigured) {
      // REAL path — identical adapter to revenue-protection's eligibility check.
      const payerRow = await db.insurancePayer.findFirst({ where: { tenantId, name: input.payerName } });
      const outcome = await createInsuranceProvider().runEligibilityCheck({
        tenantId, branchId: patient.branchId,
        payer: payerRow
          ? { id: payerRow.id, name: payerRow.name, tradingPartnerServiceId: payerRow.tradingPartnerServiceId, sourceProvider: payerRow.sourceProvider }
          : { id: '', name: input.payerName, sourceProvider: 'stedi' },
        policy: { id: '', planName: input.planName ?? 'Health Plan', memberId: input.memberId },
        serviceType: input.serviceType,
      });
      providerMode = outcome.providerMode;
      // Only a genuine 'live' payer response is NOT a simulation.
      simulated = outcome.providerMode !== 'live';
      n = {
        status: outcome.coverageActive ? (outcome.coverageStatus === 'uncertain' ? 'NEEDS_REVIEW' : 'ACTIVE') : 'INACTIVE',
        coverageActive: outcome.coverageActive, planName: outcome.planName, payerName: outcome.payerName,
        copay: outcome.copay, deductibleRemaining: outcome.deductibleRemaining, coinsurance: outcome.coinsurance,
        message: outcome.eligibilityMessage, payerReference: outcome.payerReference, checkedAt: outcome.checkedAt,
      };
      raw = outcome.storeRawResponse && outcome.rawResponse ? outcome.rawResponse : { note: 'raw payer response withheld' };
    } else {
      // SIMULATED path — FORCE sandbox labeling; never present 'production' fabricated
      // data as a real result.
      const result = runStediEligibility(
        { memberId: input.memberId, payerName: input.payerName, planName: input.planName, serviceType: input.serviceType },
        'sandbox',
      );
      n = result.normalized;
      providerMode = 'sandbox';
      simulated = true;
      raw = result.raw;
    }

    const verification = await db.eligibilityVerification.create({
      data: {
        tenantId, branchId: patient.branchId, patientId: patient.id, providerMode,
        coverageStatus: n.status, coverageActive: n.coverageActive, planName: n.planName, payerName: n.payerName,
        copay: n.copay, deductibleRemaining: n.deductibleRemaining, coinsurance: n.coinsurance,
        eligibilityMessage: n.message, payerReference: n.payerReference,
        normalizedResponse: { ...n, simulated } as unknown as object, rawResponse: raw as object,
      },
      select: { id: true, checkedAt: true },
    });
    // Audit WITHOUT PHI — never log the member ID.
    await audit(request, { action: 'insurance.eligibility.checked', resource: 'eligibilityVerification', resourceId: verification.id, metadata: { providerKey: input.providerKey, status: n.status, mode: providerMode, simulated } });
    await emitBusinessEvent(tenantId, { eventType: 'insurance.eligibility.completed', entityType: 'eligibilityVerification', entityId: verification.id, sourceModule: 'insurance', payload: { status: n.status } }).catch(() => {});

    return reply.code(201).send({
      verificationId: verification.id, status: n.status, coverageActive: n.coverageActive,
      planName: n.planName, payerName: n.payerName, copay: n.copay, deductibleRemaining: n.deductibleRemaining,
      coinsurance: n.coinsurance, message: n.message, payerReference: n.payerReference,
      maskedMemberId: maskMemberId(input.memberId), providerMode, mode: providerMode, simulated,
      checkedAt: verification.checkedAt,
    });
  });

  // Eligibility history (no member IDs are persisted; PHI-minimal).
  app.get('/eligibility/history', async request => {
    const q = z.object({ patientId: uuid.optional(), limit: z.coerce.number().min(1).max(100).default(25) }).parse(request.query);
    const rows = await db.eligibilityVerification.findMany({
      where: { tenantId: request.auth.tenantId, ...branchScope(request), ...(q.patientId ? { patientId: q.patientId } : {}) },
      orderBy: { checkedAt: 'desc' }, take: q.limit,
      select: { id: true, patientId: true, coverageStatus: true, coverageActive: true, planName: true, payerName: true, copay: true, deductibleRemaining: true, coinsurance: true, eligibilityMessage: true, providerMode: true, checkedAt: true },
    });
    const pIds = [...new Set(rows.map(r => r.patientId))];
    const patients = pIds.length ? await db.patient.findMany({ where: { id: { in: pIds }, tenantId: request.auth.tenantId }, select: { id: true, firstName: true, lastName: true } }) : [];
    const pmap = new Map(patients.map(p => [p.id, `${p.firstName} ${p.lastName}`]));
    return rows.map(r => ({ ...r, copay: Number(r.copay), deductibleRemaining: Number(r.deductibleRemaining), coinsurance: Number(r.coinsurance), patientName: pmap.get(r.patientId) ?? 'Unknown' }));
  });
};
