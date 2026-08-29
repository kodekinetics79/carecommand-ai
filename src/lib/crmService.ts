import { apiRequest } from './api';

// ============================================================================
// GrowthPulse CRM service — patient growth, retention & revenue recovery.
// All page data flows through here (no hardcoded sample data in components).
// Every callable method below is backed by a real endpoint or real-data derivation.
// ============================================================================

const num = (v: unknown): number => typeof v === 'string' ? Number(v) || 0 : typeof v === 'number' ? v : 0;

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
export interface CrmLead {
  id: string; name: string; phone: string; email?: string; channel: string;
  service: string; stage: Stage; source: string; estimatedValue: number;
  createdAt: string; ageDays: number; owner: string; branchId: string;
  score: number; scoreDrivers: ScoreDriver[];
  nextBestAction: { label: string; cta: CtaId }; bestChannel: string; bestTime: string;
  consent: ConsentFlags; isPatient: boolean;
}

export type CtaId = 'call_now' | 'send_booking_link' | 'send_deposit_link' | 'send_intake_form' | 'confirm_visit' | 'send_follow_up' | 'launch_winback' | 'recover_lost' | 'mark_retained' | 'mark_lost';

export interface CrmPatient {
  id: string; name: string; email?: string; phone?: string;
  lifecycleStage: string; churnRisk: number; lifetimeValue: number;
  lastVisit: string | null; nextVisit: string | null; tags: string[]; consent: ConsentFlags;
}

export interface CommandMetrics {
  openPipeline: number; hotLeads: number; winRate: number; avgDeal: number;
  avgChurnRisk: number; avgLtv: number; missedCallValue: number; inactiveRecoverable: number;
  campaignRoi: number | null;
}

