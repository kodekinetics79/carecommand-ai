// ===========================================================================
// Stranded-call reconciler — closing the rows the provider is finished with.
//
// WHY THIS POLLS INSTEAD OF WAITING FOR A WEBHOOK
//
// A call the provider never starts sends no lifecycle webhook. There is no
// `call_ended`, no `call_analyzed`, nothing — because from the provider's point
// of view nothing happened worth reporting. The local row it left behind stays
// `outcome: IN_PROGRESS` with `endedAt: null` forever, its
// `ReceptionistCallTarget` stays `CALLING` and can never be dialled again, and
// the row counts against tenant concurrency permanently. Verified in production
// on 2026-08-31.
//
// Webhook loss is the NORMAL case here, not an exception:
//
//   * a malformed per-call webhook URL made the provider's delivery attempts
//     fail with a permanent 400 — every call in that window lost every event;
//   * a "never connected" call has no lifecycle to report in the first place;
//   * a delivery that is retried and exhausted is silently dropped.
//
// Retries cannot fix any of those, because the failure is not transient. A
// system that only learns what happened when someone tells it does not
// converge. This one asks. Every tick, every non-terminal row past its expiry
// is compared against the provider's own record of the call, and the answer is
// written down.
//
// WHAT THIS IS NOT ALLOWED TO DO
//
//   1. A DB trigger (`ReceptionistCallLog_first_terminal_outcome_trg`) makes
//      the FIRST terminal outcome immutable. There is exactly one write per
//      row, and no way to correct it. So nothing provisional is ever written:
//      a row is closed only when the provider states a terminal status, or
//      when there is no provider call id at all — which is itself final
//      evidence that the call never reached the provider.
//
//   2. A business outcome may only come from a real conversation. `BOOKED`,
//      `NOT_INTERESTED`, `OPTED_OUT` and recording consent are decisions the
//      patient made, and this reconciler was not on the call. It may close a
//      call and record the minutes it burned; it may never decide what the
//      patient agreed to. A provider call that technically ENDED but produced
//      no signed analysis is closed `ESCALATED` and handed to a person —
//      the same disposition the manual provider-sync route already takes.
// ===========================================================================

import { env } from '../../config/env';
import { db } from '../db';
import { captureException } from '../observability';
import { getPhoneCall, type RetellCallSnapshot } from '../retell';
import { requireTenantContext } from '../tenantContext';
import { recordUsageEvent, voiceCallDedupeKey, USAGE_METRICS } from '../usageMetering';
// `targetStatusAfterOutcome` is the single definition of the campaign retry
// policy and must not be forked here — a target this reconciler releases has to
// land in exactly the state the webhook path would have put it in. It lives in
// the outbound route module today; extracting it into this directory is the
// right follow-up, and would stop the worker pulling a Fastify route module in.
import { DEFAULT_VOICE_MINUTES_LIMIT, targetStatusAfterOutcome } from '../../modules/receptionist/outbound';
import type { ReceptionistCallOutcome } from '../../generated/prisma/client';

export const CALL_RECONCILIATION_ACTOR = 'worker:receptionist-call-reconciliation';

/** Outcomes this reconciler is permitted to write. Deliberately excludes every
 *  outcome that asserts something the patient said or agreed to. */
export type ReconciledTerminalOutcome = Extract<
  ReceptionistCallOutcome,
  'FAILED' | 'NO_ANSWER' | 'VOICEMAIL' | 'ESCALATED'
>;

/**
 * Map a provider call snapshot to the terminal outcome it justifies, or `null`
 * when the provider does not yet claim the call is over.
 *
 * This mirrors the mapping the manual `provider-sync` route applies, so a
 * staff-triggered sync and an automatic tick close the same call the same way.
 * `not_connected` and a `user_declined` disconnection are NO_ANSWER: the phone
 * was never answered by a person, which is precisely what the campaign retry
 * policy means by "no answer".
 */
