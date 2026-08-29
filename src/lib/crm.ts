import { apiRequest } from './api';

// --- Types -----------------------------------------------------------------

export const AUDIENCE_TYPES = [
  'inactive_patients', 'no_show_recovery', 'unpaid_deposit_followup', 'failed_payment_recovery',
  'insurance_update_request', 'appointment_request_followup', 'review_request',
] as const;
export type AudienceType = typeof AUDIENCE_TYPES[number];

export const CAMPAIGN_TYPES = [
  'appointment_reminder', 'appointment_confirmation', 'no_show_recovery', 'unpaid_deposit_followup',
  'failed_payment_recovery', 'insurance_update_request', 'inactive_patient_reactivation',
  'missed_call_recovery', 'appointment_request_followup', 'review_request', 'custom',
] as const;
export type CampaignType = typeof CAMPAIGN_TYPES[number];

export type CommChannel = 'sms' | 'email' | 'voice' | 'whatsapp';

// --- Campaign handoff ------------------------------------------------------

/**
 * What a "start a campaign" call to action must carry.
 *
 * Every entry point into the campaign workspace — a goal card, a CRM segment, a
 * patient's next best action, a ClinicRadar or Reviews recommendation — is a
 * decision the user already made. Navigating with no payload throws that
 * decision away and asks for it again one screen later, which is how the goal
 * chosen on the planner used to be discarded on the way to the engine.
 *
 * Senders: `navigate('/campaigns', { state: <CampaignHandoff> })`.
 * Every field is optional; what is supplied prefills the creator, and what is
 * not is still asked for. Nothing here authorizes an audience or a dispatch:
 * approval and launch remain the fingerprinted server checks.
 */
export interface CampaignHandoff {
  /** A key of CAMPAIGN_GOALS. Resolves to a campaign type and audience. */
  goal?: CampaignGoal;
  /** Explicit overrides, for a sender that knows exactly what it wants. */
  campaignType?: CampaignType;
  audienceType?: AudienceType;
  channel?: CommChannel;
  /** Suggested campaign name. Always editable before creation. */
  name?: string;
  /** Where the decision was made ("ClinicRadar", "CRM segment"). */
  source?: string;
  /** The specific thing that was acted on, echoed back to the operator. */
  contextLabel?: string;
}

/**
 * The objectives the engine can actually execute, each bound to a campaign type
 * and to a server audience source that `GET /v1/crm/audiences/:type/preview`
 * can evidence. A goal with no executable audience is not offered: an objective
 * the dispatch path cannot serve is a dead end dressed as a product.
 */
export const CAMPAIGN_GOALS = {
  winback: {
    label: 'Reconnect with inactive patients',
    description: 'Draft outreach for patients with no recent visit',
    campaignType: 'inactive_patient_reactivation',
    audienceType: 'inactive_patients',
  },
  no_show: {
    label: 'Recover missed appointments',
    description: 'Draft a follow-up for recorded no-shows',
    campaignType: 'no_show_recovery',
    audienceType: 'no_show_recovery',
  },
  requests: {
    label: 'Follow up on appointment requests',
    description: 'Answer requests that have not been booked yet',
    campaignType: 'appointment_request_followup',
    audienceType: 'appointment_request_followup',
  },
  reviews: {
    label: 'Request patient feedback',
    description: 'Prepare a post-visit feedback request',
    campaignType: 'review_request',
    audienceType: 'review_request',
  },
  payments: {
    label: 'Recover failed payments',
    description: 'Follow up on payments the processor declined',
    campaignType: 'failed_payment_recovery',
    audienceType: 'failed_payment_recovery',
  },
  deposits: {
    label: 'Chase unpaid deposits',
    description: 'Follow up on deposits that were never settled',
    campaignType: 'unpaid_deposit_followup',
    audienceType: 'unpaid_deposit_followup',
  },
  insurance: {
    label: 'Request insurance updates',
    description: 'Ask for current coverage details before a visit',
    campaignType: 'insurance_update_request',
    audienceType: 'insurance_update_request',
  },
} as const satisfies Record<string, {
  label: string; description: string; campaignType: CampaignType; audienceType: AudienceType;
}>;

export type CampaignGoal = keyof typeof CAMPAIGN_GOALS;

export function isCampaignGoal(value: unknown): value is CampaignGoal {
  return typeof value === 'string' && value in CAMPAIGN_GOALS;
}