export interface SmartSegment {
  id: string; label: string; description: string; patientCount: number; recoverableValue: number;
  planningChannel: string; planningOffer: string; planningBookingRate: number; planningCost: number;
  assumptionNotice: string;
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

// ---- Unvalidated planning priority (fixed heuristic over real fields) ----
const STAGE_INTENT: Record<Stage, number> = { 'new-inquiry': 20, contacted: 40, booked: 70, visited: 80, 'follow-up': 55, retained: 90, lost: 0 };
function scoreLead(lead: { stage: Stage; estimatedValue: number; createdAt: string; channel: string }, maxValue: number): { score: number; drivers: ScoreDriver[] } {
  const drivers: ScoreDriver[] = [];
  const intent = STAGE_INTENT[lead.stage];
  drivers.push({ label: `Pipeline stage: ${STAGE_LABEL[lead.stage]}`, positive: intent >= 40, weight: Math.round(intent * 0.4) });
  const valueScore = maxValue > 0 ? Math.round((lead.estimatedValue / maxValue) * 30) : 0;
  drivers.push({ label: `Estimated value ${lead.estimatedValue}`, positive: valueScore >= 12, weight: valueScore });
  const ageDays = Math.max(0, Math.floor((Date.now() - new Date(lead.createdAt).getTime()) / 86400000));
  const recency = ageDays <= 2 ? 20 : ageDays <= 7 ? 12 : ageDays <= 30 ? 4 : 0;
  drivers.push({ label: ageDays <= 2 ? 'Fresh inquiry (< 48h)' : `Inquiry age ${ageDays}d`, positive: recency >= 12, weight: recency });
  if (['whatsapp', 'sms'].includes(lead.channel.toLowerCase())) drivers.push({ label: `Reachable channel (${lead.channel})`, positive: true, weight: 8 });
  const score = Math.max(0, Math.min(100, Math.round(intent * 0.4 + valueScore + recency + (['whatsapp', 'sms'].includes(lead.channel.toLowerCase()) ? 8 : 0))));
  return { score, drivers };
}

const NBA: Record<Stage, { label: string; cta: CtaId }> = {
  'new-inquiry': { label: 'Call now & send booking link', cta: 'call_now' },
  contacted: { label: 'Send booking link', cta: 'send_booking_link' },
  booked: { label: 'Send intake form + deposit link', cta: 'send_intake_form' },
  visited: { label: 'Send follow-up to rebook', cta: 'send_follow_up' },
  'follow-up': { label: 'Confirm next visit', cta: 'confirm_visit' },
  retained: { label: 'Nurture & request review', cta: 'mark_retained' },
  lost: { label: 'Launch winback', cta: 'launch_winback' },
};

export const crmService = {
  // [LIVE] GET /v1/leads + canonical communication-consent evidence.
  async getLeads(): Promise<CrmLead[]> {
    const [rows, consents] = await Promise.all([
      apiRequest<Array<Record<string, unknown>>>('/v1/leads?limit=100'),
      apiRequest<CommunicationConsentRow[]>('/v1/crm/consent'),
    ]);
    const maxValue = Math.max(1, ...rows.map(r => num(r.estimatedValue)));
    return rows.map(r => {
      const stage = (String(r.stage ?? 'new-inquiry') as Stage);
      const createdAt = String(r.createdAt ?? new Date().toISOString());
      const channel = String(r.channel ?? 'EMAIL');
      const ev = num(r.estimatedValue);
      const { score, drivers } = scoreLead({ stage, estimatedValue: ev, createdAt, channel }, maxValue);
      const ageDays = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400000));
      return {
        id: String(r.id), name: String(r.name ?? 'Lead'), phone: String(r.phone ?? ''), email: r.email ? String(r.email) : undefined,
        channel, service: String(r.service ?? ''), stage, source: String(r.source ?? 'Unknown'), estimatedValue: ev,
        createdAt, ageDays, owner: String(r.owner ?? 'Unassigned'), branchId: String(r.branchId ?? ''),
        score, scoreDrivers: drivers,
        nextBestAction: NBA[stage], bestChannel: channel, bestTime: ageDays <= 1 ? 'Planning assumption: prompt review now' : 'Planning assumption: review during staffed hours',
        consent: consentFromCanonicalEvidence(consents, { leadId: String(r.id) }),
        isPatient: false,
      };
    });
  },

  // [LIVE] GET /v1/patients
  async getPatients(): Promise<CrmPatient[]> {
    const [res, consents] = await Promise.all([
      apiRequest<{ data: Array<Record<string, unknown>> }>('/v1/patients?limit=100'),
      apiRequest<CommunicationConsentRow[]>('/v1/crm/consent'),
    ]);
    return (res.data ?? []).map(p => {
      const tags = (p.tags as string[]) ?? [];
      const lifecycle = String(p.lifecycleStage ?? 'ACTIVE');
      return {
        id: String(p.id), name: `${String(p.firstName ?? '')} ${String(p.lastName ?? '')}`.trim(),
        email: p.email ? String(p.email) : undefined, phone: p.phone ? String(p.phone) : undefined,
        lifecycleStage: lifecycle, churnRisk: num(p.churnRisk), lifetimeValue: num(p.lifetimeValue),
        lastVisit: (p.lastVisitAt as string) ?? null, nextVisit: (p.nextVisitAt as string) ?? null,
        tags, consent: consentFromCanonicalEvidence(consents, { patientId: String(p.id) }),
      };
    });
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

  // Derived metrics. inactiveRecoverable is an explicitly unvalidated 30% planning assumption.
  commandMetrics(leads: CrmLead[], patients: CrmPatient[], campaignRoi: number | null): CommandMetrics {
    const open = leads.filter(l => l.stage !== 'lost' && l.stage !== 'retained');
    const won = leads.filter(l => l.stage === 'retained').length;
    const lost = leads.filter(l => l.stage === 'lost').length;
    const hot = open.filter(l => l.score >= 70);
    const inactive = patients.filter(p => ['INACTIVE', 'AT_RISK', 'LOST'].includes(p.lifecycleStage));
    return {
      openPipeline: open.reduce((s, l) => s + l.estimatedValue, 0),
      hotLeads: hot.length,
      winRate: won + lost > 0 ? Math.round((won / (won + lost)) * 100) : 0,
      avgDeal: open.length ? Math.round(open.reduce((s, l) => s + l.estimatedValue, 0) / open.length) : 0,
      avgChurnRisk: patients.length ? Math.round(patients.reduce((s, p) => s + p.churnRisk, 0) / patients.length) : 0,
      avgLtv: patients.length ? Math.round(patients.reduce((s, p) => s + p.lifetimeValue, 0) / patients.length) : 0,
      missedCallValue: leads.filter(l => l.channel.toLowerCase() === 'call' && l.stage === 'new-inquiry').reduce((s, l) => s + l.estimatedValue, 0),
      inactiveRecoverable: inactive.reduce((s, p) => s + Math.round(p.lifetimeValue * 0.3), 0),
      campaignRoi,
    };
  },

  smartSegments(patients: CrmPatient[]): SmartSegment[] {
    const daysSince = (d: string | null) => d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : 9999;
    const recoverable = (ps: CrmPatient[]) => ps.reduce((s, p) => s + Math.round(p.lifetimeValue * 0.3), 0);
    const defs: Array<{ id: string; label: string; description: string; filter: (p: CrmPatient) => boolean; offer: string; channel: string; rate: number }> = [
      { id: 'inactive-30-60', label: '30–60 days inactive', description: 'Patients quiet 30–60 days', filter: p => { const d = daysSince(p.lastVisit); return d >= 30 && d < 60; }, offer: 'Gentle check-in + booking link', channel: 'SMS', rate: 18 },
      { id: 'inactive-60-90', label: '60–90 days inactive', description: 'Patients quiet 60–90 days', filter: p => { const d = daysSince(p.lastVisit); return d >= 60 && d < 90; }, offer: 'Recall reminder + small incentive', channel: 'Email', rate: 14 },
      { id: 'inactive-90-180', label: '90–180 days inactive', description: 'Reactivation candidates', filter: p => { const d = daysSince(p.lastVisit); return d >= 90 && d < 180; }, offer: 'Winback offer', channel: 'WhatsApp', rate: 11 },
      { id: 'high-ltv-inactive', label: 'High-LTV inactive', description: 'Valuable patients gone quiet', filter: p => p.lifetimeValue >= 4000 && daysSince(p.lastVisit) >= 45, offer: 'Personal outreach from care team', channel: 'Voice', rate: 26 },
      { id: 'at-risk', label: 'Patients at risk', description: 'High churn-risk patients', filter: p => p.churnRisk >= 50, offer: 'Retention outreach + next-visit booking', channel: 'SMS', rate: 20 },
      { id: 'winback-tagged', label: 'Reactivation candidates', description: 'Tagged for winback', filter: p => p.tags.map(t => t.toLowerCase()).includes('winback'), offer: 'Limited-time winback', channel: 'WhatsApp', rate: 12 },
    ];
    return defs.map(d => {
      // Candidate membership is not contact eligibility. Campaign preview/dispatch
      // must re-check canonical consent and suppression evidence.
      const ps = patients.filter(p => d.filter(p));
      return {
        id: d.id, label: d.label, description: d.description, patientCount: ps.length, recoverableValue: recoverable(ps),
        planningChannel: d.channel, planningOffer: d.offer, planningBookingRate: d.rate,
        planningCost: ps.length * (d.channel === 'Email' ? 0 : d.channel === 'Voice' ? 3 : 1),
        assumptionNotice: 'Unvalidated planning assumptions only; not a forecast or consent decision.',
      };
    }).filter(s => s.patientCount > 0);
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
