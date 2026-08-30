import { env } from '../../config/env';
import { db } from '../db';
import { remediationFor } from './remediation';
import { verifyAgentProvider, type VerifyOutcome } from './agentVerification';

// ===========================================================================
// Hourly re-verification.
//
// A verification is valid for 24 hours and then fails closed — which is right,
// but on its own it means a clinic that did nothing wrong wakes up to a
// receptionist that has stopped answering. This job renews attestations before
// they lapse, and when renewal genuinely fails it puts a task in front of
// staff instead of letting the line go quiet unannounced.
//
// It never invents a verification: renewal is the same probe the operator's
// own Verify button runs, and a failure is recorded as a failure.
// ===========================================================================

export const REVERIFY_LEAD_MS = env.RECEPTIONIST_REVERIFY_LEAD_MS;

/** Do not hammer a provider that just failed for this agent under the worker. */
const SYSTEM_RETRY_INTERVAL_MS = 30 * 60 * 1_000;
const BATCH_SIZE = 50;

export interface ReverifySummary {
  scanned: number;
  renewed: number;
  failed: number;
  transient: number;
  driftBlocked: number;
  skipped: number;
}

type VerifyFn = typeof verifyAgentProvider;
let verifyHook: VerifyFn | null = null;

/** Test seam, mirroring setConfirmationBoundaryTestHook. Never wired in production. */
export function setReverifyTestHooks(hook: VerifyFn | null): void {
  if (process.env.NODE_ENV === 'production' && hook) throw new Error('reverify_hook_test_only');
  verifyHook = hook;
}

export async function reverifyExpiringAgents(tenantId: string, now = new Date()): Promise<ReverifySummary> {
  const verify = verifyHook ?? verifyAgentProvider;
  const summary: ReverifySummary = { scanned: 0, renewed: 0, failed: 0, transient: 0, driftBlocked: 0, skipped: 0 };

  const candidates = await db.receptionistAgent.findMany({
    where: {
      tenantId,
      active: true,
      providerStatus: 'VERIFIED',
      providerVerificationExpiresAt: { lte: new Date(now.getTime() + REVERIFY_LEAD_MS) },
    },
    orderBy: { providerVerificationExpiresAt: 'asc' },
    take: BATCH_SIZE,
    select: {
      id: true, clinicId: true, name: true,
      providerLastAttemptAt: true, providerLastAttemptSource: true, providerLastAttemptStatus: true,
      providerVerificationExpiresAt: true,
    },
  });

  for (const agent of candidates) {
    summary.scanned += 1;
    const lastSystemFailure = agent.providerLastAttemptSource === 'SYSTEM'
      && agent.providerLastAttemptStatus === 'FAILED'
      && agent.providerLastAttemptAt
      && now.getTime() - agent.providerLastAttemptAt.getTime() < SYSTEM_RETRY_INTERVAL_MS;
    if (lastSystemFailure) {
      summary.skipped += 1;
      continue;
    }

    const outcome = await verify({
      tenantId,
      agentId: agent.id,
      actor: {
        userId: null,
        source: 'SYSTEM',
        trustedActor: { id: 'worker:receptionist-agent-reverify', role: 'WORKER' },
      },
      now,
      skipCooldown: true,
    });

    if (outcome.kind === 'verified') {
      summary.renewed += 1;
      continue;
    }
    if (outcome.kind === 'failed' && !outcome.permanent) {
      // Still VERIFIED and still working; the next hourly pass retries. Only
      // raise it to staff when the expiry is close enough to actually bite.
      summary.transient += 1;
      const expiresInMs = agent.providerVerificationExpiresAt ? agent.providerVerificationExpiresAt.getTime() - now.getTime() : 0;
      if (expiresInMs < 2 * 60 * 60 * 1_000) {
        await raiseAttention(tenantId, { agentId: agent.id, clinicId: agent.clinicId, code: outcome.code, priority: 'MEDIUM', now });
      }
      continue;
    }
    if (outcome.kind === 'drift_blocked') summary.driftBlocked += 1;
    else if (outcome.kind === 'failed') summary.failed += 1;
    else {
      summary.skipped += 1;
      continue;
    }
    const code = outcome.kind === 'drift_blocked' ? outcome.code : outcome.code;
    await raiseAttention(tenantId, { agentId: agent.id, clinicId: agent.clinicId, code, priority: 'HIGH', now });
  }

  return summary;
}

/**
 * One open task per (agent, code). Idempotent on purpose: an agent that keeps
 * failing every hour must produce one thing to act on, not a queue of
 * identical rows nobody reads.
 */
async function raiseAttention(
  tenantId: string,
  input: { agentId: string; clinicId: string; code: string; priority: 'HIGH' | 'MEDIUM'; now: Date },
): Promise<void> {
  const remediation = remediationFor(input.code, { agentId: input.agentId, clinicId: input.clinicId });
  const existing = await db.staffTask.findFirst({
    where: {
      tenantId,
      status: { in: ['OPEN', 'IN_PROGRESS'] },
      AND: [
        { metadata: { path: ['workflow'], equals: 'receptionist_deployment' } },
        { metadata: { path: ['agentId'], equals: input.agentId } },
        { metadata: { path: ['code'], equals: input.code } },
      ],
    },
    select: { id: true },
  });
  if (existing) return;

  // The task lands on the branch a mapped location points at, so it reaches the
  // desk that actually answers for this clinic.
  const location = await db.receptionistLocation.findFirst({
    where: { tenantId, clinicId: input.clinicId, active: true, branchId: { not: null } },
    select: { branchId: true },
  });

  await db.staffTask.create({ data: {
    tenantId,
    branchId: location?.branchId ?? null,
    title: 'AI receptionist deployment needs attention',
    priority: input.priority,
    status: 'OPEN',
    dueAt: new Date(input.now.getTime() + 60 * 60 * 1_000),
    metadata: {
      workflow: 'receptionist_deployment',
      agentId: input.agentId,
      clinicId: input.clinicId,
      code: input.code,
      title: remediation.title,
      action: remediation.action,
      fixHref: remediation.fixHref,
    },
  } });
}

export type { VerifyOutcome };
