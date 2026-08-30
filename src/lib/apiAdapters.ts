import type { Appointment, Campaign, Doctor, Integration, InventoryItem, LabOrder, Lead, Opportunity, Patient, RevenueData, RevenueLeak } from '../types';
import { apiRequest } from './api';
import { isRestrictedView, receptionistViewFromMetadata, type ReceptionistTaskInfo, type TaskOutcomeCode } from './frontDesk';

/**
 * Reads a list endpoint, accepting both shapes the API uses: a bare array and
 * a `cursorPage` envelope. Pass the caller's AbortSignal so the request is
 * cancelled with the component that asked for it.
 */
export async function fetchList<T>(path: string, signal?: AbortSignal): Promise<T[]> {
  const response = await apiRequest<T[] | { data: T[] }>(path, { signal });
  return Array.isArray(response) ? response : response.data;
}

export interface ApiPatient {
  id: string;
  branchId: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  dateOfBirth?: string | null;
  lifecycleStage: 'NEW' | 'ACTIVE' | 'AT_RISK' | 'INACTIVE' | 'LOST' | 'RETAINED';
  churnRisk: number;
  lifetimeValue: string;
  outstandingBalance: string;
  tags: string[];
  lastVisitAt?: string | null;
  nextVisitAt?: string | null;
  appointments?: ApiAppointment[];
  consentEvents?: Array<{ purpose: 'SMS' | 'WHATSAPP' | 'EMAIL' | 'MARKETING'; granted: boolean }>;
  _count?: { appointments?: number };
  patientInsurancePolicies?: Array<{
    id: string;
    payerId?: string | null;
    memberId: string;
    groupNumber?: string | null;
    payer?: { name: string } | null;
    verificationStatus: string;
    verifiedAt?: string | null;
    active: boolean;
  }>;
  eligibilityVerifications?: Array<{
    id: string;
    appointmentId?: string | null;
    payerId?: string | null;
    payer?: { name: string } | null;
    policy?: { memberId: string; groupNumber?: string | null } | null;
    coverageStatus: string;
    coverageActive: boolean;
    planName: string;
    copay: string;
    deductibleRemaining: string;
    coinsurance: string;
    eligibilityMessage: string;
    payerReference?: string | null;
    checkedAt: string;
    providerMode: string;
    priorAuthRequired?: boolean;
    recommendedAction?: string;
    riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
    revenueAtRisk?: number;
  }>;
  priorAuthorizations?: Array<{ id: string; status: string; serviceName: string; notes?: string | null; dueAt?: string | null; payer?: { name: string } | null }>;
}

export interface ApiInventoryItem {
  id: string;
  branchId: string;
  name: string;
  category: string;
  currentStock: number;
  unit: string;
  reorderLevel: number;
  expiryDate?: string | null;
  unitCost: string;
  usagePerWeek: number;
  supplier: string;
}

/**
 * The legacy `GET /v1/campaigns` row — the analytics read behind the dashboard's
 * campaign panel.
 *
 * `revenue`, `opened` and `booked` are DB defaults that NO code path writes, and
 * `status` here omits APPROVAL_REQUIRED / CANCELLED / FAILED, which the governed
 * engine does persist. Do not build a campaign surface on this shape: the
 * campaign product lives on `/v1/crm/campaigns` via src/lib/crm.ts, which is the
 * only client that can set a campaign type, an audience or an approval.
 */
export interface ApiCampaign {
  id: string;
  name: string;
  goal: string;
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'SCHEDULED';
  channels: Array<'WHATSAPP' | 'SMS' | 'EMAIL' | 'PUSH' | 'CALL' | 'VIDEO'>;
  audienceSize: number;
  sent: number;
  opened: number;
  responded: number;
  booked: number;
  revenue: string;
  startsAt?: string | null;
  endsAt?: string | null;
  aiGenerated: boolean;
}

