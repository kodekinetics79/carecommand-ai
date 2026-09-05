import { db } from './db';
import { env } from '../config/env';
import { providerConfig } from './providerCredentials';
import { runWithTenantContext, type TenantTxClient } from './tenantContext';
import type { CampaignLiveDispatchActivation, ReceptionistOptOutChannel } from '../generated/prisma/client';
import { canonicalDncDestination, isDestinationOptedOutTx } from './receptionist/dncFence';
import type { Permission } from './permissions';

// ===========================================================================
// CRM Campaign / Reactivation engine helpers. Deterministic, tenant-scoped
// audience generation; consent + suppression gating; rule-based message drafts;
// truthful provider status (never fakes delivery). No PHI in logs/payloads —
// destinations are masked. No clinical advice in any template.
// ===========================================================================

export const CAMPAIGN_TYPES = [
  'appointment_reminder', 'appointment_confirmation', 'no_show_recovery', 'unpaid_deposit_followup',
  'failed_payment_recovery', 'insurance_update_request', 'prior_auth_followup',
  'inactive_patient_reactivation', 'missed_call_recovery', 'appointment_request_followup',
  'review_request', 'custom',
] as const;
export type CampaignType = typeof CAMPAIGN_TYPES[number];

export const AUDIENCE_TYPES = [
  'inactive_patients', 'no_show_recovery', 'unpaid_deposit_followup', 'failed_payment_recovery',
  'insurance_update_request', 'appointment_request_followup', 'review_request',
] as const;
export type AudienceType = typeof AUDIENCE_TYPES[number];

// Audiences that are intentionally STAFF-facing (never patient-blaming outreach).
export const STAFF_FACING_AUDIENCES = new Set(['prior_auth_followup']);

// ---------------------------------------------------------------------------
// Campaign authority classes.
//
// Authority over a campaign is scoped by what the campaign IS, not granted
// wholesale. Two different consent classes hide behind one "campaign" noun:
//
//   payment_followup    The practice chasing money it is already owed, or the
//                       coverage that would pay it — unpaid deposit, failed
//                       payment, insurance/coverage update, prior authorization.
//                       Under HIPAA this is payment operations; it is NOT
//                       marketing, and it is ordinary billing-staff work.
//
//   marketing_outreach  Everything else, including reactivation offers and
//                       review requests. A different consent class entirely,
//                       and the default for anything unrecognised.
//
// CAMPAIGN_CLASS_AUTHORITY below is the ONLY mapping of class -> required
// grant. Routes read it; they never re-decide it. `campaign:manage` is the
// broad grant and appears in every class, so no role that can manage campaigns
// today loses anything.
// ---------------------------------------------------------------------------
export const CAMPAIGN_AUTHORITY_CLASSES = ['payment_followup', 'marketing_outreach'] as const;
export type CampaignAuthorityClass = typeof CAMPAIGN_AUTHORITY_CLASSES[number];

/** Every campaign type, classified exactly once. */
export const CAMPAIGN_TYPE_AUTHORITY_CLASS: Record<CampaignType, CampaignAuthorityClass> = {
  unpaid_deposit_followup: 'payment_followup',
  failed_payment_recovery: 'payment_followup',
  insurance_update_request: 'payment_followup',
  prior_auth_followup: 'payment_followup',
  appointment_reminder: 'marketing_outreach',
  appointment_confirmation: 'marketing_outreach',
  no_show_recovery: 'marketing_outreach',
  inactive_patient_reactivation: 'marketing_outreach',
  missed_call_recovery: 'marketing_outreach',
  appointment_request_followup: 'marketing_outreach',
  review_request: 'marketing_outreach',
  custom: 'marketing_outreach',
};

/** Every audience source, classified exactly once. */
export const AUDIENCE_TYPE_AUTHORITY_CLASS: Record<AudienceType, CampaignAuthorityClass> = {
  unpaid_deposit_followup: 'payment_followup',
  failed_payment_recovery: 'payment_followup',
  insurance_update_request: 'payment_followup',
  inactive_patients: 'marketing_outreach',
  no_show_recovery: 'marketing_outreach',
  appointment_request_followup: 'marketing_outreach',
  review_request: 'marketing_outreach',
};

/**
 * The class a campaign is governed by. Fails CLOSED in every ambiguous case:
 * an unrecognised type, a missing audience, or a payment-labelled campaign
 * pointed at a marketing audience all resolve to `marketing_outreach`. That
 * last case is the one that matters — without it, labelling a campaign
 * `unpaid_deposit_followup` while aiming it at `inactive_patients` would let
 * payment authority reach the whole patient base.
 */
export function campaignAuthorityClass(campaign: { campaignType?: string | null; audienceType?: string | null }): CampaignAuthorityClass {
  const byType = campaign.campaignType
    ? (CAMPAIGN_TYPE_AUTHORITY_CLASS as Record<string, CampaignAuthorityClass | undefined>)[campaign.campaignType]
    : undefined;
  if (byType !== 'payment_followup') return 'marketing_outreach';
  const byAudience = campaign.audienceType
    ? (AUDIENCE_TYPE_AUTHORITY_CLASS as Record<string, CampaignAuthorityClass | undefined>)[campaign.audienceType]
    : undefined;
  return byAudience === 'payment_followup' ? 'payment_followup' : 'marketing_outreach';
}

/**
 * Class -> the grants that authorize it. ANY ONE of `manage` authorizes a
 * write; any one of `read` authorizes a read. Element [0] is the broad grant
 * and is what a refusal reports, because it is the grant an administrator
 * would actually assign.
 */
export const CAMPAIGN_CLASS_AUTHORITY: Record<CampaignAuthorityClass, {
  manage: readonly [Permission, ...Permission[]];
  read: readonly [Permission, ...Permission[]];
}> = {
  marketing_outreach: {
    manage: ['campaign:manage'],
    read: ['campaign:read'],
  },
  payment_followup: {
    manage: ['campaign:manage', 'campaign:payment-followup:manage'],
    read: ['campaign:read', 'campaign:payment-followup:manage'],
  },
};

