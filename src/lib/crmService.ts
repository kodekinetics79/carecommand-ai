import { apiRequest } from './api';

// ============================================================================
// GrowthPulse CRM service — patient growth, retention & revenue recovery.
//
// This file used to COMPUTE. It fetched `/v1/leads?limit=100` and
// `/v1/patients?limit=100`, discarded the `nextCursor` the server sent back, and
// then averaged, scored, bucketed and priced whatever hundred rows happened to
// arrive. Every currency and percentage on the CRM Command View was a statistic
// about an arbitrary page, printed as a fact about a clinic.
//
// It now READS. `scoreLead`, `NBA`, `commandMetrics` and `smartSegments` are
// gone; `/v1/growth/metrics`, `/v1/growth/leads` and `/v1/growth/segments/preview`
// compute the same arithmetic over the whole tenant from GrowthPolicy,
// GrowthSegmentDefinition and GrowthChannelCost. Every threshold this file used
// to hardcode now arrives beside the number it produced, so the screen can state
// its own rules instead of repeating them.
//
// Where a list is still capped, the cap and the total come back with it and the
// UI says so. Nothing here fills a gap with a zero.
// ============================================================================

export type Stage = 'new-inquiry' | 'contacted' | 'booked' | 'visited' | 'follow-up' | 'retained' | 'lost';
export const STAGES: Stage[] = ['new-inquiry', 'contacted', 'booked', 'visited', 'follow-up', 'retained', 'lost'];
export const STAGE_LABEL: Record<Stage, string> = {
  'new-inquiry': 'New Inquiry', contacted: 'Contacted', booked: 'Booked', visited: 'Visited',
  'follow-up': 'Follow-up', retained: 'Retained', lost: 'Lost',
};

export interface ConsentFlags {
  email: ConsentEvidenceStatus; sms: ConsentEvidenceStatus;
  whatsapp: ConsentEvidenceStatus; voice: ConsentEvidenceStatus;
  evidenceAvailable: boolean;
}
export type ConsentEvidenceStatus = 'opted_in' | 'opted_out' | 'unknown';

export interface ScoreDriver { label: string; positive: boolean; weight: number }

/** Server-assigned band. `unscored` means the recorded stage is not one the heuristic knows. */
export type ScoreBand = 'high' | 'medium' | 'low' | 'unscored';

export interface CrmLead {
  id: string; name: string; phone: string; email?: string; channel: string;
  service: string; stage: string; knownStage: Stage | null; source: string; estimatedValue: number;
  createdAt: string; ageDays: number; owner: string; branchId: string;
  /** null when the server could not score the lead. Never a placeholder number. */
  score: number | null;
  scoreBand: ScoreBand;
  scoreDrivers: ScoreDriver[];
  scoreUnavailableReason: string | null;
  hot: boolean;
  goingCold: boolean;
  nextBestAction: { label: string; cta: CtaId } | null;
  bestChannel: string; bestTime: string;
  consent: ConsentFlags; isPatient: boolean;
}

export type CtaId = 'call_now' | 'send_booking_link' | 'send_deposit_link' | 'send_intake_form' | 'confirm_visit' | 'send_follow_up' | 'launch_winback' | 'recover_lost' | 'mark_retained' | 'mark_lost';

export interface CrmPatient {
  id: string; name: string; email?: string; phone?: string;
  lifecycleStage: string; churnRisk: number; lifetimeValue: number;
  lastVisit: string | null; nextVisit: string | null; tags: string[]; consent: ConsentFlags;
  /**
   * Band the server's configured `churnRiskHigh` puts this patient in. `null`
   * when no policy was loaded alongside the record — an unknown band renders as
   * an unknown band, never as "not at risk".
   */
  atRisk: boolean | null;
}

/** The configuration the server used, echoed so the screen never restates a threshold. */
export interface GrowthPolicyEcho {
  source: 'tenant' | 'default';
  hotLeadScore: number;
  scoreBandHigh: number;
  scoreBandMid: number;
  goingColdDays: number;
  churnRiskHigh: number;
  highValuePatientLtv: number;
  recoverableLtvFraction: number;
  recoverableLtvPercent: number;
}

