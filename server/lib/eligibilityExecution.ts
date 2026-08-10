import { createHmac } from 'node:crypto';
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
  if (execution.status === 'SUCCEEDED' && execution.resultVerificationId) {
    return { executionId: execution.id, replayed: true, result: await replay(execution.resultVerificationId) };
  }
  if (execution.status === 'RECONCILIATION_REQUIRED') {
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