function unionAuthority(mode: 'manage' | 'read'): [Permission, ...Permission[]] {
  const broad = CAMPAIGN_CLASS_AUTHORITY.marketing_outreach[mode][0];
  const rest = [...new Set(CAMPAIGN_AUTHORITY_CLASSES.flatMap(c => [...CAMPAIGN_CLASS_AUTHORITY[c][mode]]))]
    .filter(permission => permission !== broad);
  return [broad, ...rest];
}

/**
 * The coarse any-of gate a per-campaign route installs as its preHandler: a
 * caller holding none of these is refused before the route reads any record.
 * Derived from the table above so the gate can never drift from it.
 */
export const CAMPAIGN_ANY_MANAGE_AUTHORITY = unionAuthority('manage');
export const CAMPAIGN_ANY_READ_AUTHORITY = unionAuthority('read');

/** The campaign/audience vocabulary a given class covers (for list filtering). */
export const PAYMENT_FOLLOWUP_CAMPAIGN_TYPES = CAMPAIGN_TYPES.filter(t => CAMPAIGN_TYPE_AUTHORITY_CLASS[t] === 'payment_followup');
export const PAYMENT_FOLLOWUP_AUDIENCE_TYPES = AUDIENCE_TYPES.filter(a => AUDIENCE_TYPE_AUTHORITY_CLASS[a] === 'payment_followup');

// Canonical Lead.stage vocabulary. `Lead.stage` is a free `String` column, so
// the ONLY place the vocabulary can be enforced is the API boundary. Declared
// here (next to the other Growth vocabularies) so every boundary that accepts
// or filters a stage uses `z.enum(LEAD_STAGES)` instead of a free string, and
// so it cannot drift from the client contract in src/lib/crmService.ts.
export const LEAD_STAGES = [
  'new-inquiry', 'contacted', 'booked', 'visited', 'follow-up', 'retained', 'lost',
] as const;
export type LeadStage = typeof LEAD_STAGES[number];

export type CommChannel = 'sms' | 'email' | 'voice' | 'whatsapp';
const INACTIVE_DAYS_DEFAULT = 180;

export const NON_VOICE_OUTREACH_AUTHORITY_VERSION = 1 as const;
export interface NonVoiceOutreachAuthorityMetadata {
  authorityVersion: typeof NON_VOICE_OUTREACH_AUTHORITY_VERSION;
  outreachPurpose: string;
  policyVersion: string;
  disclosureTextHash: string;
  evidenceReference: string;
  captureMethod: string;
  evidenceSource: string;
  jurisdiction: string;
  expiresAt?: string | null;
}

function nonVoiceConsentPurpose(channel: CommChannel): 'SMS' | 'EMAIL' | 'WHATSAPP' | null {
  if (channel === 'sms') return 'SMS';
  if (channel === 'email') return 'EMAIL';
  if (channel === 'whatsapp') return 'WHATSAPP';
  return null;
}

function validAuthorityMetadata(value: unknown, outreachPurpose: string): value is NonVoiceOutreachAuthorityMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  return metadata.authorityVersion === NON_VOICE_OUTREACH_AUTHORITY_VERSION
    && metadata.outreachPurpose === outreachPurpose
    && typeof metadata.policyVersion === 'string' && metadata.policyVersion.trim().length > 0
    && typeof metadata.disclosureTextHash === 'string' && /^[0-9a-f]{64}$/.test(metadata.disclosureTextHash)
    && typeof metadata.evidenceReference === 'string' && metadata.evidenceReference.trim().length >= 3
    && typeof metadata.captureMethod === 'string' && metadata.captureMethod.trim().length > 0
    && typeof metadata.evidenceSource === 'string' && metadata.evidenceSource.trim().length > 0
    && typeof metadata.jurisdiction === 'string' && metadata.jurisdiction.trim().length >= 2
    && (metadata.expiresAt == null || (typeof metadata.expiresAt === 'string'
      && Number.isFinite(Date.parse(metadata.expiresAt)) && Date.parse(metadata.expiresAt) > Date.now()));
}

/**
 * Live non-voice outreach requires an exact, append-only patient authority
 * event for the channel and purpose being submitted. Lead authority remains
 * fail-closed until the data model has an equivalent immutable lead event.
 */
export async function hasAffirmativeNonVoiceOutreachAuthority(
  tenantId: string,
  target: { patientId?: string | null; leadId?: string | null },
  channel: CommChannel,
  outreachPurpose: string,
): Promise<boolean> {
  const purpose = nonVoiceConsentPurpose(channel);
  if (!purpose || !target.patientId || target.leadId) return false;
  return (await affirmativelyAuthorizedPatientIds(tenantId, [target.patientId], channel, outreachPurpose)).has(target.patientId);
}

export async function affirmativelyAuthorizedPatientIds(
  tenantId: string,
  patientIds: string[],
  channel: CommChannel,
  outreachPurpose: string,
): Promise<Set<string>> {
  const purpose = nonVoiceConsentPurpose(channel);
  if (!purpose || patientIds.length === 0) return new Set();
  return runWithTenantContext(tenantId, async tx => {
    const events = await tx.consentEvent.findMany({
      where: { tenantId, patientId: { in: [...new Set(patientIds)] }, purpose },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      select: { patientId: true, granted: true, metadata: true },
    });
    const decided = new Set<string>();
    const authorized = new Set<string>();
    for (const event of events) {
      if (decided.has(event.patientId)) continue;
      decided.add(event.patientId);
      if (event.granted === true && validAuthorityMetadata(event.metadata, outreachPurpose)) authorized.add(event.patientId);
    }
    return authorized;
  });
}