export interface MetricScopeInfo {
  patients: 'tenant' | 'assigned_branch';
  leads: 'tenant' | 'assigned_branch';
  branchId: string | null;
  note: string;
}

export interface CommandMetrics {
  asOf: string;
  scope: MetricScopeInfo;
  basis: {
    leadCount: number; openLeadCount: number; closedLeadCount: number;
    patientCount: number; inactivePatientCount: number; unscoredLeadCount: number;
    truncated: boolean;
  };
  metrics: {
    openPipeline: number;
    hotLeads: number;
    /** null when the tenant has nothing to compute the figure from. The card shows the reason. */
    winRate: number | null;
    avgDeal: number | null;
    avgChurnRisk: number | null;
    avgLtv: number | null;
    missedCallValue: number;
    inactiveRecoverable: number;
    campaignRoi: number | null;
  };
  unavailable: Record<string, string>;
  policy: GrowthPolicyEcho;
}

export interface StageTotal { stage: string; known: boolean; label: string | null; count: number; value: number }

export interface CrmPipeline {
  leads: CrmLead[];
  /** Tenant-wide highest-priority open leads — not the top of the loaded page. */
  priority: CrmLead[];
  stageTotals: StageTotal[];
  limit: number;
  returned: number;
  total: number;
  truncated: boolean;
  policy: GrowthPolicyEcho;
}

export interface SmartSegment {
  key: string; label: string; description: string;
  patientCount: number; recoverableValue: number;
  planningChannel: string; planningOffer: string; planningBookingRatePct: number;
  /** Integer minor units (cents). null when the channel has no configured cost. */
  plannedCostMinor: number | null;
  currency: string | null;
  costUnavailableReason: string | null;
  criteria: {
    minInactiveDays: number | null; maxInactiveDays: number | null; includeNeverVisited: boolean;
    minLifetimeValue: number | null; minChurnRisk: number | null; requiredTag: string | null;
  };
  neverVisitedCandidates: number;
  source: 'tenant' | 'default';
  assumptionNotice: string;
}

export interface SegmentPreview {
  scope: { patients: 'tenant' | 'assigned_branch'; branchId: string | null };
  segments: SmartSegment[];
  policy: GrowthPolicyEcho;
}

export interface CrmPatientPage {
  patients: CrmPatient[];
  returned: number;
  /** The server had more rows than it returned. The list is a page, and says so. */
  truncated: boolean;
}

export interface AutomationRule {
  id: string; templateKey: string; name: string; triggerType: string; actionType: string;
  config: Record<string, number>; enabled: boolean; lastRunAt: string | null; lastMatchCount: number; runCount: number; matchesNow?: number;
}
export interface RuleTemplate { key: string; name: string; triggerType: string; actionType: string; config: Record<string, number>; description: string }

interface CommunicationConsentRow {
  patientId?: string | null;
  leadId?: string | null;
  channel?: string;
  status?: string;
}

type ConsentChannel = 'email' | 'sms' | 'whatsapp' | 'voice';

/** Maps only persisted canonical communication-consent rows. Missing evidence stays unknown. */
export function consentFromCanonicalEvidence(rows: CommunicationConsentRow[], target: { patientId?: string; leadId?: string }): ConsentFlags {
  const relevant = rows.filter(row => target.patientId ? row.patientId === target.patientId : row.leadId === target.leadId);
  const statusFor = (channel: ConsentChannel): ConsentEvidenceStatus => {
    const status = relevant.find(row => row.channel?.toLowerCase() === channel)?.status?.toLowerCase();
    return status === 'opted_in' || status === 'opted_out' ? status : 'unknown';
  };
  return {
    email: statusFor('email'), sms: statusFor('sms'), whatsapp: statusFor('whatsapp'), voice: statusFor('voice'),
    evidenceAvailable: relevant.some(row => row.status === 'opted_in' || row.status === 'opted_out'),
  };
}

const num = (v: unknown): number => typeof v === 'string' ? Number(v) || 0 : typeof v === 'number' ? v : 0;

