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
};