export function maskDestination(value?: string | null): string | null {
  if (!value) return null;
  const v = value.trim();
  if (v.includes('@')) { const [u, d] = v.split('@'); return `${u.slice(0, 2)}***@${d ?? ''}`; }
  return v.length <= 4 ? '****' : `***${v.slice(-4)}`;
}

function channelField(channel: CommChannel): 'phone' | 'email' {
  return channel === 'email' ? 'email' : 'phone';
}

// --- Provider configuration status (truthful; never fakes a send) ----------
export interface ChannelStatus { channel: CommChannel; provider: string; configured: boolean; mock: boolean; setupRequired: boolean; missing: string[] }

export function channelStatus(channel: CommChannel): ChannelStatus {
  if (channel === 'sms' || channel === 'whatsapp') {
    const { values } = providerConfig('sms');
    const missing = [
      ['accountSid', 'TWILIO_ACCOUNT_SID'],
      ['authToken', 'TWILIO_AUTH_TOKEN'],
      ['fromNumber', 'TWILIO_FROM_NUMBER'],
    ].filter(([field]) => !values[field]).map(([, envKey]) => envKey);
    const configured = missing.length === 0;
    return { channel, provider: 'twilio', configured, mock: (values.accountSid ?? '').startsWith('mock'), setupRequired: !configured, missing };
  }
  if (channel === 'email') {
    const { values } = providerConfig('email');
    const missing = [
      ['apiUrl', 'EMAIL_HTTP_API_URL'],
      ['apiKey', 'EMAIL_HTTP_API_KEY'],
    ].filter(([field]) => !values[field]).map(([, envKey]) => envKey);
    const configured = missing.length === 0;
    return { channel, provider: 'http-email', configured, mock: (values.apiUrl ?? '').startsWith('mock'), setupRequired: !configured, missing };
  }
  // voice reuses the Retell receptionist configuration.
  const missing = ['RETELL_API_KEY', 'RETELL_FROM_NUMBER'].filter(k => !env[k as keyof typeof env]);
  const configured = missing.length === 0;
  return { channel, provider: 'retell', configured, mock: (env.RETELL_API_KEY ?? '').startsWith('mock'), setupRequired: !configured, missing };
}

// Per-channel provider mode (truthful — never claims live without a real sender).
export type ProviderMode = 'unconfigured' | 'mock_dev' | 'configured_pending_provider' | 'live_supported';

export function providerModeFor(channel: CommChannel): ProviderMode {
  const s = channelStatus(channel);
  if (!s.configured) return 'unconfigured';
  if (s.mock && env.NODE_ENV !== 'production') return 'mock_dev';
  // SMS/WhatsApp have a real Twilio sender wired; email is live only with an HTTP
  // email API; voice campaign sending is not wired (Retell is receptionist-only).
  if (channel === 'sms' || channel === 'whatsapp') return 'live_supported';
  if (channel === 'email') return providerConfig('email').values.apiUrl ? 'live_supported' : 'configured_pending_provider';
  return 'configured_pending_provider';
}

// --- Live campaign dispatch activation (DEFAULT OFF) -----------------------
//
// Three independent conditions must ALL hold before one live regulated campaign
// message may be submitted, and `providerReadiness()` reports each of them
// separately so an operator can see what is actually missing:
//
//   1. the durable submission fence exists (CampaignSubmissionClaim +
//      campaignIntegrity.claimCampaignProviderIntent);
//   2. the channel has a real live provider wired (providerModeFor === live_supported);
//   3. an OWNER/ADMIN wrote a CampaignLiveDispatchActivation row for THIS tenant
//      and channel with an explicit attestation.
//
// Condition 3 has no default, no seed and no backfill: absence means OFF.
export const CAMPAIGN_CHANNELS: readonly CommChannel[] = ['sms', 'email', 'voice', 'whatsapp'];

/**
 * Identifies the fence implementation an activation attestation was made
 * against. Changing the fence's safety properties must bump this constant so
 * every existing attestation is refused until it is re-made against the new
 * boundary — an activation is consent to a specific mechanism, not a forever
 * blank cheque.
 */
export const LIVE_DISPATCH_FENCE_VERSION = 'campaign-submission-claim.v1';

/** Channels a live regulated campaign message can be submitted on at all. */
export const LIVE_DISPATCH_CHANNELS: readonly CommChannel[] = ['sms', 'email', 'whatsapp'];

export type LiveDispatchBlocker =
  | 'fence_not_implemented'
  | 'channel_not_eligible_for_live_dispatch'
  | 'provider_not_configured'
  | 'provider_is_development_mock'
  | 'provider_has_no_live_sender'
  | 'tenant_activation_missing'
  | 'tenant_activation_revoked'
  | 'tenant_activation_fence_version_stale';

export interface ChannelDispatchActivation {
  channel: CommChannel;
  providerMode: ProviderMode;
  providerConfigured: boolean;
  /** A real live sender is wired for this channel (not a dev mock, not pending). */
  liveProviderReady: boolean;
  /** The durable submission fence is compiled into this build. */
  fencePresent: boolean;
  /** An unrevoked, current-version activation row exists for this tenant. */
  tenantActivated: boolean;
  /** All three conditions hold. This is the only field dispatch may act on. */
  liveDispatchActivated: boolean;
  activationId: string | null;
  activatedAt: string | null;
  activatedByUserId: string | null;
  attestation: string | null;
  blockingReasons: LiveDispatchBlocker[];
}

export type DispatchActivationRecord = Pick<CampaignLiveDispatchActivation,
  'id' | 'channel' | 'activatedAt' | 'activatedByUserId' | 'attestation' | 'fenceVersion' | 'revokedAt'
>;

/**
 * Pure resolver. `record` is the tenant's activation row for this channel, or
 * null when none exists — which is the state every tenant is in until someone
 * deliberately changes it.
 */
