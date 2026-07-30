import { apiRequest } from './api';

// --- Types -----------------------------------------------------------------

export type FieldType =
  | 'FIRST_NAME' | 'LAST_NAME' | 'PHONE' | 'EMAIL' | 'PREFERRED_DATE' | 'PREFERRED_TIME'
  | 'PREFERRED_LOCATION' | 'PATIENT_STATUS' | 'INSURANCE_PROVIDER' | 'REASON_FOR_VISIT'
  | 'PREFERRED_PROVIDER' | 'LANGUAGE_PREFERENCE' | 'CONSENT' | 'CUSTOM_TEXT'
  | 'CUSTOM_DROPDOWN' | 'CUSTOM_YES_NO';

export type CampaignStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
export type RequestStatus = 'PENDING' | 'CONFIRMED' | 'CANCELED' | 'COMPLETED' | 'NO_SLOTS';
export type CallOutcome = 'IN_PROGRESS' | 'BOOKED' | 'NOT_INTERESTED' | 'NO_ANSWER' | 'VOICEMAIL' | 'ESCALATED' | 'OPTED_OUT' | 'FAILED';
export type OptOutChannel = 'VOICE' | 'SMS' | 'EMAIL' | 'ALL';

export interface BookingRules {
  leadTimeHours?: number;
  slotDurationMinutes?: number;
  maxPerDay?: number;
  availableDays?: string[];
  hoursStart?: string;
  hoursEnd?: string;
  notes?: string;
}

export interface Location {
  id: string;
  clinicId: string;
  branchId: string | null;
  name: string;
  address: string;
  phone: string | null;
  timezone: string | null;
  workingHours: WeeklyHours | null;
  active: boolean;
}

export type HoursWindow = { open: boolean; start?: string; end?: string };
export type WeeklyHours = Partial<Record<'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday', HoursWindow>>;

export interface SchedulingBranch {
  id: string;
  name: string;
  location: string;
  timezone: string;
  active: boolean;
}

export interface Agent {
  id: string;
  clinicId: string;
  name: string;
  voice: string;
  tone: string;
  language: string;
  persona: string | null;
  greetingOverride: string | null;
  active: boolean;
  providerAgentId: string | null;
  providerVersionTag: string;
  providerVersion: number | null;
  providerStatus: 'UNVERIFIED' | 'VERIFIED' | 'INVALID';
  providerPublished: boolean | null;
  providerVoiceId: string | null;
  providerLanguage: string | null;
  providerVerifiedAt: string | null;
  providerVerificationExpiresAt: string | null;
  providerLastAttemptAt: string | null;
  providerLastAttemptStatus: 'NEVER' | 'SUCCEEDED' | 'FAILED';
  providerLastErrorCode: string | null;
}

export interface Clinic {
  id: string;
  name: string;
  logoUrl: string | null;
  phone: string;
  website: string | null;
  addressLine: string | null;
  timezone: string;
  defaultLanguage: string;
  complianceDisclosure: string;
  humanFallbackNumber: string | null;
  doNotContactPolicy: string;
  workingHours: WeeklyHours | null;
  active: boolean;
  locations?: Location[];
  agents?: Agent[];
  _count?: { campaigns: number };
}

export interface IntakeField {
  id: string;
  campaignId: string;
  fieldType: FieldType;
  label: string;
  aiQuestion: string;
  validationRule: string | null;
  placeholder: string | null;
  options: string[];
  required: boolean;
  confirmationRequired: boolean;
  sortOrder: number;
}

export interface Campaign {
  id: string;
  clinicId: string;
  agentId: string | null;
  name: string;
  campaignType: string;
  status: CampaignStatus;
  offerTitle: string;
  offerDescription: string;
  offerScript: string;
  appointmentType: string;
  bookingRules: BookingRules | null;
  eligibleLocationIds: string[];
  smsConfirmation: boolean;
  emailConfirmation: boolean;
  intakeFields?: IntakeField[];
  agent?: { id: string; name: string; voice: string } | null;
  clinic?: { id: string; name: string };
  _count?: { callLogs: number; appointmentRequests: number };
}

