import { apiRequest } from './api';
import type { CallLog, Clinic } from './receptionist';

// ===========================================================================
// Front Desk client (C4).
//
// EVERY request the Front Desk page, the Studio Activity tab, the staff-task
// receptionist card, the sidebar badge and the critical banner make lives in
// this file. The backend for this cycle is built concurrently against the
// same contract (phase2-contracts.md §8/§9/§12/§13 and design-C4 §1, §3.2,
// §4.2, §4.3, §5, §6), so a field-name delta reconciles here, in one place,
// and nowhere in a component.
//
// Shapes coded against (design-C4):
//   GET   /v1/tasks?workflow&status&kind&assignee&branchId&cursor&limit        → { data: FrontDeskTaskRow[], nextCursor }
//   GET   /v1/tasks/summary                                                     → TaskSummary
//   GET   /v1/staff/tasks/:id                                                   → FrontDeskTaskDetail (unmasked contact for receptionist:call-artifacts:read holders; audited)
//   PATCH /v1/staff/tasks/:id/acknowledge  {}                                   → FrontDeskTaskRow
//   PATCH /v1/staff/tasks/:id/status       { status, outcomeCode?, outcomeNote?, appointmentId? }
//   POST  /v1/staff/tasks/:id/notes        { text }
//   GET   /v1/receptionist/call-logs?clinicId&direction&outcome&reviewStatus&handoff&consent&from&to&cursor&limit → { data: CallLogListRow[], nextCursor }
//   GET   /v1/receptionist/call-logs/summary?clinicId&from&to                   → CallLogSummary
//   GET   /v1/receptionist/call-logs/:id                                        → CallLogDetail
//   GET   /v1/receptionist/appointment-requests?clinicId&status&cursor&limit    → { data: AppointmentRequestRow[], nextCursor }
//   GET   /v1/receptionist/appointment-requests/:id                             → AppointmentRequestDetail
//   PATCH /v1/receptionist/appointment-requests/:id { status:'REJECTED', outcomeReason }
//   POST  /v1/receptionist/appointment-requests/:id/book  BookRequestBody       → BookRequestResult (409 slot_unavailable)
//   PATCH /v1/appointments/:id/notes       { text, reasonForVisit? }            → { ...appointment, noteEntries }
//   GET   /v1/receptionist/overview?clinicId&period&from&to&direction           → OverviewKpis (kpi-v2)
// ===========================================================================

const receptionistBase = '/v1/receptionist';

// --- Tasks -----------------------------------------------------------------

/** The full kind union from phase2-contracts §8 (C3's kinds included; Front Desk shows them in an "Other" lane). */
export const RECEPTIONIST_TASK_KINDS = [
  'message', 'human_handoff', 'emergency', 'missed_call',
  'call_denied', 'ai_declined', 'tool_failure', 'identity_locked', 'booking_review',
  // D9: "your receptionist is off the air". Package D files this through
  // `createSafetyTask` on the receptionist_safety workflow; until it lands the
  // hourly re-verify worker still files the same facts under the separate
  // `receptionist_deployment` workflow, which `parseReceptionistTask` rejects.
  // Both shapes are recognised below so the Service status lane is populated
  // either way — this task must never be the one the board cannot show.
  'deployment_attention',
] as const;
export type ReceptionistTaskKind = typeof RECEPTIONIST_TASK_KINDS[number];

/** The workflow the pre-D re-verify worker files deployment attention under. */
export const RECEPTIONIST_DEPLOYMENT_WORKFLOW = 'receptionist_deployment';
/** The workflow every caller-facing receptionist task is filed under. */
export const RECEPTIONIST_SAFETY_WORKFLOW = 'receptionist_safety';

export const TASK_KIND_LABEL: Record<ReceptionistTaskKind, string> = {
  message: 'Message', human_handoff: 'Human handoff', emergency: 'Emergency', missed_call: 'Missed call',
  call_denied: 'Call refused', ai_declined: 'Declined the AI', tool_failure: 'Tool failure',
  identity_locked: 'Identity locked', booking_review: 'Booking review',
  deployment_attention: 'Service status',
};

export const TASK_OUTCOME_CODES = [
  'reached', 'left_voicemail', 'no_answer', 'wrong_number', 'booked',
  'resolved_elsewhere', 'duplicate', 'not_needed', 'transferred', 'cancelled_by_caller',
] as const;
export type TaskOutcomeCode = typeof TASK_OUTCOME_CODES[number];

