import 'dotenv/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { EligibilityExecutionStatus } from '../generated/prisma/client';
import { scanEligibilityReconciliationWork } from '../lib/eligibilityExecution';
import { runWithJobTenantContext } from '../lib/tenantContext';
import { fixtureDb } from './helpers/fixtureDb';
import { env } from '../config/env';

const tenantIds: string[] = [];

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await fixtureDb.tenant.create({
    data: { id: tenantId, name: `elig-recon-${tenantId.slice(0, 8)}`, slug: `elig-recon-${tenantId.slice(0, 8)}` },
  });
  const branch = await fixtureDb.branch.create({ data: { tenantId, name: 'Eligibility reconciliation', location: 'Test' } });
  const patient = await fixtureDb.patient.create({
    data: { tenantId, branchId: branch.id, firstName: 'Synthetic', lastName: 'Patient' },
  });
  return { tenantId, branchId: branch.id, patientId: patient.id };
}

async function execution(
  f: Fixture,
  input: {
    status: EligibilityExecutionStatus;
    createdAt?: Date;
    providerStartedAt?: Date;
    reconciliationReason?: string;
    reconciliationGeneration?: number;
    reconciliationLeaseOwner?: string;
    reconciliationLeaseExpiresAt?: Date;
  },
) {
  return fixtureDb.eligibilityExecution.create({
    data: {
      ...f,
      idempotencyKeyHash: randomBytes(32).toString('hex'),
      hmacKeyVersion: 'v1',
      requestFingerprint: randomBytes(32).toString('hex'),
      requestContract: 'insurance_v1',
      providerKey: 'test-payer',
      providerMode: 'sandbox',
      ...input,
    },
  });
}

function scan(tenantId: string, now: Date, limit = 25) {
  return runWithJobTenantContext(
    tenantId,
    () => scanEligibilityReconciliationWork(tenantId, now, limit),
    'worker:test-eligibility-reconciliation',
  );
}

afterAll(async () => {
  // EligibilityExecution is deliberately delete-protected. The authoritative
  // test command uses the disposable-DB wrapper, which drops the whole database.
  for (const tenantId of tenantIds) await fixtureDb.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await fixtureDb.$disconnect();
});