export function resolveChannelDispatchActivation(
  channel: CommChannel,
  record: DispatchActivationRecord | null,
  fencePresent = true,
): ChannelDispatchActivation {
  const status = channelStatus(channel);
  const providerMode = providerModeFor(channel);
  const liveProviderReady = providerMode === 'live_supported';
  const blockingReasons: LiveDispatchBlocker[] = [];
  if (!fencePresent) blockingReasons.push('fence_not_implemented');
  if (!LIVE_DISPATCH_CHANNELS.includes(channel)) blockingReasons.push('channel_not_eligible_for_live_dispatch');
  if (!status.configured) blockingReasons.push('provider_not_configured');
  else if (providerMode === 'mock_dev') blockingReasons.push('provider_is_development_mock');
  else if (!liveProviderReady) blockingReasons.push('provider_has_no_live_sender');
  if (!record) blockingReasons.push('tenant_activation_missing');
  else if (record.revokedAt) blockingReasons.push('tenant_activation_revoked');
  else if (record.fenceVersion !== LIVE_DISPATCH_FENCE_VERSION) blockingReasons.push('tenant_activation_fence_version_stale');
  const tenantActivated = Boolean(record && !record.revokedAt && record.fenceVersion === LIVE_DISPATCH_FENCE_VERSION);
  return {
    channel,
    providerMode,
    providerConfigured: status.configured,
    liveProviderReady,
    fencePresent,
    tenantActivated,
    liveDispatchActivated: blockingReasons.length === 0,
    activationId: tenantActivated ? record!.id : null,
    activatedAt: record?.activatedAt?.toISOString() ?? null,
    activatedByUserId: record?.activatedByUserId ?? null,
    attestation: record?.attestation ?? null,
    blockingReasons,
  };
}

const ACTIVATION_SELECT = {
  id: true, channel: true, activatedAt: true, activatedByUserId: true,
  attestation: true, fenceVersion: true, revokedAt: true,
} as const;

/** Transactional read, so the fence can linearize activation with deactivation. */
export async function resolveDispatchActivationTx(
  tx: TenantTxClient,
  tenantId: string,
  channel: CommChannel,
): Promise<ChannelDispatchActivation> {
  const record = await tx.campaignLiveDispatchActivation.findUnique({
    where: { tenantId_channel: { tenantId, channel } },
    select: ACTIVATION_SELECT,
  });
  return resolveChannelDispatchActivation(channel, record);
}

export async function resolveDispatchActivation(tenantId: string, channel: CommChannel): Promise<ChannelDispatchActivation> {
  return runWithTenantContext(tenantId, tx => resolveDispatchActivationTx(tx, tenantId, channel));
}

export async function resolveDispatchActivations(tenantId: string): Promise<Record<CommChannel, ChannelDispatchActivation>> {
  const records = await runWithTenantContext(tenantId, tx => tx.campaignLiveDispatchActivation.findMany({
    where: { tenantId },
    select: ACTIVATION_SELECT,
  }));
  const byChannel = new Map(records.map(record => [record.channel, record]));
  return Object.fromEntries(CAMPAIGN_CHANNELS.map(channel =>
    [channel, resolveChannelDispatchActivation(channel, byChannel.get(channel) ?? null)],
  )) as Record<CommChannel, ChannelDispatchActivation>;
}

function activationNoticeFor(activation: Record<CommChannel, ChannelDispatchActivation>): string {
  const active = CAMPAIGN_CHANNELS.filter(c => activation[c].liveDispatchActivated);
  if (active.length > 0) {
    return `Live campaign delivery is ACTIVE for ${active.join(', ')}. Every recipient still passes the durable submission claim and the last-second opt-out check before any provider request, and a second attempt for the same recipient is a no-op.`;
  }
  const eligible = LIVE_DISPATCH_CHANNELS.filter(c => activation[c].liveProviderReady);
  if (eligible.length === 0) {
    return 'Live campaign delivery is not activated. The durable submission fence is in place, but no channel has a live provider wired, so there is nothing to activate yet.';
  }
  const awaitingTenant = eligible.filter(c => !activation[c].tenantActivated);
  if (awaitingTenant.length > 0) {
    return `Live campaign delivery is not activated. The durable submission fence is in place and ${awaitingTenant.join(', ')} has a live provider, but no OWNER or ADMIN has recorded an activation attestation for this tenant.`;
  }
  return 'Live campaign delivery is not activated. See channelActivation for the exact blocking reason on each channel.';
}

// Structured communications readiness (no secret values; env key NAMES only).
export interface ProviderReadiness {
  smsConfigured: boolean;
  emailConfigured: boolean;
  voiceConfigured: boolean;
  providerMode: Record<CommChannel, ProviderMode>;
  missingEnvKeys: string[];
  supportedChannels: CommChannel[];
  unsupportedChannels: CommChannel[];
  schedulerEnforced: boolean;
  liveSendingSupported: boolean;
  liveCampaignDispatchActivated: boolean;
  activationNotice: string;
  /** The fence exists in this build; `liveDispatchFenceVersion` names which one. */
  liveDispatchFenceImplemented: boolean;
  liveDispatchFenceVersion: string;
  /** Channels with a real live sender wired, regardless of tenant activation. */
  liveProviderChannels: CommChannel[];
  /** Channels this tenant may actually submit live traffic on right now. */
  activatedChannels: CommChannel[];
  /** Per-channel truth, including WHY a channel is not activated. */
  channelActivation: Record<CommChannel, ChannelDispatchActivation>;
}

/**
 * Truthful readiness. `activation` carries this tenant's activation rows; when
 * it is omitted the answer is the honest "no tenant activation is in force",
 * which is also the correct answer for any caller that has no tenant in hand.
 */
