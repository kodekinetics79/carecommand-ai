import { createHash } from 'node:crypto';
import type { Campaign } from '../generated/prisma/client';
import { db } from './db';
import { affirmativelyAuthorizedPatientIds, buildAudience, channelStatus, isSuppressed, providerModeFor, type AudienceType, type CommChannel } from './campaigns';

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
    } else if (mode === 'live_supported') {
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
    liveDispatchActivated: mode === 'mock_dev',
    activationNotice: mode === 'mock_dev'
      ? null
      : 'No live campaign message will be submitted until the required consent and last-second opt-out safety control is activated and validated.',
    finalConfirmationRequired: true,
    confirmationStatement: mode === 'mock_dev'
      ? 'I reviewed this exact synthetic audience, template revision, channel, and mock provider mode and authorize this test dispatch.'
      : 'I reviewed this exact audience, template revision, channel, and provider mode. Live dispatch is not activated.',
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