const KNOWN_STAGES = new Set<string>(STAGES);

interface ServerScoredLead {
  id: string; name: string; phone: string | null; email: string | null; channel: string;
  service: string; stage: string; knownStage: Stage | null; source: string;
  estimatedValue: number | string; createdAt: string; patientId: string | null;
  ageDays: number; score: number | null; scoreBand: ScoreBand; scoreDrivers: ScoreDriver[];
  scoreUnavailableReason: string | null; hot: boolean; goingCold: boolean;
  nextBestAction: { label: string; cta: string } | null; bestTime: string;
}

/** Adapts a server-scored lead. No arithmetic happens here — only shaping. */
function adaptLead(row: ServerScoredLead, consents: CommunicationConsentRow[]): CrmLead {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone ?? '',
    email: row.email ?? undefined,
    channel: row.channel,
    service: row.service,
    stage: row.stage,
    knownStage: row.knownStage && KNOWN_STAGES.has(row.knownStage) ? row.knownStage : null,
    source: row.source,
    estimatedValue: num(row.estimatedValue),
    createdAt: row.createdAt,
    ageDays: row.ageDays,
    // The Lead table has no owner or branch column, so neither is claimed here.
    owner: 'Unassigned',
    branchId: '',
    score: row.score,
    scoreBand: row.scoreBand,
    scoreDrivers: row.scoreDrivers,
    scoreUnavailableReason: row.scoreUnavailableReason,
    hot: row.hot,
    goingCold: row.goingCold,
    nextBestAction: row.nextBestAction ? { label: row.nextBestAction.label, cta: row.nextBestAction.cta as CtaId } : null,
    bestChannel: row.channel,
    bestTime: row.bestTime,
    consent: consentFromCanonicalEvidence(consents, { leadId: row.id }),
    isPatient: row.patientId !== null,
  };
}

function adaptPatient(
  row: Record<string, unknown>,
  consents: CommunicationConsentRow[],
  churnRiskHigh: number | null,
): CrmPatient {
  const churnRisk = num(row.churnRisk);
  return {
    id: String(row.id),
    name: `${String(row.firstName ?? '')} ${String(row.lastName ?? '')}`.trim(),
    email: row.email ? String(row.email) : undefined,
    phone: row.phone ? String(row.phone) : undefined,
    lifecycleStage: String(row.lifecycleStage ?? 'ACTIVE'),
    churnRisk,
    lifetimeValue: num(row.lifetimeValue),
    lastVisit: (row.lastVisitAt as string) ?? null,
    nextVisit: (row.nextVisitAt as string) ?? null,
    tags: (row.tags as string[]) ?? [],
    consent: consentFromCanonicalEvidence(consents, { patientId: String(row.id) }),
    atRisk: churnRiskHigh === null ? null : churnRisk >= churnRiskHigh,
  };
}

/** How many patient rows one page of the Patient Intelligence table asks for. */
export const PATIENT_PAGE_SIZE = 100;