export const TASK_OUTCOME_LABEL: Record<TaskOutcomeCode, string> = {
  reached: 'Reached the caller', left_voicemail: 'Left a voicemail', no_answer: 'No answer', wrong_number: 'Wrong number',
  booked: 'Booked', resolved_elsewhere: 'Resolved elsewhere', duplicate: 'Duplicate', not_needed: 'Not needed',
  transferred: 'Transferred', cancelled_by_caller: 'Cancelled by the caller',
};

export type TaskStatus = 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELED';
export type TransferStatus = 'not_attempted' | 'attempted' | 'connected' | 'failed' | 'unknown';

export interface TaskMessage { text: string; recordedAt: string }
/**
 * The remediation sentence the server already writes on a deployment-attention
 * task (`remediationFor(code)` → title/action/fixHref). It is the only thing on
 * that card worth reading, so it is carried as a first-class field rather than
 * left in the raw metadata blob.
 */
export interface TaskRemediation { code: string | null; title: string | null; action: string | null; fixHref: string | null }
export interface TaskStaffNote { text: string; at: string; byUserId: string; byDisplayName?: string | null }
export interface CallbackWindow { start: string; end: string; timezone: string; clippedToHours?: boolean }

/** Receptionist view for a caller who holds receptionist:call-artifacts:read. Phones are MASKED here. */
export interface ReceptionistTaskView {
  kind: ReceptionistTaskKind;
  restricted?: false;
  callerName: string | null;
  callbackPhoneMasked: string | null;
  verifiedPhoneMasked: string | null;
  requestedPhoneMasked: string | null;
  hasRequestedPhone: boolean;
  messages: TaskMessage[];
  messageCount: number;
  reasonCategory: string | null;
  callbackWindow: CallbackWindow | null;
  transferStatus: TransferStatus;
  transferUpdatedAt: string | null;
  toolName: string | null;
  denialReason: string | null;
  appointmentRequestId: string | null;
  appointmentId: string | null;
  staffNotes: TaskStaffNote[];
  source: string | null;
  requiresAcknowledgement: boolean;
  /** Present on `deployment_attention` only. Null on every caller task. */
  remediation: TaskRemediation | null;
  /** Metadata clinic scope, when the task carries one (D14 / the clinic selector). */
  clinicId: string | null;
}

/** What a caller WITHOUT receptionist:call-artifacts:read sees of a receptionist task. */
export interface RestrictedReceptionistTaskView {
  kind: ReceptionistTaskKind | 'restricted';
  restricted: true;
  requiresAcknowledgement: boolean;
}

export type ReceptionistTaskInfo = ReceptionistTaskView | RestrictedReceptionistTaskView;

export interface FrontDeskTaskRow {
  id: string;
  title: string;
  priority: string;
  status: TaskStatus;
  dueAt: string | null;
  createdAt: string;
  updatedAt?: string;
  branchId: string | null;
  branch: { name: string } | null;
  assignedToId: string | null;
  assignedTo: { displayName: string } | null;
  acknowledgedAt: string | null;
  acknowledgedBy: { displayName: string } | null;
  completedAt: string | null;
  outcomeCode: TaskOutcomeCode | null;
  outcomeNote: string | null;
  callLogId: string | null;
  patientId: string | null;
  patient: { firstName: string; lastName: string; nextAppointmentAt?: string | null } | null;
  clinic: { id: string; name: string; timezone: string } | null;
  receptionist: ReceptionistTaskInfo | null;
  metadata?: Record<string, unknown> | null;
}

/** Task detail. `contact` is present (unmasked) only for receptionist:call-artifacts:read holders; the read is audited. */
export interface FrontDeskTaskDetail extends FrontDeskTaskRow {
  contact: { callbackPhone: string | null; verifiedPhone: string | null; requestedCallbackPhone: string | null; callerName: string | null } | null;
}

/**
 * One unacknowledged critical task in the banner's preview.
 *
 * `workflow`/`kind` are what D8 adds so the front desk can tell a clinical
 * emergency from a critical ops or insurance task that happens to share the
 * `critical` priority. They are optional because a pre-D server sends neither;
 * a row that carries NO workflow is kept (never hide a possible emergency),
 * a row that carries a foreign one is dropped.
 */
export interface UnacknowledgedCriticalRow {
  id: string;
  title: string;
  createdAt: string;
  clinicName: string | null;
  workflow?: string | null;
  kind?: ReceptionistTaskKind | string | null;
}

