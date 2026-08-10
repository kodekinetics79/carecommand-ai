import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { env } from '../config/env';
import type { EligibilityExecution, Prisma } from '../generated/prisma/client';
import { db } from './db';

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{8,128}$/;
const PROVIDER_IN_FLIGHT_STALE_MS = 5 * 60_000;

export class EligibilityExecutionConflictError extends Error {
  constructor(
    public readonly code: 'idempotency_key_reused' | 'execution_in_progress' | 'reconciliation_required' | 'execution_failed',
    public readonly executionId?: string,
  ) {
    super(code);
    this.name = 'EligibilityExecutionConflictError';
  }
}

export function eligibilityIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw request.server.httpErrors.badRequest('Idempotency-Key must contain 8-128 printable ASCII characters');
  }
  return value;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

function eligibilityHmac(secret: string, domain: string, value: string): string {
  return createHmac('sha256', secret)
    .update(`carecommand:${domain}:v1\0${value}`)
    .digest('hex');
}

export function eligibilityRequestIdentitiesForKeys(
  tenantId: string,
  rawKey: string,
  fingerprintParts: Record<string, unknown>,
  keys: ReadonlyArray<{ version: string; secret: string }>,
) {
  return keys.map(key => ({
    hmacKeyVersion: key.version,
    idempotencyKeyHash: eligibilityHmac(key.secret, 'eligibility-idempotency', `${tenantId}\0${rawKey}`),
    requestFingerprint: eligibilityHmac(key.secret, 'eligibility-request', canonicalize({ tenantId, ...fingerprintParts })),
  }));
}

export function eligibilityRequestIdentity(tenantId: string, rawKey: string, fingerprintParts: Record<string, unknown>) {
  return eligibilityRequestIdentitiesForKeys(tenantId, rawKey, fingerprintParts, [{
    version: env.ELIGIBILITY_HMAC_KEY_VERSION,
    secret: env.ELIGIBILITY_HMAC_SECRET ?? env.JWT_SECRET,
  }])[0]!;
}

function eligibilityRequestIdentityCandidates(tenantId: string, rawKey: string, fingerprintParts: Record<string, unknown>) {
  const keys = [{ version: env.ELIGIBILITY_HMAC_KEY_VERSION, secret: env.ELIGIBILITY_HMAC_SECRET ?? env.JWT_SECRET }];
  if (env.ELIGIBILITY_HMAC_PREVIOUS_SECRET && env.ELIGIBILITY_HMAC_PREVIOUS_KEY_VERSION) {
    keys.push({ version: env.ELIGIBILITY_HMAC_PREVIOUS_KEY_VERSION, secret: env.ELIGIBILITY_HMAC_PREVIOUS_SECRET });
  }
  return eligibilityRequestIdentitiesForKeys(tenantId, rawKey, fingerprintParts, keys);
}

type ExecutionContext = {
  tenantId: string;
  branchId: string;
  patientId: string;
  appointmentId?: string | null;
  payerId?: string | null;
  policyId?: string | null;
  actorUserId?: string | null;
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
};

type RunEligibilityExecutionInput<TOutcome, TResult> = {
  context: ExecutionContext;
  rawIdempotencyKey: string;
  fingerprintParts: Record<string, unknown>;
  requestContract: 'insurance_v1' | 'revenue_protection_v1';
  providerKey: string;
  providerMode: string;
  executeProvider: (providerExecutionKey: string) => Promise<TOutcome>;
  finalize: (tx: Prisma.TransactionClient, outcome: TOutcome, executionId: string) => Promise<{ verificationId: string; result: TResult; auditMetadata?: Prisma.InputJsonObject }>;
  replay: (verificationId: string) => Promise<TResult>;
};

export type EligibilityExecutionResult<TResult> = {
  executionId: string;
  replayed: boolean;
  result: TResult;
};