export const crmService = {
  // [LIVE] GET /v1/growth/metrics — tenant-wide aggregates plus the policy used.
  getMetrics: () => apiRequest<CommandMetrics>('/v1/growth/metrics'),

  // [LIVE] GET /v1/growth/segments/preview — tenant-wide membership counted in SQL.
  getSegments: () => apiRequest<SegmentPreview>('/v1/growth/segments/preview'),

  // [LIVE] GET /v1/growth/leads + canonical communication-consent evidence.
  // Scores, bands and next-best-actions are the server's; this only joins consent.
  async getPipeline(limit = 200): Promise<CrmPipeline> {
    const [board, consents] = await Promise.all([
      apiRequest<{
        data: ServerScoredLead[]; priority: ServerScoredLead[]; stageTotals: StageTotal[];
        limit: number; returned: number; total: number; truncated: boolean; policy: GrowthPolicyEcho;
      }>(`/v1/growth/leads?limit=${limit}`),
      apiRequest<CommunicationConsentRow[]>('/v1/crm/consent'),
    ]);
    return {
      leads: board.data.map(row => adaptLead(row, consents)),
      priority: board.priority.map(row => adaptLead(row, consents)),
      stageTotals: board.stageTotals,
      limit: board.limit,
      returned: board.returned,
      total: board.total,
      truncated: board.truncated,
      policy: board.policy,
    };
  },

  // [LIVE] GET /v1/patients — `search` is the SERVER's search parameter, so a
  // lookup runs against every patient rather than the hundred rows in memory.
  // "No patients found" is now an answer about the record system.
  async listPatients(options: { search?: string; churnRiskHigh?: number | null } = {}): Promise<CrmPatientPage> {
    const query = new URLSearchParams({ limit: String(PATIENT_PAGE_SIZE) });
    const search = options.search?.trim();
    if (search) query.set('search', search);
    const [res, consents] = await Promise.all([
      apiRequest<{ data: Array<Record<string, unknown>>; nextCursor?: string }>(`/v1/patients?${query.toString()}`),
      apiRequest<CommunicationConsentRow[]>('/v1/crm/consent'),
    ]);
    const rows = res.data ?? [];
    return {
      patients: rows.map(row => adaptPatient(row, consents, options.churnRiskHigh ?? null)),
      returned: rows.length,
      // The cursor the previous implementation threw away. Its presence is the
      // server saying "there is more", and the table now repeats that.
      truncated: Boolean(res.nextCursor),
    };
  },

  // [LIVE] GET /v1/patients — kept for pages that only need the records
  // themselves. No policy is loaded, so no risk band is claimed.
  async getPatients(): Promise<CrmPatient[]> {
    return (await crmService.listPatients()).patients;
  },

  // [LIVE] PATCH /v1/leads/:id (stage transition — audited server-side).
  // `lostReason` is required by the server when a lead moves to `lost`; it is
  // persisted on the lead, recorded in the audit trail, and written to the
  // lead's activity history, which is what the confirmation modal promises.
  async setStage(id: string, stage: Stage, lostReason?: string): Promise<void> {
    const reason = lostReason?.trim();
    await apiRequest(`/v1/leads/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(reason ? { stage, lostReason: reason } : { stage }),
    });
  },

  // Governed per-lead communications request. Synthetic mocks can execute;
  // live submission stays fail-closed behind versioned authority and the
  // atomic provider boundary. Server records the submission result.
  async sendComms(leadId: string, cta: CtaId): Promise<{ status: string; channel?: string; destinationMasked?: string | null; message?: string }> {
    const res = await apiRequest<{ status: string; channel?: string; destinationMasked?: string | null; missing?: string[]; message?: string }>(`/v1/crm/leads/${leadId}/send`, { method: 'POST', body: JSON.stringify({ cta }) });
    if (res.status === 'setup_required') throw new Error(`${res.channel ?? 'Provider'} not configured (${(res.missing ?? []).join(', ')}). No message sent.`);
    if (res.status === 'blocked') throw new Error(res.message ?? 'Contact is suppressed or opted out — no message sent.');
    if (res.status === 'no_destination') throw new Error(res.message ?? 'No phone or email on file for this lead.');
    if (res.status === 'failed') throw new Error('Send failed at the provider. No message delivered.');
    return res;
  },

  // [LIVE] Automation rules engine.
  getAutomationRules: () => apiRequest<AutomationRule[]>('/v1/crm/automation-rules'),
  getAutomationCatalog: () => apiRequest<RuleTemplate[]>('/v1/crm/automation-rules/catalog'),
  createAutomationRule: (templateKey: string) => apiRequest<AutomationRule>('/v1/crm/automation-rules', { method: 'POST', body: JSON.stringify({ templateKey, enabled: true }) }),
  toggleAutomationRule: (id: string, enabled: boolean) => apiRequest<AutomationRule>(`/v1/crm/automation-rules/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  deleteAutomationRule: (id: string) => apiRequest<void>(`/v1/crm/automation-rules/${id}`, { method: 'DELETE' }),
  runAutomationRule: (id: string) => apiRequest<{ matched: number; actionType: string; created: number; preview: boolean; route: string | null; note: string }>(`/v1/crm/automation-rules/${id}/run`, { method: 'POST' }),
};
