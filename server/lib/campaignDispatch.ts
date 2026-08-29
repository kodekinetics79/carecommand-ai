import { db } from './db';
import { env } from '../config/env';
import { channelStatus, maskDestination, type CommChannel } from './campaigns';
import { sendMessage, type SendResult } from './commsProvider';
import { emitBusinessEvent } from './intelligence';
import {
  appendChannelSafetyFooter, buildCampaignDispatchSnapshot, campaignRecipientFirstName,
  campaignRecipientIdentity, campaignSubmissionFenceKey, claimCampaignProviderIntent,
  isFencedCampaignChannel, recordCampaignSubmissionResult,
  type CampaignSubmissionMode, type CampaignSubmissionTicket, type LiveDispatchBlocker,
} from './campaignIntegrity';

// ===========================================================================
// Campaign dispatch: builds the audience, really sends through the provider
// abstraction (or dev mock / setup_required), writes idempotent delivery rows,
// and emits one PHI-safe BusinessEvent per recipient. Shared by the launch
// route and the scheduler worker.
//
// Every regulated recipient (sms / email / whatsapp) crosses the durable
// submission fence in campaignIntegrity BEFORE any provider request:
//   1. claimCampaignProviderIntent() re-reads suppression and the tenant's live
//      activation while holding the recipient dispatch lock and the same
//      suppression advisory fences opt-out writers take, then commits a
//      PROVIDER_INTENT row. That commit is the linearization point.
//   2. sendMessage() re-runs the shared last-second suppression gate (still the
//      authoritative one) and then claims SUBMISSION_CLAIM exactly once.
//   3. recordCampaignSubmissionResult() appends the truthful outcome.
// A second dispatcher for the same recipient finds the delivery row already in
// the claimed state and is a no-op instead of a duplicate send.
// ===========================================================================

export interface DispatchSummary { total: number; accepted: number; deliveryUnknown: number; suppressed: number; skipped: number; setupRequired: number; queued: number; failed: number; authorityBlocked: number; atomicBoundaryBlocked: number; activationBlockers: LiveDispatchBlocker[] }

function renderBody(template: string | null, name: string, clinicName: string): { subject: string; body: string } {
  const firstName = campaignRecipientFirstName(name);
  const body = (template ?? 'Hi {{firstName}}, a message from {{clinicName}}.').replace(/\{\{firstName\}\}/g, firstName).replace(/\{\{clinicName\}\}/g, clinicName);
  return { subject: `${clinicName}`, body };
}

// Provider HTTP acceptance is not delivery. Preserve that distinction until a
// signed provider receipt advances the state.
function deliveryStatusFor(result: SendResult): string {
  if (result.status === 'sent') return 'accepted';
  if (result.status === 'pending') return 'queued';
  if (result.failureReason?.startsWith('transport_ambiguous:')) return 'delivery_unknown';
  return result.status;
}