/**
 * Reads a router `location.state` as a handoff. Unknown or malformed payloads
 * resolve to nothing rather than to a guess: a prefilled audience the sender
 * never chose would be a fabricated decision, and this one ends in outreach.
 */
export function readCampaignHandoff(state: unknown): CampaignHandoff | null {
  if (!state || typeof state !== 'object') return null;
  const raw = state as Record<string, unknown>;
  const handoff: CampaignHandoff = {};
  if (isCampaignGoal(raw.goal)) handoff.goal = raw.goal;
  if (typeof raw.campaignType === 'string' && (CAMPAIGN_TYPES as readonly string[]).includes(raw.campaignType)) {
    handoff.campaignType = raw.campaignType as CampaignType;
  }
  if (typeof raw.audienceType === 'string' && (AUDIENCE_TYPES as readonly string[]).includes(raw.audienceType)) {
    handoff.audienceType = raw.audienceType as AudienceType;
  }
  if (raw.channel === 'sms' || raw.channel === 'email' || raw.channel === 'voice' || raw.channel === 'whatsapp') {
    handoff.channel = raw.channel;
  }
  if (typeof raw.name === 'string' && raw.name.trim()) handoff.name = raw.name.trim().slice(0, 160);
  if (typeof raw.source === 'string' && raw.source.trim()) handoff.source = raw.source.trim().slice(0, 120);
  // ClinicRadar and the patient drawer send their own context shape; `title`
  // and `recommendedAction` are the labels those screens showed the user, so
  // they are carried through rather than dropped on the floor.
  const label = [raw.contextLabel, raw.title, raw.recommendedAction].find(v => typeof v === 'string' && v.trim());
  if (typeof label === 'string') handoff.contextLabel = label.trim().slice(0, 200);
  const branch = raw.branchName;
  if (typeof branch === 'string' && branch.trim() && handoff.contextLabel) {
    handoff.contextLabel = `${handoff.contextLabel} · ${branch.trim()}`.slice(0, 240);
  }
  return Object.keys(handoff).length > 0 ? handoff : null;
}

/** The creator's starting point: the handoff's own fields, or its goal's. */
export function resolveHandoffDefaults(handoff: CampaignHandoff | null): {
  campaignType: CampaignType | null; audienceType: AudienceType | null; channel: CommChannel; name: string;
} {
  const preset = handoff?.goal ? CAMPAIGN_GOALS[handoff.goal] : null;
  return {
    campaignType: handoff?.campaignType ?? preset?.campaignType ?? null,
    audienceType: handoff?.audienceType ?? preset?.audienceType ?? null,
    channel: handoff?.channel ?? 'sms',
    name: handoff?.name ?? '',
  };
}

export interface Campaign {
  id: string;
  name: string;
  campaignType: string | null;
  audienceType: string | null;
  channel: string | null;
  status: string;
  requiresApproval: boolean;
  approvedByUserId: string | null;
  approvedAt: string | null;
  scheduledAt: string | null;
  messageSubject: string | null;
  messageTemplate: string | null;
  draftSource: string | null;
  audienceSize: number;
  allowedActions: string[];
  deepLinkTarget: string;
  requiresApprovalPending: boolean;
  archivedAt: string | null;
  dispatchAuthorizedAt: string | null;
  dispatchAuthorizedByUserId: string | null;
  dispatchAuthorizationRecorded: boolean;
  deliveryCounts?: Record<string, number>;
}

export interface AudiencePreview {
  audienceType: string;
  channel: string;
  total: number;
  eligible: number;
  suppressed: number;
  missingContact: number;
  sample: Array<{ name: string; reason: string; destinationMasked: string | null }>;
}

export interface CampaignDraft {
  subject: string;
  body: string;
  channel: string;
  draftSource: string;
  requiresApproval: boolean;
  warnings: string[];
  sourceSummary: string;
}

export interface LaunchResult {
  campaignId: string;
  status: string;
  setupRequired: boolean;
  summary: { total: number; accepted: number; deliveryUnknown: number; suppressed: number; skipped: number; setupRequired: number; queued: number; failed: number; authorityBlocked: number; atomicBoundaryBlocked: number };
  provider: { channel: string; configured: boolean; setupRequired: boolean; missing: string[]; mode: string; liveDispatchActivated: boolean };
  launchFingerprint: string;
}