export function providerTerminalOutcome(
  snapshot: Pick<RetellCallSnapshot, 'status' | 'disconnectionReason'>,
): ReconciledTerminalOutcome | null {
  const reason = (snapshot.disconnectionReason ?? '').toLowerCase();
  if (snapshot.status === 'error') return 'FAILED';
  if (reason.includes('voicemail')) {
    // Voicemail is only meaningful once the provider says the call is over.
    if (snapshot.status === 'not_connected' || snapshot.status === 'ended') return 'VOICEMAIL';
  }
  if (snapshot.status === 'not_connected') return 'NO_ANSWER';
  if (snapshot.status === 'ended') {
    const unanswered = ['no_answer', 'unanswered', 'busy', 'user_declined', 'dial_failed', 'dial_busy']
      .some(marker => reason.includes(marker));
    if (unanswered) return 'NO_ANSWER';
    // Technically ended, but nothing here is evidence of what was said. A human
    // decides; see the staff task raised alongside this outcome.
    return 'ESCALATED';
  }
  // 'registered' | 'ongoing' | 'unknown' — the provider has not finished with
  // this call. The one write we get is not spent on a guess.
  return null;
}

export interface CallReconciliationSummary {
  /** Non-terminal rows past their deadline that this pass considered. */
  scanned: number;
  /** Rows closed with a terminal outcome. */
  closed: number;
  /** Of `closed`, those with no provider call id at all. */
  closedWithoutProviderId: number;
  /** Rows the provider still reports as live/registered — left untouched. */
  stillActive: number;
  /** Rows whose provider snapshot did not belong to them — never written. */
  quarantined: number;
  /** Rows the provider could not be asked about this pass. */
  errors: number;
}

const EMPTY_SUMMARY: CallReconciliationSummary = {
  scanned: 0, closed: 0, closedWithoutProviderId: 0, stillActive: 0, quarantined: 0, errors: 0,
};

type CloseResult = 'closed' | 'already_terminal' | 'not_found' | 'no_longer_due';

interface CloseInput {
  tenantId: string;
  callLogId: string;
  outcome: ReconciledTerminalOutcome;
  /** Null when there is no provider call id — nothing to read minutes from. */
  snapshot: RetellCallSnapshot | null;
  reason: 'no_provider_call_id' | 'provider_terminal';
  now: Date;
}

/**
 * A provider snapshot is only trusted for the row it actually belongs to.
 *
 * The call id came from our own row (not from user input), and `getPhoneCall`
 * already refuses a response whose `call_id` differs from the one requested, so
 * the binding is strong before we get here. This is the residual check: if the
 * provider's own metadata NAMES a different tenant or call log, that snapshot
 * describes someone else's call and must never be written to this row.
 * Absent metadata is not a mismatch — inbound rows legitimately carry none.
 */
function snapshotContradictsRow(
  snapshot: RetellCallSnapshot,
  row: { id: string; tenantId: string; outboundCampaignId: string | null },
): boolean {
  const metaTenant = snapshot.metadata.tenantId;
  if (typeof metaTenant === 'string' && metaTenant !== row.tenantId) return true;
  const metaCallLog = snapshot.metadata.callLogId;
  if (typeof metaCallLog === 'string' && metaCallLog !== row.id) return true;
  const metaCampaign = snapshot.metadata.outboundCampaignId;
  if (typeof metaCampaign === 'string' && row.outboundCampaignId && metaCampaign !== row.outboundCampaignId) return true;
  return false;
}

/**
 * Write the terminal outcome for exactly one call row.
 *
 * Idempotent by construction: the row is re-read under the same per-call
 * advisory lock the webhook and provider-sync paths take, and anything already
 * terminal is left alone. Two overlapping ticks therefore produce one write,
 * one target release, and one usage event — the second tick finds the row
 * closed and does nothing.
 */
