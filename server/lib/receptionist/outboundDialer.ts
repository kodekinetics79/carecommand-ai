// ===========================================================================
// The dialler — one pass over a tenant's campaigns.
//
// WHAT IT DOES
//
// Until now a clinic dialled by clicking Call, once per patient. This walks a
// RUNNING campaign's PENDING targets and dials them on its own, at the pace
// the clinic set, until the campaign's concurrency ceiling is reached or the
// pass budget is spent.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// It does not decide whether a phone may ring. Every such decision —
// kill switch, demo-tenant block, shared suppression, DNC, quiet hours,
// per-tenant concurrency, voice-minute budget, live-test caps, campaign
// authority, target identity binding, and the durable provider intent — is
// made by `launchOutboundCall`, the same function the HTTP route calls. This
// module chooses WHICH target to offer and WHEN to stop offering; it never
// re-implements a gate, because a second copy of a gate is a gate that will
// eventually disagree with the first, and the first disagreement is a call
// placed to a number on the do-not-call list.
//
// The three checks that do appear here are not copies. They are calls to the
// exact same exported functions the launch path uses (`outboundStopped`,
// `quietHoursConfigurationReason`, `isWithinQuietHours`, `isTargetDialable`),
// asked earlier for a different reason: to avoid grinding. A dialler that
// selects a target it knows will be refused burns a launch attempt, an audit
// row and a database round trip per pass, all night. Asking first is pacing.
// The refusal is still the launch path's, and it is still the one that counts.
//
// TIMEZONES
//
// Quiet hours are evaluated in the CLINIC's timezone — `ReceptionistClinic.
// timezone`, the location record the campaign's branch maps to — never the
// server's, and never `new Date()` arithmetic. That is the same timezone the
// fence inside `launchOutboundCall` uses. Using a different one here (the
// Branch row also carries a timezone, and it can differ) would produce exactly
// the drift this module exists to avoid: a pacer that thinks the window is
// open and a fence that refuses, or worse, the reverse.
//
// Nothing here imports a Fastify route, a Fastify type, or `app`.
// ===========================================================================

import { env } from '../../config/env';
import { db } from '../db';
import { requireTenantContext } from '../tenantContext';
import { DIALABLE_TARGET_STATUS, isTargetDialable } from './outboundPolicy';
import {
  isWithinQuietHours,
  launchOutboundCall,
  outboundStopped,
  quietHoursConfigurationReason,
  RUNNABLE_CAMPAIGN_STATUS,
  type LaunchActor,
} from './outboundLaunch';

export const OUTBOUND_DIAL_ACTOR = 'worker:receptionist-outbound-dial';

export interface DialPassSummary {
  /** RUNNING campaigns with the dialler switched on. */
  campaignsConsidered: number;
  campaignsSkippedQuietHours: number;
  campaignsSkippedMisconfigured: number;
  campaignsAtConcurrencyCeiling: number;
  targetsConsidered: number;
  /** Targets held back because the clinic's minimum gap since the last call
   *  has not elapsed. Two calls in an hour is how a number gets a spam label. */
  targetsHeldByRetryGap: number;
  launched: number;
  /** The launch path declined to dial and said so truthfully (suppressed,
   *  quiet hours it saw and we did not, provider unconfigured). */
  skipped: number;
  /** A fence refused the dial. */
  blocked: number;
  /** The tenant kill switch was on, or came on part-way through the pass. */
  stoppedByKillSwitch: boolean;
}

const EMPTY_SUMMARY: DialPassSummary = {
  campaignsConsidered: 0,
  campaignsSkippedQuietHours: 0,
  campaignsSkippedMisconfigured: 0,
  campaignsAtConcurrencyCeiling: 0,
  targetsConsidered: 0,
  targetsHeldByRetryGap: 0,
  launched: 0,
  skipped: 0,
  blocked: 0,
  stoppedByKillSwitch: false,
};

export interface DialPassOptions {
  now?: Date;
  /** Correlates every audit row this pass writes. */
  runId: string;
  /** The BullMQ job id, written to `AuditEvent.requestId` for a worker actor. */
  jobId: string;
  /** Ceiling for the whole pass, defaulting to the configured per-pass cap. */
  limit?: number;
  intervalSeconds?: number;
}

/**
 * How many dials one pass may start for one campaign.
 *
 * The clinic sets calls per minute; the pacer runs every
 * `RECEPTIONIST_OUTBOUND_DIAL_INTERVAL_SECONDS`. The budget is what those two
 * numbers imply, floored at one so a slow campaign still makes progress rather
 * than rounding down to nothing forever, and capped so a misconfigured rate
 * cannot flood the queue in a single tick.
 */