export function providerReadiness(
  activation?: Record<CommChannel, ChannelDispatchActivation>,
): ProviderReadiness {
  const channels = [...CAMPAIGN_CHANNELS];
  const statuses = Object.fromEntries(channels.map(c => [c, channelStatus(c)])) as Record<CommChannel, ChannelStatus>;
  const modes = Object.fromEntries(channels.map(c => [c, providerModeFor(c)])) as Record<CommChannel, ProviderMode>;
  const missingEnvKeys = [...new Set(channels.flatMap(c => statuses[c].missing))];
  // "Supported" = can produce a real (mock_dev) or queued delivery.
  const supportedChannels = channels.filter(c => modes[c] === 'mock_dev' || modes[c] === 'configured_pending_provider' || modes[c] === 'live_supported');
  const channelActivation = activation
    ?? Object.fromEntries(channels.map(c => [c, resolveChannelDispatchActivation(c, null)])) as Record<CommChannel, ChannelDispatchActivation>;
  const activatedChannels = channels.filter(c => channelActivation[c].liveDispatchActivated);
  return {
    smsConfigured: statuses.sms.configured,
    emailConfigured: statuses.email.configured,
    voiceConfigured: statuses.voice.configured,
    providerMode: modes,
    missingEnvKeys,
    supportedChannels,
    unsupportedChannels: channels.filter(c => !supportedChannels.includes(c)),
    schedulerEnforced: true,   // approved SCHEDULED campaigns run via the campaign-scheduler worker
    // These two are no longer literals. Both mean "can THIS tenant submit live
    // regulated campaign traffic right now", which is false until a named
    // OWNER/ADMIN activates a channel whose provider is genuinely wired.
    liveSendingSupported: activatedChannels.length > 0,
    liveCampaignDispatchActivated: activatedChannels.length > 0,
    activationNotice: activationNoticeFor(channelActivation),
    liveDispatchFenceImplemented: true,
    liveDispatchFenceVersion: LIVE_DISPATCH_FENCE_VERSION,
    liveProviderChannels: LIVE_DISPATCH_CHANNELS.filter(c => channelActivation[c].liveProviderReady),
    activatedChannels,
    channelActivation,
  };
}

// Delivery status for one recipient given suppression, contact info, provider.
export type DeliveryStatus = 'sent' | 'skipped' | 'failed' | 'setup_required' | 'suppressed' | 'pending';

export function resolveDeliveryStatus(opts: { suppressed: boolean; hasContact: boolean; status: ChannelStatus }): DeliveryStatus {
  if (opts.suppressed) return 'suppressed';
  if (!opts.hasContact) return 'skipped';
  if (opts.status.setupRequired) return 'setup_required';
  // Mock provider (dev/test): a real, clearly-mock "send". Never in production.
  if (opts.status.mock && env.NODE_ENV !== 'production') return 'sent';
  // Real provider configured but no concrete sender wired yet — queue, never fake.
  return 'pending';
}

// --- Consent + suppression gating ------------------------------------------
// Legacy ConsentEvent (patient-level, purpose-based) maps safely to a channel
// only for SMS/EMAIL/WHATSAPP. Voice and cross-channel MARKETING are NOT mapped
// (ambiguous) and remain a carry-forward for the Patient Intake + Consent Engine.
const CONSENT_PURPOSE: Record<CommChannel, 'SMS' | 'EMAIL' | 'WHATSAPP' | null> = {
  sms: 'SMS', email: 'EMAIL', whatsapp: 'WHATSAPP', voice: null,
};

// --- Destination normalization + validation (E.164 / email) ----------------
// Shared by the send-time gate in commsProvider.sendMessage so every send path
// validates the destination before a provider call and matches opt-out rows
// (which may be stored in a different phone format) reliably.
export function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';
  return hasPlus ? `+${digits}` : digits;
}

// Best-effort E.164 coercion. Keeps an existing '+'; assumes NANP for a bare
// 10-digit number and a leading '1' for 11 digits. Never invents a country code
// for other lengths — isValidE164 then rejects anything still malformed.
export function toE164(raw: string | null | undefined, defaultCountry = '1'): string {
  const n = normalizePhone(raw);
  if (!n) return '';
  if (n.startsWith('+')) return n;
  if (n.length === 10) return `+${defaultCountry}${n}`;
  if (n.length === 11 && n.startsWith('1')) return `+${n}`;
  return `+${n}`;
}

export function isValidE164(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((email ?? '').trim());
}

// A comm channel maps to the ReceptionistOptOut channels that suppress it.
// ALL suppresses everything; SMS/WHATSAPP -> SMS; EMAIL -> EMAIL; VOICE -> VOICE.
const RECEPTIONIST_OPTOUT_CHANNELS: Record<CommChannel, ReceptionistOptOutChannel[]> = {
  sms: ['ALL', 'SMS'], whatsapp: ['ALL', 'SMS'], email: ['ALL', 'EMAIL'], voice: ['ALL', 'VOICE'],
};

// Cross-module suppression: honor an opt-out captured during an AI receptionist
// call (ReceptionistOptOut, written by the Retell webhook, channel ALL by
// default). Matched on the destination (phone/email), tenant-scoped. This is the
// bridge that makes a receptionist opt-out suppress SMS/CRM sends too.
export async function isDestinationOptedOut(tenantId: string, destination: string | null | undefined, channel: CommChannel): Promise<boolean> {
  const value = (destination ?? '').trim();
  if (!value) return false;
  const isEmail = value.includes('@');
  const channels = RECEPTIONIST_OPTOUT_CHANNELS[channel];
  const rows = await db.receptionistOptOut.findMany({
    where: { tenantId, revokedAt: null, channel: { in: channels }, ...(isEmail ? { contactEmail: { not: null } } : { contactPhone: { not: null } }) },
    select: { contactPhone: true, contactEmail: true },
  });
  if (isEmail) {
    const target = canonicalDncDestination(value);
    return rows.some(r => canonicalDncDestination(r.contactEmail ?? '') === target);
  }
  return rows.some(r => canonicalDncDestination(r.contactPhone ?? '') === canonicalDncDestination(value));
}