export interface CampaignLaunchPreview {
  campaignId: string;
  fingerprint: string;
  templateRevision: string;
  providerMode: string;
  provider: string;
  channel: CommChannel;
  scheduledAt: string | null;
  audience: { total: number; eligible: number; suppressed: number; missingContact: number; authorityRequired: number; atomicBoundaryBlocked: number };
  liveDispatchActivated: boolean;
  activationNotice: string | null;
  finalConfirmationRequired: true;
  confirmationStatement: string;
}

export interface CampaignDelivery {
  deliveryId: string;
  patientId: string | null;
  leadId: string | null;
  channel: string;
  destinationMasked: string | null;
  status: string;
  provider: string | null;
  failureReason: string | null;
  sentAt: string | null;
  providerAcceptedAt?: string | null;
  deliveredAt?: string | null;
  statusUpdatedAt?: string;
}

export const CAMPAIGN_STATUS_META: Record<string, { label: string; badge: string }> = {
  DRAFT: { label: 'Draft', badge: 'badge-blue' },
  APPROVAL_REQUIRED: { label: 'Approval required', badge: 'badge-amber' },
  SCHEDULED: { label: 'Scheduled', badge: 'badge-violet' },
  ACTIVE: { label: 'Running', badge: 'badge-emerald' },
  PAUSED: { label: 'Paused', badge: 'badge-amber' },
  COMPLETED: { label: 'Completed', badge: 'badge-emerald' },
  CANCELLED: { label: 'Canceled', badge: 'badge-red' },
  FAILED: { label: 'Failed', badge: 'badge-red' },
};

export const DELIVERY_STATUS_META: Record<string, { label: string; badge: string }> = {
  sent: { label: 'Provider accepted (legacy)', badge: 'badge-emerald' },
  pending: { label: 'Queued (legacy)', badge: 'badge-amber' },
  accepted: { label: 'Provider accepted', badge: 'badge-emerald' },
  queued: { label: 'Queued', badge: 'badge-amber' },
  delivered: { label: 'Delivered', badge: 'badge-emerald' },
  delivery_unknown: { label: 'Delivery unknown', badge: 'badge-amber' },
  suppressed: { label: 'Suppressed', badge: 'badge-violet' },
  skipped: { label: 'Skipped', badge: 'badge-blue' },
  setup_required: { label: 'Setup required', badge: 'badge-red' },
  failed: { label: 'Failed', badge: 'badge-red' },
};

export interface ProviderReadiness {
  smsConfigured: boolean;
  emailConfigured: boolean;
  voiceConfigured: boolean;
  providerMode: Record<string, 'unconfigured' | 'mock_dev' | 'configured_pending_provider' | 'live_supported'>;
  missingEnvKeys: string[];
  supportedChannels: string[];
  unsupportedChannels: string[];
  schedulerEnforced: boolean;
  liveSendingSupported: boolean;
  liveCampaignDispatchActivated: boolean;
  activationNotice: string;
}

const base = '/v1/crm';

