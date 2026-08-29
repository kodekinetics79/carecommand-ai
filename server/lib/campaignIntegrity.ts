import { createHash } from 'node:crypto';
import type { Campaign } from '../generated/prisma/client';
import { db } from './db';
import {
  affirmativelyAuthorizedPatientIds, buildAudience, channelStatus, isSuppressed, isSuppressedTx,
  providerModeFor, resolveDispatchActivationTx, LIVE_DISPATCH_CHANNELS,
  type AudienceType, type ChannelDispatchActivation, type CommChannel, type LiveDispatchBlocker,
} from './campaigns';
import { lockSuppressionFences } from './receptionist/dncFence';
import { runWithTenantContext } from './tenantContext';

export const PROVIDER_DELIVERY_STATUSES = ['queued', 'accepted', 'delivered', 'failed', 'delivery_unknown'] as const;
export type ProviderDeliveryStatus = typeof PROVIDER_DELIVERY_STATUSES[number];

export type DeliveryTransition = {
  applied: boolean;
  priorStatus: string;
  resultingStatus: string;
  outcome: 'applied' | 'duplicate' | 'rejected_regression' | 'rejected_terminal' | 'rejected_non_provider_state';
};

const RANK: Record<ProviderDeliveryStatus, number> = {
  queued: 0,
  accepted: 1,
  delivery_unknown: 2,
  failed: 3,
  delivered: 3,
};

export function normalizeStoredDeliveryStatus(status: string): string {
  if (status === 'pending') return 'queued';
  if (status === 'sent') return 'accepted';
  return status;
}

export function normalizeProviderDeliveryStatus(status: string): ProviderDeliveryStatus | null {
  const value = status.trim().toLowerCase();
  if (['queued', 'pending', 'scheduled'].includes(value)) return 'queued';
  if (['accepted', 'sent', 'submitted'].includes(value)) return 'accepted';
  if (value === 'delivered') return 'delivered';
  if (['failed', 'undelivered', 'bounced', 'rejected'].includes(value)) return 'failed';
  if (['delivery_unknown', 'unknown', 'timeout'].includes(value)) return 'delivery_unknown';
  return null;
}

/**
 * Provider events are monotonic. delivery_unknown is resolvable by a later
 * delivered/failed receipt, while delivered and failed are terminal.
 */
export function campaignDeliveryTransition(currentRaw: string, incoming: ProviderDeliveryStatus): DeliveryTransition {
  const current = normalizeStoredDeliveryStatus(currentRaw);
  if (!PROVIDER_DELIVERY_STATUSES.includes(current as ProviderDeliveryStatus)) {
    return { applied: false, priorStatus: current, resultingStatus: current, outcome: 'rejected_non_provider_state' };
  }
  if (current === incoming) {
    return { applied: false, priorStatus: current, resultingStatus: current, outcome: 'duplicate' };
  }
  if (current === 'delivered' || current === 'failed') {
    return { applied: false, priorStatus: current, resultingStatus: current, outcome: 'rejected_terminal' };
  }
  if (current === 'delivery_unknown') {
    if (incoming === 'delivered' || incoming === 'failed') {
      return { applied: true, priorStatus: current, resultingStatus: incoming, outcome: 'applied' };
    }
    return { applied: false, priorStatus: current, resultingStatus: current, outcome: 'rejected_regression' };
  }
  if (RANK[incoming] < RANK[current as ProviderDeliveryStatus]) {
    return { applied: false, priorStatus: current, resultingStatus: current, outcome: 'rejected_regression' };
  }
  return { applied: true, priorStatus: current, resultingStatus: incoming, outcome: 'applied' };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedDestination(channel: CommChannel, destination: string): string {
  return channel === 'email' ? destination.trim().toLowerCase() : destination.replace(/\D/g, '');
}

export function campaignRecipientFirstName(name: string): string {
  return (name || 'there').split(' ')[0] || 'there';
}

export async function canonicalCampaignClinicName(tenantId: string): Promise<string> {
  return (await db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }))?.name ?? 'your clinic';
}

