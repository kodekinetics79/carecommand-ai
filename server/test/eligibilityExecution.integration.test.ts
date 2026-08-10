import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { Prisma } from '../generated/prisma/client';
import { fixtureDb } from './helpers/fixtureDb';
import {
  EligibilityExecutionConflictError,
  eligibilityRequestIdentity,
  eligibilityRequestIdentitiesForKeys,
  runEligibilityExecution,
} from '../lib/eligibilityExecution';
import { runWithTenantContext } from '../lib/tenantContext';
import { db } from '../lib/db';

const tenantIds: string[] = [];

async function fixture() {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await fixtureDb.tenant.create({ data: { id: tenantId, name: `elig-${tenantId.slice(0, 8)}`, slug: `elig-${tenantId.slice(0, 8)}` } });
  const branch = await fixtureDb.branch.create({ data: { tenantId, name: 'Eligibility', location: 'Test' } });
  const patient = await fixtureDb.patient.create({ data: { tenantId, branchId: branch.id, firstName: 'Test', lastName: 'Patient' } });
  const payer = await fixtureDb.insurancePayer.create({ data: { tenantId, name: 'Test Payer' } });
  const policy = await fixtureDb.patientInsurancePolicy.create({
    data: { tenantId, branchId: branch.id, patientId: patient.id, payerId: payer.id, planName: 'Test Plan', memberId: 'MEMBER-SECRET-9912' },
  });
  const actor = await fixtureDb.user.create({ data: { tenantId, email: `${tenantId}@example.test`, displayName: 'Tester', role: 'ADMIN' } });
  return { tenantId, branchId: branch.id, patientId: patient.id, payerId: payer.id, policyId: policy.id, actorUserId: actor.id };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function inTenant<T>(f: Fixture, fn: () => Promise<T>) {
  return runWithTenantContext(f.tenantId, async () => fn(), { id: f.actorUserId, role: 'ADMIN' });
}

function runInput(
  f: Fixture,
  overrides: {
    key?: string;
    memberId?: string;
    provider?: () => Promise<{ coverageStatus: string }>;
    finalize?: (tx: Prisma.TransactionClient, outcome: { coverageStatus: string }) => Promise<{ verificationId: string; result: { verificationId: string } }>;
  } = {},
) {
  const memberId = overrides.memberId ?? 'MEMBER-SECRET-9912';
  return runEligibilityExecution({
    context: { ...f },
    rawIdempotencyKey: overrides.key ?? 'eligibility-test-key',
    fingerprintParts: { contract: 'insurance_v1', patientId: f.patientId, policyId: f.policyId, payerId: f.payerId, memberId },
    requestContract: 'insurance_v1',
    providerKey: 'test',
    providerMode: 'sandbox',
    executeProvider: overrides.provider ?? (async () => ({ coverageStatus: 'ACTIVE' })),
    finalize: overrides.finalize ?? (async (tx, outcome) => {
      const verification = await tx.eligibilityVerification.create({
        data: {
          tenantId: f.tenantId,
          branchId: f.branchId,
          patientId: f.patientId,
          payerId: f.payerId,
          policyId: f.policyId,
          providerMode: 'sandbox',
          coverageStatus: outcome.coverageStatus,
          planName: 'Test Plan',
          payerName: 'Test Payer',
          coverageActive: true,
          eligibilityMessage: 'Synthetic test response',
          normalizedResponse: { coverageStatus: outcome.coverageStatus, missingBenefitFields: [] },
          decisionSource: 'SIMULATED',
        },
      });
      return { verificationId: verification.id, result: { verificationId: verification.id } };
    }),
    replay: async verificationId => ({ verificationId }),
  });
}

afterAll(async () => {
  for (const tenantId of tenantIds) await fixtureDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  await fixtureDb.$disconnect();
});

describe('durable eligibility execution boundary', () => {
  it('serializes concurrent claims, invokes the provider once, and replays the committed result', async () => {
    const f = await fixture();
    let calls = 0;
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    const provider = async () => {
      calls += 1;
      started();
      await releasePromise;
      return { coverageStatus: 'ACTIVE' };
    };

    await inTenant(f, async () => {
      const first = runInput(f, { provider });
      await startedPromise;
      await expect(runInput(f, { provider })).rejects.toMatchObject({ code: 'execution_in_progress' });
      release();
      const completed = await first;
      expect(completed.replayed).toBe(false);
      const replay = await runInput(f, { provider });
      expect(replay).toMatchObject({ replayed: true, executionId: completed.executionId, result: completed.result });
    });

    expect(calls).toBe(1);
    expect(await fixtureDb.eligibilityExecution.count({ where: { tenantId: f.tenantId } })).toBe(1);
    expect(await fixtureDb.eligibilityVerification.count({ where: { tenantId: f.tenantId } })).toBe(1);
    expect(await fixtureDb.auditEvent.count({ where: { tenantId: f.tenantId, action: 'eligibility.checked' } })).toBe(1);
    expect(await fixtureDb.auditEvent.count({ where: { tenantId: f.tenantId, action: 'eligibility.execution.requested' } })).toBe(1);
    expect(await fixtureDb.businessEvent.count({ where: { tenantId: f.tenantId, eventType: 'insurance.eligibility.requested' } })).toBe(1);
  });

  it('rejects key reuse with a different PHI fingerprint and persists neither the raw key nor member identifier', async () => {
    const f = await fixture();
    await inTenant(f, async () => {
      await runInput(f, { key: 'same-key-different-request' });
      await expect(runInput(f, { key: 'same-key-different-request', memberId: 'DIFFERENT-MEMBER' }))
        .rejects.toBeInstanceOf(EligibilityExecutionConflictError);
    });
    const row = await fixtureDb.eligibilityExecution.findFirstOrThrow({ where: { tenantId: f.tenantId } });
    expect(row.idempotencyKeyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(row)).not.toContain('same-key-different-request');
    expect(JSON.stringify(row)).not.toContain('MEMBER-SECRET-9912');
    expect(JSON.stringify(row)).not.toContain('DIFFERENT-MEMBER');
  });

  it('fails closed on an ambiguous provider outcome and never re-executes it', async () => {
    const f = await fixture();
    let calls = 0;
    const provider = async () => {
      calls += 1;
      throw new Error('synthetic timeout');
    };
    await inTenant(f, async () => {
      await expect(runInput(f, { key: 'ambiguous-provider-key', provider })).rejects.toMatchObject({ code: 'reconciliation_required' });
      await expect(runInput(f, { key: 'ambiguous-provider-key', provider })).rejects.toMatchObject({ code: 'reconciliation_required' });
    });
    expect(calls).toBe(1);
    expect(await fixtureDb.eligibilityExecution.findFirst({ where: { tenantId: f.tenantId } })).toMatchObject({
      status: 'RECONCILIATION_REQUIRED',
      reconciliationReason: 'provider_outcome_ambiguous',
    });
    expect(await fixtureDb.integrationRunLog.count({ where: { tenantId: f.tenantId, status: 'reconciliation_required' } })).toBe(1);
  });

  it('returns the same unresolved execution for a changed browser key with the same request fingerprint', async () => {
    const f = await fixture();
    let calls = 0;
    const provider = async () => {
      calls += 1;
      throw new Error('synthetic lost response');
    };
    await inTenant(f, async () => {
      await expect(runInput(f, { key: 'browser-key-before-reload', provider })).rejects.toMatchObject({ code: 'reconciliation_required' });
      await expect(runInput(f, { key: 'browser-key-after-reload', provider })).rejects.toMatchObject({ code: 'reconciliation_required' });
    });
    expect(calls).toBe(1);
    expect(await fixtureDb.eligibilityExecution.count({ where: { tenantId: f.tenantId } })).toBe(1);
  });

  it('serializes simultaneous changed browser keys onto one active fingerprint execution', async () => {
    const f = await fixture();
    let calls = 0;
    const provider = async () => {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, 50));
      return { coverageStatus: 'ACTIVE' };
    };
    await inTenant(f, async () => {
      const outcomes = await Promise.allSettled([
        runInput(f, { key: 'simultaneous-browser-key-a', provider }),
        runInput(f, { key: 'simultaneous-browser-key-b', provider }),
      ]);
      expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
    });
    expect(calls).toBe(1);
    expect(await fixtureDb.eligibilityExecution.count({ where: { tenantId: f.tenantId } })).toBe(1);
  });

  it('rolls back normalized and downstream writes together when finalization fails', async () => {
    const f = await fixture();
    await inTenant(f, async () => {
      await expect(runInput(f, {
        key: 'atomic-finalization-key',
        finalize: async (tx, outcome) => {
          const verification = await tx.eligibilityVerification.create({
            data: {
              tenantId: f.tenantId,
              branchId: f.branchId,
              patientId: f.patientId,
              providerMode: 'sandbox',
              coverageStatus: outcome.coverageStatus,
              planName: 'Test',
              payerName: 'Test',
              coverageActive: true,
              eligibilityMessage: 'Test',
              normalizedResponse: {},
            },
          });
          await tx.benefitSnapshot.create({ data: { tenantId: f.tenantId, branchId: f.branchId, verificationId: verification.id, summary: 'Test', details: {} } });
          throw new Error('synthetic audit/downstream failure');
        },
      })).rejects.toMatchObject({ code: 'reconciliation_required' });
    });
    expect(await fixtureDb.eligibilityVerification.count({ where: { tenantId: f.tenantId } })).toBe(0);
    expect(await fixtureDb.benefitSnapshot.count({ where: { tenantId: f.tenantId } })).toBe(0);
    expect(await fixtureDb.eligibilityExecution.findFirst({ where: { tenantId: f.tenantId } })).toMatchObject({
      status: 'RECONCILIATION_REQUIRED',
      reconciliationReason: 'result_persistence_failed',
    });
  });

  it('moves a stale in-flight crash window to reconciliation without calling the provider', async () => {
    const f = await fixture();
    const identity = eligibilityRequestIdentity(f.tenantId, 'stale-in-flight-key', {
      contract: 'insurance_v1', patientId: f.patientId, policyId: f.policyId, payerId: f.payerId, memberId: 'MEMBER-SECRET-9912',
    });
    await fixtureDb.eligibilityExecution.create({
      data: {
        ...f,
        ...identity,
        requestContract: 'insurance_v1',
        providerKey: 'test',
        providerMode: 'sandbox',
        status: 'PROVIDER_IN_FLIGHT',
        providerStartedAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    let calls = 0;
    await inTenant(f, async () => {
      await expect(runInput(f, { key: 'stale-in-flight-key', provider: async () => { calls += 1; return { coverageStatus: 'ACTIVE' }; } }))
        .rejects.toMatchObject({ code: 'reconciliation_required' });
    });
    expect(calls).toBe(0);
    expect(await fixtureDb.eligibilityExecution.findFirst({ where: { tenantId: f.tenantId } })).toMatchObject({
      status: 'RECONCILIATION_REQUIRED',
      reconciliationReason: 'stale_provider_in_flight',
    });
  });

  it('resumes a durable READY intent after a crash-before-provider-call exactly once', async () => {
    const f = await fixture();
    const identity = eligibilityRequestIdentity(f.tenantId, 'crash-before-call-key', {
      contract: 'insurance_v1', patientId: f.patientId, policyId: f.policyId, payerId: f.payerId, memberId: 'MEMBER-SECRET-9912',
    });
    await fixtureDb.eligibilityExecution.create({
      data: {
        ...f,
        ...identity,
        requestContract: 'insurance_v1',
        providerKey: 'test',
        providerMode: 'sandbox',
        status: 'READY',
      },
    });
    let calls = 0;
    await inTenant(f, async () => {
      const result = await runInput(f, {
        key: 'crash-before-call-key',
        provider: async () => { calls += 1; return { coverageStatus: 'ACTIVE' }; },
      });
      expect(result.replayed).toBe(false);
    });
    expect(calls).toBe(1);
    expect(await fixtureDb.eligibilityExecution.findFirst({ where: { tenantId: f.tenantId } })).toMatchObject({ status: 'SUCCEEDED' });
  });

  it('fails closed for a suspended tenant before creating or resuming an execution', async () => {
    const f = await fixture();
    await fixtureDb.tenant.update({ where: { id: f.tenantId }, data: { status: 'suspended' } });
    await expect(inTenant(f, () => runInput(f, { key: 'suspended-tenant-key' }))).rejects.toThrow('unknown, suspended, or archived');
    expect(await fixtureDb.eligibilityExecution.count({ where: { tenantId: f.tenantId } })).toBe(0);
    await fixtureDb.tenant.update({ where: { id: f.tenantId }, data: { status: 'active' } });
  });

  it('namespaces identical idempotency keys and fingerprints by tenant', async () => {
    const a = await fixture();
    const b = await fixture();
    await inTenant(a, () => runInput(a, { key: 'shared-across-tenants' }));
    await inTenant(b, () => runInput(b, { key: 'shared-across-tenants' }));
    const rows = await fixtureDb.eligibilityExecution.findMany({ where: { tenantId: { in: [a.tenantId, b.tenantId] } } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.idempotencyKeyHash)).size).toBe(2);
  });

  it('canonicalizes request identity independent of object key order', () => {
    const tenantId = randomUUID();
    const a = eligibilityRequestIdentity(tenantId, 'canonical-test-key', { patientId: 'p', memberId: 'm' });
    const b = eligibilityRequestIdentity(tenantId, 'canonical-test-key', { memberId: 'm', patientId: 'p' });
    expect(a).toEqual(b);
  });

  it('retains a deterministic prior-key identity candidate during HMAC rotation', () => {
    const tenantId = randomUUID();
    const candidates = eligibilityRequestIdentitiesForKeys(tenantId, 'rotation-replay-key', { patientId: 'p', memberId: 'secret-member' }, [
      { version: 'v2', secret: 'current-eligibility-secret'.repeat(2) },
      { version: 'v1', secret: 'previous-eligibility-secret'.repeat(2) },
    ]);
    expect(candidates.map(candidate => candidate.hmacKeyVersion)).toEqual(['v2', 'v1']);
    expect(candidates[0]?.idempotencyKeyHash).not.toBe(candidates[1]?.idempotencyKeyHash);
    expect(JSON.stringify(candidates)).not.toContain('rotation-replay-key');
    expect(JSON.stringify(candidates)).not.toContain('secret-member');
  });

  it('denies same-tenant identity rewrites, deletion, and state corruption while allowing orchestration', async () => {
    const f = await fixture();
    const identity = eligibilityRequestIdentity(f.tenantId, 'database-guard-key', {
      contract: 'insurance_v1', patientId: f.patientId, policyId: f.policyId, payerId: f.payerId, memberId: 'MEMBER-SECRET-9912',
    });
    const execution = await fixtureDb.eligibilityExecution.create({ data: {
      ...f, ...identity, requestContract: 'insurance_v1', providerKey: 'test', providerMode: 'sandbox', status: 'READY',
    } });
    await inTenant(f, async () => {
      await expect(db.eligibilityExecution.update({ where: { id: execution.id }, data: { requestFingerprint: '0'.repeat(64) } })).rejects.toThrow(/immutable/i);
      await expect(db.eligibilityExecution.update({ where: { id: execution.id }, data: { status: 'SUCCEEDED' } })).rejects.toThrow(/state transition|state fields/i);
      await expect(db.eligibilityExecution.delete({ where: { id: execution.id } })).rejects.toThrow();
      await expect(runInput(f, { key: 'database-guard-key' })).resolves.toMatchObject({ replayed: false });
    });
    expect(await fixtureDb.eligibilityExecution.findUniqueOrThrow({ where: { id: execution.id } })).toMatchObject({ status: 'SUCCEEDED', requestFingerprint: identity.requestFingerprint });
  });

  it('defaults unverifiable legacy verification provenance truthfully', async () => {
    const f = await fixture();
    const row = await fixtureDb.eligibilityVerification.create({ data: {
      tenantId: f.tenantId, branchId: f.branchId, patientId: f.patientId, providerMode: 'sandbox', coverageStatus: 'unknown',
      planName: 'Legacy', payerName: 'Legacy', coverageActive: false, eligibilityMessage: 'Historical row', normalizedResponse: {},
    } });
    expect(row.decisionSource).toBe('LEGACY_UNVERIFIED');
    expect(row.effectiveFrom).toBeNull();
    expect(row.expiresAt).toBeNull();
  });
});