export const crmApi = {
  providerStatus: () => apiRequest<ProviderReadiness>(`${base}/provider-status`),
  // The signal is what lets a caller model this as one abortable resource
  // (useResource) instead of a fire-and-forget fetch whose late answer can
  // repaint a screen the user already left.
  listCampaigns: (signal?: AbortSignal) => apiRequest<Campaign[]>(`${base}/campaigns`, signal ? { signal } : undefined),
  getCampaign: (id: string) => apiRequest<Campaign>(`${base}/campaigns/${id}`),
  createCampaign: (body: { name: string; campaignType: CampaignType; audienceType?: AudienceType; channel?: CommChannel }) =>
    apiRequest<Campaign>(`${base}/campaigns`, { method: 'POST', body: JSON.stringify(body) }),
  generateDraft: (id: string) => apiRequest<CampaignDraft & { campaignId: string }>(`${base}/campaigns/${id}/draft`, { method: 'POST' }),
  previewAudience: (type: AudienceType, channel: CommChannel) => apiRequest<AudiencePreview>(`${base}/audiences/${type}/preview?channel=${channel}`),
  approve: (id: string, previewFingerprint: string) => apiRequest<Campaign>(`${base}/campaigns/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ previewFingerprint, confirmExactAudienceTemplateProvider: true }),
  }),
  launchPreview: (id: string) => apiRequest<CampaignLaunchPreview>(`${base}/campaigns/${id}/launch-preview`),
  launch: (id: string, previewFingerprint: string, force = false) => apiRequest<LaunchResult>(`${base}/campaigns/${id}/launch`, { method: 'POST', body: JSON.stringify({ force, previewFingerprint, confirmExactAudienceTemplateProvider: true }) }),
  pause: (id: string) => apiRequest<Campaign>(`${base}/campaigns/${id}/pause`, { method: 'POST' }),
  cancel: (id: string) => apiRequest<Campaign>(`${base}/campaigns/${id}/cancel`, { method: 'POST' }),
  updateCampaign: (id: string, body: { name?: string; messageSubject?: string; messageTemplate?: string; channel?: CommChannel; scheduledAt?: string }) =>
    apiRequest<Campaign>(`${base}/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  archiveCampaign: (id: string) => apiRequest<Campaign>(`${base}/campaigns/${id}`, { method: 'DELETE' }),
  listDeliveries: (id: string) => apiRequest<CampaignDelivery[]>(`${base}/campaigns/${id}/deliveries`),
  listSuppressions: () => apiRequest<Array<{ id: string; channel: string; reason: string; patientId: string | null }>>(`${base}/suppressions`),
  // Closed-loop attribution. Both reads are derived from CampaignAttribution
  // rows and both ship the basis that produced them.
  attributionSummary: (signal?: AbortSignal) =>
    apiRequest<CampaignAttributionSummary>(`${base}/attribution/summary`, signal ? { signal } : undefined),
  campaignAttribution: (id: string) => apiRequest<CampaignAttributionDetail>(`${base}/campaigns/${id}/attribution`),
};

// --- Closed-loop attribution ------------------------------------------------
//
// `GET /v1/crm/attribution/summary` and `GET /v1/crm/campaigns/:id/attribution`
// are derived from CampaignAttribution rows and from nothing else. Every field
// below mirrors what those routes send; the helpers underneath decide what a
// screen is ALLOWED to print from it.
//
// The rule the helpers exist to enforce: `attributedValue` is a total, and a
// total of no rows is the string '0.00'. Printing that as "$0 attributed" turns
// an absence of evidence into a measurement — the exact move this product
// refuses (Tebra multiplies volume by $3/reminder and $150/recall; RevenueWell
// credits itself with all revenue within 60 days of an unmatched request). The
// count of `paid` outcomes, never the value string, is what says money exists.

export interface CampaignAttributionOutcomes {
  engaged: number;
  booked: number;
  attended: number;
  paid: number;
}

/**
 * Engagement, always reported as unavailable with a reason. The server pins
 * openRate/responseRate to null on purpose: normalizeProviderDeliveryStatus
 * refuses a provider "opened" event, so there is no receipt to count.
 */
export interface CampaignEngagementDisclosure {
  openRate: null;
  responseRate: null;
  unavailableReason: string;
}

/** The figures both attribution endpoints ship for a campaign. */
export interface CampaignAttributionFigures {
  outcomes: CampaignAttributionOutcomes;
  /** A decimal STRING, and '0.00' whenever no `paid` row exists. Never print it directly. */
  attributedValue: string;
  currency: string | null;
  windowDaysObserved: number[];
  firstAttributedAt: string | null;
  lastAttributedAt: string | null;
  engagement: CampaignEngagementDisclosure;
}

export interface CampaignAttributionSummaryRow extends CampaignAttributionFigures {
  campaignId: string;
  name: string;
  campaignType: string | null;
  audienceType: string | null;
  branchId: string | null;
  status: string;
  /** Campaign.sent — deliveries a provider actually accepted. */
  providerAcceptedDeliveries: number;
  deepLinkTarget: string;
}

/** How the figures were produced, shipped with the figures by the API. */
export interface CampaignAttributionBasis {
  derivedFrom: string;
  rules: Record<string, string>;
  evidenceableOutcomes: string[];
  valueBasis: string;
  windowSource: string;
  notAttributed: string;
}

export interface CampaignAttributionSummary {
  campaigns: CampaignAttributionSummaryRow[];
  basis: CampaignAttributionBasis;
}

export interface CampaignAttributionRecord {
  id: string;
  outcomeType: string;
  campaignDeliveryId: string;
  patientId: string | null;
  leadId: string | null;
  branchId: string | null;
  appointmentId: string | null;
  paymentTransactionId: string | null;
  attributedValue: string;
  currency: string | null;
  window: { days: number; startsAt: string; endsAt: string; recordedAtAttributionTime: boolean };
  rule: string;
  evidence: unknown;
  attributedAt: string;
}

export interface CampaignAttributionDetail extends CampaignAttributionFigures {
  campaignId: string;
  attributions: CampaignAttributionRecord[];
  deepLinkTarget: string;
}

/**
 * What a screen may say about attributed money. `not_attributed` is a first
 * class answer, not an error: it is what the data supports when no delivery is
 * tied to a recorded payment.
 */
export type AttributedRevenue =
  | {
    status: 'attributed';
    amount: number;
    currency: string;
    /** How many `paid` outcome rows produced this total. */
    paidOutcomes: number;
    /** How many campaigns contributed at least one of them. */
    campaigns: number;
  }
  | { status: 'not_attributed'; reason: string };

export const NO_ATTRIBUTED_PAYMENT_REASON =
  'No delivery is tied to a booking or a payment yet, so no amount — including $0 — can be shown.';

/**
 * The one place a number is allowed out of an attribution payload.
 *
 * A `paid` outcome is the only row that carries money, so its COUNT is the test
 * for whether an amount exists. `attributedValue` is consulted only after that
 * count says there is something to read, which is why an empty workspace can
 * never reach "$0 attributed".
 */
export function summarizeAttributedRevenue(rows: readonly CampaignAttributionFigures[]): AttributedRevenue {
  const paying = rows.filter(row => (row.outcomes?.paid ?? 0) > 0);
  const paidOutcomes = paying.reduce((sum, row) => sum + row.outcomes.paid, 0);
  if (paying.length === 0 || paidOutcomes === 0) {
    return { status: 'not_attributed', reason: NO_ATTRIBUTED_PAYMENT_REASON };
  }

  const currencies = [...new Set(paying.map(row => row.currency?.trim().toUpperCase()).filter((c): c is string => !!c))];
  if (currencies.length === 0) {
    return {
      status: 'not_attributed',
      reason: `${paidOutcomes} attributed payment${paidOutcomes === 1 ? '' : 's'} carry no recorded currency, so they cannot be shown as one amount. Open the campaign to read the rows.`,
    };
  }
  if (currencies.length > 1) {
    return {
      status: 'not_attributed',
      reason: `Attributed payments were recorded in ${currencies.join(' and ')}. Amounts in different currencies are not added together; open each campaign to read its own total.`,
    };
  }

  const amount = paying.reduce((sum, row) => sum + Number(row.attributedValue), 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      status: 'not_attributed',
      reason: `${paidOutcomes} attributed payment${paidOutcomes === 1 ? '' : 's'} carry no readable net amount, so no figure can be shown. Open the campaign to read the rows.`,
    };
  }
  return { status: 'attributed', amount: Number(amount.toFixed(2)), currency: currencies[0], paidOutcomes, campaigns: paying.length };
}