export type CampaignLaunchPreview = {
  campaignId: string;
  fingerprint: string;
  templateRevision: string;
  providerMode: ReturnType<typeof providerModeFor>;
  provider: string;
  channel: CommChannel;
  scheduledAt: string | null;
  audience: { total: number; eligible: number; suppressed: number; missingContact: number; authorityRequired: number; atomicBoundaryBlocked: number };
  liveDispatchActivated: boolean;
  activationNotice: string | null;
  finalConfirmationRequired: true;
  confirmationStatement: string;
  /**
   * Exactly why live dispatch is not available for this channel, so the UI can
   * tell an operator what remains instead of only that "something" is off.
   * Optional: a preview built for a mock/dev provider has nothing to report.
   */
  activationBlockers?: LiveDispatchBlocker[];
};

export type CampaignLaunchFingerprintMaterial = {
  campaignId: string;
  campaignType: string | null;
  audienceType: string;
  channel: CommChannel;
  scheduledAt: string | null;
  templateRevision: string;
  subjectHash: string;
  templateHash: string;
  provider: string;
  providerMode: ReturnType<typeof providerModeFor>;
  clinicNameHash: string;
  audienceRows: Array<{ identity: string; destinationHash: string | null; eligibility: string; renderInputHash: string }>;
};

export function computeCampaignLaunchFingerprint(material: CampaignLaunchFingerprintMaterial): string {
  return sha256(JSON.stringify({ version: 3, ...material }));
}

export type CampaignDispatchAuthorization = Pick<Campaign,
  'dispatchAuthorizationFingerprint' | 'dispatchAuthorizedByUserId' | 'dispatchAuthorizedAt'
>;

export function campaignAuthorizationMatches(
  authorization: CampaignDispatchAuthorization,
  preview: CampaignLaunchPreview,
): boolean {
  return Boolean(
    authorization.dispatchAuthorizedByUserId
    && authorization.dispatchAuthorizedAt
    && authorization.dispatchAuthorizationFingerprint === preview.fingerprint,
  );
}

/**
 * Builds the PHI-safe preview and the exact internal candidate/render snapshot
 * behind it. Dispatch reuses this snapshot, closing the gap between validation
 * and the rows handed to the provider boundary.
 */