export function perPassBudget(callsPerMinute: number, intervalSeconds: number, hardCap: number): number {
  return Math.max(1, Math.min(hardCap, Math.ceil((callsPerMinute * intervalSeconds) / 60)));
}

/**
 * Calls that could still be live for this campaign.
 *
 * Deadline-aware for the same reason the tenant-wide capacity query is: a call
 * the provider accepted and never connected sends no lifecycle webhook, so its
 * row never closes on its own. Counting those forever walks a campaign to its
 * ceiling and parks it there. A row with a NULL deadline still counts — "we
 * cannot tell whether this call is over" is never "this call is over".
 */
async function countCampaignInFlight(tenantId: string, campaignId: string, now: Date): Promise<number> {
  return db.receptionistCallLog.count({
    where: {
      tenantId,
      outboundCampaignId: campaignId,
      outcome: 'IN_PROGRESS',
      endedAt: null,
      OR: [{ deadlineAt: null }, { deadlineAt: { gt: now } }],
    },
  });
}

type DialCandidate = { id: string; phone: string; attempts: number; status: string; lastCallLogId: string | null };

/**
 * The targets this campaign may offer next, oldest first.
 *
 * `status = PENDING` is the index-friendly predicate; `isTargetDialable` is
 * the authoritative one and stays the single definition of the rule. The
 * claim that actually takes the target is inside `launchOutboundCall` and is
 * atomic, so this list is a suggestion, never a reservation: two passes that
 * both suggest the same target still produce exactly one dial.
 */
async function selectCandidates(
  tenantId: string,
  campaign: { id: string; maxRetryAttempts: number; dialerRetryGapMinutes: number },
  now: Date,
  want: number,
): Promise<{ candidates: DialCandidate[]; considered: number; heldByRetryGap: number }> {
  const rows = await db.receptionistCallTarget.findMany({
    where: { tenantId, campaignId: campaign.id, status: DIALABLE_TARGET_STATUS },
    orderBy: [{ createdAt: 'asc' }],
    // Over-read so the retry-gap filter below still has candidates to offer.
    take: Math.min(want * 4, 200),
    select: { id: true, phone: true, attempts: true, status: true, lastCallLogId: true },
  });
  const dialable = rows.filter(row => isTargetDialable(row.status, row.attempts, campaign.maxRetryAttempts));

  if (campaign.dialerRetryGapMinutes <= 0) {
    return { candidates: dialable.slice(0, want), considered: dialable.length, heldByRetryGap: 0 };
  }

  // The previous attempt is read by primary key off the target's own
  // `lastCallLogId`, so this costs one indexed lookup and needs no new index.
  const lastCallIds = dialable.map(row => row.lastCallLogId).filter((id): id is string => Boolean(id));
  const lastCalls = lastCallIds.length
    ? await db.receptionistCallLog.findMany({
      where: { tenantId, id: { in: lastCallIds } },
      select: { id: true, startedAt: true, createdAt: true },
    })
    : [];
  const lastCallAt = new Map(lastCalls.map(call => [call.id, call.startedAt ?? call.createdAt]));
  const gapMs = campaign.dialerRetryGapMinutes * 60_000;

  const candidates: DialCandidate[] = [];
  let heldByRetryGap = 0;
  for (const row of dialable) {
    const previous = row.lastCallLogId ? lastCallAt.get(row.lastCallLogId) : null;
    if (previous && now.getTime() - previous.getTime() < gapMs) {
      heldByRetryGap += 1;
      continue;
    }
    candidates.push(row);
    if (candidates.length >= want) break;
  }
  return { candidates, considered: dialable.length, heldByRetryGap };
}

/**
 * One dialling pass for one tenant.
 *
 * The caller must already hold that tenant's context (the worker establishes
 * it with `runInTenantContext`); this asserts it and fails closed rather than
 * dialling for nobody, or for the wrong clinic.
 */