export type SuppressionTarget = { patientId?: string | null; leadId?: string | null; destination?: string | null };

/**
 * Identity-keyed half of the suppression decision, on a caller-supplied tenant
 * transaction. Factored out of isSuppressed() so the durable submission fence
 * can take the SAME decision inside the transaction that commits the provider
 * intent, without the two checks ever drifting apart.
 */
async function identitySuppressedTx(tx: TenantTxClient, tenantId: string, target: SuppressionTarget, channel: CommChannel): Promise<boolean> {
  const where = { tenantId, patientId: target.patientId ?? null, leadId: target.leadId ?? null };
  const [optedOut, suppressed] = await Promise.all([
    tx.communicationConsent.count({ where: { ...where, channel, status: 'opted_out' } }),
    tx.campaignSuppression.count({ where: { ...where, channel, active: true } }),
  ]);
  if (optedOut > 0 || suppressed > 0) return true;

  // Honor an explicit legacy ConsentEvent opt-out (latest event per purpose).
  // Never fabricates opt-in — only an explicit granted=false suppresses.
  // A MARKETING opt-out suppresses ALL channels (cross-channel marketing consent);
  // SMS/EMAIL/WHATSAPP opt-outs suppress their mapped channel.
  if (target.patientId) {
    const purpose = CONSENT_PURPOSE[channel];
    const purposes = purpose ? [purpose, 'MARKETING' as const] : ['MARKETING' as const];
    const events = await tx.consentEvent.findMany({ where: { tenantId, patientId: target.patientId, purpose: { in: purposes } }, orderBy: { occurredAt: 'desc' } });
    const seen = new Set<string>();
    for (const e of events) {
      if (seen.has(e.purpose)) continue; // latest per purpose only
      seen.add(e.purpose);
      if (e.granted === false) return true;
    }
  }
  return false;
}

/**
 * The full suppression decision on ONE transaction. Callers that need the
 * decision linearized with a durable claim (see campaignIntegrity) must use
 * this and must hold the receptionist suppression advisory fences first.
 */
export async function isSuppressedTx(tx: TenantTxClient, tenantId: string, target: SuppressionTarget, channel: CommChannel): Promise<boolean> {
  if (await identitySuppressedTx(tx, tenantId, target, channel)) return true;
  if (target.destination && await isDestinationOptedOutTx(tx, tenantId, target.destination, channel)) return true;
  return false;
}

export async function isSuppressed(tenantId: string, target: SuppressionTarget, channel: CommChannel): Promise<boolean> {
  // ConsentEvent is RLS-enrolled, so the consent reads run inside a tenant
  // transaction (GUC set on the same connection). Without it the legacy
  // ConsentEvent opt-out check would silently see zero rows under app_rls and
  // fail OPEN (a real opt-out would be missed). CommunicationConsent /
  // CampaignSuppression are not enrolled but are read here for a single context.
  const identitySuppressed = await runWithTenantContext(tenantId, tx => identitySuppressedTx(tx, tenantId, target, channel));
  if (identitySuppressed) return true;

  // Cross-module: a receptionist-call opt-out (destination-keyed) suppresses too.
  // ReceptionistOptOut is not RLS-enrolled, so it is read on the global client.
  if (target.destination && await isDestinationOptedOut(tenantId, target.destination, channel)) return true;

  return false;
}

// --- Audience candidates ---------------------------------------------------
export interface AudienceCandidate { patientId: string | null; leadId: string | null; name: string; email: string | null; phone: string | null; reason: string }

/** Audience generation options. */
export interface AudienceOptions {
  /** Inactivity window (days) for the `inactive_patients` audience. */
  inactiveDays?: number;
  /**
   * Branch isolation. Audience sources previously filtered on tenantId ONLY, so
   * a branch-restricted operator could preview and target patients belonging to
   * branches they cannot otherwise see. Callers pass `request.auth.branchId`;
   * null/undefined means the caller is tenant-wide. Semantics deliberately match
   * `branchScope()` in server/lib/scope.ts: an exact branchId match, so rows
   * with no branch assigned (e.g. an unrouted AppointmentRequest) fail CLOSED
   * for a scoped caller rather than leaking into their audience.
   */
  branchId?: string | null;
}

