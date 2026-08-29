// ===========================================================================
// FROZEN TRANSCRIPTION of the browser-side Growth arithmetic, exactly as
// src/lib/crmService.ts:84-209 ran it before it was deleted.
//
// This file is evidence, not product code. Two claims depend on it:
//
//   1. For a tenant under the 100-row page cap, `GET /v1/growth/metrics`,
//      `/v1/growth/leads` and `/v1/growth/segments/preview` return the SAME
//      numbers this did — the seeded configuration reproduces today's constants,
//      so moving the computation to the server changed nothing observable.
//   2. For a tenant over the cap, this and the server DISAGREE, and this is the
//      one that is wrong. That difference is the defect being fixed.
//
// Do not "improve" anything here. Its only value is being a faithful copy of
// what shipped. Every line below is the deleted source, verbatim apart from the
// types it needs to stand alone.
// ===========================================================================

export type LegacyStage = 'new-inquiry' | 'contacted' | 'booked' | 'visited' | 'follow-up' | 'retained' | 'lost';

export const LEGACY_STAGE_LABEL: Record<LegacyStage, string> = {
  'new-inquiry': 'New Inquiry', contacted: 'Contacted', booked: 'Booked', visited: 'Visited',
  'follow-up': 'Follow-up', retained: 'Retained', lost: 'Lost',
};

const STAGE_INTENT: Record<LegacyStage, number> = {
  'new-inquiry': 20, contacted: 40, booked: 70, visited: 80, 'follow-up': 55, retained: 90, lost: 0,
};

export type LegacyDriver = { label: string; positive: boolean; weight: number };

export type LegacyLead = {
  id: string; stage: LegacyStage; estimatedValue: number; createdAt: string; channel: string;
  score: number; scoreDrivers: LegacyDriver[]; nextBestAction: { label: string; cta: string };
};

export type LegacyPatient = {
  id: string; churnRisk: number; lifetimeValue: number; lastVisit: string | null;
  lifecycleStage: string; tags: string[];
};

export const num = (v: unknown): number =>
  typeof v === 'string' ? Number(v) || 0 : typeof v === 'number' ? v : 0;

/** src/lib/crmService.ts:85-97 */
export function legacyScoreLead(
  lead: { stage: LegacyStage; estimatedValue: number; createdAt: string; channel: string },
  maxValue: number,
): { score: number; drivers: LegacyDriver[] } {
  const drivers: LegacyDriver[] = [];
  const intent = STAGE_INTENT[lead.stage];
  drivers.push({ label: `Pipeline stage: ${LEGACY_STAGE_LABEL[lead.stage]}`, positive: intent >= 40, weight: Math.round(intent * 0.4) });
  const valueScore = maxValue > 0 ? Math.round((lead.estimatedValue / maxValue) * 30) : 0;
  drivers.push({ label: `Estimated value ${lead.estimatedValue}`, positive: valueScore >= 12, weight: valueScore });
  const ageDays = Math.max(0, Math.floor((Date.now() - new Date(lead.createdAt).getTime()) / 86400000));
  const recency = ageDays <= 2 ? 20 : ageDays <= 7 ? 12 : ageDays <= 30 ? 4 : 0;
  drivers.push({ label: ageDays <= 2 ? 'Fresh inquiry (< 48h)' : `Inquiry age ${ageDays}d`, positive: recency >= 12, weight: recency });
  if (['whatsapp', 'sms'].includes(lead.channel.toLowerCase())) drivers.push({ label: `Reachable channel (${lead.channel})`, positive: true, weight: 8 });
  const score = Math.max(0, Math.min(100, Math.round(intent * 0.4 + valueScore + recency + (['whatsapp', 'sms'].includes(lead.channel.toLowerCase()) ? 8 : 0))));
  return { score, drivers };
}

/** src/lib/crmService.ts:99-107 */
export const LEGACY_NBA: Record<LegacyStage, { label: string; cta: string }> = {
  'new-inquiry': { label: 'Call now & send booking link', cta: 'call_now' },
  contacted: { label: 'Send booking link', cta: 'send_booking_link' },
  booked: { label: 'Send intake form + deposit link', cta: 'send_intake_form' },
  visited: { label: 'Send follow-up to rebook', cta: 'send_follow_up' },
  'follow-up': { label: 'Confirm next visit', cta: 'confirm_visit' },
  retained: { label: 'Nurture & request review', cta: 'mark_retained' },
  lost: { label: 'Launch winback', cta: 'launch_winback' },
};

/**
 * src/lib/crmService.ts:111-133 — the browser's adapter, including the
 * page-local `maxValue` on line 116 that made a lead's score depend on which
 * other leads happened to load beside it.
 */