export interface PromptResult {
  systemPrompt: string;
  samples: {
    greeting: string;
    pitch: string;
    intakeQuestions: string[];
    confirmation: string;
  };
}

export interface RetellConfig {
  systemPrompt: string;
  voiceId: string;
  language: string;
  beginMessage: string;
  dynamicVariables: Record<string, string>;
  webhookUrl: string;
  bookingFunction: Record<string, unknown>;
  callOutcomeFields: Array<Record<string, unknown>>;
}

export interface CallLog {
  id: string;
  campaignId: string | null;
  retellCallId: string | null;
  callerName: string | null;
  callerPhone: string | null;
  direction: string;
  outcome: CallOutcome;
  durationSeconds: number;
  sentiment: string | null;
  transcriptSummary: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  campaign?: { id: string; name: string } | null;
}

export interface AppointmentRequest {
  id: string;
  campaignId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  appointmentType: string | null;
  requestedDate: string | null;
  requestedTime: string | null;
  bookedSlot: string | null;
  status: RequestStatus;
  createdAt: string;
  campaign?: { id: string; name: string } | null;
}

export interface OptOut {
  id: string;
  contactPhone: string | null;
  contactEmail: string | null;
  channel: OptOutChannel;
  reason: string | null;
  createdAt: string;
}

export interface Overview {
  clinics: number;
  activeCampaigns: number;
  totalCampaigns: number;
  totalCalls: number;
  booked: number;
  bookingRate: number;
  appointmentRequests: number;
  optOuts: number;
  avgDurationSeconds: number;
}

// --- Outbound calling (Phase A) --------------------------------------------

export type OutboundRequiredField =
  | 'firstName' | 'lastName' | 'phone' | 'email' | 'preferredBranch' | 'preferredService' | 'preferredDateTime';

export type OutboundCampaignStatus = 'DRAFT' | 'SCHEDULED' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'FAILED';
export type OutboundBookingMode = 'APPOINTMENT_REQUEST_ONLY' | 'DIRECT_BOOKING_IF_SLOT_AVAILABLE';
export type CallTargetStatus = 'PENDING' | 'CALLING' | 'COMPLETED' | 'FAILED' | 'OPTED_OUT';
export type BookingRequestStatus = 'PENDING_REVIEW' | 'BOOKED' | 'REJECTED' | 'MISSING_INFO' | 'DUPLICATE';

export const OUTBOUND_REQUIRED_FIELDS: Array<{ key: OutboundRequiredField; label: string }> = [
  { key: 'firstName', label: 'First name' },
  { key: 'lastName', label: 'Last name' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'preferredBranch', label: 'Preferred branch' },
  { key: 'preferredService', label: 'Preferred service' },
  { key: 'preferredDateTime', label: 'Preferred date/time' },
];

export interface RetellStatus {
  configured: boolean;
  mock: boolean;
  missing: string[];
  readyAgents: number;
  checklist: Array<{ key: string; label: string; set: boolean }>;
}

export interface OutboundCampaign {
  id: string;
  clinicId: string;
  agentId: string | null;
  name: string;
  script: string;
  requiredFields: OutboundRequiredField[];
  customQuestions: unknown;
  consentText: string | null;
  humanHandoffInstruction: string | null;
  bookingMode: OutboundBookingMode;
  defaultBranchId: string | null;
  defaultService: string | null;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  maxRetryAttempts: number;
  status: OutboundCampaignStatus;
  createdAt: string;
  updatedAt: string;
  targets?: CallTarget[];
  _count?: { targets: number; callLogs: number };
}

export interface CallTarget {
  id: string;
  campaignId: string;
  patientId: string | null;
  leadId: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string;
  email: string | null;
  status: CallTargetStatus;
  attempts: number;
  lastOutcome: string | null;
  createdAt: string;
}