async function closeCall(input: CloseInput): Promise<CloseResult> {
  const { tenantId, callLogId, outcome, snapshot, now } = input;
  return db.$transaction(async tx => {
    const current = await tx.receptionistCallLog.findFirst({
      where: { id: callLogId, tenantId },
      select: {
        id: true, retellCallId: true, outcome: true, durationSeconds: true,
        startedAt: true, endedAt: true, deadlineAt: true,
        targetId: true, outboundCampaignId: true,
        outboundCampaign: { select: { defaultBranchId: true, maxRetryAttempts: true } },
      },
    });
    if (!current) return 'not_found';

    // Same lock key the webhook and provider-sync paths use, so a lifecycle
    // event arriving mid-tick serialises against this write rather than racing it.
    const lockKey = `receptionist-call-lifecycle:${tenantId}:${current.retellCallId ?? current.id}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;

    // Re-read under the lock: a webhook may have closed the row between the
    // scan and now, and the first terminal outcome is immutable.
    const locked = await tx.receptionistCallLog.findFirst({
      where: { id: callLogId, tenantId },
      select: { outcome: true, durationSeconds: true, startedAt: true, endedAt: true, deadlineAt: true },
    });
    if (!locked) return 'not_found';
    if (locked.outcome !== 'IN_PROGRESS' || locked.endedAt !== null) return 'already_terminal';
    if (!locked.deadlineAt || locked.deadlineAt >= now) return 'no_longer_due';

    const providerSeconds = snapshot ? Math.max(0, Math.round(snapshot.durationMs / 1_000)) : 0;
    const durationSeconds = Math.max(locked.durationSeconds, providerSeconds);
    const providerStartedAt = snapshot?.startTimestamp ? new Date(snapshot.startTimestamp) : null;
    const providerEndedAt = snapshot?.endTimestamp ? new Date(snapshot.endTimestamp) : null;

    const updated = await tx.receptionistCallLog.update({
      where: { id: callLogId },
      data: {
        outcome,
        durationSeconds,
        startedAt: locked.startedAt ?? providerStartedAt ?? undefined,
        endedAt: providerEndedAt ?? now,
      },
      select: { id: true, durationSeconds: true, endedAt: true },
    });

    // Minutes actually burned are a fact about the call, not a claim about the
    // conversation, so the reconciler is allowed to record them. The dedupe key
    // is cumulative-minutes based, so a redelivered webhook cannot double-bill.
    const priorMinutes = Math.ceil(locked.durationSeconds / 60);
    const finalMinutes = Math.ceil(updated.durationSeconds / 60);
    const deltaMinutes = Math.max(0, finalMinutes - priorMinutes);
    if (deltaMinutes > 0) {
      await recordUsageEvent(tx, {
        tenantId,
        metric: USAGE_METRICS.voiceMinute,
        quantity: deltaMinutes,
        occurredAt: updated.endedAt ?? now,
        sourceModule: 'receptionist',
        sourceType: 'receptionistCallLog',
        sourceId: updated.id,
        dedupeKey: voiceCallDedupeKey(current.retellCallId ?? updated.id, finalMinutes),
      });
      await tx.tenantAiUsage.upsert({
        where: { tenantId },
        update: { receptionistMinutes: { increment: deltaMinutes } },
        create: { tenantId, receptionistMinutes: deltaMinutes },
      });
      await tx.tenantUsageLimit.upsert({
        where: { tenantId_key: { tenantId, key: 'voice_minutes' } },
        update: { used: { increment: deltaMinutes } },
        create: { tenantId, key: 'voice_minutes', limitValue: DEFAULT_VOICE_MINUTES_LIMIT, used: deltaMinutes },
      });
    }

    // Release the target. A target left in CALLING can never be dialled again,
    // so this is half the point of the whole job.
    let targetStatus: string | null = null;
    if (current.targetId && current.outboundCampaignId && current.outboundCampaign) {
      const target = await tx.receptionistCallTarget.findFirst({
        where: { id: current.targetId, tenantId, campaignId: current.outboundCampaignId },
        select: { id: true, attempts: true, status: true, lastCallLogId: true },
      });
      // Only release a target still held BY THIS CALL. One that has moved on to
      // a newer attempt is not ours to touch.
      if (target && target.status === 'CALLING' && target.lastCallLogId === current.id) {
        const next = targetStatusAfterOutcome(outcome, target.attempts, current.outboundCampaign.maxRetryAttempts);
        if (next) {
          const released = await tx.receptionistCallTarget.updateMany({
            where: { id: target.id, tenantId, campaignId: current.outboundCampaignId, status: 'CALLING', lastCallLogId: current.id },
            data: { status: next, lastOutcome: outcome },
          });
          if (released.count === 1) targetStatus = next;
        }
      }
    }

    // A call the provider says ENDED, with no signed analysis behind it, cannot
    // be turned into an appointment, a consent, or a campaign result by this
    // job. Put it in front of a person exactly once.
    if (outcome === 'ESCALATED') {
      const workflowKey = `call_reconciler_review:${current.id}`;
      const existing = await tx.staffTask.findFirst({
        where: { tenantId, metadata: { path: ['workflowKey'], equals: workflowKey } },
        select: { id: true },
      });
      if (!existing) {
        await tx.staffTask.create({ data: {
          tenantId,
          branchId: current.outboundCampaign?.defaultBranchId ?? null,
          title: 'Review AI receptionist call closed without provider analysis',
          priority: 'HIGH',
          callLogId: current.id,
          metadata: {
            workflow: 'receptionist_call_reconciliation',
            workflowKey,
            callLogId: current.id,
            reason: 'provider_ended_without_signed_analysis',
          },
        } });
      }
    }

    await tx.auditEvent.create({ data: {
      tenantId,
      actorUserId: null,
      action: 'receptionist.call.reconciled',
      resource: 'receptionistCallLog',
      resourceId: current.id,
      metadata: {
        reason: input.reason,
        outcome,
        targetStatus,
        deltaMinutes,
        // Provider-derived identifiers and statuses only. No transcript, no
        // recording, no phone number, no free-text analysis.
        providerStatus: snapshot?.status ?? null,
        providerDisconnectionReason: snapshot?.disconnectionReason ?? null,
        hadProviderCallId: current.retellCallId !== null,
      },
    } });

    return 'closed';
  }, { timeout: 15_000 });
}

/**
 * One reconciliation pass for one tenant.
 *
 * MUST be called with an active tenant context (see the worker). Every read and
 * write below goes through `db`, which opens a tenant-scoped transaction with
 * the RLS GUCs applied — so a pass that somehow ran unscoped reads nothing and
 * throws rather than quietly reconciling the wrong tenant, or nobody.
 */
export async function reconcileStrandedCalls(
  tenantId: string,
  now: Date = new Date(),
  limit: number = env.RECEPTIONIST_CALL_RECONCILIATION_BATCH_SIZE,
): Promise<CallReconciliationSummary> {
  const context = requireTenantContext();
  if (context.tenantId !== tenantId) {
    throw new Error('Call reconciliation: active tenant context does not match the tenant being reconciled (fail-closed)');
  }

  const candidates = await db.receptionistCallLog.findMany({
    where: {
      tenantId,
      outcome: 'IN_PROGRESS',
      endedAt: null,
      deadlineAt: { not: null, lt: now },
    },
    orderBy: { deadlineAt: 'asc' },
    take: limit,
    select: { id: true, tenantId: true, retellCallId: true, outboundCampaignId: true },
  });

  const summary: CallReconciliationSummary = { ...EMPTY_SUMMARY, scanned: candidates.length };

  for (const candidate of candidates) {
    try {
      // No provider call id means the call demonstrably never reached the
      // provider: there is nothing to ask about and nothing that can arrive
      // later to contradict it. FAILED is the terminal truth.
      //
      // It is also the one first-terminal value the DB trigger permits to be
      // upgraded (FAILED with a null provider id -> ESCALATED once an id turns
      // up), so a late provider acceptance is still recoverable.
      if (!candidate.retellCallId) {
        const result = await closeCall({
          tenantId, callLogId: candidate.id, outcome: 'FAILED',
          snapshot: null, reason: 'no_provider_call_id', now,
        });
        if (result === 'closed') { summary.closed += 1; summary.closedWithoutProviderId += 1; }
        continue;
      }

      const provider = await getPhoneCall(candidate.retellCallId);
      if (!provider.ok) {
        // The provider could not be asked. Nothing is written; the row stays
        // due and the next tick asks again. Convergence is the point.
        summary.errors += 1;
        continue;
      }
      if (snapshotContradictsRow(provider.call, candidate)) {
        summary.quarantined += 1;
        captureException(new Error('Receptionist call reconciliation: provider snapshot does not belong to this call log'), {
          route: 'worker:receptionist-call-reconciliation', tenantId,
        });
        continue;
      }

      const outcome = providerTerminalOutcome(provider.call);
      if (!outcome) { summary.stillActive += 1; continue; }

      const result = await closeCall({
        tenantId, callLogId: candidate.id, outcome,
        snapshot: provider.call, reason: 'provider_terminal', now,
      });
      if (result === 'closed') summary.closed += 1;
    } catch (error) {
      summary.errors += 1;
      captureException(error instanceof Error ? error : new Error(String(error)), {
        route: 'worker:receptionist-call-reconciliation', tenantId,
      });
    }
  }

  return summary;
}
