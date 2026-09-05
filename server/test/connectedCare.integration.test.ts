import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Stub the BullMQ queues module so no Redis connection opens (rate-limiter
// falls back to its in-memory store) and the test process exits cleanly.
vi.mock('../workers/queues', () => ({
  redisConnection: {},
  autopilotQueue: { client: Promise.resolve(undefined), add: async () => undefined },
  enqueueAutopilotExecution: async () => undefined,
  complianceQueue: { add: async () => undefined },
  registerComplianceSchedules: async () => undefined,
  campaignQueue: { add: async () => undefined },
  registerCampaignSchedules: async () => undefined,
}));

const { buildApp } = await import('../app');
const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { recomputeEntitlements } = await import('../lib/entitlements');
const { encryptSecret } = await import('../lib/security');
const { detectOfflineDevices } = await import('../lib/connectedCare/safetyDetection');
const { buildRpmEvidenceSnapshot, rpmPeriodBounds } = await import('../lib/connectedCare/rpmEvidence');
const { computeAndStoreRpmReadiness, countCurrentReadyRpmPatients } = await import('../lib/connectedCare/rpmReadinessService');
const { aiContextBuilder } = await import('../lib/ai/context');
const { runWithTenantContext } = await import('../lib/tenantContext');
const { runWithJobTenantContext } = await import('../lib/tenantContext');
const { scanEligibilityReconciliationWork } = await import('../lib/eligibilityExecution');

// Configure a per-tenant device provider row with an encrypted webhook secret,
// exactly as the devices config route / seed do. This is what makes an inbound
// webhook verifiable (and therefore ingestible) for that tenant.
async function configureDeviceProviderSecret(tenantId: string, providerKey: string, webhookSecret: string) {
  await db.deviceProvider.upsert({
    where: { tenantId_providerKey: { tenantId, providerKey } },
    create: { tenantId, providerKey, displayName: providerKey, category: 'DIRECT_API', mode: 'sandbox', status: 'SANDBOX', encryptedConfig: encryptSecret(JSON.stringify({ webhookSecret })), webhookConfigured: true },
    update: { encryptedConfig: encryptSecret(JSON.stringify({ webhookSecret })), webhookConfigured: true },
  });
}
// Sign exactly what the webhook route verifies: JSON.stringify(request.body).
function signWebhook(secret: string, payload: unknown): { raw: string; sig: string } {
  const raw = JSON.stringify(payload);
  return { raw, sig: createHmac('sha256', secret).update(raw).digest('hex') };
}

let app: FastifyInstance;
const createdTenantIds: string[] = [];
const realSuiteStart = new Date();
const rpmSuiteNow = new Date(Date.UTC(
  realSuiteStart.getUTCFullYear(),
  realSuiteStart.getUTCMonth() + 1,
  1,
) - 1);

async function makeTenant(planKey: 'enterprise' | 'starter') {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `it-${id.slice(0, 6)}`, slug: `it-${id.slice(0, 8)}` } });
  createdTenantIds.push(id);
  const plan = await db.subscriptionPlan.findUnique({ where: { key: planKey } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id, db);
  // Explicitly UTC. The suite pins its clock to the last instant of the UTC
  // month so the RPM fixtures can supply a full set of device-days; the billing
  // period is now reckoned in the BRANCH's zone, so a branch on the default
  // Europe/London would already be in the next local month at that instant and
  // every fixture reading would fall outside the period. The local-period
  // behaviour itself is covered by rpmPeriod.test.ts and by the non-UTC branch
  // case below, rather than by leaving this fixture's zone implicit.
  const branch = await db.branch.create({ data: { tenantId: id, name: 'b', location: 'x', timezone: 'UTC' } });
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'IT', lastName: 'Patient', lifecycleStage: 'NEW' } });
  const payer = await db.insurancePayer.create({ data: { tenantId: id, name: 'Aetna', sourceProvider: 'stedi' } });
  const activePolicy = await db.patientInsurancePolicy.create({ data: { tenantId: id, branchId: branch.id, patientId: patient.id, payerId: payer.id, planName: 'PPO', memberId: 'AET-110293', coverageOrder: 1 } });
  const inactivePolicy = await db.patientInsurancePolicy.create({ data: { tenantId: id, branchId: branch.id, patientId: patient.id, payerId: payer.id, planName: 'Secondary', memberId: 'AET-1100', coverageOrder: 2 } });
  // Real users — the auth plugin derives the role from the DB user, not the token.
  const adminUser = await db.user.create({ data: { tenantId: id, role: 'ADMIN', active: true, email: `a-${id.slice(0, 8)}@it.test`, displayName: 'Admin' } });
  const providerUser = await db.user.create({ data: { tenantId: id, branchId: branch.id, role: 'PROVIDER', active: true, email: `p-${id.slice(0, 8)}@it.test`, displayName: 'Provider' } });
  const providerProfile = await db.providerProfile.create({ data: { tenantId: id, branchId: branch.id, userId: providerUser.id, specialty: 'Primary Care' } });
  return { id, branchId: branch.id, patientId: patient.id, activePolicyId: activePolicy.id, inactivePolicyId: inactivePolicy.id, adminUserId: adminUser.id, providerUserId: providerUser.id, providerProfileId: providerProfile.id };
}
const tok = (tenantId: string, userId: string) => app.jwt.sign({ userId, tenantId, role: 'OWNER', type: 'access' });
const auth = (t: string, ip = '203.0.113.1') => ({ authorization: `Bearer ${t}`, 'x-forwarded-for': ip });

type TenantFixture = Awaited<ReturnType<typeof makeTenant>>;

function inTenant<T>(t: TenantFixture, work: () => Promise<T>): Promise<T> {
  return runWithTenantContext(t.id, async () => work(), { id: t.adminUserId, role: 'ADMIN' });
}

async function prepareRpmBaseEvidence(t: TenantFixture, deviceId?: string, latestReadingAt?: Date) {
  const admin = auth(tok(t.id, t.adminUserId));
  await configureDeviceProviderSecret(t.id, 'withings', `whsec-${randomUUID()}`);
  const linkedDeviceId = deviceId ?? (await db.device.create({
    data: { tenantId: t.id, branchId: t.branchId, name: 'RPM fixture device', deviceType: 'scale', active: true, status: 'online' },
    select: { id: true },
  })).id;
  const enrollmentResponse = await app.inject({ method: 'POST', url: '/v1/connected-care/enrollments', headers: admin, payload: { patientId: t.patientId, providerKey: 'withings', deviceId: linkedDeviceId } });
  expect(enrollmentResponse.statusCode).toBe(201);
  const enrollmentId = enrollmentResponse.json().id as string;
  const period = rpmPeriodBounds();
  await db.patientDeviceEnrollment.update({ where: { id: enrollmentId }, data: { enrolledAt: period.start } });
  expect((await app.inject({ method: 'POST', url: '/v1/connected-care/consent', headers: admin, payload: { patientId: t.patientId, consentType: 'rpm', granted: true, method: 'written' } })).statusCode).toBe(201);

  const now = new Date();
  const readingAsOf = latestReadingAt ?? now;
  await db.deviceReading.createMany({
    data: Array.from({ length: 16 }, (_, day) => ({
      tenantId: t.id,
      patientId: t.patientId,
      deviceId: linkedDeviceId,
      branchId: t.branchId,
      readingType: 'weight',
      value: `${80 + day / 10}`,
      numericValue: 80 + day / 10,
      unit: 'kg',
      capturedAt: new Date(readingAsOf.getTime() - day * 24 * 60 * 60_000),
      source: 'webhook',
      validationStatus: 'valid',
      dedupeKey: `rpm-fixture-${randomUUID()}`,
      sourceProviderKey: 'withings',
      sourceEnrollmentId: enrollmentId,
    })),
  });
  return { admin, now };
}

async function rpmReadinessRow(patientId: string, headers: Record<string, string>) {
  const response = await app.inject({ method: 'GET', url: '/v1/connected-care/rpm-readiness', headers });
  expect(response.statusCode).toBe(200);
  const row = (response.json() as { items: Array<{
    patientId: string; evidenceVersion: string; evidenceHash: string; signoffAttestationRevision: string;
  }> }).items.find(item => item.patientId === patientId);
  expect(row).toBeTruthy();
  return row!;
}

async function signoffRpm(patientId: string, headers: Record<string, string>, overrides: Record<string, string> = {}) {
  const evidence = await rpmReadinessRow(patientId, headers);
  return app.inject({
    method: 'POST', url: `/v1/connected-care/rpm-readiness/${patientId}/signoff`, headers,
    payload: {
      expectedEvidenceVersion: evidence.evidenceVersion,
      expectedEvidenceHash: evidence.evidenceHash,
      attestationRevision: evidence.signoffAttestationRevision,
      ...overrides,
    },
  });
}