export interface ApiIntegration {
  id: string;
  key: string;
  name: string;
  category: string;
  status: 'CONNECTED' | 'DISCONNECTED' | 'ERROR' | 'COMING_SOON';
  config?: { icon?: string; description?: string } | null;
  lastSyncAt?: string | null;
}

export interface ApiProviderProfile {
  id: string;
  branchId: string;
  specialty: string;
  /** Whether the clinician is on the booking schedule (ProviderProfile.active). */
  active: boolean;
  utilization: number;
  appointmentsToday: number;
  appointmentsThisMonth: number;
  rating: string;
  reviewCount: number;
  revenueThisMonth: string;
  repeatVisitRate: number;
  followUpRate: number;
  branch: { name: string };
  user: { displayName: string };
  /** Active recurring windows, from GET /v1/providers/overview. */
  _count?: { availability: number };
}

export interface ApiAppointment {
  id: string;
  branchId: string;
  patientId: string;
  patientName?: string | null;
  providerRef?: string | null;
  service: string;
  startsAt: string;
  status: 'CONFIRMED' | 'RISKY' | 'ARRIVED' | 'NO_SHOW' | 'CANCELED' | 'COMPLETED' | 'WAITLIST';
  channel: 'WHATSAPP' | 'SMS' | 'EMAIL' | 'PUSH' | 'CALL' | 'VIDEO';
  value: string;
  noShowRisk: number;
  notes?: string | null;
}

export interface ApiLead {
  id: string;
  name: string;
  phone?: string | null;
  channel: 'WHATSAPP' | 'SMS' | 'EMAIL' | 'PUSH' | 'CALL' | 'VIDEO';
  service: string;
  stage: Lead['stage'];
  source: string;
  createdAt: string;
  estimatedValue: string;
}

export interface ApiReview {
  id: string;
  branchId?: string | null;
  rating: number;
  text: string;
  platform: string;
  createdAt: string;
  responded: boolean;
  aiDraftResponse?: string | null;
  sentiment: string;
}

export interface ApiPartnerReport {
  id: string;
  patientId?: string | null;
  branchId: string;
  providerRef?: string | null;
  reportType: string;
  partner: string;
  orderedAt: string;
  reviewedAt?: string | null;
  status: string;
  urgency: string;
  summary?: string | null;
  reviewedByUser?: { displayName: string } | null;
  branch?: { name: string } | null;
  patient?: { firstName: string; lastName: string } | null;
}

export interface ApiStaffTask {
  id: string;
  title: string;
  branchId?: string | null;
  assignedToId?: string | null;
  priority: string;
  dueAt?: string | null;
  createdAt?: string;
  status: 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELED';
  branch?: { name: string } | null;
  assignedTo?: { displayName: string } | null;
  metadata?: Record<string, unknown> | null;
  // C4 receptionist contract (design-C4 §1.5). Every field is optional so a
  // pre-C4 row still maps; the receptionist view is then derived from metadata.
  acknowledgedAt?: string | null;
  acknowledgedBy?: { displayName: string } | null;
  completedAt?: string | null;
  outcomeCode?: TaskOutcomeCode | null;
  outcomeNote?: string | null;
  callLogId?: string | null;
  patientId?: string | null;
  patient?: { firstName: string; lastName: string; nextAppointmentAt?: string | null } | null;
  clinic?: { id: string; name: string; timezone: string } | null;
  receptionist?: ReceptionistTaskInfo | null;
}

/** Human label for the control that filed a hand-off task, or null for a task typed by hand. */
const HANDOFF_ORIGIN_LABEL: Record<string, string> = {
  opportunity_handoff: 'Opportunity Center',
  conversation_escalation: 'AI Receptionist escalation',
  insurance_denial_prevention: 'Insurance denial review',
  receptionist_safety: 'AI receptionist safety',
  receptionist_provider_intent_recovery: 'Receptionist call recovery',
  receptionist_outbound_stop_reconciliation: 'Receptionist outbound stop',
};