export interface BookingRequest {
  id: string;
  branchId: string | null;
  patientId: string | null;
  leadId: string | null;
  campaignId: string | null;
  callLogId: string | null;
  requestedService: string | null;
  requestedDateTime: string | null;
  collectedName: string | null;
  collectedPhone: string | null;
  collectedEmail: string | null;
  status: BookingRequestStatus;
  source: string;
  missingFields: string[];
  outcomeReason: string | null;
  bookedAppointmentId: string | null;
  createdAt: string;
}

export type LaunchCallResult =
  | { status: 'launched'; callId: string; callLogId: string; mock: boolean }
  | { status: 'setup_required'; missing: string[] }
  | { status: 'failed'; error: string; callLogId?: string };

export interface OutboundCampaignInput {
  clinicId: string;
  agentId?: string | null;
  name: string;
  script: string;
  requiredFields?: OutboundRequiredField[];
  consentText?: string | null;
  humanHandoffInstruction?: string | null;
  bookingMode?: OutboundBookingMode;
  defaultBranchId?: string | null;
  defaultService?: string | null;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  maxRetryAttempts?: number;
  status?: OutboundCampaignStatus;
}

// --- Field catalog (UI metadata) -------------------------------------------

export const FIELD_CATALOG: Array<{ type: FieldType; label: string; question: string; group: string; hasOptions?: boolean }> = [
  { type: 'FIRST_NAME', label: 'First name', question: 'Can I start with your first name?', group: 'Identity' },
  { type: 'LAST_NAME', label: 'Last name', question: 'And your last name?', group: 'Identity' },
  { type: 'PHONE', label: 'Phone number', question: 'What is the best phone number to reach you on?', group: 'Contact' },
  { type: 'EMAIL', label: 'Email', question: 'What email should we send the confirmation to?', group: 'Contact' },
  { type: 'PREFERRED_DATE', label: 'Preferred date', question: 'What day works best for you?', group: 'Scheduling' },
  { type: 'PREFERRED_TIME', label: 'Preferred time', question: 'Do you prefer morning or afternoon?', group: 'Scheduling' },
  { type: 'PREFERRED_LOCATION', label: 'Preferred location', question: 'Which of our locations is most convenient?', group: 'Scheduling', hasOptions: true },
  { type: 'PATIENT_STATUS', label: 'New or existing patient', question: 'Have you visited us before, or would this be your first time?', group: 'Clinical' },
  { type: 'INSURANCE_PROVIDER', label: 'Insurance provider', question: 'Which insurance provider do you have, if any?', group: 'Clinical' },
  { type: 'REASON_FOR_VISIT', label: 'Reason for visit', question: 'May I ask the main reason for your visit?', group: 'Clinical' },
  { type: 'PREFERRED_PROVIDER', label: 'Preferred provider', question: 'Is there a specific provider you would like to see?', group: 'Clinical' },
  { type: 'LANGUAGE_PREFERENCE', label: 'Language preference', question: 'What language are you most comfortable speaking?', group: 'Clinical' },
  { type: 'CONSENT', label: 'SMS/email consent', question: 'Is it okay if we send you appointment reminders by text or email?', group: 'Compliance' },
  { type: 'CUSTOM_TEXT', label: 'Custom text field', question: 'Could you tell me a little more?', group: 'Custom' },
  { type: 'CUSTOM_DROPDOWN', label: 'Custom dropdown field', question: 'Which option applies to you?', group: 'Custom', hasOptions: true },
  { type: 'CUSTOM_YES_NO', label: 'Custom yes/no field', question: 'Can you confirm yes or no?', group: 'Custom' },
];

export const VOICE_OPTIONS = [
  { id: '11labs-Adrian', label: 'Adrian (male, warm)' },
  { id: '11labs-Anna', label: 'Anna (female, friendly)' },
  { id: '11labs-Bella', label: 'Bella (female, calm)' },
  { id: '11labs-Brian', label: 'Brian (male, professional)' },
  { id: '11labs-Marissa', label: 'Marissa (female, upbeat)' },
  { id: 'openai-Alloy', label: 'Alloy (neutral)' },
  { id: 'openai-Nova', label: 'Nova (female, bright)' },
];