export function legacyAdaptLeads(rows: Array<Record<string, unknown>>): LegacyLead[] {
  const maxValue = Math.max(1, ...rows.map(r => num(r.estimatedValue)));
  return rows.map(r => {
    const stage = String(r.stage ?? 'new-inquiry') as LegacyStage;
    const createdAt = String(r.createdAt ?? new Date().toISOString());
    const channel = String(r.channel ?? 'EMAIL');
    const estimatedValue = num(r.estimatedValue);
    const { score, drivers } = legacyScoreLead({ stage, estimatedValue, createdAt, channel }, maxValue);
    return {
      id: String(r.id), stage, estimatedValue, createdAt, channel,
      score, scoreDrivers: drivers, nextBestAction: LEGACY_NBA[stage],
    };
  });
}

/** src/lib/crmService.ts:142-152 */
export function legacyAdaptPatients(rows: Array<Record<string, unknown>>): LegacyPatient[] {
  return rows.map(p => ({
    id: String(p.id),
    lifecycleStage: String(p.lifecycleStage ?? 'ACTIVE'),
    churnRisk: num(p.churnRisk),
    lifetimeValue: num(p.lifetimeValue),
    lastVisit: (p.lastVisitAt as string) ?? null,
    tags: (p.tags as string[]) ?? [],
  }));
}

export type LegacyMetrics = {
  openPipeline: number; hotLeads: number; winRate: number; avgDeal: number;
  avgChurnRisk: number; avgLtv: number; missedCallValue: number; inactiveRecoverable: number;
};

/** src/lib/crmService.ts:168-185 */
export function legacyCommandMetrics(leads: LegacyLead[], patients: LegacyPatient[]): LegacyMetrics {
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
  };
}

export type LegacySegment = {
  id: string; label: string; description: string;
  patientCount: number; recoverableValue: number; planningCost: number;
  planningChannel: string; planningOffer: string; planningBookingRate: number;
};

/**
 * src/lib/crmService.ts:187-209 — including the `9999` sentinel on line 188.
 *
 * ONE declared deviation: the original ended with `.filter(s => s.patientCount > 0)`,
 * which dropped empty groups before they reached the screen. That filter is a
 * presentation choice, not arithmetic, and keeping it here would make an empty
 * group indistinguishable from a missing one when the two implementations are
 * compared key by key. The caller applies it where the comparison needs it.
 */
export function legacySmartSegments(patients: LegacyPatient[]): LegacySegment[] {
  const daysSince = (d: string | null) => d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : 9999;
  const recoverable = (ps: LegacyPatient[]) => ps.reduce((s, p) => s + Math.round(p.lifetimeValue * 0.3), 0);
  const defs: Array<{ id: string; label: string; description: string; filter: (p: LegacyPatient) => boolean; offer: string; channel: string; rate: number }> = [
    { id: 'inactive-30-60', label: '30–60 days inactive', description: 'Patients quiet 30–60 days', filter: p => { const d = daysSince(p.lastVisit); return d >= 30 && d < 60; }, offer: 'Gentle check-in + booking link', channel: 'SMS', rate: 18 },
    { id: 'inactive-60-90', label: '60–90 days inactive', description: 'Patients quiet 60–90 days', filter: p => { const d = daysSince(p.lastVisit); return d >= 60 && d < 90; }, offer: 'Recall reminder + small incentive', channel: 'Email', rate: 14 },
    { id: 'inactive-90-180', label: '90–180 days inactive', description: 'Reactivation candidates', filter: p => { const d = daysSince(p.lastVisit); return d >= 90 && d < 180; }, offer: 'Winback offer', channel: 'WhatsApp', rate: 11 },
    { id: 'high-ltv-inactive', label: 'High-LTV inactive', description: 'Valuable patients gone quiet', filter: p => p.lifetimeValue >= 4000 && daysSince(p.lastVisit) >= 45, offer: 'Personal outreach from care team', channel: 'Voice', rate: 26 },
    { id: 'at-risk', label: 'Patients at risk', description: 'High churn-risk patients', filter: p => p.churnRisk >= 50, offer: 'Retention outreach + next-visit booking', channel: 'SMS', rate: 20 },
    { id: 'winback-tagged', label: 'Reactivation candidates', description: 'Tagged for winback', filter: p => p.tags.map(t => t.toLowerCase()).includes('winback'), offer: 'Limited-time winback', channel: 'WhatsApp', rate: 12 },
  ];
  return defs.map(d => {
    const ps = patients.filter(p => d.filter(p));
    return {
      id: d.id, label: d.label, description: d.description,
      patientCount: ps.length, recoverableValue: recoverable(ps),
      planningChannel: d.channel, planningOffer: d.offer, planningBookingRate: d.rate,
      planningCost: ps.length * (d.channel === 'Email' ? 0 : d.channel === 'Voice' ? 3 : 1),
    };
  });
}