export interface ApiStaffProfile {
  id: string;
  branchId: string;
  roleTitle: string;
  responseTime: string;
  missedCalls: number;
  followUpRate: number;
  bookingConversionRate: number;
  tasksCompleted: number;
  tasksPending: number;
  patientFeedbackScore: string;
  branch: { name: string };
  user: { displayName: string };
}

export interface ApiRevenueSnapshot {
  id: string;
  period: string;
  revenue: string;
  recovered: string;
  lost: string;
  campaigns: string;
}

export interface ApiRevenueLeak {
  id: string;
  branchId: string;
  category: string;
  source: string;
  evidence: string;
  estimatedValue: string;
  confidence: number;
  status: string;
  workflowStatus: string;
  suggestedAction: string;
  createdAt: string;
  branch: { name: string };
  ownerUser?: { displayName: string } | null;
  patient?: { firstName: string; lastName: string } | null;
}

export interface ApiOpportunity {
  id: string;
  branchId: string;
  title: string;
  source: string;
  category: string;
  trigger: string;
  automationSteps: { steps?: string[] } | string[] | string;
  expectedRevenue: string;
  actualRevenue: string;
  roi: string;
  confidence: number;
  effortLevel: string;
  urgency: string;
  status: string;
  ownerApprovalRequired: boolean;
  recommendedAction: string;
  createdAt: string;
  branch: { name: string };
  ownerUser?: { displayName: string } | null;
  patient?: { firstName: string; lastName: string } | null;
}

export interface ApiConversation {
  id: string;
  channel: 'WHATSAPP' | 'SMS' | 'EMAIL' | 'PUSH' | 'CALL' | 'VIDEO';
  status: string;
  intent?: string | null;
  latestMessage: string;
  lastAgentMessage?: string | null;
  lastAgentMessageAt?: string | null;
  estimatedValue: string;
  aiHandled: boolean;
  createdAt: string;
  updatedAt: string;
  patient?: { firstName: string; lastName: string } | null;
  branch?: { name: string } | null;
  replyReadiness: {
    channel: 'sms' | 'email' | 'whatsapp' | null;
    destinationMasked: string | null;
    identityStatus: 'patient_linked' | 'not_linked';
    destinationSource: 'linked_patient_record' | 'unavailable';
    destinationVerificationStatus: 'format_verified' | 'not_verified';
    authorizationBasis: 'recorded_inbound_conversation_reply' | 'none';
    explicitConsentStatus: string;
    consentSource: string | null;
    consentCapturedAt: string | null;
    suppressionStatus: 'suppressed' | 'not_suppressed' | 'not_checked_no_destination';
    submissionState: 'clear' | 'submission_result_unknown' | 'provider_evidence_pending';
    ready: boolean;
    readinessReason: 'patient_identity_not_linked' | 'destination_not_available' | 'destination_format_invalid' | 'recipient_suppressed' | 'submission_result_unknown' | 'provider_evidence_pending' | 'ready_for_server_recheck';
    draftSource: 'rule_based_staff_review_draft';
    senderIdentity: string;
    channelTerms: 'operational_reply_to_recorded_inbound_conversation';
    channelTermsSource: 'carecommand_operational_reply_policy_v1';
  };
}

const lifecycleMap = {
  NEW: 'new',
  ACTIVE: 'active',
  AT_RISK: 'at-risk',
  INACTIVE: 'inactive',
  LOST: 'lost',
  RETAINED: 'retained',
} as const;