export interface TaskSummary {
  /** Receptionist-scoped: counted over the receptionist_safety workflow only. */
  openByKind: Partial<Record<ReceptionistTaskKind, number>>;
  /** Receptionist-scoped total. Absent on a pre-D server; derived from openByKind then. */
  openNeedsAction?: number;
  /** TENANT-WIDE (D8): every open task, not only receptionist work. Never mixed with the lane counts. */
  overdue: number;
  /** The first few unacknowledged criticals — a PREVIEW, capped server-side. */
  unacknowledgedCritical: UnacknowledgedCriticalRow[];
  /**
   * D7: the real `count()`, uncapped. The preview's length is only a floor —
   * nine emergencies used to read as five because the page derived the count
   * from `.length`. Optional until D lands; `criticalSignal` says so out loud
   * rather than printing a number nobody verified.
   */
  unacknowledgedCriticalCount?: number;
  /** TENANT-WIDE (D8). */
  mine: number;
  /** TENANT-WIDE (D8). */
  dueWithin30m: number;
  generatedAt: string;
}

export interface TaskListQuery {
  cursor?: string;
  limit?: number;
  status?: TaskStatus[];
  workflow?: string;
  kind?: ReceptionistTaskKind[];
  assignee?: 'me' | 'unassigned' | string;
  branchId?: string;
  callLogId?: string;
  patientId?: string;
  overdue?: boolean;
}

export interface TaskStatusBody {
  status: TaskStatus;
  outcomeCode?: TaskOutcomeCode;
  outcomeNote?: string;
  appointmentId?: string;
}

// --- Calls -------------------------------------------------------------------

export type CallDirection = 'inbound' | 'outbound';
export type ReviewStatus = 'UNREVIEWED' | 'DRAFT' | 'REVIEWED' | 'SIGNED_OFF';
export type RecordingConsentStatus = 'NOT_STATED' | 'ACKNOWLEDGED' | 'REFUSED' | 'DECLINED' | 'GRANTED' | string;

export interface CallLogListRow {
  id: string;
  clinicId: string | null;
  campaign: { id: string; name: string } | null;
  callerName: string | null;
  callerPhoneMasked: string | null;
  patientId: string | null;
  patient: { firstName: string; lastName: string } | null;
  direction: CallDirection | string;
  outcome: string;
  durationSeconds: number;
  startedAt: string | null;
  endedAt: string | null;
  reviewStatus: ReviewStatus;
  recordingConsentStatus: RecordingConsentStatus | null;
  recordingAvailable: boolean;
  openHandoffCount: number;
  bookedAppointmentId: string | null;
  transcriptSummary: string | null;
  transferOutcome?: 'connected' | 'unknown' | null;
  createdAt: string;
}