async function createOrLoadExecution<TOutcome, TResult>(input: RunEligibilityExecutionInput<TOutcome, TResult>) {
  const identities = eligibilityRequestIdentityCandidates(
    input.context.tenantId,
    input.rawIdempotencyKey,
    input.fingerprintParts,
  );
  const [{ idempotencyKeyHash, requestFingerprint, hmacKeyVersion }] = identities;
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`eligibility:${input.context.tenantId}:${idempotencyKeyHash}`}, 0))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`eligibility-fingerprint:${input.context.tenantId}:${requestFingerprint}`}, 0))`;
    const existing = await tx.eligibilityExecution.findFirst({
      where: { tenantId: input.context.tenantId, OR: identities.map(identity => ({ idempotencyKeyHash: identity.idempotencyKeyHash })) },
    });
    if (existing) {
      const matchingIdentity = identities.find(identity => identity.hmacKeyVersion === existing.hmacKeyVersion);
      if (!matchingIdentity || existing.requestFingerprint !== matchingIdentity.requestFingerprint) {
        throw new EligibilityExecutionConflictError('idempotency_key_reused', existing.id);
      }
      if (
        existing.status === 'PROVIDER_IN_FLIGHT'
        && existing.providerStartedAt
        && existing.providerStartedAt.getTime() < Date.now() - PROVIDER_IN_FLIGHT_STALE_MS
      ) {
        const stale = await tx.eligibilityExecution.update({
          where: { id: existing.id },
          data: { status: 'RECONCILIATION_REQUIRED', reconciliationReason: 'stale_provider_in_flight' },
        });
        await tx.auditEvent.create({
          data: {
            tenantId: existing.tenantId,
            actorUserId: existing.actorUserId,
            action: 'eligibility.execution.reconciliation_required',
            resource: 'eligibilityExecution',
            resourceId: existing.id,
            metadata: { reason: 'stale_provider_in_flight' },
          },
        });
        return stale;
      }
      return existing;
    }
    const activeByFingerprint = await tx.eligibilityExecution.findFirst({
      where: {
        tenantId: input.context.tenantId,
        requestFingerprint: { in: identities.map(identity => identity.requestFingerprint) },
        status: { in: ['READY', 'PROVIDER_IN_FLIGHT', 'RECONCILIATION_REQUIRED', 'MANUAL_EVIDENCE_PENDING'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (activeByFingerprint) return activeByFingerprint;
    const created = await tx.eligibilityExecution.create({
      data: {
        tenantId: input.context.tenantId,
        branchId: input.context.branchId,
        patientId: input.context.patientId,
        appointmentId: input.context.appointmentId ?? undefined,
        payerId: input.context.payerId ?? undefined,
        policyId: input.context.policyId ?? undefined,
        actorUserId: input.context.actorUserId ?? undefined,
        idempotencyKeyHash,
        hmacKeyVersion,
        requestFingerprint,
        requestContract: input.requestContract,
        providerKey: input.providerKey,
        providerMode: input.providerMode,
      },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: input.context.tenantId,
        actorUserId: input.context.actorUserId ?? undefined,
        action: 'eligibility.execution.requested',
        resource: 'eligibilityExecution',
        resourceId: created.id,
        requestId: input.context.requestId,
        ipAddress: input.context.ipAddress,
        userAgent: input.context.userAgent,
        metadata: {
          requestContract: input.requestContract,
          providerKey: input.providerKey,
          providerMode: input.providerMode,
          branchId: input.context.branchId,
        },
      },
    });
    await tx.businessEvent.create({
      data: {
        tenantId: input.context.tenantId,
        eventType: 'insurance.eligibility.requested',
        entityType: 'eligibilityExecution',
        entityId: created.id,
        sourceModule: 'insurance',
        payload: { provider: input.providerKey, requestContract: input.requestContract },
      },
    });
    return created;
  });
}

async function claimProviderAttempt(execution: EligibilityExecution): Promise<{ execution: EligibilityExecution; claimed: boolean }> {
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`eligibility-execution:${execution.id}`}, 0))`;
    const current = await tx.eligibilityExecution.findFirstOrThrow({
      where: { id: execution.id, tenantId: execution.tenantId },
    });
    if (current.status === 'READY') {
      return { claimed: true, execution: await tx.eligibilityExecution.update({
        where: { id: current.id },
        data: { status: 'PROVIDER_IN_FLIGHT', providerStartedAt: new Date() },
      }) };
    }
    return { claimed: false, execution: current };
  });
}

async function requireReplayable<TResult>(execution: EligibilityExecution, replay: (verificationId: string) => Promise<TResult>): Promise<EligibilityExecutionResult<TResult>> {
  if ((execution.status === 'SUCCEEDED' || execution.status === 'MANUALLY_RECONCILED') && execution.resultVerificationId) {
    return { executionId: execution.id, replayed: true, result: await replay(execution.resultVerificationId) };
  }
  if (execution.status === 'RECONCILIATION_REQUIRED' || execution.status === 'MANUAL_EVIDENCE_PENDING') {
    throw new EligibilityExecutionConflictError('reconciliation_required', execution.id);
  }
  if (execution.status === 'FAILED_DEFINITIVE') {
    throw new EligibilityExecutionConflictError('execution_failed', execution.id);
  }
  throw new EligibilityExecutionConflictError('execution_in_progress', execution.id);
}