export function mapPatient(row: ApiPatient): Patient {
  const latestConsent = new Map<string, boolean>();
  row.consentEvents?.forEach(event => {
    if (!latestConsent.has(event.purpose)) latestConsent.set(event.purpose, event.granted);
  });
  return {
    id: row.id,
    name: `${row.firstName} ${row.lastName}`,
    age: row.dateOfBirth ? Math.max(0, Math.floor((Date.now() - new Date(row.dateOfBirth).getTime()) / 31_556_952_000)) : null,
    gender: null,
    branchId: row.branchId,
    assignedDoctorId: null,
    lastVisit: row.lastVisitAt ?? null,
    nextVisit: row.nextVisitAt ?? undefined,
    lifecycleStage: lifecycleMap[row.lifecycleStage],
    churnRisk: row.churnRisk,
    lifetimeValue: Number(row.lifetimeValue),
    preferredChannel: latestConsent.get('WHATSAPP') ? 'whatsapp' : latestConsent.get('SMS') ? 'sms' : latestConsent.get('EMAIL') ? 'email' : null,
    consentStatus: {
      sms: latestConsent.get('SMS') ?? false,
      whatsapp: latestConsent.get('WHATSAPP') ?? false,
      email: latestConsent.get('EMAIL') ?? false,
      marketing: latestConsent.get('MARKETING') ?? false,
    },
    tags: row.tags,
    phone: row.phone ?? '',
    email: row.email ?? '',
    visitCount: row._count?.appointments ?? row.appointments?.length ?? 0,
    outstandingBalance: Number(row.outstandingBalance),
  };
}

export function mapInventoryItem(row: ApiInventoryItem): InventoryItem {
  const expiring = row.expiryDate && new Date(row.expiryDate) < new Date(Date.now() + 30 * 86400000);
  const status = row.currentStock === 0 ? 'critical' : row.currentStock <= row.reorderLevel ? 'low' : expiring ? 'expiring' : 'ok';
  return {
    ...row,
    expiryDate: row.expiryDate?.slice(0, 10),
    unitCost: Number(row.unitCost),
    status,
  };
}

/** Legacy analytics rows only — see the note on ApiCampaign before reusing this. */
export function mapCampaign(row: ApiCampaign): Campaign {
  return {
    ...row,
    status: row.status.toLowerCase() as Campaign['status'],
    channels: row.channels.map(channel => channel.toLowerCase() as Campaign['channels'][number]),
    revenue: Number(row.revenue),
    startDate: row.startsAt ?? new Date().toISOString(),
    endDate: row.endsAt ?? undefined,
  };
}

export function mapIntegration(row: ApiIntegration): Integration {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    status: row.status.toLowerCase().replace('_', '-') as Integration['status'],
    icon: row.config?.icon ?? 'Cloud',
    description: row.config?.description ?? 'No integration description provided.',
    lastSync: row.lastSyncAt ? new Date(row.lastSyncAt).toLocaleString() : undefined,
  };
}

export function mapProviderProfile(row: ApiProviderProfile): Doctor {
  return {
    id: row.id,
    name: row.user.displayName,
    specialty: row.specialty,
    branchId: row.branchId,
    active: row.active,
    // null means the response did not carry the count — never rendered as
    // "no working hours", which is a different claim from "not known".
    availabilityWindows: row._count?.availability ?? null,
    utilization: row.utilization,
    appointmentsToday: row.appointmentsToday,
    appointmentsThisMonth: row.appointmentsThisMonth,
    rating: Number(row.rating),
    reviewCount: row.reviewCount,
    revenueThisMonth: Number(row.revenueThisMonth),
    repeatVisitRate: row.repeatVisitRate,
    followUpRate: row.followUpRate,
  };
}

export function mapAppointment(row: ApiAppointment): Appointment {
  const startsAt = new Date(row.startsAt);
  return {
    id: row.id,
    patientId: row.patientId,
    // Real patient name from the API (list/detail now include it); fall back only
    // when a row genuinely lacks a linked patient name.
    patientName: row.patientName?.trim() || 'Unknown patient',
    doctorId: row.providerRef ?? '',
    doctorName: row.providerRef ?? 'Provider not linked',
    branchId: row.branchId,
    service: row.service,
    date: startsAt.toISOString().slice(0, 10),
    time: startsAt.toTimeString().slice(0, 5),
    status: row.status.toLowerCase().replace('_', '-') as Appointment['status'],
    noShowRisk: row.noShowRisk,
    channel: row.channel.toLowerCase() as Appointment['channel'],
    value: Number(row.value),
    notes: row.notes ?? undefined,
  };
}