export const TONE_OPTIONS = [
  'Warm and professional',
  'Warm, upbeat, and concise',
  'Calm and reassuring',
  'Friendly and energetic',
  'Formal and precise',
];

export const LANGUAGE_OPTIONS = [
  { id: 'en-US', label: 'English (US)' },
  { id: 'en-GB', label: 'English (UK)' },
  { id: 'es-ES', label: 'Spanish (Spain)' },
  { id: 'es-419', label: 'Spanish (Latin America)' },
  { id: 'fr-FR', label: 'French' },
  { id: 'de-DE', label: 'German' },
  { id: 'pt-BR', label: 'Portuguese (Brazil)' },
];

export const CAMPAIGN_TYPES = ['Reactivation', 'New patient', 'Recall / Recare', 'Promotion', 'Waitlist fill', 'Post-op follow-up', 'Survey'];

export const TIMEZONE_OPTIONS = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Phoenix', 'Europe/London', 'Europe/Paris', 'Australia/Sydney',
];

// --- API helpers -----------------------------------------------------------

const base = '/v1/receptionist';

export const receptionistApi = {
  overview: () => apiRequest<Overview>(`${base}/overview`),

  listClinics: () => apiRequest<Clinic[]>(`${base}/clinics`),
  createClinic: (body: Partial<Clinic>) => apiRequest<Clinic>(`${base}/clinics`, { method: 'POST', body: JSON.stringify(body) }),
  updateClinic: (id: string, body: Partial<Clinic>) => apiRequest<Clinic>(`${base}/clinics/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteClinic: (id: string) => apiRequest<void>(`${base}/clinics/${id}`, { method: 'DELETE' }),

  listSchedulingBranches: () => apiRequest<SchedulingBranch[]>(`${base}/scheduling-branches`),

  createLocation: (body: Partial<Location> & { clinicId: string; branchId: string }) => apiRequest<Location>(`${base}/locations`, { method: 'POST', body: JSON.stringify(body) }),
  updateLocation: (id: string, body: Partial<Location>) => apiRequest<Location>(`${base}/locations/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteLocation: (id: string) => apiRequest<void>(`${base}/locations/${id}`, { method: 'DELETE' }),

  listAgents: (clinicId: string) => apiRequest<Agent[]>(`${base}/agents?clinicId=${clinicId}`),
  createAgent: (body: Partial<Agent> & { clinicId: string }) => apiRequest<Agent>(`${base}/agents`, { method: 'POST', body: JSON.stringify(body) }),
  updateAgent: (id: string, body: Partial<Agent>) => apiRequest<Agent>(`${base}/agents/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  verifyAgentProvider: (id: string) => apiRequest<Agent>(`${base}/agents/${id}/verify-provider`, { method: 'POST' }),
  deleteAgent: (id: string) => apiRequest<void>(`${base}/agents/${id}`, { method: 'DELETE' }),

  listCampaigns: (clinicId: string) => apiRequest<Campaign[]>(`${base}/campaigns?clinicId=${clinicId}`),
  getCampaign: (id: string) => apiRequest<Campaign>(`${base}/campaigns/${id}`),
  createCampaign: (body: Partial<Campaign> & { clinicId: string }) => apiRequest<Campaign>(`${base}/campaigns`, { method: 'POST', body: JSON.stringify(body) }),
  updateCampaign: (id: string, body: Partial<Campaign>) => apiRequest<Campaign>(`${base}/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteCampaign: (id: string) => apiRequest<void>(`${base}/campaigns/${id}`, { method: 'DELETE' }),

  listIntakeFields: (campaignId: string) => apiRequest<IntakeField[]>(`${base}/intake-fields?campaignId=${campaignId}`),
  createIntakeField: (body: Partial<IntakeField> & { campaignId: string; fieldType: FieldType }) => apiRequest<IntakeField>(`${base}/intake-fields`, { method: 'POST', body: JSON.stringify(body) }),
  updateIntakeField: (id: string, body: Partial<IntakeField>) => apiRequest<IntakeField>(`${base}/intake-fields/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteIntakeField: (id: string) => apiRequest<void>(`${base}/intake-fields/${id}`, { method: 'DELETE' }),
  reorderIntakeFields: (campaignId: string, orderedIds: string[]) => apiRequest<IntakeField[]>(`${base}/intake-fields/reorder`, { method: 'POST', body: JSON.stringify({ campaignId, orderedIds }) }),

  getPrompt: (campaignId: string) => apiRequest<PromptResult>(`${base}/campaigns/${campaignId}/prompt`),
  getRetellConfig: (campaignId: string) => apiRequest<RetellConfig>(`${base}/campaigns/${campaignId}/retell-config`),

  listCallLogs: (clinicId: string) => apiRequest<CallLog[]>(`${base}/call-logs?clinicId=${clinicId}`),
  listAppointmentRequests: (clinicId: string) => apiRequest<AppointmentRequest[]>(`${base}/appointment-requests?clinicId=${clinicId}`),
  listOptOuts: () => apiRequest<OptOut[]>(`${base}/opt-outs`),
  createOptOut: (body: Partial<OptOut> & { clinicId?: string }) => apiRequest<OptOut>(`${base}/opt-outs`, { method: 'POST', body: JSON.stringify(body) }),
  deleteOptOut: (id: string) => apiRequest<void>(`${base}/opt-outs/${id}`, { method: 'DELETE' }),

  // --- Outbound calling ----------------------------------------------------
  retellStatus: () => apiRequest<RetellStatus>(`${base}/retell-status`),
  listOutboundCampaigns: (clinicId?: string) => apiRequest<OutboundCampaign[]>(`${base}/outbound-campaigns${clinicId ? `?clinicId=${clinicId}` : ''}`),
  getOutboundCampaign: (id: string) => apiRequest<OutboundCampaign>(`${base}/outbound-campaigns/${id}`),
  createOutboundCampaign: (body: OutboundCampaignInput) => apiRequest<OutboundCampaign>(`${base}/outbound-campaigns`, { method: 'POST', body: JSON.stringify(body) }),
  updateOutboundCampaign: (id: string, body: Partial<OutboundCampaignInput>) => apiRequest<OutboundCampaign>(`${base}/outbound-campaigns/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  listTargets: (campaignId: string) => apiRequest<CallTarget[]>(`${base}/outbound-campaigns/${campaignId}/targets`),
  addTargets: (campaignId: string, targets: Array<Partial<CallTarget> & { phone: string }>) =>
    apiRequest<{ added: number }>(`${base}/outbound-campaigns/${campaignId}/targets`, { method: 'POST', body: JSON.stringify({ targets }) }),
  deleteTarget: (campaignId: string, id: string) =>
    apiRequest<void>(`${base}/outbound-campaigns/${campaignId}/targets/${id}`, { method: 'DELETE' }),
  launchCall: (campaignId: string, body: { phone: string; firstName?: string; lastName?: string; email?: string; targetId?: string }) =>
    apiRequest<LaunchCallResult>(`${base}/outbound-campaigns/${campaignId}/call`, { method: 'POST', body: JSON.stringify(body) }),
  listOutboundCallLogs: (campaignId: string) => apiRequest<CallLog[]>(`${base}/outbound-campaigns/${campaignId}/call-logs`),
  listBookingRequests: (status?: BookingRequestStatus) => apiRequest<BookingRequest[]>(`${base}/booking-requests${status ? `?status=${status}` : ''}`),
  updateBookingRequest: (id: string, body: { status?: BookingRequestStatus; outcomeReason?: string }) =>
    apiRequest<BookingRequest>(`${base}/booking-requests/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
};