export async function buildCampaignDispatchSnapshot(tenantId: string, campaign: Campaign): Promise<{
  preview: CampaignLaunchPreview;
  clinicName: string;
  candidates: Awaited<ReturnType<typeof buildAudience>>;
}> {
  if (!campaign.audienceType) throw new Error('Campaign has no audience type');
  const channel = (campaign.campaignChannel ?? 'sms') as CommChannel;
  const mode = providerModeFor(channel);
  // The activation state is part of the preview an operator authorizes, and it
  // feeds the per-recipient eligibility below, so activating (or revoking)
  // live dispatch invalidates every fingerprint authorized before the change.
  const activation = await runWithTenantContext(tenantId, tx => resolveDispatchActivationTx(tx, tenantId, channel));
  const clinicName = await canonicalCampaignClinicName(tenantId);
  const candidates = await buildAudience(tenantId, campaign.audienceType as AudienceType);
  const authorizedPatientIds = mode === 'live_supported'
    ? await affirmativelyAuthorizedPatientIds(
        tenantId,
        candidates.flatMap(candidate => candidate.patientId ? [candidate.patientId] : []),
        channel,
        campaign.campaignType ?? 'custom',
      )
    : new Set<string>();
  const audienceRows: Array<{ identity: string; destinationHash: string | null; eligibility: string; renderInputHash: string }> = [];
  let eligible = 0;
  let suppressed = 0;
  let missingContact = 0;
  let authorityRequired = 0;
  let atomicBoundaryBlocked = 0;
  for (const candidate of candidates) {
    const destination = channel === 'email' ? candidate.email : candidate.phone;
    let eligibility: 'eligible' | 'suppressed' | 'missing_contact' | 'authority_required' | 'atomic_boundary_inactive';
    if (!destination) {
      eligibility = 'missing_contact';
      missingContact++;
    } else if (await isSuppressed(tenantId, { patientId: candidate.patientId, leadId: candidate.leadId, destination }, channel)) {
      eligibility = 'suppressed';
      suppressed++;
    } else if (mode === 'live_supported' && (!candidate.patientId || candidate.leadId || !authorizedPatientIds.has(candidate.patientId))) {
      eligibility = 'authority_required';
      authorityRequired++;
    } else if (mode === 'live_supported' && !activation.liveDispatchActivated) {
      eligibility = 'atomic_boundary_inactive';
      atomicBoundaryBlocked++;
    } else {
      eligibility = 'eligible';
      eligible++;
    }
    audienceRows.push({
      identity: candidate.patientId ? `patient:${candidate.patientId}` : `lead:${candidate.leadId ?? 'unbound'}`,
      destinationHash: destination ? sha256(normalizedDestination(channel, destination)) : null,
      eligibility,
      // The exact final message varies with these render inputs. Hash them so
      // the preview stays PHI-safe while any patient/lead or clinic-name change
      // invalidates prior operator authority.
      renderInputHash: sha256(JSON.stringify({ firstName: campaignRecipientFirstName(candidate.name), clinicName })),
    });
  }
  audienceRows.sort((a, b) => `${a.identity}:${a.destinationHash ?? ''}`.localeCompare(`${b.identity}:${b.destinationHash ?? ''}`));
  const provider = channelStatus(channel).provider;
  // This revision changes only when message content changes. Persisting an
  // authorization updates Campaign.updatedAt, so using updatedAt here would
  // immediately invalidate the exact preview the operator just authorized.
  const templateRevision = sha256(JSON.stringify({
    subject: campaign.messageSubject ?? '',
    body: campaign.messageTemplate ?? '',
    source: campaign.draftSource ?? null,
  }));
  const fingerprint = computeCampaignLaunchFingerprint({
    campaignId: campaign.id,
    campaignType: campaign.campaignType,
    audienceType: campaign.audienceType,
    channel,
    scheduledAt: campaign.scheduledAt?.toISOString() ?? null,
    templateRevision,
    subjectHash: sha256(campaign.messageSubject ?? ''),
    templateHash: sha256(campaign.messageTemplate ?? ''),
    provider,
    providerMode: mode,
    clinicNameHash: sha256(clinicName),
    audienceRows,
  });
  const preview: CampaignLaunchPreview = {
    campaignId: campaign.id,
    fingerprint,
    templateRevision,
    providerMode: mode,
    provider,
    channel,
    scheduledAt: campaign.scheduledAt?.toISOString() ?? null,
    audience: { total: candidates.length, eligible, suppressed, missingContact, authorityRequired, atomicBoundaryBlocked },
    // Truthful, no longer a hardcoded mode test: a mock provider really does
    // dispatch (a clearly-mock message), and a live provider dispatches only
    // once this tenant has an activation attestation in force for the channel.
    liveDispatchActivated: mode === 'mock_dev' || activation.liveDispatchActivated,
    activationNotice: mode === 'mock_dev' || activation.liveDispatchActivated
      ? null
      : `No live campaign message will be submitted for this campaign. Remaining: ${activation.blockingReasons.join(', ')}.`,
    finalConfirmationRequired: true,
    confirmationStatement: mode === 'mock_dev'
      ? 'I reviewed this exact synthetic audience, template revision, channel, and mock provider mode and authorize this test dispatch.'
      : activation.liveDispatchActivated
        ? 'I reviewed this exact audience, template revision, channel, and provider mode, and I authorize LIVE submission to these recipients. Every recipient is still re-checked for opt-out immediately before submission.'
        : 'I reviewed this exact audience, template revision, channel, and provider mode. Live dispatch is not activated.',
    activationBlockers: activation.blockingReasons,
  };
  return { preview, clinicName, candidates };
}

/** Public preview never returns recipient identities, destinations, or names. */
export async function buildCampaignLaunchPreview(tenantId: string, campaign: Campaign): Promise<CampaignLaunchPreview> {
  return (await buildCampaignDispatchSnapshot(tenantId, campaign)).preview;
}