async function prepareCompleteRpmEvidence(t: TenantFixture, deviceId?: string, latestReadingAt?: Date) {
  const { admin, now } = await prepareRpmBaseEvidence(t, deviceId, latestReadingAt);
  const endedAt = new Date(now.getTime() - 2 * 60_000);
  const startedAt = new Date(endedAt.getTime() - 20 * 60_000);
  const review = await app.inject({
    method: 'PATCH',
    url: `/v1/connected-care/rpm-readiness/${t.patientId}/review`,
    headers: admin,
    payload: {
      reviewEventId: randomUUID(),
      sourceRef: `ehr-${randomUUID()}`,
      provenance: 'EHR_TIMER',
      startedAt,
      endedAt,
      activityNarrative: 'Reviewed BP trend, confirmed medication adherence, advised on cuff placement.',
      communicationModality: 'live_phone',
    },
  });
  expect(review.statusCode).toBe(200);
  expect(review.json().status).toBe('NEEDS_REVIEW');
  return { admin, now, firstReviewStartedAt: startedAt };
}

beforeAll(async () => {
  // RPM v2 uses fixed UTC calendar months. Keep this suite deterministic even
  // during the first 15 days of a month, when a real-time `now - day` fixture
  // cannot truthfully provide 16 current-period device-days. Faking Date only
  // leaves timers and database behavior real, while month-end also guarantees
  // database-generated audit timestamps remain inside the evidence cutoff.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(rpmSuiteNow);
  app = await buildApp();
}, 60_000);

afterAll(async () => {
  try {
    for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
    await app?.close();
    await db.$disconnect();
  } finally {
    vi.useRealTimers();
  }
});

describe('insurance provider registry + eligibility (integration)', () => {
  it('configures Stedi sandbox, runs a health check, and never returns config', async () => {
    const t = await makeTenant('enterprise');
    const admin = tok(t.id, t.adminUserId);

    const cfg = await app.inject({ method: 'POST', url: '/v1/insurance/providers/stedi/configure', headers: auth(admin), payload: { mode: 'sandbox', config: {} } });
    expect(cfg.statusCode).toBe(200);
    const cfgBody = JSON.parse(cfg.body);
    expect(cfgBody.status).toBe('SANDBOX');
    expect(cfgBody).not.toHaveProperty('encryptedConfig');

    const health = await app.inject({ method: 'POST', url: '/v1/insurance/providers/stedi/health-check', headers: auth(admin) });
    expect(health.statusCode).toBe(200);
    expect(JSON.parse(health.body).lastHealthStatus).toBe('healthy');

    // Optum stays NOT_CONFIGURED (no fake active integration).
    const list = JSON.parse((await app.inject({ method: 'GET', url: '/v1/insurance/providers', headers: auth(admin) })).body);
    expect(list.find((p: { key: string }) => p.key === 'optum').status).toBe('NOT_CONFIGURED');
  });

  it('runs ACTIVE + INACTIVE eligibility checks and masks the member id', async () => {
    const t = await makeTenant('enterprise');
    const admin = tok(t.id, t.adminUserId);
    await app.inject({ method: 'POST', url: '/v1/insurance/providers/stedi/configure', headers: auth(admin), payload: { mode: 'sandbox', config: {} } });

    const active = JSON.parse((await app.inject({ method: 'POST', url: '/v1/insurance/eligibility/check', headers: { ...auth(admin), 'idempotency-key': 'connected-active-eligibility' }, payload: { patientId: t.patientId, policyId: t.activePolicyId, payerName: 'Aetna', memberId: 'AET-110293' } })).body);
    expect(active.status).toBe('ACTIVE');
    expect(active.maskedMemberId).toBe('••••0293');
    expect(active.replayed).toBe(false);
    const activeReplay = JSON.parse((await app.inject({ method: 'POST', url: '/v1/insurance/eligibility/check', headers: { ...auth(admin), 'idempotency-key': 'connected-active-eligibility' }, payload: { patientId: t.patientId, policyId: t.activePolicyId, payerName: 'Aetna', memberId: 'AET-110293' } })).body);
    expect(activeReplay).toMatchObject({ verificationId: active.verificationId, executionId: active.executionId, replayed: true, status: 'ACTIVE' });
    expect(await db.eligibilityVerification.count({ where: { tenantId: t.id, policyId: t.activePolicyId } })).toBe(1);
    const storedActive = await db.eligibilityVerification.findUniqueOrThrow({ where: { id: active.verificationId } });
    expect(storedActive.rawResponse).toBeNull();
    expect(JSON.stringify(storedActive.normalizedResponse)).not.toContain('AET-110293');

    const conflicting = await app.inject({ method: 'POST', url: '/v1/insurance/eligibility/check', headers: { ...auth(admin), 'idempotency-key': 'connected-active-eligibility' }, payload: { patientId: t.patientId, policyId: t.inactivePolicyId, payerName: 'Aetna', memberId: 'AET-1100' } });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json().status).toBe('idempotency_key_reused');

    const inactive = JSON.parse((await app.inject({ method: 'POST', url: '/v1/insurance/eligibility/check', headers: { ...auth(admin), 'idempotency-key': 'connected-inactive-eligibility' }, payload: { patientId: t.patientId, policyId: t.inactivePolicyId, payerName: 'Aetna', memberId: 'AET-1100' } })).body);
    expect(inactive.status).toBe('INACTIVE');

    const history = JSON.parse((await app.inject({ method: 'GET', url: '/v1/insurance/eligibility/history', headers: auth(admin) })).body);
    expect(history.length).toBe(2);
  });

  it('enforces RBAC — a PROVIDER cannot configure providers', async () => {
    const t = await makeTenant('enterprise');
    const res = await app.inject({ method: 'POST', url: '/v1/insurance/providers/stedi/configure', headers: auth(tok(t.id, t.providerUserId)), payload: { mode: 'sandbox', config: {} } });
    expect(res.statusCode).toBe(403);
  });

  it('enforces feature gating — a starter plan has no eligibility surface', async () => {
    const t = await makeTenant('starter');
    const res = await app.inject({ method: 'GET', url: '/v1/insurance/providers', headers: auth(tok(t.id, t.adminUserId)) });
    expect(res.statusCode).toBe(403);
  });

  it('enforces tenant isolation — one tenant cannot see another tenant’s history', async () => {
    const a = await makeTenant('enterprise');
    const b = await makeTenant('enterprise');
    const aAdmin = tok(a.id, a.adminUserId);
    await app.inject({ method: 'POST', url: '/v1/insurance/providers/stedi/configure', headers: auth(aAdmin), payload: { mode: 'sandbox', config: {} } });
    await app.inject({ method: 'POST', url: '/v1/insurance/eligibility/check', headers: { ...auth(aAdmin), 'idempotency-key': 'connected-tenant-a-eligibility' }, payload: { patientId: a.patientId, policyId: a.activePolicyId, payerName: 'Aetna', memberId: 'AET-110293' } });

    const aHistory = JSON.parse((await app.inject({ method: 'GET', url: '/v1/insurance/eligibility/history', headers: auth(aAdmin) })).body);
    expect(aHistory.length).toBe(1);
    const bHistory = JSON.parse((await app.inject({ method: 'GET', url: '/v1/insurance/eligibility/history', headers: auth(tok(b.id, b.adminUserId)) })).body);
    expect(bHistory.length).toBe(0);
  });

  it('lists and resolves ambiguous executions without fabricating successful payer data', async () => {
    const t = await makeTenant('enterprise');
    const other = await makeTenant('enterprise');
    const execution = await db.eligibilityExecution.create({
      data: {
        tenantId: t.id,
        branchId: t.branchId,
        patientId: t.patientId,
        policyId: t.activePolicyId,
        actorUserId: t.adminUserId,
        idempotencyKeyHash: 'a'.repeat(64),
        hmacKeyVersion: 'v1',
        requestFingerprint: 'b'.repeat(64),
        requestContract: 'insurance_v1',
        providerKey: 'stedi',
        providerMode: 'sandbox',
        status: 'RECONCILIATION_REQUIRED',
        reconciliationReason: 'provider_outcome_ambiguous',
      },
    });
    const abandonedReady = await db.eligibilityExecution.create({
      data: {
        tenantId: t.id,
        branchId: t.branchId,
        patientId: t.patientId,
        policyId: t.inactivePolicyId,
        actorUserId: t.adminUserId,
        idempotencyKeyHash: 'c'.repeat(64),
        hmacKeyVersion: 'v1',
        requestFingerprint: 'd'.repeat(64),
        requestContract: 'insurance_v1',
        providerKey: 'stedi',
        providerMode: 'sandbox',
        status: 'READY',
        createdAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    const admin = auth(tok(t.id, t.adminUserId));
    const frontDeskUser = await db.user.create({ data: {
      tenantId: t.id, branchId: t.branchId, role: 'FRONT_DESK', active: true,
      email: `fd-${t.id.slice(0, 8)}@it.test`, displayName: 'Front Desk',
    } });
    const frontDesk = auth(tok(t.id, frontDeskUser.id));
    const unauthenticated = await app.inject({ method: 'GET', url: '/v1/insurance/eligibility/executions/reconciliation' });
    expect(unauthenticated.statusCode).toBe(401);
    const crossTenant = await app.inject({
      method: 'POST', url: `/v1/insurance/eligibility/executions/${execution.id}/reconcile`, headers: auth(tok(other.id, other.adminUserId)),
      payload: { resolution: 'confirmed_failed', expectedGeneration: 0, reason: 'Cross tenant attempt must not resolve' },
    });
    expect(crossTenant.statusCode).toBe(404);
    const list = await app.inject({ method: 'GET', url: '/v1/insurance/eligibility/executions/reconciliation', headers: admin });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: execution.id, status: 'RECONCILIATION_REQUIRED' })]));
    expect(list.json()).toEqual(expect.arrayContaining([expect.objectContaining({
      id: abandonedReady.id,
      status: 'READY',
      operatorState: 'stale_ready',
      providerCallMayHaveOccurred: false,
    })]));
    expect((await app.inject({ method: 'GET', url: '/v1/insurance/eligibility/executions/reconciliation?state=all', headers: frontDesk })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST', url: `/v1/insurance/eligibility/executions/${execution.id}/claim`, headers: frontDesk,
      payload: { expectedGeneration: 0 },
    })).statusCode).toBe(403);

    await runWithJobTenantContext(t.id, () => scanEligibilityReconciliationWork(t.id), 'worker:test-connected-care');
    const pending = await db.eligibilityExecution.findUniqueOrThrow({ where: { id: execution.id } });
    const fabricatedSuccess = await app.inject({
      method: 'POST', url: `/v1/insurance/eligibility/executions/${execution.id}/reconcile`, headers: admin,
      payload: { resolution: 'confirmed_succeeded', expectedGeneration: pending.reconciliationGeneration, reason: 'Staff cannot invent a provider result' },
    });
    expect(fabricatedSuccess.statusCode).toBe(400);

    const claim = await app.inject({
      method: 'POST', url: `/v1/insurance/eligibility/executions/${execution.id}/claim`, headers: admin,
      payload: { expectedGeneration: pending.reconciliationGeneration },
    });
    expect(claim.statusCode).toBe(200);

    const safeReset = await app.inject({
      method: 'POST', url: `/v1/insurance/eligibility/executions/${execution.id}/reconcile`, headers: admin,
      payload: { resolution: 'confirmed_not_submitted', expectedGeneration: pending.reconciliationGeneration, reason: 'Provider portal confirms it was not submitted' },
    });
    expect(safeReset.statusCode).toBe(200);
    expect(safeReset.json()).toMatchObject({ status: 'READY', providerCalled: false });
    expect(await db.eligibilityExecution.findUnique({ where: { id: execution.id } })).toMatchObject({ status: 'READY' });
    expect(await db.auditEvent.count({ where: { tenantId: t.id, action: 'eligibility.execution.reconciled', resourceId: execution.id } })).toBe(1);

    const pendingReady = await db.eligibilityExecution.findUniqueOrThrow({ where: { id: abandonedReady.id } });
    expect(pendingReady.status).toBe('MANUAL_EVIDENCE_PENDING');
    expect((await app.inject({
      method: 'POST', url: `/v1/insurance/eligibility/executions/${abandonedReady.id}/claim`, headers: admin,
      payload: { expectedGeneration: pendingReady.reconciliationGeneration - 1 },
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: 'POST', url: `/v1/insurance/eligibility/executions/${abandonedReady.id}/claim`, headers: admin,
      payload: { expectedGeneration: pendingReady.reconciliationGeneration },
    })).statusCode).toBe(200);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
    const manual = await app.inject({
      method: 'POST', url: `/v1/insurance/eligibility/executions/${abandonedReady.id}/reconcile`, headers: admin,
      payload: {
        resolution: 'confirmed_succeeded', expectedGeneration: pendingReady.reconciliationGeneration,
        reason: 'Verified in payer portal against exact member and service date',
        evidence: {
          outcome: 'ACTIVE', source: 'PAYER_PORTAL', reference: 'PORTAL-REF-1001', verifiedAt: new Date().toISOString(),
          effectiveFrom: tomorrow.toISOString(), expiresAt: null,
          attestation: { patientMatches: true, policyMatches: true, payerMatches: true, serviceAndDateMatch: true },
        },
      },
    });
    expect(manual.statusCode).toBe(200);
    expect(manual.json()).toMatchObject({ status: 'MANUALLY_RECONCILED', providerCalled: false });
    const verification = await db.eligibilityVerification.findUniqueOrThrow({ where: { id: manual.json().verificationId } });
    expect(verification).toMatchObject({ coverageStatus: 'NEEDS_REVIEW', coverageActive: false, copay: null, deductibleRemaining: null, coinsurance: null });
    expect(await db.patientInsurancePolicy.findUniqueOrThrow({ where: { id: t.inactivePolicyId } })).toMatchObject({ verificationStatus: 'needs_review' });
    expect(await db.patient.findUniqueOrThrow({ where: { id: t.patientId } })).toMatchObject({ eligibilityStatus: 'NEEDS_REVIEW' });
  });
});