export interface CallLogQuery {
  clinicId?: string;
  campaignId?: string;
  direction?: CallDirection;
  outcome?: string[];
  reviewStatus?: ReviewStatus[];
  handoff?: 'open' | 'any' | 'none';
  consent?: string[];
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

export interface CallLogSummary {
  unreviewed: number;
  openHandoffs: number;
  inbound: number;
  outbound: number;
  booked: number;
  pendingRequests: number;
  range: { from: string; to: string };
}

export interface AppointmentNote {
  id: string;
  text: string;
  actorType: 'staff' | 'voice_agent' | 'system';
  actorUserId: string | null;
  actor?: { id: string; displayName: string } | null;
  callLogId: string | null;
  createdAt: string;
}

export interface CallStaffTaskRef {
  id: string;
  title: string;
  status: TaskStatus;
  priority: string;
  dueAt: string | null;
  createdAt: string;
  kind?: ReceptionistTaskKind | null;
}

/** Detail = today's CallLog plus the C4 additions. `handoffReferences` stays as a one-cycle alias of `staffTasks`. */
export interface CallLogDetail extends CallLog {
  recordingConsentStatus?: RecordingConsentStatus | null;
  patient?: { id: string; firstName: string; lastName: string } | null;
  staffTasks?: CallStaffTaskRef[];
  appointments?: Array<{ id: string; service: string; startsAt: string; status: string; noteEntries?: AppointmentNote[] }>;
  operationalNotes?: (NonNullable<CallLog['operationalNotes']> & { actor?: { id: string; displayName: string } | null }) | null;
}

// --- Appointment requests (core AppointmentRequest) ----------------------------

export type AppointmentRequestStatus = 'PENDING_REVIEW' | 'BOOKED' | 'REJECTED' | 'MISSING_INFO' | 'DUPLICATE';

export interface AppointmentRequestRow {
  id: string;
  branchId: string | null;
  patientId: string | null;
  campaignId: string | null;
  callLogId: string | null;
  requestedService: string | null;
  requestedDateTime: string | null;
  collectedName: string | null;
  collectedPhoneMasked: string | null;
  collectedEmail: string | null;
  status: AppointmentRequestStatus;
  source: string;
  missingFields: string[];
  outcomeReason: string | null;
  bookedAppointmentId: string | null;
  bookedAppointment: {
    id: string;
    service: string;
    startsAt: string;
    branch: { timezone: string; name: string };
    providerProfile: { user: { displayName: string } } | null;
  } | null;
  callLog: { id: string; providerCallRef: string | null; callerName: string | null; direction: string; startedAt: string | null; clinicId: string | null; patientId: string | null } | null;
  patient: { firstName: string; lastName: string } | null;
  createdAt: string;
}

/**
 * The detail route is gated on `receptionist:call-artifacts:read` and audited,
 * so it — and only it — carries the caller's unmasked number. Reading it is the
 * same deliberate, logged act as revealing a callback number on a task card.
 */
export interface AppointmentRequestDetail extends AppointmentRequestRow {
  rawCollectedFields: Record<string, unknown> | null;
  collectedPhone?: string | null;
}

export interface AppointmentRequestQuery {
  clinicId?: string;
  campaignId?: string;
  status?: AppointmentRequestStatus[];
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

/**
 * E1. The route's schema is `.strict()` and takes `patientId` (a uuid) OR a
 * sibling `createPatient` object — exactly one of the two. The old shape here
 * (`patientId: { create: … }`) could never parse, so every booking for a caller
 * with no patient record 400'd with a raw Zod string. `branchId` is NOT a field
 * of `createPatient`: the server takes the branch from the chosen provider, and
 * sending it is a 400 under `.strict()`.
 */
export interface BookRequestBody {
  patientId?: string;
  createPatient?: { firstName: string; lastName: string; phone?: string; email?: string };
  providerProfileId: string;
  startsAt: string;
  serviceCatalogItemId?: string;
  service: string;
  channel?: 'WHATSAPP' | 'SMS' | 'EMAIL' | 'PUSH' | 'CALL' | 'VIDEO';
  acknowledgeRequestDifferences: true;
  outcomeReason?: string;
}

export interface BookRequestResult {
  status: 'BOOKED';
  appointment: { id: string; service: string; startsAt: string; endsAt?: string; branchId?: string; providerProfileId?: string };
  confirmationsQueued: Array<{ channel: string; status: string }>;
}

// --- Overview KPIs (kpi-v2) ------------------------------------------------------

export type OverviewPeriod = 'today' | '7d' | '30d' | 'custom';

export interface OverviewKpis {
  period: { from: string; to: string; timezone: string };
  counts: {
    inbound: number; outbound: number; answeredInbound: number; booked: number; escalated: number; optedOut: number;
    pendingRequests: number; openHandoffs: number; activeCampaigns: number; clinics: number;
  };
  /** null = undefined (no denominator), never a fake 0. */
  rates: { bookingRate: number | null; containedPct: number | null; afterHoursPct: number | null; callbacksWithinSlaPct: number | null };
  aht: number | null;
  definitions: Record<string, string> & { version: string };
}

// --- Book-it dependencies (providers, slots, patients) -----------------------------

export interface BookableProvider {
  id: string;
  branchId: string;
  active: boolean;
  specialty: string;
  branch: { name: string };
  user: { displayName: string };
  _count?: { availability: number };
}

export interface ProviderSlot { startsAt: string; endsAt: string }

/** `GET /v1/services` (ServiceCatalogItem). The voice columns are absent on a pre-C2 server. */
export interface ServiceCatalogRow {
  id: string;
  name: string;
  category: string;
  active: boolean;
  defaultDurationMinutes: number;
  bookableByVoice?: boolean;
  voiceDurationMinutes?: number | null;
}

export interface PatientMatch { id: string; firstName: string; lastName: string; branchId: string; phone?: string | null }

// --- Paging ----------------------------------------------------------------

export interface Page<T> { data: T[]; nextCursor: string | null }

/**
 * Both list shapes are accepted: `{ data, nextCursor }` (the C4 contract) and
 * a bare array (what the pre-C4 routes still return while the backend lands).
 */
export function pageOf<T>(payload: T[] | { data: T[]; nextCursor?: string | null }): Page<T> {
  if (Array.isArray(payload)) return { data: payload, nextCursor: null };
  return { data: payload.data ?? [], nextCursor: payload.nextCursor ?? null };
}

function qs(params: Record<string, string | number | boolean | string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    search.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

// --- API ---------------------------------------------------------------------

export const frontDeskApi = {
  // Tasks
  listTasks: async (query: TaskListQuery = {}) =>
    pageOf(await apiRequest<FrontDeskTaskRow[] | Page<FrontDeskTaskRow>>(`/v1/tasks${qs({
      cursor: query.cursor, limit: query.limit, status: query.status, workflow: query.workflow, kind: query.kind,
      assignee: query.assignee, branchId: query.branchId, callLogId: query.callLogId, patientId: query.patientId,
      overdue: query.overdue ? 'true' : undefined,
    })}`)),
  taskSummary: () => apiRequest<TaskSummary>('/v1/tasks/summary'),
  getTask: (id: string) => apiRequest<FrontDeskTaskDetail>(`/v1/staff/tasks/${id}`),
  acknowledgeTask: (id: string) => apiRequest<FrontDeskTaskRow>(`/v1/staff/tasks/${id}/acknowledge`, { method: 'PATCH', body: JSON.stringify({}) }),
  setTaskStatus: (id: string, body: TaskStatusBody) => apiRequest<FrontDeskTaskRow>(`/v1/staff/tasks/${id}/status`, { method: 'PATCH', body: JSON.stringify(body) }),
  setTaskAssignment: (id: string, assignedToId: string | null) => apiRequest<FrontDeskTaskRow>(`/v1/staff/tasks/${id}/assignment`, { method: 'PATCH', body: JSON.stringify({ assignedToId }) }),
  addTaskNote: (id: string, text: string) => apiRequest<FrontDeskTaskRow>(`/v1/staff/tasks/${id}/notes`, { method: 'POST', body: JSON.stringify({ text }) }),

  // Clinics (context: timezone, name). Same route the Studio reads.
  listClinics: () => apiRequest<Clinic[]>(`${receptionistBase}/clinics`),

  // Calls
  listCallLogs: async (query: CallLogQuery = {}) =>
    pageOf(await apiRequest<CallLogListRow[] | Page<CallLogListRow>>(`${receptionistBase}/call-logs${qs({
      clinicId: query.clinicId, campaignId: query.campaignId, direction: query.direction, outcome: query.outcome,
      reviewStatus: query.reviewStatus, handoff: query.handoff, consent: query.consent, from: query.from, to: query.to,
      cursor: query.cursor, limit: query.limit,
    })}`)),
  callLogSummary: (query: { clinicId?: string; from?: string; to?: string } = {}) =>
    apiRequest<CallLogSummary>(`${receptionistBase}/call-logs/summary${qs(query)}`),
  getCallLog: (id: string) => apiRequest<CallLogDetail>(`${receptionistBase}/call-logs/${id}`),

  // Appointment requests (core)
  listAppointmentRequests: async (query: AppointmentRequestQuery = {}) =>
    pageOf(await apiRequest<AppointmentRequestRow[] | Page<AppointmentRequestRow>>(`${receptionistBase}/appointment-requests${qs({
      clinicId: query.clinicId, campaignId: query.campaignId, status: query.status, from: query.from, to: query.to,
      cursor: query.cursor, limit: query.limit,
    })}`)),
  getAppointmentRequest: (id: string) => apiRequest<AppointmentRequestDetail>(`${receptionistBase}/appointment-requests/${id}`),
  bookAppointmentRequest: (id: string, body: BookRequestBody) =>
    apiRequest<BookRequestResult>(`${receptionistBase}/appointment-requests/${id}/book`, { method: 'POST', body: JSON.stringify(body) }),
  rejectAppointmentRequest: (id: string, outcomeReason: string) =>
    apiRequest<AppointmentRequestRow>(`${receptionistBase}/appointment-requests/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'REJECTED', outcomeReason }) }),

  // Appointment notes (append-only)
  appendAppointmentNote: (appointmentId: string, body: { text: string; reasonForVisit?: string }) =>
    apiRequest<{ id: string; noteEntries: AppointmentNote[] }>(`/v1/appointments/${appointmentId}/notes`, { method: 'PATCH', body: JSON.stringify(body) }),

  // Overview KPIs
  overview: (query: { clinicId?: string; period?: OverviewPeriod; from?: string; to?: string; direction?: CallDirection } = {}) =>
    apiRequest<OverviewKpis>(`${receptionistBase}/overview${qs(query)}`),

  // Book-it dependencies: the same routes Scheduling already drives.
  listProviders: async () => pageOf(await apiRequest<BookableProvider[] | Page<BookableProvider>>('/v1/providers/overview?limit=100')).data,
  providerSlots: (providerId: string, date: string, service: string) =>
    apiRequest<{ providerId: string; date: string; slots: ProviderSlot[] }>(`/v1/scheduling/providers/${providerId}/slots${qs({ date, service })}`),
  searchPatients: async (search: string) =>
    pageOf(await apiRequest<PatientMatch[] | Page<PatientMatch>>(`/v1/patients${qs({ search, limit: 10 })}`)).data,
  listServices: () => apiRequest<ServiceCatalogRow[]>('/v1/services'),
};

/** Client-side mask for a phone that reached the client unmasked (pre-C4 metadata). Never renders more than the last four digits. */
export function maskPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.includes('*')) return value;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 4 ? `***-***-${digits.slice(-4)}` : '***-***-****';
}

// --- Task row normalization (one derivation, shared by every surface) --------

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** The server's remediation copy, wherever the task carries it. Null when it carries none. */
export function remediationFromMetadata(metadata: Record<string, unknown> | null | undefined): TaskRemediation | null {
  if (!metadata) return null;
  const code = asString(metadata.code);
  const title = asString(metadata.title);
  const action = asString(metadata.action);
  const fixHref = asString(metadata.fixHref);
  if (!code && !title && !action && !fixHref) return null;
  return { code, title, action, fixHref };
}

/**
 * A deployment-attention task has no caller: no message, no callback number,
 * no transfer. Everything worth reading is the remediation sentence, so the
 * caller-shaped fields are null rather than invented.
 */
function deploymentAttentionView(metadata: Record<string, unknown>): ReceptionistTaskView {
  return {
    kind: 'deployment_attention',
    callerName: null,
    callbackPhoneMasked: null,
    verifiedPhoneMasked: null,
    requestedPhoneMasked: null,
    hasRequestedPhone: false,
    messages: [],
    messageCount: 0,
    reasonCategory: null,
    callbackWindow: null,
    transferStatus: 'not_attempted',
    transferUpdatedAt: null,
    toolName: null,
    denialReason: null,
    appointmentRequestId: null,
    appointmentId: null,
    staffNotes: [],
    source: asString(metadata.source) ?? 'system',
    // The AI is off the air until a person acts, so it is always an
    // acknowledgement-first task regardless of the priority it was filed with.
    requiresAcknowledgement: true,
    remediation: remediationFromMetadata(metadata),
    clinicId: asString(metadata.clinicId),
  };
}

/**
 * The receptionist view for a row that carries only the legacy metadata
 * (pre-C4 backend, or a serializer that omitted `receptionist`). Phones in
 * legacy metadata may be unmasked; they are masked here and never rendered
 * whole from a list row.
 */
export function receptionistViewFromMetadata(metadata: Record<string, unknown> | null | undefined, createdAt: string | undefined): ReceptionistTaskInfo | null {
  if (!metadata) return null;
  const workflow = asString(metadata.workflow);
  // The pre-D re-verify worker files deployment attention under its own
  // workflow with no `kind` at all. Read it as the `deployment_attention` kind
  // so one lane renders both shapes; once D files it through `createSafetyTask`
  // the row arrives on the safety workflow already carrying the kind.
  if (workflow === RECEPTIONIST_DEPLOYMENT_WORKFLOW) {
    return deploymentAttentionView(metadata);
  }
  if (workflow !== RECEPTIONIST_SAFETY_WORKFLOW) return null;
  if (asString(metadata.kind) === 'deployment_attention') return deploymentAttentionView(metadata);
  const rawKind = asString(metadata.kind);
  const requiresAcknowledgement = metadata.requiresAcknowledgement === true;
  if (metadata.restricted === true) {
    return { kind: (RECEPTIONIST_TASK_KINDS as readonly string[]).includes(rawKind ?? '') ? rawKind as ReceptionistTaskKind : 'restricted', restricted: true, requiresAcknowledgement };
  }
  const kind: ReceptionistTaskKind = (RECEPTIONIST_TASK_KINDS as readonly string[]).includes(rawKind ?? '') ? rawKind as ReceptionistTaskKind : 'message';
  const messageList = Array.isArray(metadata.messages)
    ? metadata.messages.flatMap(entry => {
      if (!entry || typeof entry !== 'object') return [];
      const text = asString((entry as Record<string, unknown>).text);
      return text ? [{ text, recordedAt: asString((entry as Record<string, unknown>).recordedAt) ?? createdAt ?? '' }] : [];
    })
    : [];
  const latest = asString(metadata.message);
  const messages = messageList.length ? messageList : latest ? [{ text: latest, recordedAt: createdAt ?? '' }] : [];
  const window = metadata.callbackWindow && typeof metadata.callbackWindow === 'object' ? metadata.callbackWindow as Record<string, unknown> : null;
  const requested = asString(metadata.requestedCallbackPhone);
  const transfer = asString(metadata.transferStatus);
  return {
    kind,
    callerName: asString(metadata.callerName),
    callbackPhoneMasked: maskPhone(asString(metadata.callbackPhoneMasked) ?? asString(metadata.callbackPhone)),
    verifiedPhoneMasked: maskPhone(asString(metadata.verifiedPhoneMasked) ?? asString(metadata.verifiedPhone)),
    requestedPhoneMasked: maskPhone(asString(metadata.requestedPhoneMasked) ?? requested),
    hasRequestedPhone: Boolean(requested || metadata.hasRequestedPhone === true),
    messages,
    messageCount: typeof metadata.messageCount === 'number' ? metadata.messageCount : messages.length,
    reasonCategory: asString(metadata.reasonCategory),
    callbackWindow: window && asString(window.start) && asString(window.end)
      ? { start: window.start as string, end: window.end as string, timezone: asString(window.timezone) ?? 'UTC', clippedToHours: window.clippedToHours === true }
      : null,
    transferStatus: (['not_attempted', 'attempted', 'connected', 'failed', 'unknown'] as const).find(value => value === transfer) ?? 'not_attempted',
    transferUpdatedAt: asString(metadata.transferUpdatedAt),
    toolName: asString(metadata.toolName),
    denialReason: asString(metadata.denialReason),
    appointmentRequestId: asString(metadata.appointmentRequestId),
    appointmentId: asString(metadata.appointmentId),
    staffNotes: Array.isArray(metadata.staffNotes)
      ? metadata.staffNotes.flatMap(entry => {
        if (!entry || typeof entry !== 'object') return [];
        const note = entry as Record<string, unknown>;
        const text = asString(note.text);
        return text ? [{ text, at: asString(note.at) ?? '', byUserId: asString(note.byUserId) ?? '', byDisplayName: asString(note.byDisplayName) }] : [];
      })
      : [],
    source: asString(metadata.source),
    requiresAcknowledgement,
    remediation: null,
    clinicId: asString(metadata.clinicId),
  };
}


/**
 * Fills a partial task row (what a pre-C4 `/v1/tasks` still returns) up to the
 * full C4 projection so one card component can render both. Nothing is
 * invented: every absent field becomes null, and the receptionist view is
 * derived from `metadata` only when the server did not send one.
 */
export function normalizeTaskRow(row: Partial<FrontDeskTaskRow> & { id: string; title: string; priority: string; status: TaskStatus }): FrontDeskTaskRow {
  return {
    ...row,
    dueAt: row.dueAt ?? null,
    createdAt: row.createdAt ?? '',
    branchId: row.branchId ?? null,
    branch: row.branch ?? null,
    assignedToId: row.assignedToId ?? null,
    assignedTo: row.assignedTo ?? null,
    acknowledgedAt: row.acknowledgedAt ?? null,
    acknowledgedBy: row.acknowledgedBy ?? null,
    completedAt: row.completedAt ?? null,
    outcomeCode: row.outcomeCode ?? null,
    outcomeNote: row.outcomeNote ?? null,
    callLogId: row.callLogId ?? (typeof row.metadata?.callLogId === 'string' ? row.metadata.callLogId : null),
    patientId: row.patientId ?? null,
    patient: row.patient ?? null,
    clinic: row.clinic ?? null,
    receptionist: row.receptionist ?? receptionistViewFromMetadata(row.metadata, row.createdAt),
  };
}

// --- Derivations shared by the page, the card and the badge -----------------------

export function isRestrictedView(view: ReceptionistTaskInfo | null | undefined): view is RestrictedReceptionistTaskView {
  return Boolean(view && (view as RestrictedReceptionistTaskView).restricted === true);
}

export function isLiveTask(status: TaskStatus | string): boolean {
  return status === 'OPEN' || status === 'IN_PROGRESS';
}

/** Kinds that must be acknowledged by a human before anything else. */
export function needsAcknowledgement(view: ReceptionistTaskInfo | null | undefined): boolean {
  if (!view) return false;
  if (view.requiresAcknowledgement) return true;
  return view.kind === 'emergency' || view.kind === 'human_handoff';
}

/** How many rows the server's unacknowledged-critical PREVIEW carries at most. */
export const CRITICAL_PREVIEW_LIMIT = 5;

export interface CriticalSignal {
  /** The preview rows, already scoped to genuine receptionist emergencies. */
  rows: UnacknowledgedCriticalRow[];
  /** How many unacknowledged emergencies there are. */
  count: number;
  /**
   * False when `count` came from a capped preview rather than a real count()
   * — the number is then a FLOOR ("5 or more"), and every surface says so
   * instead of printing 5 as if it were the total.
   */
  exact: boolean;
  /** Rows beyond the preview: `count - rows.length` when that is knowable. */
  hidden: number;
}

/**
 * D7 + D8, read as one fact.
 *
 * D7: nine unacknowledged emergencies used to read as five, because the count
 * was `preview.length` and the preview is `take: 5`. `unacknowledgedCriticalCount`
 * is the real count; when it is absent the preview length is reported as a
 * floor, never as the total.
 *
 * D8: the preview query is tenant-wide, so a critical insurance or ops task
 * could be announced to the front desk as a clinical emergency. A row that
 * declares a workflow that is not the receptionist's is dropped here.
 */
export function criticalSignal(summary: TaskSummary | null): CriticalSignal {
  if (!summary) return { rows: [], count: 0, exact: true, hidden: 0 };
  const all = summary.unacknowledgedCritical ?? [];
  const rows = all.filter(row => {
    // No workflow declared (pre-D server) ⇒ keep it: never hide a task that
    // might be an emergency. A foreign workflow ⇒ drop it: the emergency banner
    // is the one alert staff must never learn to ignore.
    if (row.workflow != null && row.workflow !== RECEPTIONIST_SAFETY_WORKFLOW) return false;
    return row.kind == null || row.kind !== 'deployment_attention';
  });
  const dropped = all.length - rows.length;
  const reported = summary.unacknowledgedCriticalCount;
  if (typeof reported === 'number' && Number.isFinite(reported)) {
    // The server's count is over the same scope as the preview it sent, so any
    // row this client dropped has to come off the total too.
    const count = Math.max(rows.length, reported - dropped);
    return { rows, count, exact: true, hidden: Math.max(0, count - rows.length) };
  }
  // No real count: the preview length is all we have. It is exact only while it
  // sits below the cap.
  const exact = all.length < CRITICAL_PREVIEW_LIMIT;
  return { rows, count: rows.length, exact, hidden: 0 };
}

/** Sidebar / header badge from the summary. Nothing (never a zero) unless the summary loaded. */
export function summarizeNeedsAction(summary: TaskSummary | null): { count: number; critical: number; criticalExact: boolean } {
  if (!summary) return { count: 0, critical: 0, criticalExact: true };
  const byKind = summary.openByKind ?? {};
  const count = typeof summary.openNeedsAction === 'number'
    ? summary.openNeedsAction
    : Object.values(byKind).reduce((sum, value) => sum + (value ?? 0), 0);
  const critical = criticalSignal(summary);
  return { count, critical: critical.count, criticalExact: critical.exact };
}

/** Open tasks of one kind, from the summary — the single source for a lane's tile. */
export function openCountOf(summary: TaskSummary | null, kinds: readonly ReceptionistTaskKind[]): number | null {
  if (!summary?.openByKind) return null;
  return kinds.reduce((sum, kind) => sum + (summary.openByKind[kind] ?? 0), 0);
}

// --- KPI presentation (kpi-v2, SF-2) ---------------------------------------

/** What a KPI with no denominator reads as. Never "0" and never "0%". */
export const KPI_UNAVAILABLE = 'Unavailable';

/** A kpi-v2 rate (0..1) as a percentage, or UNAVAILABLE when the denominator was empty. */
export function formatKpiRate(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return KPI_UNAVAILABLE;
  return `${Math.round(value * 100)}%`;
}

/** A kpi-v2 count. Zero is a real answer for a count, so 0 is shown; absence is not. */
export function formatKpiCount(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : KPI_UNAVAILABLE;
}

/** Average handle time in seconds, or UNAVAILABLE when no call could be averaged. */
export function formatKpiDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return KPI_UNAVAILABLE;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`;
}
