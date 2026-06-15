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
  messageSubject: string | null;
  messageTemplate: string | null;
  draftSource: string | null;
  audienceSize: number;
  allowedActions: string[];
  deepLinkTarget: string;
  requiresApprovalPending: boolean;
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
  summary: { total: number; sent: number; suppressed: number; skipped: number; setupRequired: number; pending: number };
  provider: { channel: string; configured: boolean; setupRequired: boolean; missing: string[] };
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
}

export const CAMPAIGN_STATUS_META: Record<string, { label: string; badge: string }> = {
  DRAFT: { label: 'Draft', badge: 'badge-blue' },
  APPROVAL_REQUIRED: { label: 'Approval required', badge: 'badge-amber' },
  SCHEDULED: { label: 'Scheduled', badge: 'badge-violet' },
  ACTIVE: { label: 'Running', badge: 'badge-emerald' },
  PAUSED: { label: 'Paused', badge: 'badge-amber' },
  COMPLETED: { label: 'Completed', badge: 'badge-emerald' },
  CANCELLED: { label: 'Cancelled', badge: 'badge-red' },
  FAILED: { label: 'Failed', badge: 'badge-red' },
};

export const DELIVERY_STATUS_META: Record<string, { label: string; badge: string }> = {
  sent: { label: 'Sent', badge: 'badge-emerald' },
  pending: { label: 'Queued', badge: 'badge-amber' },
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
}

const base = '/v1/crm';

export const crmApi = {
  providerStatus: () => apiRequest<ProviderReadiness>(`${base}/provider-status`),
  listCampaigns: () => apiRequest<Campaign[]>(`${base}/campaigns`),
  getCampaign: (id: string) => apiRequest<Campaign>(`${base}/campaigns/${id}`),
  createCampaign: (body: { name: string; campaignType: CampaignType; audienceType?: AudienceType; channel?: CommChannel }) =>
    apiRequest<Campaign>(`${base}/campaigns`, { method: 'POST', body: JSON.stringify(body) }),
  generateDraft: (id: string) => apiRequest<CampaignDraft & { campaignId: string }>(`${base}/campaigns/${id}/draft`, { method: 'POST' }),
  previewAudience: (type: AudienceType, channel: CommChannel) => apiRequest<AudiencePreview>(`${base}/audiences/${type}/preview?channel=${channel}`),
  approve: (id: string) => apiRequest<Campaign>(`${base}/campaigns/${id}/approve`, { method: 'POST' }),
  launch: (id: string, force = false) => apiRequest<LaunchResult>(`${base}/campaigns/${id}/launch`, { method: 'POST', body: JSON.stringify({ force }) }),
  pause: (id: string) => apiRequest<Campaign>(`${base}/campaigns/${id}/pause`, { method: 'POST' }),
  cancel: (id: string) => apiRequest<Campaign>(`${base}/campaigns/${id}/cancel`, { method: 'POST' }),
  updateCampaign: (id: string, body: { name?: string; messageSubject?: string; messageTemplate?: string; channel?: CommChannel; scheduledAt?: string }) =>
    apiRequest<Campaign>(`${base}/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteCampaign: (id: string) => apiRequest<void>(`${base}/campaigns/${id}`, { method: 'DELETE' }),
  listDeliveries: (id: string) => apiRequest<CampaignDelivery[]>(`${base}/campaigns/${id}/deliveries`),
  listSuppressions: () => apiRequest<Array<{ id: string; channel: string; reason: string; patientId: string | null }>>(`${base}/suppressions`),
};