export async function dispatchCampaign(tenantId: string, campaignId: string, opts: { force?: boolean; authorizationFingerprint?: string } = {}): Promise<DispatchSummary & { channel: CommChannel; provider: ReturnType<typeof channelStatus> }> {
  const campaign = await db.campaign.findFirstOrThrow({ where: { id: campaignId, tenantId } });
  const snapshot = await buildCampaignDispatchSnapshot(tenantId, campaign);
  const currentPreview = snapshot.preview;
  const authorizedFingerprint = campaign.dispatchAuthorizationFingerprint;
  if (!authorizedFingerprint
    || currentPreview.fingerprint !== authorizedFingerprint
    || (opts.authorizationFingerprint && opts.authorizationFingerprint !== authorizedFingerprint)
    || !campaign.dispatchAuthorizedByUserId
    || !campaign.dispatchAuthorizedAt) {
    throw new Error('CAMPAIGN_DISPATCH_AUTHORIZATION_STALE');
  }
  const channel = (campaign.campaignChannel ?? 'sms') as CommChannel;
  const status = channelStatus(channel);
  const clinicName = snapshot.clinicName;
  const candidates = snapshot.candidates;
  // The same test sendMessage applies: an explicitly-mock provider outside
  // production is a synthetic send that needs no tenant activation. Everything
  // else is a live submission and must satisfy the activation gate.
  const submissionMode: CampaignSubmissionMode = status.mock && env.NODE_ENV !== 'production' ? 'mock_dev' : 'live';
  const fenced = isFencedCampaignChannel(channel);

  const s: DispatchSummary = { total: candidates.length, accepted: 0, deliveryUnknown: 0, suppressed: 0, skipped: 0, setupRequired: 0, queued: 0, failed: 0, authorityBlocked: 0, atomicBoundaryBlocked: 0, activationBlockers: [] };
  const activationBlockers = new Set<LiveDispatchBlocker>();

  for (const cand of candidates) {
    const contact = channel === 'email' ? cand.email : cand.phone;
    const key = `${campaignId}:${cand.patientId ?? cand.leadId ?? 'x'}:${channel}`;
    const existing = await db.campaignDelivery.findFirst({ where: { tenantId, campaignId, patientId: cand.patientId, leadId: cand.leadId, channel } });
    // Idempotent: never resend a provider-accepted/delivered recipient unless
    // the separately reviewed force path was explicitly requested.
    if (existing && ['sent', 'accepted', 'delivered'].includes(existing.status) && !opts.force) { s.accepted++; continue; }
    if (existing?.status === 'failed' && !opts.force) { s.failed++; continue; }
    // An earlier process crossed (or may have crossed) the provider boundary
    // without a conclusive result. Never auto-resubmit that recipient.
    if (existing?.status === 'delivery_unknown' && !opts.force) { s.deliveryUnknown++; continue; }

    let deliveryStatus: string;
    let providerMessageId: string | null = existing?.providerMessageId ?? null;
    let failureReason: string | null = null;
    let ticket: CampaignSubmissionTicket | null = null;
    let resultForEvidence: SendResult | null = null;

    if (!contact) {
      deliveryStatus = 'skipped';
    } else if (status.setupRequired) {
      // Identical to sendMessage's first line: an unconfigured provider is
      // reported truthfully and nothing is claimed or submitted.
      deliveryStatus = 'setup_required';
    } else if (fenced) {
      const fenceKey = campaignSubmissionFenceKey(tenantId, campaignId, campaignRecipientIdentity(cand), channel);
      const intent = await claimCampaignProviderIntent({
        tenantId,
        campaignId,
        channel,
        candidate: { patientId: cand.patientId, leadId: cand.leadId },
        destination: contact,
        destinationMasked: maskDestination(contact),
        provider: status.provider,
        idempotencyKey: key,
        launchFingerprint: authorizedFingerprint,
        submissionMode,
        force: Boolean(opts.force),
      });

      if (intent.outcome === 'already_accepted') { s.accepted++; continue; }
      if (intent.outcome === 'already_failed') { s.failed++; continue; }
      if (intent.outcome === 'delivery_unknown') { s.deliveryUnknown++; continue; }
      if (intent.outcome === 'suppressed') {
        // The fence already recorded the suppression inside the transaction
        // that observed it. Nothing was handed to any provider.
        deliveryStatus = 'suppressed';
      } else if (intent.outcome === 'live_dispatch_not_activated') {
        for (const reason of intent.blockingReasons) activationBlockers.add(reason);
        deliveryStatus = 'failed';
        // Contract-stable reason string; the specific blockers travel in the
        // dispatch summary so the route and audit can report what remains.
        failureReason = 'live_outreach_atomic_boundary_not_activated';
        s.atomicBoundaryBlocked++;
      } else {
        ticket = intent.ticket;
        // sendMessage is the SINGLE consent/suppression + destination gate: it
        // returns 'suppressed' (no provider call) for an opted-out/suppressed
        // recipient — including a receptionist-call opt-out (ReceptionistOptOut)
        // that landed after the intent above committed. It then claims the
        // submission exactly once immediately before provider I/O.
        const rendered = renderBody(campaign.messageTemplate, cand.name, clinicName);
        const body = appendChannelSafetyFooter(channel, rendered.body, clinicName);
        const result = await sendMessage(channel, contact, rendered.subject, body, key, {
          tenantId, patientId: cand.patientId, leadId: cand.leadId,
          regulatedOutreach: { purpose: campaign.campaignType ?? 'custom' },
          campaignSubmission: { campaignId, fenceKey, ticket },
        });
        resultForEvidence = result;
        deliveryStatus = deliveryStatusFor(result);
        providerMessageId = result.providerMessageId ?? providerMessageId;
        failureReason = deliveryStatus === 'failed' ? (result.failureReason ?? null) : null;
        if (failureReason === 'affirmative_outreach_authority_required') s.authorityBlocked++;
        if (failureReason === 'live_outreach_atomic_boundary_not_activated') s.atomicBoundaryBlocked++;
      }
    } else {
      // Unfenced channel (campaign voice is not wired to a sender). Unchanged:
      // a durable claim before the boundary, then the shared gate.
      const claimData = {
        status: 'delivery_unknown',
        destinationMasked: maskDestination(contact),
        provider: status.provider,
        failureReason: 'provider_submission_claimed',
        idempotencyKey: key,
        statusUpdatedAt: new Date(),
      };
      if (existing) {
        const claimed = await db.campaignDelivery.updateMany({
          where: { id: existing.id, tenantId, status: existing.status },
          data: claimData,
        });
        if (claimed.count !== 1) { s.deliveryUnknown++; continue; }
      } else {
        try {
          await db.campaignDelivery.create({ data: { tenantId, campaignId, patientId: cand.patientId, leadId: cand.leadId, channel, ...claimData } });
        } catch {
          s.deliveryUnknown++;
          continue;
        }
      }
      const rendered = renderBody(campaign.messageTemplate, cand.name, clinicName);
      const body = appendChannelSafetyFooter(channel, rendered.body, clinicName);
      const result = await sendMessage(channel, contact, rendered.subject, body, key, {
        tenantId, patientId: cand.patientId, leadId: cand.leadId,
        regulatedOutreach: { purpose: campaign.campaignType ?? 'custom' },
      });
      deliveryStatus = deliveryStatusFor(result);
      providerMessageId = result.providerMessageId ?? providerMessageId;
      failureReason = deliveryStatus === 'failed' ? (result.failureReason ?? null) : null;
      if (failureReason === 'affirmative_outreach_authority_required') s.authorityBlocked++;
      if (failureReason === 'live_outreach_atomic_boundary_not_activated') s.atomicBoundaryBlocked++;
    }

    const now = new Date();
    const data = {
      status: deliveryStatus,
      destinationMasked: maskDestination(contact), provider: status.provider, providerMessageId, failureReason, idempotencyKey: key,
      sentAt: deliveryStatus === 'accepted' ? now : existing?.sentAt ?? null,
      providerAcceptedAt: deliveryStatus === 'accepted' ? now : existing?.providerAcceptedAt ?? null,
      deliveredAt: existing?.deliveredAt ?? null,
      statusUpdatedAt: now,
    };
    const claimedDelivery = await db.campaignDelivery.findFirst({ where: { tenantId, campaignId, patientId: cand.patientId, leadId: cand.leadId, channel } });
    const delivery = claimedDelivery
      ? await db.campaignDelivery.update({ where: { id: claimedDelivery.id }, data })
      : await db.campaignDelivery.create({ data: { tenantId, campaignId, patientId: cand.patientId, leadId: cand.leadId, channel, ...data } });

    // Durable, PHI-free evidence of what the provider actually said for this
    // exact claimed attempt. Best-effort: it can never cause a resubmission.
    if (ticket) {
      await recordCampaignSubmissionResult({
        tenantId, campaignId, channel, ticket,
        status: deliveryStatus,
        provider: status.provider,
        providerMessageId: resultForEvidence?.providerMessageId ?? null,
        failureCode: failureReason,
      });
    }

    if (deliveryStatus === 'accepted') s.accepted++;
    else if (deliveryStatus === 'delivery_unknown') s.deliveryUnknown++;
    else if (deliveryStatus === 'suppressed') s.suppressed++;
    else if (deliveryStatus === 'skipped') s.skipped++;
    else if (deliveryStatus === 'setup_required') s.setupRequired++;
    else if (deliveryStatus === 'failed') s.failed++;
    else s.queued++;

    // One PHI-safe BusinessEvent per recipient (ids/status only — no destination).
    if (deliveryStatus === 'accepted' || deliveryStatus === 'failed' || deliveryStatus === 'suppressed') {
      const eventType = `campaign.delivery.${deliveryStatus}` as 'campaign.delivery.accepted' | 'campaign.delivery.failed' | 'campaign.delivery.suppressed';
      await emitBusinessEvent(tenantId, { eventType, entityType: 'campaignDelivery', entityId: delivery.id, sourceModule: 'crm', payload: { campaignId, channel, status: deliveryStatus } }).catch(() => {});
    }
  }

  s.activationBlockers = [...activationBlockers];
  const newStatus = s.authorityBlocked > 0 || s.atomicBoundaryBlocked > 0
    ? 'APPROVAL_REQUIRED'
    : s.accepted > 0 || s.deliveryUnknown > 0 ? 'ACTIVE' : 'SCHEDULED';
  await db.campaign.update({ where: { id: campaignId }, data: { status: newStatus as never, audienceSize: candidates.length, sent: s.accepted } });
  return { ...s, channel, provider: status };
}