describe('connected care — enrollment, webhook ingest, RPM readiness (integration)', () => {
  it('activates a signed sandbox provider through the management API before allowing enrollment', async () => {
    const t = await makeTenant('enterprise');
    const admin = tok(t.id, t.adminUserId);
    const webhookSecret = `whsec-${randomUUID()}`;

    const incomplete = await app.inject({
      method: 'POST', url: '/v1/devices/providers/withings/configure', headers: auth(admin),
      payload: { mode: 'sandbox', config: { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' } },
    });
    expect(incomplete.statusCode).toBe(400);
    expect(await db.deviceProvider.count({ where: { tenantId: t.id, providerKey: 'withings' } })).toBe(0);

    const configured = await app.inject({
      method: 'POST', url: '/v1/devices/providers/withings/configure', headers: auth(admin),
      payload: { mode: 'sandbox', config: { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', webhookSecret } },
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json()).toMatchObject({ providerKey: 'withings', status: 'SANDBOX', mode: 'sandbox', webhookConfigured: true });

    const providers = (await app.inject({ method: 'GET', url: '/v1/devices/providers', headers: auth(admin) })).json() as Array<Record<string, unknown>>;
    expect(providers.find(provider => provider.key === 'withings')).toMatchObject({ configured: true, webhookConfigured: true, status: 'SANDBOX' });
    expect(JSON.stringify(providers)).not.toContain(webhookSecret);

    const device = await app.inject({
      method: 'POST', url: '/v1/devices', headers: auth(admin),
      payload: {
        name: 'Synthetic Withings BP monitor', deviceType: 'vitals_monitor', connectionType: 'cloud_api',
        vendor: 'Withings', model: 'BPM Connect Sandbox', serialNumber: `SYN-${randomUUID()}`, branchId: t.branchId,
      },
    });
    expect(device.statusCode).toBe(201);

    const enrolled = await app.inject({
      method: 'POST', url: '/v1/connected-care/enrollments', headers: auth(admin),
      payload: { patientId: t.patientId, providerKey: 'withings', externalRef: 'SYNTHETIC-PATIENT-1', deviceId: device.json().id },
    });
    expect(enrolled.statusCode).toBe(201);
    expect(enrolled.json()).toMatchObject({ status: 'active' });
    expect(await db.patientDeviceEnrollment.findUnique({ where: { id: enrolled.json().id } })).toMatchObject({
      patientId: t.patientId, providerKey: 'withings', deviceId: device.json().id, status: 'active',
    });

    const stored = await db.deviceProvider.findUniqueOrThrow({ where: { tenantId_providerKey: { tenantId: t.id, providerKey: 'withings' } } });
    expect(stored.webhookConfigured).toBe(true);
    expect(stored.encryptedConfig).not.toContain(webhookSecret);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, action: 'device.provider.configured', resourceId: stored.id } })).toBe(1);
  });

  it('enrolls a patient, ingests a correctly-signed webhook reading, and creates a backend-decided alert', async () => {
    const t = await makeTenant('enterprise');
    const admin = tok(t.id, t.adminUserId);
    const SECRET = `whsec-${randomUUID()}`;
    await configureDeviceProviderSecret(t.id, 'withings', SECRET);

    const device = await db.device.create({ data: { tenantId: t.id, branchId: t.branchId, name: 'Linked Withings device', deviceType: 'scale', active: true, status: 'online' } });
    const enroll = await app.inject({ method: 'POST', url: '/v1/connected-care/enrollments', headers: auth(admin), payload: { patientId: t.patientId, providerKey: 'withings', externalRef: 'EXT-IT-1', deviceId: device.id } });
    expect(enroll.statusCode).toBe(201);

    const { raw, sig } = signWebhook(SECRET, { readings: [{ patientExternalRef: 'EXT-IT-1', readingType: 'glucose', value: '330', numericValue: 330, unit: 'mg/dL' }] });
    const hook = await app.inject({ method: 'POST', url: `/v1/connected-care/${t.id}/providers/withings/webhook`, headers: { 'content-type': 'application/json', 'x-cc-signature': sig }, payload: raw });
    expect(hook.statusCode).toBe(200);
    const hb = JSON.parse(hook.body);
    expect(hb.ingested).toBe(1);
    expect(hb.alertsCreated).toBe(1); // 330 mg/dL → critical, decided server-side

    const logs = JSON.parse((await app.inject({ method: 'GET', url: '/v1/connected-care/sync-logs', headers: auth(admin) })).body);
    expect(logs[0].readingsIngested).toBe(1);
    const stored = await db.deviceReading.findFirstOrThrow({ where: { tenantId: t.id, patientId: t.patientId } });
    expect(stored).toMatchObject({ deviceId: device.id, source: 'webhook', sourceProviderKey: 'withings', sourceEnrollmentId: enroll.json().id });
    const evidence = await inTenant(t, () => db.$transaction(tx => buildRpmEvidenceSnapshot(tx, t.id, t.patientId, rpmPeriodBounds())));
    expect(evidence).toMatchObject({ readingDays: 1, qualifyingReadingCount: 1, excludedReadingCount: 0, deviceExceptions: [] });
  });

  it('counts only device-bound automated evidence: 16 manual/unlinked days count as zero and 15 linked plus one manual count as 15', async () => {
    const makeEnrollment = async (t: TenantFixture) => {
      const device = await db.device.create({ data: { tenantId: t.id, branchId: t.branchId, name: 'Evidence device', deviceType: 'scale', active: true, status: 'online' } });
      const enrollment = await db.patientDeviceEnrollment.create({ data: { tenantId: t.id, patientId: t.patientId, branchId: t.branchId, providerKey: 'withings', deviceId: device.id, programType: 'rpm', status: 'active', enrolledAt: rpmPeriodBounds().start } });
      return { device, enrollment };
    };
    const asOf = new Date();

    const unlinkedTenant = await makeTenant('enterprise');
    await makeEnrollment(unlinkedTenant);
    await db.deviceReading.createMany({ data: Array.from({ length: 16 }, (_, day) => ({
      tenantId: unlinkedTenant.id, patientId: unlinkedTenant.patientId, branchId: unlinkedTenant.branchId,
      readingType: 'weight', value: '80', numericValue: 80, unit: 'kg',
      capturedAt: new Date(asOf.getTime() - day * 24 * 60 * 60_000), source: day % 2 ? 'manual' : 'import', validationStatus: 'valid',
    })) });
    const unlinked = await inTenant(unlinkedTenant, () => db.$transaction(tx => buildRpmEvidenceSnapshot(tx, unlinkedTenant.id, unlinkedTenant.patientId, rpmPeriodBounds())));
    expect(unlinked).toMatchObject({ readingDays: 0, qualifyingReadingCount: 0, excludedReadingCount: 16 });
    expect(unlinked.deviceExceptions).toEqual([{ reason: 'not_automated_provider_ingest', count: 16 }]);

    const mixedTenant = await makeTenant('enterprise');
    const { device, enrollment } = await makeEnrollment(mixedTenant);
    await db.deviceReading.createMany({ data: Array.from({ length: 16 }, (_, day) => ({
      tenantId: mixedTenant.id, patientId: mixedTenant.patientId, branchId: mixedTenant.branchId,
      deviceId: day < 15 ? device.id : null, readingType: 'weight', value: '80', numericValue: 80, unit: 'kg',
      capturedAt: new Date(asOf.getTime() - day * 24 * 60 * 60_000), source: day < 15 ? 'webhook' : 'manual', validationStatus: 'valid',
      dedupeKey: day < 15 ? `linked-${randomUUID()}` : null,
      sourceProviderKey: day < 15 ? 'withings' : null,
      sourceEnrollmentId: day < 15 ? enrollment.id : null,
    })) });
    const mixed = await inTenant(mixedTenant, () => db.$transaction(tx => buildRpmEvidenceSnapshot(tx, mixedTenant.id, mixedTenant.patientId, rpmPeriodBounds())));
    expect(mixed).toMatchObject({ readingDays: 15, qualifyingReadingCount: 15, excludedReadingCount: 1 });
    expect(mixed.deviceExceptions).toEqual([{ reason: 'not_automated_provider_ingest', count: 1 }]);
  });

  it('excludes provider/device mismatches, future timestamps, and readings outside the enrollment term without exposing row data', async () => {
    const t = await makeTenant('enterprise');
    const period = rpmPeriodBounds();
    const day = (offset: number) => new Date(period.start.getTime() + offset * 24 * 60 * 60_000);
    const device = await db.device.create({ data: { tenantId: t.id, branchId: t.branchId, name: 'Bound device', deviceType: 'scale', active: true, status: 'online' } });
    const otherDevice = await db.device.create({ data: { tenantId: t.id, branchId: t.branchId, name: 'Other device', deviceType: 'scale', active: true, status: 'online' } });
    const enrollment = await db.patientDeviceEnrollment.create({ data: { tenantId: t.id, patientId: t.patientId, branchId: t.branchId, providerKey: 'withings', deviceId: device.id, programType: 'rpm', status: 'active', enrolledAt: day(5) } });
    // PostgreSQL's now() is not controlled by Vitest's fake JS clock. Pin the
    // receipt time before the custom day-15 cutoff so all four rows are
    // deterministically selected and then rejected by provenance classification.
    const base = { tenantId: t.id, patientId: t.patientId, branchId: t.branchId, readingType: 'weight', value: '80', numericValue: 80, unit: 'kg', source: 'webhook', validationStatus: 'valid', sourceEnrollmentId: enrollment.id, receivedAt: period.start };
    await db.deviceReading.createMany({ data: [
      { ...base, deviceId: device.id, capturedAt: day(10), dedupeKey: `mismatch-${randomUUID()}`, sourceProviderKey: 'validic' },
      { ...base, deviceId: device.id, capturedAt: day(20), dedupeKey: `future-${randomUUID()}`, sourceProviderKey: 'withings' },
      { ...base, deviceId: device.id, capturedAt: day(2), dedupeKey: `outside-${randomUUID()}`, sourceProviderKey: 'withings' },
      { ...base, deviceId: otherDevice.id, capturedAt: day(11), dedupeKey: `device-${randomUUID()}`, sourceProviderKey: 'withings' },
    ] });
    const snapshot = await inTenant(t, () => db.$transaction(tx => buildRpmEvidenceSnapshot(tx, t.id, t.patientId, { ...period, asOf: day(15) })));
    expect(snapshot).toMatchObject({ readingDays: 0, qualifyingReadingCount: 0, excludedReadingCount: 4 });
    expect(snapshot.deviceExceptions).toEqual([
      { reason: 'device_link_mismatch', count: 1 },
      { reason: 'future_captured_at', count: 1 },
      { reason: 'outside_enrollment_term', count: 1 },
      { reason: 'provider_link_mismatch', count: 1 },
    ]);
    expect(Object.keys(snapshot.deviceExceptions[0]!).sort()).toEqual(['count', 'reason']);
  });

  it('FAILS CLOSED: rejects an unsigned / unverifiable webhook (P0) and writes no readings; a correctly-signed one still ingests', async () => {
    const t = await makeTenant('enterprise');
    await db.patientDeviceEnrollment.create({ data: { tenantId: t.id, branchId: t.branchId, patientId: t.patientId, providerKey: 'withings', programType: 'general', externalRef: 'EXT-CLOSED-1', status: 'active' } });

    const attackPayload = { readings: [{ patientExternalRef: 'EXT-CLOSED-1', readingType: 'glucose', value: '330', numericValue: 330, unit: 'mg/dL' }] };

    // (a) No provider secret configured at all → unverifiable → REJECT. This is
    // the exact P0: an unauthenticated caller trusting only the URL tenantId.
    const noSecret = await app.inject({ method: 'POST', url: `/v1/connected-care/${t.id}/providers/withings/webhook`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(attackPayload) });
    expect(noSecret.statusCode).toBe(401);

    // Now configure a secret; an unsigned/wrong-signature request must still reject.
    const SECRET = `whsec-${randomUUID()}`;
    await configureDeviceProviderSecret(t.id, 'withings', SECRET);

    // (b) Secret configured but NO signature header → REJECT.
    const unsigned = await app.inject({ method: 'POST', url: `/v1/connected-care/${t.id}/providers/withings/webhook`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(attackPayload) });
    expect(unsigned.statusCode).toBe(401);

    // (c) Secret configured but WRONG signature → REJECT.
    const wrong = await app.inject({ method: 'POST', url: `/v1/connected-care/${t.id}/providers/withings/webhook`, headers: { 'content-type': 'application/json', 'x-cc-signature': 'deadbeef' }, payload: JSON.stringify(attackPayload) });
    expect(wrong.statusCode).toBe(401);

    // After every rejected attempt: NOT ONE reading or alert was written for this tenant.
    expect(await db.deviceReading.count({ where: { tenantId: t.id } })).toBe(0);
    expect(await db.readingAlert.count({ where: { tenantId: t.id } })).toBe(0);

    // (d) A correctly-signed request from the configured provider STILL ingests + alerts.
    const { raw, sig } = signWebhook(SECRET, attackPayload);
    const ok = await app.inject({ method: 'POST', url: `/v1/connected-care/${t.id}/providers/withings/webhook`, headers: { 'content-type': 'application/json', 'x-cc-signature': sig }, payload: raw });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).ingested).toBe(1);
    expect(await db.deviceReading.count({ where: { tenantId: t.id } })).toBe(1);
    expect(await db.readingAlert.count({ where: { tenantId: t.id } })).toBe(1);
  });

  it('DEDUP (P1 billing integrity): an identical redelivered webhook reading collapses to one row + one alert', async () => {
    const t = await makeTenant('enterprise');
    const admin = tok(t.id, t.adminUserId);
    const SECRET = `whsec-${randomUUID()}`;
    await configureDeviceProviderSecret(t.id, 'withings', SECRET);
    await app.inject({ method: 'POST', url: '/v1/connected-care/enrollments', headers: auth(admin), payload: { patientId: t.patientId, providerKey: 'withings', programType: 'general', externalRef: 'EXT-DEDUP-1' } });

    // Same measurement (same captured timestamp/value) delivered twice.
    const payload = { readings: [{ patientExternalRef: 'EXT-DEDUP-1', readingType: 'glucose', value: '330', numericValue: 330, unit: 'mg/dL', capturedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() }] };
    const { raw, sig } = signWebhook(SECRET, payload);
    const url = `/v1/connected-care/${t.id}/providers/withings/webhook`;

    const first = await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-cc-signature': sig }, payload: raw });
    expect(JSON.parse(first.body).ingested).toBe(1);
    const second = await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', 'x-cc-signature': sig }, payload: raw });
    const sb = JSON.parse(second.body);
    expect(sb.ingested).toBe(0);       // redelivery ingests nothing
    expect(sb.duplicates).toBe(1);
    expect(sb.alertsCreated).toBe(0);  // no duplicate alert

    // Exactly one reading + one alert for this tenant → device-days not inflated.
    expect(await db.deviceReading.count({ where: { tenantId: t.id } })).toBe(1);
    expect(await db.readingAlert.count({ where: { tenantId: t.id } })).toBe(1);
  });

  it('computes RPM readiness with consent + signoff and exposes the requirement checklist', async () => {
    const t = await makeTenant('enterprise');
    const admin = tok(t.id, t.adminUserId);
    await app.inject({ method: 'POST', url: '/v1/connected-care/enrollments', headers: auth(admin), payload: { patientId: t.patientId, providerKey: 'manual' } });
    await app.inject({ method: 'POST', url: '/v1/connected-care/consent', headers: auth(admin), payload: { patientId: t.patientId, consentType: 'rpm', granted: true } });

    const readiness = JSON.parse((await app.inject({ method: 'GET', url: '/v1/connected-care/rpm-readiness', headers: auth(admin) })).body).items;
    expect(readiness.length).toBe(1);
    // Fresh patient has no device-days yet → not billable, requirement listed.
    expect(readiness[0].status).toBe('MISSING_REQUIREMENTS');
    expect(readiness[0].requirements.some((r: { key: string; met: boolean }) => r.key === 'reading_days' && !r.met)).toBe(true);

    // Fail closed: an under-qualified record cannot capture provider signoff.
    const signed = await signoffRpm(t.patientId, auth(tok(t.id, t.providerUserId)));
    expect(signed.statusCode).toBe(409);
    expect(signed.json().message).toContain('complete current evidence');
    const stored = await db.rPMBillingReadiness.findFirstOrThrow({ where: { tenantId: t.id, patientId: t.patientId } });
    expect(stored.providerSignoffAt).toBeNull();
    expect(stored.providerSignoffEvidenceHash).toBeNull();
    expect(await db.auditEvent.count({ where: { tenantId: t.id, action: 'connectedcare.rpm.signoff', resourceId: t.patientId } })).toBe(0);
  });

  it('binds provider signoff to current evidence, invalidates it after evidence mutation, and requires re-signoff', async () => {
    const t = await makeTenant('enterprise');
    const { admin, firstReviewStartedAt } = await prepareCompleteRpmEvidence(t);
    const provider = auth(tok(t.id, t.providerUserId));

    const reviewedEvidence = await rpmReadinessRow(t.patientId, provider);
    const staleAttestation = await signoffRpm(t.patientId, provider, { attestationRevision: 'rpm-provider-attestation-v0' });
    expect(staleAttestation.statusCode).toBe(409);
    expect(staleAttestation.json().message).toContain('attestation revision is stale');
    const signed = await signoffRpm(t.patientId, provider);
    expect(signed.statusCode).toBe(200);
    expect(signed.json().status).toBe('READY');
    const firstSnapshot = await db.rPMBillingReadiness.findFirstOrThrow({ where: { tenantId: t.id, patientId: t.patientId } });
    expect(firstSnapshot.providerSignoffUserId).toBe(t.providerUserId);
    expect(firstSnapshot.providerSignoffEvidenceVersion).toBe('rpm-readiness-evidence-v5');
    expect(firstSnapshot.providerSignoffAttestationRevision).toBe('rpm-provider-attestation-v1');
    expect(firstSnapshot.providerSignoffEvidenceHash).toMatch(/^[a-f0-9]{64}$/);

    const mutationEndedAt = firstReviewStartedAt;
    const mutationStartedAt = new Date(mutationEndedAt.getTime() - 60_000);
    const mutation = await app.inject({
      method: 'PATCH',
      url: `/v1/connected-care/rpm-readiness/${t.patientId}/review`,
      headers: admin,
      payload: {
        reviewEventId: randomUUID(),
        sourceRef: `ehr-${randomUUID()}`,
        provenance: 'EHR_TIMER',
        startedAt: mutationStartedAt,
        endedAt: mutationEndedAt,
        activityNarrative: 'Reviewed BP trend, confirmed medication adherence, advised on cuff placement.',
      communicationModality: 'live_phone',
      },
    });
    expect(mutation.statusCode).toBe(200);
    expect(mutation.json().status).toBe('NEEDS_REVIEW');
    const invalidated = await db.rPMBillingReadiness.findFirstOrThrow({ where: { tenantId: t.id, patientId: t.patientId } });
    expect(invalidated.providerSignoffUserId).toBeNull();
    expect(invalidated.providerSignoffAt).toBeNull();
    expect(invalidated.providerSignoffEvidenceVersion).toBeNull();
    expect(invalidated.providerSignoffEvidenceHash).toBeNull();
    const invalidationAudit = await db.auditEvent.findFirstOrThrow({ where: { tenantId: t.id, action: 'connectedcare.rpm.signoff_invalidated', resourceId: t.patientId }, orderBy: { occurredAt: 'desc' } });
    expect(invalidationAudit.metadata).toMatchObject({ reason: 'review_evidence_mutated', priorEvidenceHash: firstSnapshot.providerSignoffEvidenceHash });

    const staleHash = await signoffRpm(t.patientId, provider, { expectedEvidenceHash: reviewedEvidence.evidenceHash });
    expect(staleHash.statusCode).toBe(409);
    expect(staleHash.json().message).toContain('evidence changed after review');
    const currentEvidence = await inTenant(t, () => db.$transaction(tx => buildRpmEvidenceSnapshot(tx, t.id, t.patientId, rpmPeriodBounds())));
    await db.rPMBillingReadiness.update({
      where: { tenantId_patientId_periodStart: { tenantId: t.id, patientId: t.patientId, periodStart: rpmPeriodBounds().start } },
      data: { reviewMinutes: 999, communicationFlag: false },
    });
    const reSigned = await app.inject({
      method: 'POST', url: `/v1/connected-care/rpm-readiness/${t.patientId}/signoff`, headers: provider,
      payload: { expectedEvidenceVersion: currentEvidence.version, expectedEvidenceHash: currentEvidence.hash, attestationRevision: 'rpm-provider-attestation-v1' },
    });
    expect(reSigned.statusCode).toBe(200);
    expect(reSigned.json().status).toBe('READY');
    const renewed = await db.rPMBillingReadiness.findFirstOrThrow({ where: { tenantId: t.id, patientId: t.patientId } });
    expect(renewed.providerSignoffEvidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(renewed.providerSignoffEvidenceHash).not.toBe(firstSnapshot.providerSignoffEvidenceHash);
    expect(renewed.reviewMinutes).toBe(currentEvidence.reviewMinutes);
    expect(renewed.communicationFlag).toBe(currentEvidence.communicationFlag);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, action: 'connectedcare.rpm.signoff', resourceId: t.patientId } })).toBe(2);
  });

  it('ignores forged readiness aggregates and makes AI/monitoring consumers recompute current evidence', async () => {
    const t = await makeTenant('enterprise');
    const { admin } = await prepareRpmBaseEvidence(t);
    const period = rpmPeriodBounds();
    await inTenant(t, () => computeAndStoreRpmReadiness(t.id, t.patientId));
    await db.rPMBillingReadiness.update({
      where: { tenantId_patientId_periodStart: { tenantId: t.id, patientId: t.patientId, periodStart: period.start } },
      data: { reviewMinutes: 999, communicationFlag: true, status: 'READY' },
    });

    const refused = await signoffRpm(t.patientId, auth(tok(t.id, t.providerUserId)));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toContain('20 clinical review minutes');
    expect(refused.json().message).toContain('Patient communication');

    const snapshot = await inTenant(t, () => aiContextBuilder.buildOperationalSnapshot(t.id));
    expect(snapshot.metrics.find(metric => metric.metric === 'rpm_billing_ready')?.value).toBe(0);
    const briefing = await app.inject({ method: 'GET', url: '/v1/monitoring/morning-briefing', headers: admin });
    expect(briefing.statusCode).toBe(200);
    expect(briefing.json().counts.rpmBillingReady).toBe(0);
    const corrected = await db.rPMBillingReadiness.findUniqueOrThrow({ where: { tenantId_patientId_periodStart: { tenantId: t.id, patientId: t.patientId, periodStart: period.start } } });
    expect(corrected).toMatchObject({ reviewMinutes: 0, communicationFlag: false, status: 'MISSING_REQUIREMENTS' });
  });

  it('keeps evidence stable within a UTC billing month and rolls over without consuming historical READY rows', async () => {
    const t = await makeTenant('enterprise');
    await prepareCompleteRpmEvidence(t);
    const provider = auth(tok(t.id, t.providerUserId));
    expect((await signoffRpm(t.patientId, provider)).json().status).toBe('READY');
    const asOf = new Date();
    const currentPeriod = rpmPeriodBounds(asOf);
    const initial = await inTenant(t, () => computeAndStoreRpmReadiness(t.id, t.patientId, asOf));
    const laterThisMonth = new Date(Math.min(currentPeriod.end.getTime() - 1, asOf.getTime() + 24 * 60 * 60_000));
    const samePeriod = await inTenant(t, () => computeAndStoreRpmReadiness(t.id, t.patientId, laterThisMonth));
    expect(samePeriod.period.start.toISOString()).toBe(currentPeriod.start.toISOString());
    expect(samePeriod.result.status).toBe('READY');
    expect(samePeriod.evidence.hash).toBe(initial.evidence.hash);
    expect(samePeriod.evidence.reviewMinutes).toBe(20);
    expect(samePeriod.evidence.communicationFlag).toBe(true);

    const nextMonth = new Date(currentPeriod.end.getTime() + 60_000);
    const rolled = await inTenant(t, () => computeAndStoreRpmReadiness(t.id, t.patientId, nextMonth));
    expect(rolled.period.start.toISOString()).toBe(currentPeriod.end.toISOString());
    expect(rolled.result.status).toBe('MISSING_REQUIREMENTS');
    expect(rolled.evidence.reviewMinutes).toBe(0);
    expect(rolled.evidence.communicationFlag).toBe(false);
    expect(await inTenant(t, () => countCurrentReadyRpmPatients(t.id, null, nextMonth))).toBe(0);

    const historical = await db.rPMBillingReadiness.findUniqueOrThrow({ where: { tenantId_patientId_periodStart: { tenantId: t.id, patientId: t.patientId, periodStart: currentPeriod.start } } });
    const current = await db.rPMBillingReadiness.findUniqueOrThrow({ where: { tenantId_patientId_periodStart: { tenantId: t.id, patientId: t.patientId, periodStart: rolled.period.start } } });
    expect(historical.status).toBe('READY');
    expect(current.status).toBe('MISSING_REQUIREMENTS');
  });

  it('invalidates READY atomically when the offline detector mutates an enrolled device and remains race-safe with signoff', async () => {
    const t = await makeTenant('enterprise');
    const now = new Date();
    const device = await db.device.create({ data: { tenantId: t.id, branchId: t.branchId, name: 'RPM Monitor', deviceType: 'vitals_monitor', status: 'online', active: true, lastSeenAt: new Date(now.getTime() - 48 * 60 * 60_000) } });
    const { admin } = await prepareCompleteRpmEvidence(t, device.id, new Date(now.getTime() - 48 * 60 * 60_000));
    const provider = auth(tok(t.id, t.providerUserId));
    expect((await signoffRpm(t.patientId, provider)).json().status).toBe('READY');

    // Fixture setup performs enrollment and evidence writes after device
    // creation. Reassert the exact detector precondition immediately before
    // scanning instead of depending on timestamps from earlier setup steps.
    await inTenant(t, () => db.device.update({
      where: { id: device.id },
      data: { status: 'online', active: true, lastSeenAt: new Date(now.getTime() - 48 * 60 * 60_000) },
    }));
    const detected = await detectOfflineDevices(t.id, 24, now);
    expect(detected.flipped).toBe(1);
    const period = rpmPeriodBounds(now);
    const invalidated = await db.rPMBillingReadiness.findUniqueOrThrow({ where: { tenantId_patientId_periodStart: { tenantId: t.id, patientId: t.patientId, periodStart: period.start } } });
    expect(invalidated).toMatchObject({ status: 'NEEDS_REVIEW', providerSignoffAt: null, providerSignoffEvidenceHash: null });
    expect(await db.auditEvent.count({ where: { tenantId: t.id, action: 'connectedcare.rpm.signoff_invalidated', resourceId: t.patientId, metadata: { path: ['reason'], equals: 'offline_detector_device_status_mutated' } } })).toBe(1);

    expect((await signoffRpm(t.patientId, provider)).json().status).toBe('READY');
    // A device coming back is OBSERVED, never asserted. `online` is no longer a
    // human-settable status — staff previously picked it from a dropdown and the
    // backend stamped lastSeenAt, manufacturing the very telemetry the staleness
    // check relies on. Recovery is expressed as fresh activity, as ingest does.
    const humanClaimsOnline = await app.inject({ method: 'PATCH', url: `/v1/devices/${device.id}`, headers: admin, payload: { status: 'online' } });
    expect(humanClaimsOnline.statusCode).toBe(400);
    await inTenant(t, () => db.device.update({
      where: { id: device.id },
      data: { status: 'online', lastSeenAt: now },
    }));
    expect((await signoffRpm(t.patientId, provider)).json().status).toBe('READY');
    // The suite clock is month-end, so advancing 25 hours would test a
    // different billing period. Make the owner-controlled fixture stale in
    // place, preserving the intended same-period detector/signoff lock race.
    await inTenant(t, () => db.device.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date(now.getTime() - 48 * 60 * 60_000) },
    }));
    const [raceDetection, raceSignoff] = await Promise.all([
      detectOfflineDevices(t.id, 24, now),
      signoffRpm(t.patientId, provider),
    ]);
    expect(raceDetection.flipped).toBe(1);
    // Both lock orderings are safe. A signoff that acquires the evidence lock
    // first may succeed and is then either retained or invalidated by the
    // detector. A signoff whose preview was read before the detector mutation
    // but whose write acquires the lock afterward must fail closed with an
    // optimistic-concurrency conflict rather than signing changed evidence.
    expect([200, 409]).toContain(raceSignoff.statusCode);
    if (raceSignoff.statusCode === 409) {
      expect(raceSignoff.json().message).toContain('RPM evidence changed after review');
    }
    const finalRow = await db.rPMBillingReadiness.findUniqueOrThrow({ where: { tenantId_patientId_periodStart: { tenantId: t.id, patientId: t.patientId, periodStart: period.start } } });
    const finalEvidence = await inTenant(t, () => db.$transaction(tx => buildRpmEvidenceSnapshot(tx, t.id, t.patientId, rpmPeriodBounds())));
    if (raceSignoff.statusCode === 409) {
      expect(finalRow).toMatchObject({
        status: 'NEEDS_REVIEW',
        providerSignoffAt: null,
        providerSignoffEvidenceHash: null,
      });
    } else if (finalRow.providerSignoffAt) {
      expect(finalRow.status).toBe('READY');
      expect(finalRow.providerSignoffEvidenceHash).toBe(finalEvidence.hash);
    } else {
      expect(finalRow.status).toBe('NEEDS_REVIEW');
    }
  });

  it('invalidates the historical billing period containing a late backdated reading', async () => {
    const t = await makeTenant('enterprise');
    const { admin } = await prepareRpmBaseEvidence(t);
    const currentPeriod = rpmPeriodBounds();
    const priorAsOf = new Date(currentPeriod.start.getTime() - 60_000);
    const priorPeriod = rpmPeriodBounds(priorAsOf);
    await db.rPMBillingReadiness.create({ data: {
      tenantId: t.id, patientId: t.patientId,
      periodStart: priorPeriod.start, periodEnd: priorPeriod.end,
      status: 'READY', providerSignoffUserId: t.providerUserId,
      providerSignoffAt: priorAsOf,
      providerSignoffEvidenceVersion: 'rpm-readiness-evidence-v2',
      providerSignoffEvidenceHash: 'a'.repeat(64),
    } });
    const lateReading = await app.inject({
      method: 'POST', url: '/v1/monitoring/readings/ingest', headers: admin,
      payload: { patientId: t.patientId, readingType: 'weight', value: '81', numericValue: 81, unit: 'kg', capturedAt: new Date(priorPeriod.end.getTime() - 24 * 60 * 60_000), source: 'manual' },
    });
    expect(lateReading.statusCode).toBe(201);
    const historical = await db.rPMBillingReadiness.findUniqueOrThrow({ where: { tenantId_patientId_periodStart: { tenantId: t.id, patientId: t.patientId, periodStart: priorPeriod.start } } });
    expect(historical).toMatchObject({ status: 'NEEDS_REVIEW', providerSignoffAt: null, providerSignoffEvidenceHash: null });
    expect(await db.auditEvent.count({ where: { tenantId: t.id, action: 'connectedcare.rpm.signoff_invalidated', resourceId: t.patientId, metadata: { path: ['reason'], equals: 'device_reading_evidence_mutated' } } })).toBeGreaterThan(0);
  });

  it('enforces branch scope for enrollment mutations, consent, review evidence, and readiness', async () => {
    const t = await makeTenant('enterprise');
    const otherBranch = await db.branch.create({ data: { tenantId: t.id, name: 'other', location: 'y' } });
    const manager = await db.user.create({ data: { tenantId: t.id, branchId: otherBranch.id, role: 'MANAGER', active: true, email: `m-${randomUUID()}@it.test`, displayName: 'Other manager' } });
    const restricted = auth(tok(t.id, manager.id));
    const enrollment = await db.patientDeviceEnrollment.create({ data: { tenantId: t.id, patientId: t.patientId, branchId: t.branchId, providerKey: 'manual', programType: 'rpm', status: 'active' } });

    expect((await app.inject({ method: 'PATCH', url: `/v1/connected-care/enrollments/${enrollment.id}`, headers: restricted, payload: { status: 'paused' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/v1/connected-care/consent?patientId=${t.patientId}`, headers: restricted })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/v1/connected-care/consent', headers: restricted, payload: { patientId: t.patientId, granted: true, method: 'verbal' } })).statusCode).toBe(403);
    const endedAt = new Date();
    const startedAt = new Date(endedAt.getTime() - 10 * 60_000);
    expect((await app.inject({ method: 'PATCH', url: `/v1/connected-care/rpm-readiness/${t.patientId}/review`, headers: restricted, payload: { reviewEventId: randomUUID(), sourceRef: `ehr-${randomUUID()}`, provenance: 'EHR_TIMER', startedAt, endedAt, activityNarrative: 'Reviewed readings for the branch-scope probe.', communicationModality: 'live_phone' } })).statusCode).toBe(403);
    const readiness = await app.inject({ method: 'GET', url: '/v1/connected-care/rpm-readiness', headers: restricted });
    expect(readiness.statusCode).toBe(200);
    // Paged envelope: a branch-restricted user sees no rows from other branches.
    expect(JSON.parse(readiness.body)).toMatchObject({ items: [], total: 0 });
  });

  it('refuses active provider enrollments that cannot ingest or bind RPM evidence', async () => {
    const t = await makeTenant('enterprise');
    const admin = auth(tok(t.id, t.adminUserId));

    const unconfigured = await app.inject({
      method: 'POST', url: '/v1/connected-care/enrollments', headers: admin,
      payload: { patientId: t.patientId, providerKey: 'withings', programType: 'general' },
    });
    expect(unconfigured.statusCode).toBe(409);
    expect(unconfigured.json().message).toContain('Configure and verify');

    await configureDeviceProviderSecret(t.id, 'withings', `whsec-${randomUUID()}`);
    const noDevice = await app.inject({
      method: 'POST', url: '/v1/connected-care/enrollments', headers: admin,
      payload: { patientId: t.patientId, providerKey: 'withings', programType: 'rpm' },
    });
    expect(noDevice.statusCode).toBe(400);
    expect(noDevice.json().message).toContain('specific device');
    expect(await db.patientDeviceEnrollment.count({ where: { tenantId: t.id } })).toBe(0);
  });

  it('validates enrolled devices and prevents ambiguous provider patient references', async () => {
    const t = await makeTenant('enterprise');
    const admin = auth(tok(t.id, t.adminUserId));
    const otherPatient = await db.patient.create({ data: { tenantId: t.id, branchId: t.branchId, firstName: 'Other', lastName: 'Patient', lifecycleStage: 'NEW' } });
    const foreign = await makeTenant('enterprise');
    await configureDeviceProviderSecret(t.id, 'withings', `whsec-${randomUUID()}`);
    const foreignDevice = await db.device.create({ data: { tenantId: foreign.id, branchId: foreign.branchId, name: 'foreign', deviceType: 'wearable_gateway', active: true } });
    const badDevice = await app.inject({ method: 'POST', url: '/v1/connected-care/enrollments', headers: admin, payload: { patientId: t.patientId, providerKey: 'withings', deviceId: foreignDevice.id } });
    expect(badDevice.statusCode).toBe(400);
    const first = await app.inject({ method: 'POST', url: '/v1/connected-care/enrollments', headers: admin, payload: { patientId: t.patientId, providerKey: 'withings', programType: 'general', externalRef: 'provider-patient-1' } });
    expect(first.statusCode).toBe(201);
    const collision = await app.inject({ method: 'POST', url: '/v1/connected-care/enrollments', headers: admin, payload: { patientId: otherPatient.id, providerKey: 'withings', programType: 'general', externalRef: 'provider-patient-1' } });
    expect(collision.statusCode).toBe(409);
  });

  it('records immutable consent versions and revocation prevents readiness consent from remaining met', async () => {
    const t = await makeTenant('enterprise');
    const admin = auth(tok(t.id, t.adminUserId));
    await app.inject({ method: 'POST', url: '/v1/connected-care/enrollments', headers: admin, payload: { patientId: t.patientId, providerKey: 'manual' } });
    const granted = await app.inject({ method: 'POST', url: '/v1/connected-care/consent', headers: admin, payload: { patientId: t.patientId, consentType: 'rpm', granted: true, method: 'written' } });
    const revoked = await app.inject({ method: 'POST', url: '/v1/connected-care/consent', headers: admin, payload: { patientId: t.patientId, consentType: 'rpm', granted: false, method: 'written' } });
    expect(granted.statusCode).toBe(201);
    expect(revoked.statusCode).toBe(201);
    expect(granted.json().evidenceVersion).not.toBe(revoked.json().evidenceVersion);
    const versions = await db.auditEvent.findMany({ where: { tenantId: t.id, action: 'connectedcare.consent.version_created', resourceId: t.patientId }, orderBy: { occurredAt: 'asc' } });
    expect(versions).toHaveLength(2);
    // The Date-only suite clock deliberately gives both evidence snapshots the
    // same application timestamp. UUID tie ordering is not consent semantics;
    // prove that both immutable decisions exist and that current state is the
    // revocation below.
    expect(versions.map(v => (v.metadata as { granted: boolean }).granted)).toEqual(expect.arrayContaining([true, false]));
    const readiness = ((await app.inject({ method: 'GET', url: '/v1/connected-care/rpm-readiness', headers: admin })).json() as { items: Array<{ requirements: Array<{ key: string; met: boolean }> }> }).items;
    expect(readiness[0]?.requirements.find(r => r.key === 'consent')?.met).toBe(false);
  });

  it('makes RPM review evidence idempotent and rejects duplicate-source or overlapping time inflation', async () => {
    const t = await makeTenant('enterprise');
    const admin = auth(tok(t.id, t.adminUserId));
    await app.inject({ method: 'POST', url: '/v1/connected-care/enrollments', headers: admin, payload: { patientId: t.patientId, providerKey: 'manual' } });
    const endedAt = new Date();
    const startedAt = new Date(endedAt.getTime() - 10 * 60_000);
    const payload = { reviewEventId: randomUUID(), sourceRef: `ehr-${randomUUID()}`, provenance: 'EHR_TIMER', startedAt, endedAt, activityNarrative: 'Reviewed glucose trend and counselled the patient by phone.', communicationModality: 'live_phone' };
    const concurrent = await Promise.all([
      app.inject({ method: 'PATCH', url: `/v1/connected-care/rpm-readiness/${t.patientId}/review`, headers: admin, payload }),
      app.inject({ method: 'PATCH', url: `/v1/connected-care/rpm-readiness/${t.patientId}/review`, headers: admin, payload }),
    ]);
    expect(concurrent.map(response => response.statusCode)).toEqual([200, 200]);
    expect(concurrent.map(response => response.json().recorded).sort()).toEqual([false, true]);
    expect(concurrent.map(response => response.json().reviewMinutes).sort((a, b) => a - b)).toEqual([0, 10]);
    expect((await db.rPMBillingReadiness.findFirstOrThrow({ where: { tenantId: t.id, patientId: t.patientId } })).reviewMinutes).toBe(10);

    const duplicateSource = await app.inject({ method: 'PATCH', url: `/v1/connected-care/rpm-readiness/${t.patientId}/review`, headers: admin, payload: { ...payload, reviewEventId: randomUUID(), startedAt: new Date(startedAt.getTime() - 20 * 60_000), endedAt: new Date(startedAt.getTime() - 10 * 60_000) } });
    expect(duplicateSource.statusCode).toBe(409);
    const overlap = await app.inject({ method: 'PATCH', url: `/v1/connected-care/rpm-readiness/${t.patientId}/review`, headers: admin, payload: { ...payload, reviewEventId: randomUUID(), sourceRef: `ehr-${randomUUID()}`, startedAt: new Date(startedAt.getTime() + 60_000), endedAt: new Date(endedAt.getTime() + 60_000) } });
    expect(overlap.statusCode).toBe(409);
    expect((await db.rPMBillingReadiness.findFirstOrThrow({ where: { tenantId: t.id, patientId: t.patientId } })).reviewMinutes).toBe(10);
  });

  it('requires an active provider profile in the patient branch for provider signoff', async () => {
    const t = await makeTenant('enterprise');
    const admin = auth(tok(t.id, t.adminUserId));
    await app.inject({ method: 'POST', url: '/v1/connected-care/enrollments', headers: admin, payload: { patientId: t.patientId, providerKey: 'manual' } });
    expect((await app.inject({ method: 'POST', url: `/v1/connected-care/rpm-readiness/${t.patientId}/signoff`, headers: admin })).statusCode).toBe(403);
    const evidence = await rpmReadinessRow(t.patientId, admin);
    const signoffPayload = { expectedEvidenceVersion: evidence.evidenceVersion, expectedEvidenceHash: evidence.evidenceHash, attestationRevision: evidence.signoffAttestationRevision };

    const noProfile = await db.user.create({ data: { tenantId: t.id, branchId: t.branchId, role: 'PROVIDER', active: true, email: `np-${randomUUID()}@it.test`, displayName: 'No profile' } });
    expect((await app.inject({ method: 'POST', url: `/v1/connected-care/rpm-readiness/${t.patientId}/signoff`, headers: auth(tok(t.id, noProfile.id)), payload: signoffPayload })).statusCode).toBe(403);
    const otherBranch = await db.branch.create({ data: { tenantId: t.id, name: 'provider-other', location: 'z' } });
    const wrongBranchUser = await db.user.create({ data: { tenantId: t.id, branchId: otherBranch.id, role: 'PROVIDER', active: true, email: `wb-${randomUUID()}@it.test`, displayName: 'Wrong branch provider' } });
    await db.providerProfile.create({ data: { tenantId: t.id, branchId: otherBranch.id, userId: wrongBranchUser.id, specialty: 'Primary Care' } });
    expect((await app.inject({ method: 'POST', url: `/v1/connected-care/rpm-readiness/${t.patientId}/signoff`, headers: auth(tok(t.id, wrongBranchUser.id)), payload: signoffPayload })).statusCode).toBe(403);
    // The correctly scoped provider passes identity/profile authorization and
    // reaches the independent evidence-completeness gate.
    const signed = await signoffRpm(t.patientId, auth(tok(t.id, t.providerUserId)));
    expect(signed.statusCode).toBe(409);
    expect(signed.json().message).toContain('complete current evidence');
  });

  it('restricts raw sync payloads to tenant admins and audits the sensitive read', async () => {
    const t = await makeTenant('enterprise');
    const log = await db.deviceProviderSyncLog.create({ data: { tenantId: t.id, providerKind: 'device', providerKey: 'withings', direction: 'inbound', event: 'webhook', status: 'processed', payload: { patientExternalRef: 'sensitive-ref' } } });
    expect((await app.inject({ method: 'GET', url: `/v1/connected-care/sync-logs/${log.id}`, headers: auth(tok(t.id, t.providerUserId)) })).statusCode).toBe(403);
    const allowed = await app.inject({ method: 'GET', url: `/v1/connected-care/sync-logs/${log.id}`, headers: auth(tok(t.id, t.adminUserId)) });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().payload).toEqual({ patientExternalRef: 'sensitive-ref' });
    expect(await db.auditEvent.count({ where: { tenantId: t.id, action: 'connectedcare.sync_log.raw_read', resourceId: log.id } })).toBe(1);
  });

  it('rejects implausible and foreign direct-patient webhook readings even with a valid provider signature', async () => {
    const t = await makeTenant('enterprise');
    const foreign = await makeTenant('enterprise');
    const secret = `whsec-${randomUUID()}`;
    await configureDeviceProviderSecret(t.id, 'withings', secret);
    await app.inject({ method: 'POST', url: '/v1/connected-care/enrollments', headers: auth(tok(t.id, t.adminUserId)), payload: { patientId: t.patientId, providerKey: 'withings', programType: 'general' } });
    const payload = { readings: [
      { patientId: t.patientId, readingType: 'glucose', value: '5000', numericValue: 5000, unit: 'mg/dL' },
      { patientId: foreign.patientId, readingType: 'glucose', value: '120', numericValue: 120, unit: 'mg/dL' },
    ] };
    const { raw, sig } = signWebhook(secret, payload);
    const response = await app.inject({ method: 'POST', url: `/v1/connected-care/${t.id}/providers/withings/webhook`, headers: { 'content-type': 'application/json', 'x-cc-signature': sig }, payload: raw });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ received: 2, ingested: 0, invalid: 2 });
    expect(await db.deviceReading.count({ where: { tenantId: t.id } })).toBe(0);
  });
});