async function markReconciliationRequired(execution: EligibilityExecution, reason: string) {
  await db.$transaction(async tx => {
    const updated = await tx.eligibilityExecution.updateMany({
      where: { id: execution.id, tenantId: execution.tenantId, status: 'PROVIDER_IN_FLIGHT' },
      data: {
        status: 'RECONCILIATION_REQUIRED',
        providerCompletedAt: new Date(),
        reconciliationReason: reason,
      },
    });
    if (updated.count) {
      await tx.integrationRunLog.create({
        data: {
          tenantId: execution.tenantId,
          branchId: execution.branchId,
          provider: execution.providerKey,
          providerMode: execution.providerMode,
          operation: 'eligibility.check',
          status: 'reconciliation_required',
          requestSummary: { executionId: execution.id, requestContract: execution.requestContract },
          errorMessage: reason,
        },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: execution.tenantId,
          actorUserId: execution.actorUserId,
          action: 'eligibility.execution.reconciliation_required',
          resource: 'eligibilityExecution',
          resourceId: execution.id,
          metadata: { reason, providerKey: execution.providerKey },
        },
      });
    }
  });
}

export async function runEligibilityExecution<TOutcome, TResult>(input: RunEligibilityExecutionInput<TOutcome, TResult>): Promise<EligibilityExecutionResult<TResult>> {
  const initial = await createOrLoadExecution(input);
  if (initial.status !== 'READY') return requireReplayable(initial, input.replay);

  const claim = await claimProviderAttempt(initial);
  if (!claim.claimed) {
    return requireReplayable(claim.execution, input.replay);
  }
  const claimed = claim.execution;

  let outcome: TOutcome;
  try {
    outcome = await input.executeProvider(claimed.providerExecutionKey);
  } catch {
    await markReconciliationRequired(claimed, 'provider_outcome_ambiguous');
    throw new EligibilityExecutionConflictError('reconciliation_required', claimed.id);
  }

  try {
    const finalized = await db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`eligibility-execution:${claimed.id}`}, 0))`;
      const current = await tx.eligibilityExecution.findFirstOrThrow({ where: { id: claimed.id, tenantId: claimed.tenantId } });
      if (current.status !== 'PROVIDER_IN_FLIGHT') throw new EligibilityExecutionConflictError('reconciliation_required', current.id);
      const persisted = await input.finalize(tx, outcome, claimed.id);
      await tx.auditEvent.create({
        data: {
          tenantId: claimed.tenantId,
          actorUserId: input.context.actorUserId ?? undefined,
          action: 'eligibility.checked',
          resource: 'eligibilityVerification',
          resourceId: persisted.verificationId,
          requestId: input.context.requestId,
          ipAddress: input.context.ipAddress,
          userAgent: input.context.userAgent,
          metadata: { executionId: claimed.id, providerKey: input.providerKey, ...persisted.auditMetadata },
        },
      });
      await tx.eligibilityExecution.update({
        where: { id: claimed.id },
        data: {
          status: 'SUCCEEDED',
          resultVerificationId: persisted.verificationId,
          providerCompletedAt: new Date(),
          completedAt: new Date(),
        },
      });
      return persisted;
    });
    return { executionId: claimed.id, replayed: false, result: finalized.result };
  } catch (error) {
    if (error instanceof EligibilityExecutionConflictError) throw error;
    await markReconciliationRequired(claimed, 'result_persistence_failed');
    throw new EligibilityExecutionConflictError('reconciliation_required', claimed.id);
  }
}

export async function reconcileStaleEligibilityExecutions(tenantId: string, staleBefore: Date): Promise<number> {
  return db.$transaction(async tx => {
    const stale = await tx.eligibilityExecution.findMany({
      where: { tenantId, status: 'PROVIDER_IN_FLIGHT', providerStartedAt: { lt: staleBefore } },
      select: { id: true, actorUserId: true },
    });
    for (const row of stale) {
      await tx.eligibilityExecution.update({
        where: { id: row.id },
        data: { status: 'RECONCILIATION_REQUIRED', reconciliationReason: 'stale_provider_in_flight' },
      });
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorUserId: row.actorUserId,
          action: 'eligibility.execution.reconciliation_required',
          resource: 'eligibilityExecution',
          resourceId: row.id,
          metadata: { reason: 'stale_provider_in_flight' },
        },
      });
    }
    return stale.length;
  });
}

export async function scanEligibilityReconciliationWork(tenantId: string, now = new Date(), limit = env.ELIGIBILITY_RECONCILIATION_BATCH_SIZE) {
  const staleBefore = new Date(now.getTime() - env.ELIGIBILITY_RECONCILIATION_STALE_SECONDS * 1000);
  const leaseOwner = `eligibility-scan:${randomUUID()}`;
  const leaseExpiresAt = new Date(now.getTime() + 60_000);
  const candidates = await db.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM "EligibilityExecution"
      WHERE "tenantId" = ${tenantId}::uuid
        AND "reconciliationTaskId" IS NULL
        AND ("reconciliationLeaseExpiresAt" IS NULL OR "reconciliationLeaseExpiresAt" < ${now})
        AND (
          status = 'RECONCILIATION_REQUIRED'
          OR (status = 'READY' AND "createdAt" < ${staleBefore})
          OR (status = 'PROVIDER_IN_FLIGHT' AND "providerStartedAt" < ${staleBefore})
      )
      ORDER BY "updatedAt" ASC
      LIMIT ${limit}
    `;
  let escalated = 0;
  let errors = 0;
  for (const candidate of candidates) {
    try {
      const didEscalate = await db.$transaction(async tx => {
        const rows = await tx.$queryRaw<Array<{
          id: string; branchId: string; status: EligibilityExecution['status']; reconciliationReason: string | null;
          reconciliationGeneration: number; providerKey: string;
        }>>`
          SELECT id, "branchId", status, "reconciliationReason", "reconciliationGeneration", "providerKey"
          FROM "EligibilityExecution"
          WHERE id = ${candidate.id}::uuid
            AND "tenantId" = ${tenantId}::uuid
            AND "reconciliationTaskId" IS NULL
            AND ("reconciliationLeaseExpiresAt" IS NULL OR "reconciliationLeaseExpiresAt" < ${now})
            AND (
              status = 'RECONCILIATION_REQUIRED'
              OR (status = 'READY' AND "createdAt" < ${staleBefore})
              OR (status = 'PROVIDER_IN_FLIGHT' AND "providerStartedAt" < ${staleBefore})
            )
          FOR UPDATE SKIP LOCKED
        `;
        const row = rows[0];
        if (!row) return false;
        const leased = await tx.eligibilityExecution.updateMany({
          where: {
            id: row.id,
            tenantId,
            status: row.status,
            reconciliationGeneration: row.reconciliationGeneration,
            reconciliationTaskId: null,
            OR: [{ reconciliationLeaseExpiresAt: null }, { reconciliationLeaseExpiresAt: { lt: now } }],
          },
          data: {
            reconciliationLeaseOwner: leaseOwner,
            reconciliationLeaseExpiresAt: leaseExpiresAt,
            reconciliationGeneration: { increment: 1 },
          },
        });
        if (leased.count !== 1) return false;
        const providerCallMayHaveOccurred = row.status !== 'READY';
        const task = await tx.staffTask.create({ data: {
          tenantId,
          branchId: row.branchId,
          title: 'Reconcile ambiguous insurance eligibility response',
          priority: 'high',
          status: 'OPEN',
          dueAt: now,
          metadata: {
            workflow: 'eligibility_reconciliation',
            eligibilityExecutionId: row.id,
            providerKey: row.providerKey,
            providerCallMayHaveOccurred,
            noAutomaticPayerRetry: true,
          },
        } });
        const bound = await tx.eligibilityExecution.updateMany({
          where: {
            id: row.id,
            tenantId,
            status: row.status,
            reconciliationGeneration: row.reconciliationGeneration + 1,
            reconciliationLeaseOwner: leaseOwner,
            reconciliationTaskId: null,
          },
          data: {
            status: 'MANUAL_EVIDENCE_PENDING',
            reconciliationReason: row.reconciliationReason ?? (row.status === 'READY' ? 'stale_ready_without_provider_claim' : 'stale_or_ambiguous_provider_attempt'),
            reconciliationTaskId: task.id,
            reconciliationLeaseOwner: null,
            reconciliationLeaseExpiresAt: null,
          },
        });
        if (bound.count !== 1) throw new Error('Eligibility reconciliation lease was lost');
        await tx.auditEvent.create({ data: {
          tenantId,
          actorUserId: null,
          action: 'eligibility.execution.manual_evidence_requested',
          resource: 'eligibilityExecution',
          resourceId: row.id,
          metadata: { taskId: task.id, providerKey: row.providerKey, providerCallMayHaveOccurred, noAutomaticPayerRetry: true },
        } });
        return true;
      });
      if (didEscalate) escalated += 1;
    } catch {
      // A malformed or concurrently corrupted row must not prevent other tenant
      // work from becoming visible. The worker reports only aggregate counts.
      errors += 1;
    }
  }
  return { scanned: candidates.length, escalated, errors };
}