export function mapLead(row: ApiLead): Lead {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone ?? '',
    channel: row.channel.toLowerCase() as Lead['channel'],
    service: row.service,
    stage: row.stage,
    source: row.source,
    createdAt: row.createdAt,
    branchId: '',
    estimatedValue: Number(row.estimatedValue),
  };
}

/**
 * A review as the API is actually able to describe it.
 *
 * `GET /v1/reviews` returns the stored Review row and nothing more: it loads no
 * author relation, and `platform` / `sentiment` are free-text columns. The
 * previous mapping papered over all three gaps — it stamped the same invented
 * name on every row, folded every non-Google platform into "internal" (so a
 * Yelp or Facebook review was displayed as a first-party one), and relabelled
 * any unrecognised sentiment as "neutral", which silently deflated the
 * positive-sentiment percentage. This shape keeps each absence visible so the
 * screen can say "not recorded" instead of guessing.
 */
export interface ReviewRow {
  id: string;
  branchId: string;
  /** null when the stored rating is not a usable number. */
  rating: number | null;
  text: string;
  /** Exactly the platform string the row was stored with; never coerced. */
  platform: string;
  date: string;
  responded: boolean;
  /**
   * The stored `aiDraftResponse` column: the recorded response once `responded`
   * is true, and a stored draft awaiting review before that.
   */
  storedResponse?: string;
  /** null when the stored sentiment is not one of the three known values. */
  sentiment: 'positive' | 'neutral' | 'negative' | null;
}

const KNOWN_SENTIMENTS = ['positive', 'neutral', 'negative'] as const;

export function mapReview(row: ApiReview): ReviewRow {
  const rating = Number(row.rating);
  const platform = row.platform?.trim() ?? '';
  return {
    id: row.id,
    branchId: row.branchId ?? '',
    rating: Number.isFinite(rating) ? rating : null,
    text: row.text,
    platform,
    date: row.createdAt.slice(0, 10),
    responded: row.responded,
    storedResponse: row.aiDraftResponse ?? undefined,
    sentiment: (KNOWN_SENTIMENTS as readonly string[]).includes(row.sentiment)
      ? row.sentiment as ReviewRow['sentiment']
      : null,
  };
}

export function mapPartnerReport(row: ApiPartnerReport): LabOrder {
  return {
    id: row.id,
    patientId: row.patientId ?? '',
    patientName: row.patient ? `${row.patient.firstName} ${row.patient.lastName}` : 'Patient not linked',
    doctorId: row.providerRef ?? '',
    doctorName: row.providerRef ?? 'Provider not linked',
    branchId: row.branchId,
    testName: row.reportType,
    orderedAt: row.orderedAt,
    status: ['ordered', 'sample-collected', 'pending-result', 'result-received', 'doctor-reviewed'].includes(row.status) ? row.status as LabOrder['status'] : 'ordered',
    lab: row.partner,
    urgency: ['routine', 'urgent', 'stat'].includes(row.urgency) ? row.urgency as LabOrder['urgency'] : 'routine',
    resultSummary: row.summary ?? undefined,
    reviewedAt: row.reviewedAt ?? undefined,
    reviewedBy: row.reviewedByUser?.displayName ?? undefined,
  };
}