export function appendChannelSafetyFooter(channel: CommChannel, body: string, clinicName: string): string {
  const trimmed = body.trim();
  if (channel === 'sms' || channel === 'whatsapp') {
    return `${trimmed}\n\nReply STOP to request no further messages. For help, contact ${clinicName} using a verified clinic number. Replies do not automatically book, pay, submit forms, confirm, or reschedule.`;
  }
  if (channel === 'email') {
    return `${trimmed}\n\nTo opt out or request help, contact ${clinicName} using verified contact details. Replies do not automatically book, pay, submit forms, confirm, or reschedule.`;
  }
  return trimmed;
}

// ===========================================================================
// Campaign dispatch fence.
//
// A port of the receptionist appointment-confirmation outbox boundary
// (server/lib/receptionist/confirmationOutbox.ts +
// commsProvider.sendAuthorizedAppointmentConfirmation) to per-recipient
// campaign sends. Three phases, all keyed on ONE CampaignDelivery row:
//
//   PROVIDER_INTENT   claimCampaignProviderIntent() — one transaction that
//                     holds the recipient dispatch lock AND the receptionist
//                     suppression advisory fences, re-reads suppression, re-reads
//                     the tenant activation, moves the delivery row into the
//                     claimed state, and appends the intent. This COMMIT is the
//                     linearization point between "not opted out" and "we are
//                     about to submit". An opt-out writer that takes the same
//                     fences either commits before us (and we see it) or lands
//                     strictly after the authorization.
//
//   SUBMISSION_CLAIM  claimCampaignProviderSubmission() — inside commsProvider,
//                     immediately before provider I/O, exactly once. The unique
//                     index (tenantId, campaignDeliveryId, attemptNumber, phase)
//                     is what makes a second worker a no-op rather than a
//                     duplicate message, even if it somehow held a valid intent.
//
//   RESULT            recordCampaignSubmissionResult() — the truthful outcome.
//                     `accepted` is provider acceptance, never delivery.
//
// No database transaction is held open across the provider request.
// ===========================================================================

export const CAMPAIGN_SUBMISSION_PHASES = ['PROVIDER_INTENT', 'SUBMISSION_CLAIM', 'RESULT'] as const;
export type CampaignSubmissionPhase = typeof CAMPAIGN_SUBMISSION_PHASES[number];

/** mock_dev never needs an activation; live always does. */
export type CampaignSubmissionMode = 'mock_dev' | 'live';

/** The claimed intermediate state of a CampaignDelivery row. Set before provider I/O. */
export const CAMPAIGN_SUBMISSION_CLAIMED_REASON = 'provider_submission_claimed';

export function campaignRecipientIdentity(candidate: { patientId?: string | null; leadId?: string | null }): string {
  return candidate.patientId ? `patient:${candidate.patientId}` : `lead:${candidate.leadId ?? 'unbound'}`;
}

/** One advisory lock per (tenant, campaign, recipient identity, channel). */
export function campaignSubmissionFenceKey(
  tenantId: string,
  campaignId: string,
  identity: string,
  channel: CommChannel,
): string {
  return `campaign-submission:${tenantId}:${campaignId}:${identity}:${channel}`;
}

/** Destination evidence without PHI: the same normalization the preview uses. */
export function campaignDestinationHash(channel: CommChannel, destination: string): string {
  return sha256(normalizedDestination(channel, destination));
}

export type CampaignSubmissionTicket = {
  claimId: string;
  campaignDeliveryId: string;
  attemptNumber: number;
  idempotencyKey: string;
  destinationHash: string;
  submissionMode: CampaignSubmissionMode;
  dispatchActivationId: string | null;
  launchFingerprint: string;
};

export type CampaignProviderIntentOutcome =
  | { outcome: 'claimed'; ticket: CampaignSubmissionTicket; deliveryId: string }
  | { outcome: 'suppressed'; deliveryId: string }
  | { outcome: 'already_accepted'; deliveryId: string }
  | { outcome: 'already_failed'; deliveryId: string }
  | { outcome: 'delivery_unknown'; deliveryId: string | null }
  | { outcome: 'live_dispatch_not_activated'; blockingReasons: LiveDispatchBlocker[] };

export type CampaignProviderIntentInput = {
  tenantId: string;
  campaignId: string;
  channel: CommChannel;
  candidate: { patientId: string | null; leadId: string | null };
  destination: string;
  destinationMasked: string | null;
  provider: string;
  idempotencyKey: string;
  launchFingerprint: string;
  submissionMode: CampaignSubmissionMode;
  force: boolean;
};