export async function buildAudience(tenantId: string, audienceType: AudienceType, opts: AudienceOptions = {}): Promise<AudienceCandidate[]> {
  const now = Date.now();
  const branchFilter = opts.branchId ? { branchId: opts.branchId } : {};
  // Audience sources read RLS-enrolled PHI tables (Patient, Appointment,
  // PaymentRequest, DepositRequirement, EligibilityVerification). Run inside a
  // tenant transaction so app.current_tenant_id is set on the SAME connection —
  // otherwise, under the enforced app_rls role, these reads fail-closed to ZERO
  // rows and every campaign would silently target nobody.
  return runWithTenantContext(tenantId, async tx => {
    switch (audienceType) {
      case 'inactive_patients': {
        const cutoff = new Date(now - (opts.inactiveDays ?? INACTIVE_DAYS_DEFAULT) * 86400000);
        const rows = await tx.patient.findMany({
          where: { tenantId, ...branchFilter, deletedAt: null, lifecycleStage: { not: 'LOST' }, OR: [{ lastVisitAt: { lt: cutoff } }, { lastVisitAt: null, createdAt: { lt: cutoff } }] },
          select: { id: true, firstName: true, lastName: true, email: true, phone: true }, take: 500,
        });
        return rows.map(p => ({ patientId: p.id, leadId: null, name: `${p.firstName} ${p.lastName}`, email: p.email, phone: p.phone, reason: 'No recent visit' }));
      }
      case 'no_show_recovery': {
        const appts = await tx.appointment.findMany({ where: { tenantId, ...branchFilter, status: 'NO_SHOW', deletedAt: null }, select: { patientId: true, patient: { select: { firstName: true, lastName: true, email: true, phone: true } } }, orderBy: { startsAt: 'desc' }, take: 500 });
        const seen = new Set<string>();
        const out: AudienceCandidate[] = [];
        for (const a of appts) { if (seen.has(a.patientId)) continue; seen.add(a.patientId); out.push({ patientId: a.patientId, leadId: null, name: `${a.patient.firstName} ${a.patient.lastName}`, email: a.patient.email, phone: a.patient.phone, reason: 'Missed appointment' }); }
        return out;
      }
      case 'unpaid_deposit_followup': {
        const reqs = await tx.depositRequirement.findMany({ where: { tenantId, ...branchFilter, status: { in: ['required', 'requested', 'link_sent'] }, patientId: { not: null } }, select: { patientId: true, patient: { select: { firstName: true, lastName: true, email: true, phone: true } } }, take: 500 });
        const seen = new Set<string>();
        const out: AudienceCandidate[] = [];
        for (const r of reqs) { if (!r.patientId || seen.has(r.patientId)) continue; seen.add(r.patientId); out.push({ patientId: r.patientId, leadId: null, name: r.patient ? `${r.patient.firstName} ${r.patient.lastName}` : 'Patient', email: r.patient?.email ?? null, phone: r.patient?.phone ?? null, reason: 'Unpaid deposit' }); }
        return out;
      }
      case 'failed_payment_recovery': {
        const prs = await tx.paymentRequest.findMany({ where: { tenantId, ...branchFilter, status: { in: ['failed', 'expired'] }, patientId: { not: null } }, select: { patientId: true, patient: { select: { firstName: true, lastName: true, email: true, phone: true } } }, orderBy: { createdAt: 'desc' }, take: 500 });
        const seen = new Set<string>();
        const out: AudienceCandidate[] = [];
        for (const r of prs) { if (!r.patientId || seen.has(r.patientId)) continue; seen.add(r.patientId); out.push({ patientId: r.patientId, leadId: null, name: r.patient ? `${r.patient.firstName} ${r.patient.lastName}` : 'Patient', email: r.patient?.email ?? null, phone: r.patient?.phone ?? null, reason: 'Failed/expired payment' }); }
        return out;
      }
      case 'insurance_update_request': {
        // Patient-facing "please update your insurance" — uses ineligible checks.
        const vers = await tx.eligibilityVerification.findMany({ where: { tenantId, ...branchFilter, coverageActive: false }, select: { patientId: true, patient: { select: { firstName: true, lastName: true, email: true, phone: true } } }, orderBy: { checkedAt: 'desc' }, take: 500 });
        const seen = new Set<string>();
        const out: AudienceCandidate[] = [];
        for (const v of vers) { if (seen.has(v.patientId)) continue; seen.add(v.patientId); out.push({ patientId: v.patientId, leadId: null, name: `${v.patient.firstName} ${v.patient.lastName}`, email: v.patient.email, phone: v.patient.phone, reason: 'Insurance needs update' }); }
        return out;
      }
      case 'appointment_request_followup': {
        const reqs = await tx.appointmentRequest.findMany({ where: { tenantId, ...branchFilter, status: { in: ['PENDING_REVIEW', 'MISSING_INFO'] } }, select: { id: true, patientId: true, leadId: true, collectedName: true, collectedPhone: true, collectedEmail: true, patient: { select: { firstName: true, lastName: true, email: true, phone: true } } }, take: 500 });
        return reqs.map(r => ({ patientId: r.patientId, leadId: r.leadId, name: r.patient ? `${r.patient.firstName} ${r.patient.lastName}` : (r.collectedName ?? 'Lead'), email: r.patient?.email ?? r.collectedEmail, phone: r.patient?.phone ?? r.collectedPhone, reason: 'Pending appointment request' }));
      }
      case 'review_request': {
        const appts = await tx.appointment.findMany({ where: { tenantId, ...branchFilter, status: 'COMPLETED', deletedAt: null }, select: { patientId: true, patient: { select: { firstName: true, lastName: true, email: true, phone: true } } }, orderBy: { startsAt: 'desc' }, take: 500 });
        const seen = new Set<string>();
        const out: AudienceCandidate[] = [];
        for (const a of appts) { if (seen.has(a.patientId)) continue; seen.add(a.patientId); out.push({ patientId: a.patientId, leadId: null, name: `${a.patient.firstName} ${a.patient.lastName}`, email: a.patient.email, phone: a.patient.phone, reason: 'Completed visit' }); }
        return out;
      }
      default:
        return [];
    }
  });
}

// Preview: deterministic counts after consent/suppression + contact gating.
export interface AudiencePreview { audienceType: AudienceType; channel: CommChannel; total: number; eligible: number; suppressed: number; missingContact: number; sample: Array<{ name: string; reason: string; destinationMasked: string | null }> }

export async function previewAudience(tenantId: string, audienceType: AudienceType, channel: CommChannel, opts: AudienceOptions = {}): Promise<AudiencePreview> {
  // The sample returns REAL patient names + a reason string, so the branch scope
  // of the caller must reach the audience query itself — not just the response.
  const candidates = await buildAudience(tenantId, audienceType, opts);
  let eligible = 0, suppressed = 0, missingContact = 0;
  const sample: AudiencePreview['sample'] = [];
  const field = channelField(channel);
  for (const c of candidates) {
    const contact = field === 'email' ? c.email : c.phone;
    if (!contact) { missingContact++; continue; }
    if (await isSuppressed(tenantId, { patientId: c.patientId, leadId: c.leadId, destination: contact }, channel)) { suppressed++; continue; }
    eligible++;
    if (sample.length < 5) sample.push({ name: c.name, reason: c.reason, destinationMasked: maskDestination(contact) });
  }
  return { audienceType, channel, total: candidates.length, eligible, suppressed, missingContact, sample };
}