export function mapStaffTask(row: ApiStaffTask) {
  const dueAt = row.dueAt ? new Date(row.dueAt) : undefined;
  const status = row.status.toLowerCase().replace('_', '-') as 'open' | 'in-progress' | 'completed' | 'canceled';
  const workflow = typeof row.metadata?.workflow === 'string' ? row.metadata.workflow : null;
  const receptionist = row.receptionist ?? receptionistViewFromMetadata(row.metadata, row.createdAt);
  return {
    id: row.id,
    title: row.title,
    branch: row.branch?.name ?? (row.branchId ? 'Live branch' : 'All'),
    // Priority strings are written by several modules in mixed case ('high',
    // 'HIGH', 'CRITICAL'). Normalise for display and styling; the stored value
    // is untouched.
    priority: row.priority.toLowerCase(),
    dueAt: dueAt ?? null,
    createdAt: row.createdAt ?? null,
    // Only a live task can be overdue — a finished one is not work in arrears.
    overdue: Boolean(dueAt && dueAt < new Date() && (status === 'open' || status === 'in-progress')),
    // No `due` string here: the page formats `dueAt` in the CLINIC's zone
    // (`formatClinicDateTime(task.dueAt, task.clinic?.timezone)`), not the viewer's.
    assignedToId: row.assignedToId ?? null,
    assignee: row.assignedTo?.displayName ?? null,
    origin: workflow ? HANDOFF_ORIGIN_LABEL[workflow] ?? workflow.replace(/_/g, ' ') : null,
    status,
    rawStatus: row.status,
    acknowledgedAt: row.acknowledgedAt ?? null,
    acknowledgedBy: row.acknowledgedBy?.displayName ?? null,
    completedAt: row.completedAt ?? null,
    outcomeCode: row.outcomeCode ?? null,
    outcomeNote: row.outcomeNote ?? null,
    callLogId: row.callLogId ?? (typeof row.metadata?.callLogId === 'string' ? row.metadata.callLogId : null),
    patientId: row.patientId ?? null,
    patient: row.patient ?? null,
    clinic: row.clinic ?? null,
    receptionist,
    restricted: isRestrictedView(receptionist),
  };
}

export function mapStaffProfile(row: ApiStaffProfile) {
  return {
    id: row.id,
    name: row.user.displayName,
    role: row.roleTitle,
    branchId: row.branchId,
    branch: row.branch.name,
    responseTime: Number(row.responseTime),
    missedCalls: row.missedCalls,
    followUpRate: row.followUpRate,
    bookingConversionRate: row.bookingConversionRate,
    tasksCompleted: row.tasksCompleted,
    tasksPending: row.tasksPending,
    patientFeedbackScore: Number(row.patientFeedbackScore),
  };
}

export function mapRevenueSnapshot(row: ApiRevenueSnapshot): RevenueData & { id: string } {
  return {
    id: row.id,
    month: new Date(row.period).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }),
    periodTs: new Date(row.period).getTime(),
    revenue: Number(row.revenue),
    recovered: Number(row.recovered),
    lost: Number(row.lost),
    campaigns: Number(row.campaigns),
  };
}

export function mapRevenueLeak(row: ApiRevenueLeak): RevenueLeak {
  return {
    id: row.id,
    branchId: row.branchId,
    branchName: row.branch.name,
    category: row.category,
    source: row.source,
    evidence: row.evidence,
    estimatedValue: Number(row.estimatedValue),
    confidence: row.confidence,
    status: row.status,
    workflowStatus: row.workflowStatus,
    suggestedAction: row.suggestedAction,
    ownerName: row.ownerUser?.displayName,
    patientName: row.patient ? `${row.patient.firstName} ${row.patient.lastName}` : undefined,
    createdAt: row.createdAt,
  };
}

export function mapOpportunity(row: ApiOpportunity): Opportunity {
  let steps: string[] = [];
  if (Array.isArray(row.automationSteps)) {
    steps = row.automationSteps;
  } else if (row.automationSteps && typeof row.automationSteps === 'object' && 'steps' in row.automationSteps && Array.isArray(row.automationSteps.steps)) {
    steps = row.automationSteps.steps;
  }
  return {
    id: row.id,
    branchId: row.branchId,
    branchName: row.branch.name,
    title: row.title,
    source: row.source,
    category: row.category,
    trigger: row.trigger,
    automationSteps: steps,
    expectedRevenue: Number(row.expectedRevenue),
    actualRevenue: Number(row.actualRevenue),
    roi: Number(row.roi),
    confidence: row.confidence,
    effortLevel: row.effortLevel,
    urgency: row.urgency,
    status: row.status,
    ownerApprovalRequired: row.ownerApprovalRequired,
    recommendedAction: row.recommendedAction,
    ownerName: row.ownerUser?.displayName,
    patientName: row.patient ? `${row.patient.firstName} ${row.patient.lastName}` : undefined,
    createdAt: row.createdAt,
  };
}

