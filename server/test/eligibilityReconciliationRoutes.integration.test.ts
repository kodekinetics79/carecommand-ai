import 'dotenv/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { UserRole } from '../generated/prisma/enums';

vi.mock('../workers/queues', () => ({
  redisConnection: {},
  autopilotQueue: { client: Promise.resolve(undefined), add: async () => undefined },
  enqueueAutopilotExecution: async () => undefined,
  complianceQueue: { add: async () => undefined },
  registerComplianceSchedules: async () => undefined,
  campaignQueue: { add: async () => undefined },
  registerCampaignSchedules: async () => undefined,
  monitoringQueue: { add: async () => undefined },
  registerMonitoringSchedules: async () => undefined,
  eligibilityReconciliationQueue: { add: async () => undefined },
  registerEligibilityReconciliationSchedule: async () => undefined,
}));

const { buildApp } = await import('../app');
const { fixtureDb } = await import('./helpers/fixtureDb');
const { recomputeEntitlements } = await import('../lib/entitlements');
const { scanEligibilityReconciliationWork } = await import('../lib/eligibilityExecution');
const { runWithJobTenantContext } = await import('../lib/tenantContext');

let app: FastifyInstance;
const tenantIds: string[] = [];

async function tenantFixture() {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await fixtureDb.tenant.create({ data: { id: tenantId, name: `route-${tenantId.slice(0, 8)}`, slug: `route-${tenantId.slice(0, 8)}` } });
  const plan = await fixtureDb.subscriptionPlan.findUniqueOrThrow({ where: { key: 'enterprise' } });
  await fixtureDb.tenantSubscription.create({ data: { tenantId, planId: plan.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(tenantId, fixtureDb);
  const firstBranch = await fixtureDb.branch.create({ data: { tenantId, name: 'First branch', location: 'Test' } });
  const secondBranch = await fixtureDb.branch.create({ data: { tenantId, name: 'Second branch', location: 'Test' } });
  const firstPatient = await fixtureDb.patient.create({ data: { tenantId, branchId: firstBranch.id, firstName: 'First', lastName: 'Patient' } });
  const secondPatient = await fixtureDb.patient.create({ data: { tenantId, branchId: secondBranch.id, firstName: 'Second', lastName: 'Patient' } });
  const payer = await fixtureDb.insurancePayer.create({ data: { tenantId, name: 'Synthetic Payer' } });
  const firstPolicy = await fixtureDb.patientInsurancePolicy.create({
    data: { tenantId, branchId: firstBranch.id, patientId: firstPatient.id, payerId: payer.id, planName: 'Synthetic Plan', memberId: 'MEMBER-PRIVATE-1' },
  });

  async function user(role: UserRole, branchId: string | null = null) {
    return fixtureDb.user.create({ data: {
      tenantId, branchId, role, active: true,
      email: `${role.toLowerCase()}-${randomUUID()}@route.test`, displayName: `${role} Tester`,
    } });
  }
  const admin = await user('ADMIN');
  const billing = await user('BILLING');
  const manager = await user('MANAGER', firstBranch.id);
  const frontDesk = await user('FRONT_DESK', firstBranch.id);
  const provider = await user('PROVIDER', firstBranch.id);
  return {
    tenantId, firstBranchId: firstBranch.id, secondBranchId: secondBranch.id,
    firstPatientId: firstPatient.id, secondPatientId: secondPatient.id,
    payerId: payer.id, firstPolicyId: firstPolicy.id,
    admin, billing, manager, frontDesk, provider,
  };
}

type TenantFixture = Awaited<ReturnType<typeof tenantFixture>>;

function token(f: TenantFixture, user: { id: string }) {
  return app.jwt.sign({ userId: user.id, tenantId: f.tenantId, role: 'OWNER', type: 'access' });
}

function headers(f: TenantFixture, user: { id: string }) {
  return { authorization: `Bearer ${token(f, user)}` };
}

async function createExecution(f: TenantFixture, options: { branch?: 'first' | 'second'; status?: 'READY' | 'RECONCILIATION_REQUIRED' | 'FAILED_DEFINITIVE' } = {}) {
  const branchId = options.branch === 'second' ? f.secondBranchId : f.firstBranchId;
  const patientId = options.branch === 'second' ? f.secondPatientId : f.firstPatientId;
  const status = options.status ?? 'RECONCILIATION_REQUIRED';
  const requestedServiceAt = new Date('2026-07-15T14:00:00.000Z');
  const execution = await fixtureDb.eligibilityExecution.create({ data: {
    tenantId: f.tenantId, branchId, patientId,
    payerId: options.branch === 'second' ? undefined : f.payerId,
    policyId: options.branch === 'second' ? undefined : f.firstPolicyId,
    actorUserId: f.admin.id,
    idempotencyKeyHash: randomBytes(32).toString('hex'), hmacKeyVersion: 'v1',
    requestFingerprint: randomBytes(32).toString('hex'), requestContract: 'insurance_v1',
    providerKey: 'test-payer', providerMode: 'sandbox', status,
    requestedServiceType: 'MRI imaging review',
    requestedServiceAt,
    providerStartedAt: status === 'RECONCILIATION_REQUIRED' ? new Date(Date.now() - 8 * 60_000) : undefined,
    reconciliationReason: status === 'RECONCILIATION_REQUIRED' ? 'provider_outcome_ambiguous' : undefined,
    failureCode: status === 'FAILED_DEFINITIVE' ? 'provider_failure_confirmed' : undefined,
    completedAt: status === 'FAILED_DEFINITIVE' ? new Date() : undefined,
    createdAt: status === 'READY' ? new Date(Date.now() - 10 * 60_000) : undefined,
  } });
  await fixtureDb.auditEvent.create({
    data: {
      tenantId: f.tenantId, actorUserId: f.admin.id, action: 'eligibility.execution.requested',
      resource: 'eligibilityExecution', resourceId: execution.id,
      metadata: { requestedServiceType: 'MRI imaging review', requestedServiceAt: requestedServiceAt.toISOString() },
    },
  });
  return execution;
}

async function surface(f: TenantFixture, executionId: string) {
  await runWithJobTenantContext(
    f.tenantId,
    () => scanEligibilityReconciliationWork(f.tenantId),
    'worker:test-eligibility-reconciliation-routes',
  );
  return fixtureDb.eligibilityExecution.findUniqueOrThrow({ where: { id: executionId } });
}

beforeAll(async () => {
  app = await buildApp();
}, 60_000);

afterAll(async () => {
  for (const tenantId of tenantIds) await fixtureDb.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await app?.close();
  await fixtureDb.$disconnect();
});

describe('eligibility reconciliation routes', () => {
  it('filters server-held work by lifecycle, tenant, branch, and view-versus-resolve permission', async () => {
    const f = await tenantFixture();
    const other = await tenantFixture();
    const firstPending = await createExecution(f);
    const secondPending = await createExecution(f, { branch: 'second' });
    const terminal = await createExecution(f, { status: 'FAILED_DEFINITIVE' });
    await surface(f, firstPending.id);

    const frontDeskList = await app.inject({
      method: 'GET', url: '/v1/insurance/eligibility/executions/reconciliation?state=all', headers: headers(f, f.frontDesk),
    });
    expect(frontDeskList.statusCode).toBe(200);
    expect(frontDeskList.json()).toEqual([
      expect.objectContaining({
        id: firstPending.id, status: 'MANUAL_EVIDENCE_PENDING', canReconcile: false, noAutomaticPayerRetry: true,
        payerName: 'Synthetic Payer', planName: 'Synthetic Plan', requestedServiceType: 'MRI imaging review',
        requestedServiceAt: '2026-07-15T14:00:00.000Z', requestTime: expect.any(String), lastAttemptAt: expect.any(String),
        auditTrail: expect.arrayContaining([expect.objectContaining({ action: 'eligibility.execution.requested' })]),
      }),
    ]);
    expect(frontDeskList.json()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: secondPending.id }), expect.objectContaining({ id: terminal.id }),
    ]));

    const providerList = await app.inject({ method: 'GET', url: '/v1/insurance/eligibility/executions/reconciliation', headers: headers(f, f.provider) });
    expect(providerList.statusCode).toBe(403);

    const billingTerminal = await app.inject({
      method: 'GET', url: '/v1/insurance/eligibility/executions/reconciliation?state=terminal', headers: headers(f, f.billing),
    });
    expect(billingTerminal.statusCode).toBe(200);
    expect(billingTerminal.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: terminal.id, canReconcile: true })]));

    const otherList = await app.inject({ method: 'GET', url: '/v1/insurance/eligibility/executions/reconciliation?state=all', headers: headers(other, other.admin) });
    expect(otherList.statusCode).toBe(200);
    expect(otherList.json()).toHaveLength(0);
  });

  it('fences claims by permission, tenant, branch, and expected generation while auditing one winner', async () => {
    const f = await tenantFixture();
    const other = await tenantFixture();
    const candidate = await createExecution(f);
    const pending = await surface(f, candidate.id);

    const denied = await app.inject({
      method: 'POST', url: `/v1/insurance/eligibility/executions/${candidate.id}/claim`, headers: headers(f, f.frontDesk),
      payload: { expectedGeneration: pending.reconciliationGeneration },
    });
    expect(denied.statusCode).toBe(403);
    const crossTenant = await app.inject({
      method: 'POST', url: `/v1/insurance/eligibility/executions/${candidate.id}/claim`, headers: headers(other, other.admin),
      payload: { expectedGeneration: pending.reconciliationGeneration },
    });
    expect(crossTenant.statusCode).toBe(404);
    const stale = await app.inject({
      method: 'POST', url: `/v1/insurance/eligibility/executions/${candidate.id}/claim`, headers: headers(f, f.billing),
      payload: { expectedGeneration: pending.reconciliationGeneration + 1 },
    });
    expect(stale.statusCode).toBe(409);

    const claimed = await app.inject({
      method: 'POST', url: `/v1/insurance/eligibility/executions/${candidate.id}/claim`, headers: headers(f, f.billing),
      payload: { expectedGeneration: pending.reconciliationGeneration },
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toMatchObject({ claimed: true, replayed: false });
    const replay = await app.inject({
      method: 'POST', url: `/v1/insurance/eligibility/executions/${candidate.id}/claim`, headers: headers(f, f.billing),
      payload: { expectedGeneration: pending.reconciliationGeneration },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ claimed: true, replayed: true });
    expect(await fixtureDb.auditEvent.count({
      where: { tenantId: f.tenantId, resourceId: candidate.id, action: 'eligibility.execution.reconciliation.claimed' },
    })).toBe(1);

    const explicitlyGranted = await createExecution(f);
    const explicitlyPending = await surface(f, explicitlyGranted.id);
    await fixtureDb.roleDefinition.upsert({
      where: { tenantId_name: { tenantId: f.tenantId, name: 'Front Desk' } },
      create: { tenantId: f.tenantId, name: 'Front Desk', description: 'Test override', permissions: ['billing:read', 'insurance:reconcile'] },
      update: { permissions: ['billing:read', 'insurance:reconcile'] },
    });
    const grantedClaim = await app.inject({
      method: 'POST', url: `/v1/insurance/eligibility/executions/${explicitlyGranted.id}/claim`, headers: headers(f, f.frontDesk),
      payload: { expectedGeneration: explicitlyPending.reconciliationGeneration },
    });
    expect(grantedClaim.statusCode).toBe(200);
  });

  it('requires exact payer evidence, downgrades date-inapplicable coverage, preserves null benefits, and never regresses terminal state', async () => {
    const f = await tenantFixture();
    const candidate = await createExecution(f);
    const pending = await surface(f, candidate.id);
    const generation = pending.reconciliationGeneration;
    expect((await app.inject({
      method: 'POST', url: `/v1/insurance/eligibility/executions/${candidate.id}/claim`, headers: headers(f, f.manager),
      payload: { expectedGeneration: generation },
    })).statusCode).toBe(200);

    const missingEvidence = await app.inject({
      method: 'POST', url: `/v1/insurance/eligibility/executions/${candidate.id}/reconcile`, headers: headers(f, f.manager),
      payload: { resolution: 'confirmed_succeeded', expectedGeneration: generation, reason: 'Missing evidence is invalid' },
    });
    expect(missingEvidence.statusCode).toBe(400);

    const futureEvidence = await app.inject({
      method: 'POST', url: `/v1/insurance/eligibility/executions/${candidate.id}/reconcile`, headers: headers(f, f.manager),
      payload: {
        resolution: 'confirmed_succeeded', expectedGeneration: generation, reason: 'Future evidence is invalid',
        evidence: evidencePayload({ verifiedAt: new Date(Date.now() + 10 * 60_000).toISOString() }),
      },
    });
    expect(futureEvidence.statusCode).toBe(400);

    const validEvidence = evidencePayload({
      verifiedAt: new Date(Date.now() - 60_000).toISOString(),
      effectiveFrom: new Date(Date.now() - 20 * 24 * 60 * 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 10 * 24 * 60 * 60_000).toISOString(),
    });
    const resolved = await app.inject({
      method: 'POST', url: `/v1/insurance/eligibility/executions/${candidate.id}/reconcile`, headers: headers(f, f.manager),
      payload: { resolution: 'confirmed_succeeded', expectedGeneration: generation, reason: 'Payer portal evidence was reviewed', evidence: validEvidence },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ status: 'MANUALLY_RECONCILED', providerCalled: false });

    const execution = await fixtureDb.eligibilityExecution.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(execution).toMatchObject({
      status: 'MANUALLY_RECONCILED', reconciliationGeneration: generation + 1,
      manualEvidenceOutcome: 'UNCERTAIN', manualEvidenceSource: 'PAYER_PORTAL',
      manualEvidenceReference: 'PAYER-REF-123', manualEvidenceVerifiedByUserId: f.manager.id,
      manualCopay: null, manualDeductibleRemaining: null, manualCoinsurance: null,
    });
    const verification = await fixtureDb.eligibilityVerification.findUniqueOrThrow({ where: { id: execution.resultVerificationId! } });
    expect(verification).toMatchObject({
      coverageStatus: 'NEEDS_REVIEW', coverageActive: false, decisionSource: 'MANUAL_PAYER_EVIDENCE',
      payerReference: 'PAYER-REF-123', copay: null, deductibleRemaining: null, coinsurance: null,
    });
    expect(verification.eligibilityMessage).toContain('not a payment guarantee');
    expect(await fixtureDb.staffTask.count({ where: { id: execution.reconciliationTaskId!, status: 'COMPLETED' } })).toBe(1);
    expect(await fixtureDb.eligibilityVerification.count({ where: { eligibilityExecution: { id: candidate.id } } })).toBe(1);
    expect(await fixtureDb.auditEvent.count({
      where: { tenantId: f.tenantId, resourceId: candidate.id, action: 'eligibility.execution.manually_reconciled' },
    })).toBe(1);

    const reconciledList = await app.inject({
      method: 'GET', url: '/v1/insurance/eligibility/executions/reconciliation?state=reconciled', headers: headers(f, f.manager),
    });
    expect(reconciledList.statusCode).toBe(200);
    expect(reconciledList.json()).toEqual(expect.arrayContaining([expect.objectContaining({
      id: candidate.id, resultSource: 'MANUAL_PAYER_EVIDENCE', resultStatus: 'NEEDS_REVIEW',
      manualEvidenceSource: 'PAYER_PORTAL', manualEvidenceReference: 'PAYER-REF-123',
      manualCopay: null, manualDeductibleRemaining: null, manualCoinsurance: null,
      payerName: 'Synthetic Payer', planName: 'Synthetic Plan', requestedServiceType: 'MRI imaging review',
      auditTrail: expect.arrayContaining([expect.objectContaining({ action: 'eligibility.execution.manually_reconciled' })]),
    })]));

    const terminalRetry = await app.inject({
      method: 'POST', url: `/v1/insurance/eligibility/executions/${candidate.id}/reconcile`, headers: headers(f, f.manager),
      payload: { resolution: 'confirmed_succeeded', expectedGeneration: generation, reason: 'Must not create a second result', evidence: validEvidence },
    });
    expect(terminalRetry.statusCode).toBe(409);
    expect(await fixtureDb.eligibilityVerification.count({ where: { eligibilityExecution: { id: candidate.id } } })).toBe(1);
  });
});

function evidencePayload(overrides: Record<string, unknown> = {}) {
  return {
    outcome: 'ACTIVE', source: 'PAYER_PORTAL', reference: 'PAYER-REF-123', verifiedAt: new Date().toISOString(),
    effectiveFrom: null, expiresAt: null, copay: null, deductibleRemaining: null, coinsurance: null,
    notes: 'Synthetic payer portal review',
    attestation: { patientMatches: true, policyMatches: true, payerMatches: true, serviceAndDateMatch: true },
    ...overrides,
  };
}