/**
 * Phase 1. Returns 'claimed' only when a durable PROVIDER_INTENT is committed
 * for exactly this recipient attempt. Everything else is a refusal that the
 * caller must record without contacting any provider.
 */
export async function claimCampaignProviderIntent(input: CampaignProviderIntentInput): Promise<CampaignProviderIntentOutcome> {
  const identity = campaignRecipientIdentity(input.candidate);
  const fenceKey = campaignSubmissionFenceKey(input.tenantId, input.campaignId, identity, input.channel);
  const destinationHash = campaignDestinationHash(input.channel, input.destination);
  return runWithTenantContext(input.tenantId, async tx => {
    // (a) Serialize every dispatcher for this recipient.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${fenceKey}, 0))`;
    // (b) Take the SAME fences suppression/DNC writers take, in their order, so
    //     the suppression read below cannot be overtaken by an opt-out commit.
    await lockSuppressionFences(tx, {
      tenantId: input.tenantId,
      destinations: [input.destination],
      patientId: input.candidate.patientId,
      leadId: input.candidate.leadId,
    });

    const existing = await tx.campaignDelivery.findFirst({
      where: {
        tenantId: input.tenantId, campaignId: input.campaignId,
        patientId: input.candidate.patientId, leadId: input.candidate.leadId, channel: input.channel,
      },
      select: { id: true, status: true },
    });

    // (c) Existing per-recipient idempotency, re-applied under the lock. These
    //     are the same rules dispatch pre-checks; repeating them here is what
    //     makes two simultaneous dispatchers produce ONE submission.
    if (existing && !input.force) {
      if (['sent', 'accepted', 'delivered'].includes(existing.status)) return { outcome: 'already_accepted', deliveryId: existing.id };
      if (existing.status === 'failed') return { outcome: 'already_failed', deliveryId: existing.id };
      // Crossed (or may have crossed) the provider boundary without a conclusive
      // result. Never auto-resubmit; reconciliation is a separate, reviewed path.
      if (existing.status === 'delivery_unknown') return { outcome: 'delivery_unknown', deliveryId: existing.id };
    }

    // (d) Authoritative-at-claim-time suppression. sendMessage still re-checks
    //     immediately before provider I/O; this one exists so the decision and
    //     the claim share a single commit.
    if (await isSuppressedTx(tx, input.tenantId, {
      patientId: input.candidate.patientId, leadId: input.candidate.leadId, destination: input.destination,
    }, input.channel)) {
      const suppressedData = {
        status: 'suppressed', destinationMasked: input.destinationMasked, provider: input.provider,
        providerMessageId: null, failureReason: null, idempotencyKey: input.idempotencyKey,
        statusUpdatedAt: new Date(),
      };
      const row = existing
        ? await tx.campaignDelivery.update({ where: { id: existing.id }, data: suppressedData, select: { id: true } })
        : await tx.campaignDelivery.create({ data: {
            tenantId: input.tenantId, campaignId: input.campaignId,
            patientId: input.candidate.patientId, leadId: input.candidate.leadId,
            channel: input.channel, ...suppressedData,
          }, select: { id: true } });
      return { outcome: 'suppressed', deliveryId: row.id };
    }

    // (e) Activation, re-read inside the same transaction so a revocation that
    //     commits concurrently is either seen here or lands after the claim.
    let activation: ChannelDispatchActivation | null = null;
    if (input.submissionMode === 'live') {
      activation = await resolveDispatchActivationTx(tx, input.tenantId, input.channel);
      if (!activation.liveDispatchActivated) {
        return { outcome: 'live_dispatch_not_activated', blockingReasons: activation.blockingReasons };
      }
    }

    // (f) Move the delivery row into the claimed state and append the intent.
    const claimData = {
      status: 'delivery_unknown',
      destinationMasked: input.destinationMasked,
      provider: input.provider,
      failureReason: CAMPAIGN_SUBMISSION_CLAIMED_REASON,
      idempotencyKey: input.idempotencyKey,
      statusUpdatedAt: new Date(),
    };
    const delivery = existing
      ? await tx.campaignDelivery.update({ where: { id: existing.id }, data: claimData, select: { id: true } })
      : await tx.campaignDelivery.create({ data: {
          tenantId: input.tenantId, campaignId: input.campaignId,
          patientId: input.candidate.patientId, leadId: input.candidate.leadId,
          channel: input.channel, ...claimData,
        }, select: { id: true } });

    const attemptNumber = await tx.campaignSubmissionClaim.count({
      where: { tenantId: input.tenantId, campaignDeliveryId: delivery.id, phase: 'PROVIDER_INTENT' },
    }) + 1;
    const claim = await tx.campaignSubmissionClaim.create({ data: {
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      campaignDeliveryId: delivery.id,
      attemptNumber,
      phase: 'PROVIDER_INTENT',
      status: 'provider_intent_committed',
      channel: input.channel,
      destinationHash,
      idempotencyKey: input.idempotencyKey,
      launchFingerprint: input.launchFingerprint,
      consentEvidence: input.submissionMode === 'live' ? 'affirmative_authority_and_not_suppressed' : 'not_suppressed_synthetic_mock',
      submissionMode: input.submissionMode,
      dispatchActivationId: activation?.activationId ?? null,
      provider: input.provider,
      completedAt: new Date(),
    }, select: { id: true } });

    return {
      outcome: 'claimed',
      deliveryId: delivery.id,
      ticket: {
        claimId: claim.id,
        campaignDeliveryId: delivery.id,
        attemptNumber,
        idempotencyKey: input.idempotencyKey,
        destinationHash,
        submissionMode: input.submissionMode,
        dispatchActivationId: activation?.activationId ?? null,
        launchFingerprint: input.launchFingerprint,
      },
    };
  });
}

