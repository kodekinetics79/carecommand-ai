import { ApiError, apiRequest } from './api';

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
  inboundNumber?: string | null;
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

export interface VoiceLineConfiguration {
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
  clinicId: string;
  campaignId: string | null;
  providerCallRef: string | null;
  callerName: string | null;
  callerPhone: string | null;
  direction: string;
  outcome: CallOutcome;
  durationSeconds: number;
  sentiment: string | null;
  transcriptSummary: string | null;
  providerSummary?: {
    text: string;
    source: 'PROVIDER_CALL_ANALYSIS';
    sourceCallId: string | null;
  } | null;
  operationalNotes?: {
    source: 'STAFF_ENTERED';
    actorUserId: string;
    recordedAt: string;
    summary: string | null;
    correction: string | null;
    callerIntent: string | null;
    actionsTaken: string[];
    followUpNotes: string | null;
  } | null;
  unresolvedActionItems?: string[];
  reviewStatus?: 'UNREVIEWED' | 'DRAFT' | 'REVIEWED' | 'SIGNED_OFF';
  reviewRevision?: number;
  reviewedAt?: string | null;
  signedOffAt?: string | null;
  reviewedBy?: { id: string; displayName: string } | null;
  signedOffBy?: { id: string; displayName: string } | null;
  recordingAvailable?: boolean;
  recordingAccess?: 'available' | 'restricted' | 'not_available' | 'purged';
  recordingUrl?: string | null;
  reviewCapabilities?: { canEdit: boolean; canSignOff: boolean };
  appointments?: Array<{ id: string; service: string; startsAt: string; status: string }>;
  appointmentRequests?: Array<{
    id: string;
    requestedService: string | null;
    requestedDateTime: string | null;
    status: string;
    bookedAppointmentId: string | null;
  }>;
  handoffReferences?: Array<{
    id: string;
    title: string;
    status: string;
    priority: string;
    dueAt: string | null;
    createdAt: string;
  }>;
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
  revokedAt: string | null;
  revokedByUserId: string | null;
  revocationReason: string | null;
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

export interface VoiceLineStatus {
  configured: boolean;
  mock: boolean;
  missing: string[];
  readyAgents: number;
  adhocTestCallsAllowed: boolean;
  liveTest: {
    enabled: boolean;
    active: boolean;
    executionId: string | null;
    allowedDestinationMasked: string | null;
    expiresAt: string | null;
    timezone: string;
    windowStart: string;
    windowEnd: string;
    maxCalls: number;
    maxCallMinutes: number;
    maxTotalMinutes: number;
    maxProviderCostUsd: number;
    projectedMaximumCostUsd: number;
    blockingReason: string | null;
    attemptsUsed: number;
    callsRemaining: number;
    minutesUsed: number;
    minutesRemaining: number;
    activeCalls: number;
    admissionReason: string | null;
  };
  checklist: Array<{ key: string; label: string; set: boolean }>;
}

export interface ProviderCallSyncResult {
  status: string;
  providerStatus: string;
  providerCallIdMasked: string | null;
  outcome: string;
  durationSeconds: number;
  endedAt: string | null;
  destinationMasked: string | null;
  costNativeUnits: number | null;
  reviewTaskId: string | null;
  verification: 'mock' | 'provider_poll';
}

export interface OutboundCampaign {
  id: string;
  clinicId: string;
  agentId: string | null;
  receptionistCampaignId: string | null;
  name: string;
  script: string;
  purpose: 'CARE_COORDINATION' | 'APPOINTMENT_REMINDER' | 'PATIENT_REACTIVATION' | null;
  legalBasis: 'EXPLICIT_CONSENT' | 'TREATMENT_OPERATIONS' | null;
  policyVersion: string | null;
  authorityApprovedAt: string | null;
  authorityApprovedById: string | null;
  authorityFingerprint: string | null;
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

/**
 * How far a reminder campaign has actually got: how many of its targets are
 * about an appointment, and how many of those appointments the PATIENT has
 * since said they will attend.
 *
 * `patientConfirmed` counts every confirmation, however it arrived (a call, the
 * front desk, the portal). `confirmedOnCampaignCall` is the subset this
 * campaign's own calls produced — the narrower claim, kept separate so the
 * panel never credits the campaign with a confirmation someone took at the desk.
 */
export interface OutboundConfirmationSummary {
  campaignId: string;
  /** Everyone on the list, appointment-linked or not. */
  targets: number;
  /** Targets that are about a live appointment — the only ones confirmable. */
  targetsWithAppointment: number;
  patientConfirmed: number;
  confirmedOnCampaignCall: number;
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
  lastCallLogId: string | null;
  lastOutcome: string | null;
  /** The appointment this target is being called ABOUT; null for a recall or reactivation call. */
  appointmentId: string | null;
  createdAt: string;
}

export interface OutboundReconciliationEvidence {
  localCallLogId: string;
  providerCallId: string | null;
  targetId: string | null;
  triggerSources: Array<'RECONCILIATION_REQUIRED' | 'RECONCILIATION_SIGNAL' | 'RECONCILIATION_TASK' | 'UNBOUND_PROVIDER_INTENT'>;
  signalIds: string[];
  signalStatuses: string[];
  reviewTaskIds: string[];
  reviewTaskStatuses: string[];
  createdAt: string;
}

export const OUTBOUND_RECONCILIATION_WARNING = 'possible live provider call—do not retry';

/** Successful refresh replaces durable state; a failed refresh preserves it. */
export function mergeReconciliationRefresh(
  current: OutboundReconciliationEvidence[],
  refresh: { ok: true; rows: OutboundReconciliationEvidence[] } | { ok: false },
): OutboundReconciliationEvidence[] {
  return refresh.ok ? refresh.rows : current;
}

export function launchControlsBlocked(input: {
  transportAmbiguous: boolean;
  reconciliationVerified: boolean;
  reconciliations: OutboundReconciliationEvidence[];
}): boolean {
  return input.transportAmbiguous || !input.reconciliationVerified || input.reconciliations.length > 0;
}

/** One upcoming appointment a target may be created FROM, so the call is about the patient's own visit. */
export interface OutboundTargetCandidateAppointment {
  appointmentId: string;
  /** ISO instant; render it in `timezone`, which is the branch the patient attends. */
  startsAt: string;
  timezone: string;
  service: string;
  clinician: string | null;
  location: string;
}

export interface OutboundTargetCandidate {
  type: 'patient' | 'lead';
  id: string;
  name: string;
  phone: string;
  voiceAuthorizationReady: boolean;
  voiceAuthorizationReason: 'compatible_immutable_consent' | 'treatment_operations' | 'suppressed' | 'consent_missing_or_incompatible';
  /** Always empty for a lead: an appointment belongs to a patient. */
  appointments: OutboundTargetCandidateAppointment[];
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
  bookedAppointment: {
    id: string;
    service: string;
    startsAt: string;
    branch: { timezone: string; name: string; location: string };
    providerProfile: { user: { displayName: string } } | null;
  } | null;
  createdAt: string;
}

export type ConfirmationDeliveryStatus =
  | 'queued' | 'retrying' | 'failed' | 'suppressed'
  | 'accepted' | 'delivered' | 'dead_lettered' | 'delivery_unknown';

export interface ConfirmationDelivery {
  id: string;
  appointmentId: string | null;
  patientId: string | null;
  patientName: string | null;
  appointmentService: string | null;
  appointmentStartsAt: string | null;
  channel: string;
  status: ConfirmationDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  failureReason: string | null;
  provider: string | null;
  acceptedAt: string | null;
  deliveredAt: string | null;
  deadLetteredAt: string | null;
  createdAt: string;
}

export type LaunchBlockReason =
  | 'campaign_not_running' | 'outbound_authority_unapproved' | 'outbound_stopped'
  | 'invalid_e164_destination' | 'adhoc_call_not_authorized'
  | 'target_identity_unbound' | 'target_identity_mismatch' | 'target_not_dialable'
  | 'positive_voice_consent_missing' | 'concurrency_limit_reached' | 'voice_minutes_limit_reached'
  | 'target_identity_changed' | 'shared_suppression_gate' | 'campaign_authority_changed'
  | 'quiet_hours' | 'provider_intent_evidence_failed'
  | 'campaign_authority_invalid' | 'agent_unlinked' | 'agent_inactive' | 'agent_unverified'
  | 'agent_configuration_changed' | 'agent_verification_stale'
  | 'direct_booking_authority_unlinked' | 'direct_booking_authority_unattested'
  | 'direct_booking_agent_mismatch' | 'direct_booking_branch_missing'
  | 'direct_booking_branch_not_eligible' | 'direct_booking_service_missing'
  | 'direct_booking_service_mismatch' | 'outbound_purpose_or_legal_basis_missing'
  | 'clinic_inactive_or_foreign' | 'branch_inactive_or_foreign' | 'branch_not_mapped_to_clinic'
  | 'agent_scope_mismatch' | 'direct_booking_authority_inactive_or_foreign'
  | 'quiet_hours_missing' | 'quiet_hours_incomplete' | 'quiet_hours_invalid'
  | 'quiet_hours_equal' | 'quiet_hours_timezone_invalid' | 'client_attempt_not_claimable'
  | 'live_test_not_authorized' | 'live_test_execution_id_missing' | 'live_test_tenant_missing'
  | 'live_test_tenant_not_authorized' | 'live_test_recipient_invalid'
  | 'live_test_authorization_expired' | 'live_test_outside_window' | 'live_test_limits_invalid'
  | 'live_test_cost_cap_invalid' | 'live_test_destination_not_allowlisted'
  | 'live_test_attempt_token_required' | 'live_test_configuration_invalid'
  | 'live_test_attempt_replayed' | 'live_test_call_cap_reached'
  | 'live_test_single_active_call' | 'live_test_minute_cap_reached'
  | 'live_test_cost_cap_reached';

type LaunchEvidence = {
  callId?: string;
  callLogId?: string;
  providerStopApplied?: boolean;
  reviewRecorded?: boolean;
  signalRecorded?: boolean;
  auditRecorded?: boolean;
  businessEventRecorded?: boolean;
  reviewTaskId?: string | null;
  signalId?: string | null;
};

export type LaunchCallResult =
  | ({ status: 'launched'; callId: string; callLogId: string; mock: boolean; trackingDegraded: boolean } & LaunchEvidence)
  | { status: 'setup_required'; missing: string[] }
  | ({ status: 'skipped'; reason: 'opted_out' | 'quiet_hours'; callLogId?: string } & LaunchEvidence)
  | ({ status: 'blocked'; reason: LaunchBlockReason } & LaunchEvidence)
  | ({ status: 'cancelled'; reason: 'outbound_stopped' | 'provider_intent_cancelled' } & LaunchEvidence)
  | ({ status: 'reconciliation_required'; reason?: string; error?: string } & LaunchEvidence)
  | ({ status: 'failed'; error: string } & LaunchEvidence)
  | { status: 'transport_ambiguous'; clientAttemptToken: string }
  | { status: 'unknown_response'; receivedStatus?: string };

const LAUNCH_RESULT_STATUSES = new Set([
  'launched', 'setup_required', 'skipped', 'blocked', 'cancelled',
  'reconciliation_required', 'failed',
]);
const LAUNCH_BLOCK_REASONS = new Set<LaunchBlockReason>([
  'campaign_not_running', 'outbound_authority_unapproved', 'outbound_stopped',
  'invalid_e164_destination', 'adhoc_call_not_authorized', 'target_identity_unbound',
  'target_identity_mismatch', 'target_not_dialable', 'positive_voice_consent_missing',
  'concurrency_limit_reached', 'voice_minutes_limit_reached', 'target_identity_changed',
  'shared_suppression_gate', 'campaign_authority_invalid', 'agent_unlinked',
  'campaign_authority_changed', 'quiet_hours', 'provider_intent_evidence_failed',
  'agent_inactive', 'agent_unverified', 'agent_configuration_changed',
  'agent_verification_stale', 'direct_booking_authority_unlinked',
  'direct_booking_authority_unattested', 'direct_booking_agent_mismatch',
  'direct_booking_branch_missing', 'direct_booking_branch_not_eligible',
  'direct_booking_service_missing', 'direct_booking_service_mismatch',
  'outbound_purpose_or_legal_basis_missing', 'clinic_inactive_or_foreign',
  'branch_inactive_or_foreign', 'branch_not_mapped_to_clinic', 'agent_scope_mismatch',
  'direct_booking_authority_inactive_or_foreign', 'quiet_hours_missing',
  'quiet_hours_incomplete', 'quiet_hours_invalid', 'quiet_hours_equal',
  'quiet_hours_timezone_invalid', 'client_attempt_not_claimable',
  'live_test_not_authorized', 'live_test_execution_id_missing',
  'live_test_tenant_missing', 'live_test_tenant_not_authorized',
  'live_test_recipient_invalid', 'live_test_authorization_expired',
  'live_test_outside_window', 'live_test_limits_invalid',
  'live_test_cost_cap_invalid', 'live_test_destination_not_allowlisted',
  'live_test_attempt_token_required', 'live_test_configuration_invalid',
  'live_test_attempt_replayed', 'live_test_call_cap_reached',
  'live_test_single_active_call', 'live_test_minute_cap_reached',
  'live_test_cost_cap_reached',
]);

export const TRANSPORT_AMBIGUITY_STORAGE_UNAVAILABLE = 'storage-unavailable';

export function transportAmbiguityStorageKey(campaignId: string): string {
  return `carecommand:receptionist:transport-ambiguity:${campaignId}`;
}

export function readTransportAmbiguityToken(storage: Pick<Storage, 'getItem'>, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    // If durable browser state cannot be inspected, launch must remain blocked.
    return TRANSPORT_AMBIGUITY_STORAGE_UNAVAILABLE;
  }
}

export function writeTransportAmbiguityToken(storage: Pick<Storage, 'setItem'>, key: string, token: string): boolean {
  try {
    storage.setItem(key, token);
    return true;
  } catch {
    return false;
  }
}

export function clearTransportAmbiguityToken(storage: Pick<Storage, 'removeItem'>, key: string): boolean {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalEvidenceValid(value: Record<string, unknown>): boolean {
  return ['providerStopApplied', 'reviewRecorded', 'signalRecorded', 'auditRecorded', 'businessEventRecorded', 'trackingDegraded']
    .every(key => value[key] === undefined || typeof value[key] === 'boolean')
    && ['callId', 'callLogId'].every(key => value[key] === undefined || typeof value[key] === 'string')
    && ['reviewTaskId', 'signalId'].every(key => value[key] === undefined || value[key] === null || typeof value[key] === 'string');
}

export function parseLaunchResult(value: unknown): LaunchCallResult {
  if (!isRecord(value) || typeof value.status !== 'string') return { status: 'unknown_response' };
  if (!optionalEvidenceValid(value)) return { status: 'unknown_response', receivedStatus: value.status };
  if (value.status === 'launched' && typeof value.callId === 'string' && typeof value.callLogId === 'string'
    && typeof value.mock === 'boolean' && typeof value.trackingDegraded === 'boolean') return value as LaunchCallResult;
  if (value.status === 'setup_required' && Array.isArray(value.missing) && value.missing.every(item => typeof item === 'string')) return value as LaunchCallResult;
  if (value.status === 'skipped' && (value.reason === 'opted_out' || value.reason === 'quiet_hours')) return value as LaunchCallResult;
  if (value.status === 'blocked' && typeof value.reason === 'string' && LAUNCH_BLOCK_REASONS.has(value.reason as LaunchBlockReason)) return value as LaunchCallResult;
  if (value.status === 'cancelled' && (value.reason === 'outbound_stopped' || value.reason === 'provider_intent_cancelled')) return value as LaunchCallResult;
  if (value.status === 'reconciliation_required' && typeof value.callLogId === 'string'
    && (value.reason === undefined || typeof value.reason === 'string') && (value.error === undefined || typeof value.error === 'string')) return value as LaunchCallResult;
  if (value.status === 'failed' && typeof value.error === 'string' && typeof value.callLogId === 'string') return value as LaunchCallResult;
  return { status: 'unknown_response', receivedStatus: value.status };
}

/** Preserve the server's structured non-2xx launch decision for fail-safe UI. */
export function launchResultFromError(error: unknown): LaunchCallResult | null {
  if (!(error instanceof ApiError) || !error.details) return null;
  const status = error.details.status;
  if (typeof status !== 'string') return null;
  if (!LAUNCH_RESULT_STATUSES.has(status)) return { status: 'unknown_response', receivedStatus: status };
  return parseLaunchResult(error.details);
}

export type LaunchPresentation = { kind: 'ok' | 'warn' | 'err'; text: string; refresh: boolean };

function launchWords(value: string) {
  return value.replaceAll('_', ' ');
}

function maskedProviderReference(value: string | null | undefined): string {
  if (!value) return 'the call log';
  if (value.length <= 8) return '********';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function presentLaunchResult(result: LaunchCallResult): LaunchPresentation {
  switch (result.status) {
    case 'launched':
      return result.trackingDegraded
        ? { kind: 'warn', text: `Provider accepted call ${maskedProviderReference(result.callId)}, but local tracking or audit evidence is degraded. Do not retry; reconcile the call log.`, refresh: true }
        : { kind: 'ok', text: `Call accepted by the provider${result.mock ? ' in mock mode' : ''} — provider reference ${maskedProviderReference(result.callId)}. Delivery/connection is not yet proven.`, refresh: true };
    case 'setup_required':
      return { kind: 'warn', text: `No call was placed. Setup is incomplete: ${result.missing.join(', ')}.`, refresh: false };
    case 'skipped':
      return { kind: 'warn', text: result.reason === 'opted_out' ? 'No call was placed: the destination is suppressed by do-not-contact evidence.' : 'No call was placed: the clinic is currently inside configured quiet hours.', refresh: true };
    case 'blocked':
      return { kind: 'err', text: `No call was placed. Launch was blocked: ${launchWords(result.reason)}. Correct the authority or safety condition before retrying.`, refresh: true };
    case 'cancelled':
      return { kind: 'warn', text: `The launch was canceled (${launchWords(result.reason)}).${result.providerStopApplied === true ? ' Provider stop was confirmed.' : ' Do not assume provider submission; check the call log before retrying.'}`, refresh: true };
    case 'reconciliation_required': {
      const missingEvidence = [
        result.providerStopApplied === false ? 'provider stop unconfirmed' : null,
        result.reviewRecorded === false ? 'review task not recorded' : null,
        result.signalRecorded === false ? 'operational signal not recorded' : null,
        result.auditRecorded === false ? 'audit event not recorded' : null,
        result.businessEventRecorded === false ? 'business event not recorded' : null,
      ].filter(Boolean).join(', ');
      return { kind: 'err', text: `Provider acceptance is uncertain; do not retry. Reconcile ${result.callId ? `provider reference ${maskedProviderReference(result.callId)}` : result.callLogId ? 'the durable call log' : 'the call log'}${result.error ? ` (${launchWords(result.error)})` : ''}.${missingEvidence ? ` Degraded evidence: ${missingEvidence}.` : ''}`, refresh: true };
    }
    case 'failed': {
      const degraded = [result.reviewRecorded === false ? 'review task' : null, result.signalRecorded === false ? 'operational signal' : null].filter(Boolean).join(' and ');
      return { kind: 'err', text: `Provider rejected the launch: ${launchWords(result.error)}. No successful call is claimed.${degraded ? ` The ${degraded} could not be recorded.` : ''}`, refresh: true };
    }
    case 'transport_ambiguous':
      return { kind: 'err', text: `The launch response was lost. ${OUTBOUND_RECONCILIATION_WARNING}. Refresh durable evidence and verify provider state before any further launch.`, refresh: true };
    case 'unknown_response':
      return { kind: 'err', text: `Unknown or malformed launch response (${result.receivedStatus || 'missing status'}). Do not retry; reconcile provider and local call evidence.`, refresh: true };
  }
}

const STRICT_OUTBOUND_HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function validateOutboundQuietHours(startValue: string | null | undefined, endValue: string | null | undefined, timezone: string): string | null {
  const start = startValue?.trim() ?? '';
  const end = endValue?.trim() ?? '';
  if (!start && !end) return 'Quiet hours are required before campaign approval.';
  if (!start || !end) return 'Quiet hours require both a start and end time.';
  if (!STRICT_OUTBOUND_HH_MM.test(start) || !STRICT_OUTBOUND_HH_MM.test(end)) return 'Quiet hours must use strict 24-hour HH:mm format.';
  if (start === end) return 'Quiet-hours start and end cannot be equal.';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    return 'The clinic timezone is invalid; outbound scheduling is blocked.';
  }
  return null;
}

export interface OutboundControlStatus {
  stopped: boolean;
  reason?: string | null;
  changedAt?: string | null;
}

export interface OutboundStopResult {
  stopped: true;
  activeCancellation: {
    requested: number;
    confirmed: number;
    failed: number;
    unconfirmed: number;
    unboundIntentsQuarantined: number;
    reconciliationRequired: number;
    signalRecorded: number;
    reviewRecorded: number;
    auditRecorded: boolean;
  };
}

export interface BookingReconciliationResult {
  status: 'BOOKED';
  requestId: string;
  appointmentId: string;
  duplicate: boolean;
  appointment: {
    service: string;
    startsAt: string;
    timezone: string;
    locationName: string;
    locationAddress: string | null;
    providerName: string | null;
  };
}

export interface OutboundCampaignInput {
  clinicId: string;
  agentId?: string | null;
  receptionistCampaignId?: string | null;
  name: string;
  script: string;
  purpose?: 'CARE_COORDINATION' | 'APPOINTMENT_REMINDER' | 'PATIENT_REACTIVATION' | null;
  legalBasis?: 'EXPLICIT_CONSENT' | 'TREATMENT_OPERATIONS' | null;
  policyVersion?: string | null;
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
//
// These lists are being retired in favour of GET /v1/receptionist/catalog
// (see src/lib/receptionistCatalog.ts): a compiled-in list cannot describe a
// tenant's own timezones, and silently rendered the first option whenever the
// stored value was not one of them. TIMEZONE_OPTIONS is gone — ClinicPanel,
// LocationsEditor and the create dialog read the catalog. The five below are
// still imported by AgentEditor, CampaignPanel and IntakeBuilder, which other
// packages own this wave; they go when those panels move to the catalog.

export const FIELD_CATALOG: Array<{ type: FieldType; label: string; question: string; group: string; hasOptions?: boolean }> = [
  { type: 'FIRST_NAME', label: 'First name', question: 'Can I start with your first name?', group: 'Identity' },
  { type: 'LAST_NAME', label: 'Last name', question: 'And your last name?', group: 'Identity' },
  { type: 'PHONE', label: 'Phone number', question: 'What is the best phone number to reach you on?', group: 'Contact' },
  { type: 'EMAIL', label: 'Email', question: 'What email should we send the confirmation to?', group: 'Contact' },
  { type: 'PREFERRED_DATE', label: 'Preferred date', question: 'What day works best for you?', group: 'Scheduling' },
  { type: 'PREFERRED_TIME', label: 'Preferred time', question: 'Do you prefer morning or afternoon?', group: 'Scheduling' },
  { type: 'PREFERRED_LOCATION', label: 'Preferred location', question: 'Which of our locations is most convenient?', group: 'Scheduling' },
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

// VOICE_OPTIONS was deleted here. It was a hardcoded fallback list of seven
// SUPPLIER-prefixed voice ids compiled into the
// browser bundle, and nothing had imported it since the Studio moved to the
// server-served catalogue — so it named two suppliers in shipped JavaScript
// while doing no work at all. Voices come from `GET /voices`, which now
// projects out the synthesising house as well.

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
  getVoiceLineConfiguration: (campaignId: string) => apiRequest<VoiceLineConfiguration>(`${base}/campaigns/${campaignId}/voice-line-configuration`),

  listCallLogs: (clinicId: string) => apiRequest<CallLog[]>(`${base}/call-logs?clinicId=${clinicId}`),
  getCallLog: (id: string) => apiRequest<CallLog>(`${base}/call-logs/${id}`),
  updateCallReview: (id: string, body: {
    operation: 'SAVE_DRAFT' | 'MARK_REVIEWED' | 'SIGN_OFF';
    expectedRevision: number;
    operationalNotes: { summary?: string | null; correction?: string | null; callerIntent?: string | null; actionsTaken: string[]; followUpNotes?: string | null };
    unresolvedActionItems: string[];
    acknowledgeUnresolvedActions?: true;
  }) => apiRequest<CallLog>(`${base}/call-logs/${id}/operator-review`, { method: 'PATCH', body: JSON.stringify(body) }),
  listAppointmentRequests: (clinicId: string) => apiRequest<AppointmentRequest[]>(`${base}/appointment-requests?clinicId=${clinicId}`),
  listOptOuts: () => apiRequest<OptOut[]>(`${base}/opt-outs`),
  createOptOut: (body: Partial<OptOut> & { clinicId?: string }) => apiRequest<OptOut>(`${base}/opt-outs`, { method: 'POST', body: JSON.stringify(body) }),
  revokeOptOut: (id: string, reason: string) => apiRequest<void>(`${base}/opt-outs/${id}`, {
    method: 'DELETE',
    body: JSON.stringify({ reason, acknowledgeReactivationRisk: true }),
  }),

  // --- Outbound calling ----------------------------------------------------
  voiceLineStatus: () => apiRequest<VoiceLineStatus>(`${base}/voice-line-status`),
  listOutboundCampaigns: (clinicId?: string) => apiRequest<OutboundCampaign[]>(`${base}/outbound-campaigns${clinicId ? `?clinicId=${clinicId}` : ''}`),
  getOutboundCampaign: (id: string) => apiRequest<OutboundCampaign>(`${base}/outbound-campaigns/${id}`),
  createOutboundCampaign: (body: OutboundCampaignInput) => apiRequest<OutboundCampaign>(`${base}/outbound-campaigns`, { method: 'POST', body: JSON.stringify(body) }),
  updateOutboundCampaign: (id: string, body: Partial<OutboundCampaignInput>) => apiRequest<OutboundCampaign>(`${base}/outbound-campaigns/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  approveOutboundCampaign: (id: string, status: 'SCHEDULED' | 'RUNNING') => apiRequest<OutboundCampaign>(`${base}/outbound-campaigns/${id}/approve`, { method: 'POST', body: JSON.stringify({ approvalConfirmed: true, status }) }),
  listTargets: (campaignId: string) => apiRequest<CallTarget[]>(`${base}/outbound-campaigns/${campaignId}/targets`),
  // Counts only — see GET /outbound-campaigns/:id/confirmations. There is no
  // client-side fallback and no default object: a failed read must render as a
  // named failure, never as a campaign that produced nothing.
  getOutboundConfirmations: (campaignId: string) =>
    apiRequest<OutboundConfirmationSummary>(`${base}/outbound-campaigns/${campaignId}/confirmations`),
  listOutboundTargetCandidates: (campaignId: string, q = '') => apiRequest<OutboundTargetCandidate[]>(`${base}/outbound-target-candidates?campaignId=${encodeURIComponent(campaignId)}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  addTargets: (campaignId: string, targets: Array<Partial<CallTarget> & { patientId?: string; leadId?: string; appointmentId?: string }>) =>
    apiRequest<{ added: number }>(`${base}/outbound-campaigns/${campaignId}/targets`, { method: 'POST', body: JSON.stringify({ targets }) }),
  attachLiveTestTarget: (campaignId: string, body: {
    firstName?: string;
    lastName?: string;
    scenario?: string;
    acknowledgeAuthorizedSyntheticRecipient: true;
    acknowledgeSyntheticConsentEvidence?: boolean;
  }) => apiRequest<{
    status: string;
    targetId: string;
    leadId: string;
    targetStatus: string;
    destinationMasked: string;
    executionId: string;
  }>(`${base}/outbound-campaigns/${campaignId}/live-test-target`, { method: 'POST', body: JSON.stringify(body) }),
  deleteTarget: (campaignId: string, id: string) =>
    apiRequest<void>(`${base}/outbound-campaigns/${campaignId}/targets/${id}`, { method: 'DELETE' }),
  launchCall: async (campaignId: string, body: { phone?: string; firstName?: string; lastName?: string; email?: string; targetId?: string }) => {
    const clientAttemptToken = crypto.randomUUID();
    await apiRequest(`${base}/outbound-campaigns/${campaignId}/launch-attempts`, {
      method: 'POST', body: JSON.stringify({ token: clientAttemptToken }),
    });
    try {
      const result = await apiRequest<unknown>(`${base}/outbound-campaigns/${campaignId}/call`, {
        method: 'POST', body: JSON.stringify({ ...body, clientAttemptToken }),
      });
      return parseLaunchResult(result);
    } catch (error) {
      const decision = launchResultFromError(error);
      if (decision) return decision;
      // Submission may already have crossed the provider boundary even though
      // the HTTP response was lost. Never surface that as an ordinary retry.
      return { status: 'transport_ambiguous' as const, clientAttemptToken };
    }
  },
  verifyClearLaunchAttempt: (campaignId: string, token: string) => apiRequest<{
    cleared: boolean; proof: string; callLogId?: string; providerCallId?: string | null;
  }>(`${base}/outbound-campaigns/${campaignId}/launch-attempts/${token}/verify-clear`, { method: 'POST' }),
  outboundControl: () => apiRequest<OutboundControlStatus>(`${base}/outbound-control`),
  stopOutbound: (reason: string) => apiRequest<OutboundStopResult>(`${base}/outbound-control`, {
    method: 'POST', body: JSON.stringify({ stopped: true, reason }),
  }),
  listOutboundCallLogs: (campaignId: string) => apiRequest<CallLog[]>(`${base}/outbound-campaigns/${campaignId}/call-logs`),
  syncOutboundProviderCall: (campaignId: string, callLogId: string) => apiRequest<ProviderCallSyncResult>(`${base}/outbound-campaigns/${campaignId}/call-logs/${callLogId}/provider-sync`, { method: 'POST' }),
  listOutboundReconciliations: (campaignId: string) => apiRequest<OutboundReconciliationEvidence[]>(`${base}/outbound-campaigns/${campaignId}/reconciliations`),
  listBookingRequests: (status?: BookingRequestStatus) => apiRequest<BookingRequest[]>(`${base}/booking-requests${status ? `?status=${status}` : ''}`),
  listConfirmationDeliveries: (limit = 100) => apiRequest<ConfirmationDelivery[]>(`${base}/confirmation-deliveries?limit=${limit}`),
  updateBookingRequest: (id: string, body: { status?: BookingRequestStatus; outcomeReason?: string }) =>
    apiRequest<BookingRequest>(`${base}/booking-requests/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  reconcileBookingRequest: (id: string, body: { appointmentId: string; outcomeReason: string; acknowledgeRequestDifferences: true }) =>
    apiRequest<BookingReconciliationResult>(`${base}/booking-requests/${id}/reconcile`, { method: 'POST', body: JSON.stringify(body) }),
};