// --- Real open-slot detection (from existing appointment gaps) -------------
// Computes genuinely-open slots from existing bookings — NOT a fake count and
// NOT an automated booking engine. Uses a standard clinic window (09:00–17:00,
// 30-min slots) per branch over the next `days`, counting slots not overlapped
// by an active appointment. This is a recommendation input only.
const SLOT_MINUTES = 30;
const DAY_START_HOUR = 9;
const DAY_END_HOUR = 17;

export async function countOpenSlots(tenantId: string, days = 7, opts: { branchId?: string | null } = {}): Promise<number> {
  const now = new Date();
  const horizon = new Date(now.getTime() + days * 86400000);
  // A branch-restricted caller must not learn the capacity of other branches.
  const branchFilter = opts.branchId ? { branchId: opts.branchId } : {};
  const [branches, appts] = await Promise.all([
    db.branch.findMany({ where: { tenantId, active: true, ...(opts.branchId ? { id: opts.branchId } : {}) }, select: { id: true } }),
    db.appointment.findMany({ where: { tenantId, ...branchFilter, deletedAt: null, startsAt: { gte: now, lt: horizon }, status: { notIn: ['CANCELED', 'NO_SHOW', 'COMPLETED'] } }, select: { branchId: true, startsAt: true, endsAt: true } }),
  ]);
  const busyByBranch = new Map<string, Array<{ start: number; end: number }>>();
  for (const a of appts) {
    const arr = busyByBranch.get(a.branchId) ?? [];
    arr.push({ start: a.startsAt.getTime(), end: a.endsAt.getTime() });
    busyByBranch.set(a.branchId, arr);
  }
  let open = 0;
  for (const b of branches) {
    const busy = busyByBranch.get(b.id) ?? [];
    for (let d = 0; d < days; d++) {
      const day = new Date(now.getTime() + d * 86400000);
      for (let h = DAY_START_HOUR; h < DAY_END_HOUR; h++) {
        for (let m = 0; m < 60; m += SLOT_MINUTES) {
          const slotStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
          const slotEnd = slotStart + SLOT_MINUTES * 60000;
          if (slotStart < now.getTime()) continue;
          if (!busy.some(x => x.start < slotEnd && x.end > slotStart)) open++;
        }
      }
    }
  }
  return open;
}

// --- Rule-based message drafts (no LLM; no clinical advice) -----------------
export interface CampaignDraft { subject: string; body: string; channel: CommChannel; reason: string; draftSource: 'rule_based' | 'ai'; requiresApproval: true; warnings: string[]; sourceSummary: string }

const TEMPLATES: Record<string, { subject: string; body: string }> = {
  appointment_reminder: { subject: 'Appointment reminder', body: 'Hi {{firstName}}, this is a reminder of your upcoming appointment at {{clinicName}}. Contact the clinic using verified contact details to confirm or request a change. This message does not change the appointment.' },
  appointment_confirmation: { subject: 'Please confirm your appointment', body: 'Hi {{firstName}}, contact {{clinicName}} using verified contact details to confirm or request a change to your upcoming appointment. This message does not change the appointment.' },
  no_show_recovery: { subject: 'We missed you', body: 'Hi {{firstName}}, we missed you at your recent appointment with {{clinicName}}. We’d love to help you rebook at a time that works for you.' },
  unpaid_deposit_followup: { subject: 'Complete your booking', body: 'Hi {{firstName}}, your appointment with {{clinicName}} has an outstanding deposit. You can complete payment using the secure link our team will share.' },
  failed_payment_recovery: { subject: 'Payment didn’t go through', body: 'Hi {{firstName}}, a recent payment for your visit with {{clinicName}} didn’t complete. Our team can share a fresh secure payment link whenever you’re ready.' },
  insurance_update_request: { subject: 'Update your insurance', body: 'Hi {{firstName}}, to keep your records current, please share your latest insurance information with {{clinicName}} before your next visit.' },
  inactive_patient_reactivation: { subject: 'We’d love to see you again', body: 'Hi {{firstName}}, it’s been a while since your last visit to {{clinicName}}. Reach out whenever you’d like to schedule a visit.' },
  missed_call_recovery: { subject: 'Sorry we missed your call', body: 'Hi {{firstName}}, we saw we missed your call to {{clinicName}}. Let us know how we can help or when you’d like to book.' },
  appointment_request_followup: { subject: 'Let’s finish booking', body: 'Hi {{firstName}}, thanks for your appointment request with {{clinicName}}. Our team will follow up to confirm the details.' },
  review_request: { subject: 'How was your visit?', body: 'Hi {{firstName}}, thank you for visiting {{clinicName}}. We’d appreciate your feedback when you have a moment.' },
  custom: { subject: 'A message from {{clinicName}}', body: 'Hi {{firstName}}, {{clinicName}} would like to get in touch.' },
};

export function generateDraft(campaignType: CampaignType, channel: CommChannel, audienceType: AudienceType): CampaignDraft {
  const tpl = TEMPLATES[campaignType] ?? TEMPLATES.custom;
  const warnings: string[] = [];
  if (STAFF_FACING_AUDIENCES.has(audienceType)) warnings.push('This audience is staff-facing; route to staff review rather than patient outreach.');
  warnings.push('Rule-based draft — review before approval. No clinical advice; do not add diagnosis or treatment instructions.');
  return {
    subject: tpl.subject, body: tpl.body, channel, reason: `${campaignType} via ${channel}`,
    draftSource: 'rule_based', requiresApproval: true, warnings,
    sourceSummary: `Generated from the ${campaignType} template for the ${audienceType} audience (rule-based, no PHI).`,
  };
}