/** Every attribution window that actually produced a row, ascending. */
export function attributionWindowsObserved(rows: readonly CampaignAttributionFigures[]): number[] {
  return [...new Set(rows.flatMap(row => row.windowDaysObserved ?? []))].sort((a, b) => a - b);
}

/** Total outcomes of one kind across a portfolio. */
export function countAttributedOutcomes(rows: readonly CampaignAttributionFigures[], outcome: keyof CampaignAttributionOutcomes): number {
  return rows.reduce((sum, row) => sum + (row.outcomes?.[outcome] ?? 0), 0);
}

/** Formats an attributed amount in the currency the evidence was recorded in. */
export function formatAttributedAmount(amount: number, currency: string): string {
  const code = currency.trim().toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  } catch {
    // An unrecognised code is still evidence; it is shown beside the number
    // rather than dropped or silently rendered as dollars.
    return `${amount.toFixed(2)} ${code}`;
  }
}

const ENGAGEMENT_UNAVAILABLE_REASONS: Record<string, string> = {
  no_truthful_open_or_reply_receipt:
    'Open and reply rates are not reported: no provider gives this platform a truthful open or reply receipt, so no percentage — including 0% — can be shown.',
};

/**
 * The engagement sentence. There is deliberately no numeric branch: a rate this
 * platform cannot evidence is named as unavailable, never rendered as 0%.
 */
export function describeEngagementUnavailability(engagement: { unavailableReason?: string } | null | undefined): string {
  const reason = engagement?.unavailableReason?.trim();
  if (!reason) {
    return 'Open and reply rates are not reported, and no reason was stated. No percentage — including 0% — can be shown.';
  }
  return ENGAGEMENT_UNAVAILABLE_REASONS[reason]
    ?? `Open and reply rates are not reported (${reason}). No percentage — including 0% — can be shown.`;
}