describe('eligibility reconciliation discovery', () => {
  it('surfaces stale READY and PROVIDER_IN_FLIGHT work without touching fresh executions or calling a payer', async () => {
    const f = await fixture();
    const now = new Date();
    const stale = new Date(now.getTime() - 10 * 60_000);
    const staleReady = await execution(f, { status: 'READY', createdAt: stale });
    const staleInFlight = await execution(f, { status: 'PROVIDER_IN_FLIGHT', providerStartedAt: stale });
    const alreadyAmbiguous = await execution(f, {
      status: 'RECONCILIATION_REQUIRED',
      providerStartedAt: stale,
      reconciliationReason: 'provider_outcome_ambiguous',
    });
    const freshReady = await execution(f, { status: 'READY', createdAt: now });
    const freshInFlight = await execution(f, { status: 'PROVIDER_IN_FLIGHT', providerStartedAt: now });

    const result = await scan(f.tenantId, now);

    expect(result).toMatchObject({ scanned: 3, escalated: 3 });
    const surfaced = await fixtureDb.eligibilityExecution.findMany({
      where: { id: { in: [staleReady.id, staleInFlight.id, alreadyAmbiguous.id] } },
      orderBy: { id: 'asc' },
    });
    expect(surfaced).toHaveLength(3);
    expect(surfaced.every(row => row.status === 'MANUAL_EVIDENCE_PENDING')).toBe(true);
    expect(surfaced.every(row => row.reconciliationTaskId !== null)).toBe(true);
    expect(surfaced.every(row => row.reconciliationGeneration === 1)).toBe(true);
    expect(surfaced.every(row => row.providerCompletedAt === null)).toBe(true);

    expect(await fixtureDb.eligibilityExecution.findUniqueOrThrow({ where: { id: freshReady.id } }))
      .toMatchObject({ status: 'READY', reconciliationTaskId: null, reconciliationGeneration: 0 });
    expect(await fixtureDb.eligibilityExecution.findUniqueOrThrow({ where: { id: freshInFlight.id } }))
      .toMatchObject({ status: 'PROVIDER_IN_FLIGHT', reconciliationTaskId: null, reconciliationGeneration: 0 });

    const tasks = await fixtureDb.staffTask.findMany({
      where: { tenantId: f.tenantId, metadata: { path: ['workflow'], equals: 'eligibility_reconciliation' } },
    });
    expect(tasks).toHaveLength(3);
    expect(tasks.every(task => task.status === 'OPEN' && task.assignedToId === null)).toBe(true);
    expect(tasks.every(task => {
      const metadata = task.metadata as Record<string, unknown>;
      return metadata.noAutomaticPayerRetry === true && typeof metadata.eligibilityExecutionId === 'string';
    })).toBe(true);
    expect(await fixtureDb.auditEvent.count({
      where: { tenantId: f.tenantId, action: 'eligibility.execution.manual_evidence_requested' },
    })).toBe(3);
  });

  it('fences overlapping scanners to exactly one task, one audit, and one generation advance', async () => {
    const f = await fixture();
    const now = new Date();
    const row = await execution(f, {
      status: 'RECONCILIATION_REQUIRED',
      providerStartedAt: new Date(now.getTime() - 10 * 60_000),
      reconciliationReason: 'provider_outcome_ambiguous',
    });

    const scans = await Promise.all([scan(f.tenantId, now), scan(f.tenantId, now)]);

    expect(scans.reduce((sum, item) => sum + item.escalated, 0)).toBe(1);
    expect(await fixtureDb.staffTask.count({
      where: { tenantId: f.tenantId, metadata: { path: ['eligibilityExecutionId'], equals: row.id } },
    })).toBe(1);
    expect(await fixtureDb.auditEvent.count({
      where: {
        tenantId: f.tenantId,
        action: 'eligibility.execution.manual_evidence_requested',
        resourceId: row.id,
      },
    })).toBe(1);
    expect(await fixtureDb.eligibilityExecution.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      status: 'MANUAL_EVIDENCE_PENDING',
      reconciliationGeneration: 1,
      reconciliationLeaseOwner: null,
      reconciliationLeaseExpiresAt: null,
    });

    expect(await scan(f.tenantId, new Date(now.getTime() + 2 * 60_000))).toMatchObject({ scanned: 0, escalated: 0 });
    expect(await fixtureDb.eligibilityExecution.findUniqueOrThrow({ where: { id: row.id } }))
      .toMatchObject({ reconciliationGeneration: 1 });
  });

  it('honors tenant scope and advances only an expired lease generation', async () => {
    const first = await fixture();
    const second = await fixture();
    const now = new Date();
    const stale = new Date(now.getTime() - 10 * 60_000);
    const firstRow = await execution(first, {
      status: 'READY',
      createdAt: stale,
      reconciliationGeneration: 7,
      reconciliationLeaseOwner: 'expired-worker',
      reconciliationLeaseExpiresAt: new Date(now.getTime() - 1_000),
    });
    const secondRow = await execution(second, { status: 'READY', createdAt: stale });

    expect(await scan(first.tenantId, now)).toMatchObject({ scanned: 1, escalated: 1 });
    expect(await fixtureDb.eligibilityExecution.findUniqueOrThrow({ where: { id: firstRow.id } })).toMatchObject({
      tenantId: first.tenantId,
      status: 'MANUAL_EVIDENCE_PENDING',
      reconciliationGeneration: 8,
    });
    expect(await fixtureDb.eligibilityExecution.findUniqueOrThrow({ where: { id: secondRow.id } })).toMatchObject({
      tenantId: second.tenantId,
      status: 'READY',
      reconciliationGeneration: 0,
      reconciliationTaskId: null,
    });
    expect(await fixtureDb.staffTask.count({ where: { tenantId: second.tenantId } })).toBe(0);
    expect(await fixtureDb.auditEvent.count({
      where: { tenantId: second.tenantId, action: 'eligibility.execution.manual_evidence_requested' },
    })).toBe(0);
  });

  it('drains 101 stale executions through two concurrent bounded scanners without duplicates or residual leases', async () => {
    const f = await fixture();
    const now = new Date();
    const stale = new Date(now.getTime() - 10 * 60_000);
    const rows = Array.from({ length: 101 }, (_, index) => ({
      ...f,
      idempotencyKeyHash: randomBytes(32).toString('hex'),
      hmacKeyVersion: 'v1',
      requestFingerprint: randomBytes(32).toString('hex'),
      requestContract: 'insurance_v1',
      providerKey: 'test-payer',
      providerMode: 'sandbox',
      status: index % 2 === 0 ? 'READY' as const : 'PROVIDER_IN_FLIGHT' as const,
      createdAt: stale,
      providerStartedAt: index % 2 === 0 ? null : stale,
    }));
    await fixtureDb.eligibilityExecution.createMany({ data: rows });
    expect(env.ELIGIBILITY_RECONCILIATION_BATCH_SIZE).toBe(25);
    expect(env.ELIGIBILITY_RECONCILIATION_MAX_CONCURRENCY).toBe(2);

    const startedAt = performance.now();
    let scanErrors = 0;
    let waves = 0;
    while (await fixtureDb.eligibilityExecution.count({
      where: { tenantId: f.tenantId, status: { in: ['READY', 'PROVIDER_IN_FLIGHT'] } },
    })) {
      const pair = await Promise.all([scan(f.tenantId, now), scan(f.tenantId, now)]);
      scanErrors += pair.reduce((sum, result) => sum + result.errors, 0);
      waves += 1;
      if (waves > 10) throw new Error('configured reconciliation scanners did not converge within ten waves');
    }
    const durationMs = performance.now() - startedAt;

    expect(durationMs).toBeLessThan(10_000);
    expect(scanErrors).toBe(0);
    expect(await fixtureDb.staffTask.count({
      where: { tenantId: f.tenantId, metadata: { path: ['workflow'], equals: 'eligibility_reconciliation' } },
    })).toBe(101);
    expect(await fixtureDb.auditEvent.count({
      where: { tenantId: f.tenantId, action: 'eligibility.execution.manual_evidence_requested' },
    })).toBe(101);
    expect(await fixtureDb.eligibilityExecution.count({
      where: {
        tenantId: f.tenantId,
        OR: [{ reconciliationTaskId: null }, { reconciliationGeneration: { not: 1 } }, { reconciliationLeaseOwner: { not: null } }, { reconciliationLeaseExpiresAt: { not: null } }],
      },
    })).toBe(0);
    expect(await fixtureDb.staffTask.count({ where: { tenantId: f.tenantId, branchId: { not: f.branchId } } })).toBe(0);
    console.info({ case: 'eligibility-reconciliation-101', durationMs: Math.round(durationMs), waves, providerLookups: 0, scanErrors });
  }, 15_000);
});