export type CampaignSubmissionClaimResult =
  | { claimed: true }
  | { claimed: false; reason: 'intent_missing_or_stale' | 'already_submitted' | 'delivery_state_changed' | 'activation_revoked' | 'suppressed_at_submission' };

/**
 * Phase 2 — the exactly-once provider submission claim. Called from
 * commsProvider immediately before the provider request, never from a caller
 * that has not already committed a matching PROVIDER_INTENT.
 */
export async function claimCampaignProviderSubmission(input: {
  tenantId: string;
  campaignId: string;
  channel: CommChannel;
  destination: string;
  idempotencyKey: string;
  ticket: CampaignSubmissionTicket;
  fenceKey: string;
}): Promise<CampaignSubmissionClaimResult> {
  const destinationHash = campaignDestinationHash(input.channel, input.destination);
  return runWithTenantContext(input.tenantId, async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.fenceKey}, 0))`;
    const intent = await tx.campaignSubmissionClaim.findUnique({
      where: { tenantId_campaignDeliveryId_attemptNumber_phase: {
        tenantId: input.tenantId,
        campaignDeliveryId: input.ticket.campaignDeliveryId,
        attemptNumber: input.ticket.attemptNumber,
        phase: 'PROVIDER_INTENT',
      } },
    });
    if (!intent
      || intent.id !== input.ticket.claimId
      || intent.status !== 'provider_intent_committed'
      || !intent.completedAt
      || intent.campaignId !== input.campaignId
      || intent.channel !== input.channel
      || intent.idempotencyKey !== input.idempotencyKey
      || intent.destinationHash !== destinationHash
      || intent.submissionMode !== input.ticket.submissionMode) {
      return { claimed: false, reason: 'intent_missing_or_stale' } as const;
    }

    const already = await tx.campaignSubmissionClaim.count({
      where: {
        tenantId: input.tenantId,
        campaignDeliveryId: input.ticket.campaignDeliveryId,
        attemptNumber: input.ticket.attemptNumber,
        phase: { in: ['SUBMISSION_CLAIM', 'RESULT'] },
      },
    });
    if (already !== 0) return { claimed: false, reason: 'already_submitted' } as const;

    // The delivery row must still be in the claimed state this intent put it in.
    // Anything else means another process finalized (or a webhook advanced) it.
    const delivery = await tx.campaignDelivery.findFirst({
      where: { id: input.ticket.campaignDeliveryId, tenantId: input.tenantId },
      select: { status: true, failureReason: true, patientId: true, leadId: true },
    });
    if (!delivery || delivery.status !== 'delivery_unknown' || delivery.failureReason !== CAMPAIGN_SUBMISSION_CLAIMED_REASON) {
      return { claimed: false, reason: 'delivery_state_changed' } as const;
    }

    // ADDITIONAL suppression check, as late as it can be taken while still
    // being a database decision, and under the same advisory fences opt-out
    // writers hold. This does not replace or weaken the authoritative
    // last-second gate in sendMessage — that already ran, outside, before this
    // call. It closes the remaining window between that gate and the provider
    // request for every opt-out writer that participates in the fence.
    await lockSuppressionFences(tx, {
      tenantId: input.tenantId,
      destinations: [input.destination],
      patientId: delivery.patientId,
      leadId: delivery.leadId,
    });
    if (await isSuppressedTx(tx, input.tenantId, {
      patientId: delivery.patientId, leadId: delivery.leadId, destination: input.destination,
    }, input.channel)) {
      return { claimed: false, reason: 'suppressed_at_submission' } as const;
    }

    // A live submission needs the activation it was claimed under to still be
    // in force. Revoking activation stops in-flight recipients, not just future ones.
    if (input.ticket.submissionMode === 'live') {
      if (!intent.dispatchActivationId) return { claimed: false, reason: 'activation_revoked' } as const;
      const activation = await resolveDispatchActivationTx(tx, input.tenantId, input.channel);
      if (!activation.liveDispatchActivated || activation.activationId !== intent.dispatchActivationId) {
        return { claimed: false, reason: 'activation_revoked' } as const;
      }
    }

    // The unique index is the real guarantee: if a concurrent transaction won
    // the race despite the advisory lock, this insert fails and nothing is sent.
    await tx.campaignSubmissionClaim.create({ data: {
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      campaignDeliveryId: input.ticket.campaignDeliveryId,
      attemptNumber: input.ticket.attemptNumber,
      phase: 'SUBMISSION_CLAIM',
      status: 'submission_claimed',
      channel: input.channel,
      destinationHash,
      idempotencyKey: input.idempotencyKey,
      launchFingerprint: intent.launchFingerprint,
      consentEvidence: intent.consentEvidence,
      submissionMode: intent.submissionMode,
      dispatchActivationId: intent.dispatchActivationId,
      provider: intent.provider,
      completedAt: new Date(),
    } });
    return { claimed: true } as const;
  }).catch(() => ({ claimed: false, reason: 'already_submitted' } as const));
}

/**
 * Phase 3 — durable, PHI-free evidence of what the provider actually said.
 * Best-effort: a failure here must never resubmit a message, and the
 * CampaignDelivery row carries the operational status either way.
 */
export async function recordCampaignSubmissionResult(input: {
  tenantId: string;
  campaignId: string;
  channel: CommChannel;
  ticket: CampaignSubmissionTicket;
  status: string;
  provider: string;
  providerMessageId: string | null;
  failureCode: string | null;
}): Promise<void> {
  await runWithTenantContext(input.tenantId, tx => tx.campaignSubmissionClaim.create({ data: {
    tenantId: input.tenantId,
    campaignId: input.campaignId,
    campaignDeliveryId: input.ticket.campaignDeliveryId,
    attemptNumber: input.ticket.attemptNumber,
    phase: 'RESULT',
    status: input.status,
    channel: input.channel,
    destinationHash: input.ticket.destinationHash,
    idempotencyKey: input.ticket.idempotencyKey,
    launchFingerprint: input.ticket.launchFingerprint,
    consentEvidence: 'recorded_at_result',
    submissionMode: input.ticket.submissionMode,
    dispatchActivationId: input.ticket.dispatchActivationId,
    provider: input.provider,
    providerMessageId: input.providerMessageId,
    failureCode: input.failureCode,
    completedAt: new Date(),
  } })).catch(() => undefined);
}

/** Channels whose regulated live submission is fenced by the machinery above. */
export function isFencedCampaignChannel(channel: CommChannel): boolean {
  return LIVE_DISPATCH_CHANNELS.includes(channel);
}

export type { LiveDispatchBlocker };