export async function runOutboundDialPass(
  tenantId: string,
  options: DialPassOptions,
): Promise<DialPassSummary> {
  const context = requireTenantContext();
  if (context.tenantId !== tenantId) {
    throw new Error('Outbound dial pass: active tenant context does not match the tenant being dialled (fail-closed)');
  }

  const now = options.now ?? new Date();
  const intervalSeconds = options.intervalSeconds ?? env.RECEPTIONIST_OUTBOUND_DIAL_INTERVAL_SECONDS;
  const passLimit = options.limit ?? env.RECEPTIONIST_OUTBOUND_DIAL_MAX_PER_PASS;
  const actor: LaunchActor = { kind: 'worker', jobId: options.jobId, runId: options.runId };
  const summary: DialPassSummary = { ...EMPTY_SUMMARY };

  // The kill switch, asked first and asked cheaply. This is the pacing copy;
  // the load-bearing one is inside the provider-intent transaction in the
  // launch path, which no dial can escape. Asking here is what makes a stop
  // INSTANT rather than "after the batch already in flight" — a stopped tenant
  // claims nothing, dials nothing and writes no audit rows at all.
  if (await outboundStopped(tenantId)) return { ...summary, stoppedByKillSwitch: true };

  const campaigns = await db.receptionistOutboundCampaign.findMany({
    where: { tenantId, status: RUNNABLE_CAMPAIGN_STATUS, dialerEnabled: true },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      quietHoursStart: true,
      quietHoursEnd: true,
      maxRetryAttempts: true,
      dialerMaxConcurrentCalls: true,
      dialerCallsPerMinute: true,
      dialerRetryGapMinutes: true,
      clinic: { select: { timezone: true } },
    },
  });
  summary.campaignsConsidered = campaigns.length;

  let remaining = passLimit;
  for (const campaign of campaigns) {
    if (remaining <= 0) break;

    // Quiet hours, in the clinic's timezone, from the same two functions the
    // fence uses. A misconfigured window is a deployment error and is treated
    // as quiet: never as implicit permission to dial.
    const misconfigured = quietHoursConfigurationReason(
      campaign.quietHoursStart,
      campaign.quietHoursEnd,
      campaign.clinic.timezone,
      true,
    );
    if (misconfigured) {
      summary.campaignsSkippedMisconfigured += 1;
      continue;
    }
    if (isWithinQuietHours(campaign.quietHoursStart, campaign.quietHoursEnd, campaign.clinic.timezone)) {
      summary.campaignsSkippedQuietHours += 1;
      continue;
    }

    const budget = Math.min(
      remaining,
      perPassBudget(campaign.dialerCallsPerMinute, intervalSeconds, env.RECEPTIONIST_OUTBOUND_DIAL_MAX_PER_PASS),
    );
    const { candidates, considered, heldByRetryGap } = await selectCandidates(tenantId, campaign, now, budget);
    summary.targetsConsidered += considered;
    summary.targetsHeldByRetryGap += heldByRetryGap;
    if (candidates.length === 0) continue;

    let ceilingHit = false;
    // A campaign-scoped refusal (authority changed, agent went unverified, the
    // window shut a second ago) will refuse every remaining patient for the
    // same reason. Offering all twenty-five of them anyway produces
    // twenty-five identical audit rows and no dials. Three in a row is enough
    // evidence that the problem is the campaign, not the patient.
    let consecutiveBlocks = 0;
    for (const target of candidates) {
      if (remaining <= 0) break;

      // Re-asked before EVERY dial, not once per pass. An operator who hits
      // stop while a pass is running must be obeyed on the next target, not
      // after the batch finishes.
      if (await outboundStopped(tenantId)) {
        summary.stoppedByKillSwitch = true;
        return summary;
      }

      // Counted before every dial too, because the previous dial in this loop
      // has already taken a slot.
      if (await countCampaignInFlight(tenantId, campaign.id, now) >= campaign.dialerMaxConcurrentCalls) {
        ceilingHit = true;
        break;
      }

      // The whole point of this module. Every fence, one implementation.
      // No phone number is passed: the destination is the target's own, so
      // the dialler never asserts an identity the record does not already
      // carry, and the launch path's identity binding is the only authority.
      const result = await launchOutboundCall({
        tenantId,
        campaignId: campaign.id,
        targetId: target.id,
        actor,
      });
      remaining -= 1;

      if (result.code === 423) {
        // The launch path saw the kill switch closer to the provider than we
        // can. Stop the pass; do not try the next patient.
        summary.stoppedByKillSwitch = true;
        return summary;
      }
      if (result.body.status === 'launched') {
        summary.launched += 1;
        consecutiveBlocks = 0;
        continue;
      }
      if (result.code < 300) {
        summary.skipped += 1;
        consecutiveBlocks = 0;
        // The provider is not configured for this deployment at all. Trying
        // the next 24 patients produces 24 identical refusals.
        if (result.body.status === 'setup_required') return summary;
        // The window shut between our check and the fence's. Every remaining
        // patient in this campaign is now behind the same closed window.
        if (result.body.reason === 'quiet_hours') break;
        continue;
      }
      summary.blocked += 1;
      consecutiveBlocks += 1;
      if (consecutiveBlocks >= 3) break;
    }
    if (ceilingHit) summary.campaignsAtConcurrencyCeiling += 1;
  }

  return summary;
}