export interface ApiTelehealthSession {
  id: string;
  patientName: string;
  service: string;
  startsAt: string;
  status: 'CONFIRMED' | 'RISKY' | 'ARRIVED' | 'NO_SHOW' | 'CANCELED' | 'COMPLETED' | 'WAITLIST';
  provider: string;
  branchName: string;
  value: string;
  noShowRisk: number;
  intakeComplete: boolean;
}

export interface TelehealthSession {
  id: string;
  patient: string;
  initials: string;
  service: string;
  date: string;
  time: string;
  status: 'Confirmed' | 'Pending';
  provider: string;
  value: number;
  intakeComplete: boolean;
}

export function mapTelehealthSession(row: ApiTelehealthSession): TelehealthSession {
  const startsAt = new Date(row.startsAt);
  const initials = row.patientName.split(' ').map(part => part[0]).slice(0, 2).join('').toUpperCase();
  return {
    id: row.id,
    patient: row.patientName,
    initials,
    service: row.service,
    date: startsAt.toISOString().slice(0, 10),
    time: startsAt.toTimeString().slice(0, 5),
    status: row.status === 'CONFIRMED' || row.status === 'ARRIVED' || row.status === 'COMPLETED' ? 'Confirmed' : 'Pending',
    provider: row.provider,
    value: Number(row.value),
    intakeComplete: row.intakeComplete,
  };
}

export interface ApiAuditEvent {
  id: string;
  action: string;
  resource: string;
  resourceId?: string | null;
  actor: string;
  occurredAt: string;
  metadata?: unknown;
}

export interface AuditLogEntry {
  id: string;
  event: string;
  user: string;
  date: string;
  type: string;
}

const auditTypeMap: Record<string, string> = {
  'patient.consent.recorded': 'consent',
  'patient.consent.revoked': 'optout',
  'conversation.replied': 'access',
  'partnerReport.reviewed': 'approval',
};

export function mapAuditEvent(row: ApiAuditEvent): AuditLogEntry {
  const type = auditTypeMap[row.action]
    ?? (row.action.includes('consent') ? 'consent'
      : row.action.includes('created') ? 'change'
      : row.action.includes('approv') ? 'approval'
      : 'access');
  return {
    id: row.id,
    event: row.action.replace(/[._]/g, ' ').replace(/^\w/, char => char.toUpperCase()),
    user: row.actor,
    date: new Date(row.occurredAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    type,
  };
}

export interface ApiConsentSummary {
  totalPatients: number;
  channels: Array<{ purpose: 'WHATSAPP' | 'SMS' | 'EMAIL' | 'MARKETING'; opted: number; total: number; pct: number }>;
}

export function mapConversation(row: ApiConversation) {
  return {
    id: row.id,
    name: row.patient ? `${row.patient.firstName} ${row.patient.lastName}` : row.branch?.name ?? 'Anonymous caller',
    channel: row.channel.toLowerCase(),
    message: row.latestMessage,
    time: new Date(row.updatedAt).toLocaleString(),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: row.status,
    aiHandled: row.aiHandled,
    intent: row.intent ?? 'General enquiry',
    lastAgentMessage: row.lastAgentMessage ?? undefined,
    lastAgentMessageAt: row.lastAgentMessageAt ?? undefined,
    suggestedSlot: null,
    value: `$${Number(row.estimatedValue).toLocaleString()}`,
    valueEvidence: 'Recorded estimate · source not verified',
    replyReadiness: row.replyReadiness,
  };
}
