import { db } from './db';
import { env } from '../config/env';

// ===========================================================================
// CRM Campaign / Reactivation engine helpers. Deterministic, tenant-scoped
// audience generation; consent + suppression gating; rule-based message drafts;
// truthful provider status (never fakes delivery). No PHI in logs/payloads —
// destinations are masked. No clinical advice in any template.
// ===========================================================================

export const CAMPAIGN_TYPES = [
  'appointment_reminder', 'appointment_confirmation', 'no_show_recovery', 'unpaid_deposit_followup',
  'failed_payment_recovery', 'insurance_update_request', 'prior_auth_followup',
  'inactive_patient_reactivation', 'missed_call_recovery', 'appointment_request_followup',
  'review_request', 'custom',
] as const;
export type CampaignType = typeof CAMPAIGN_TYPES[number];

export const AUDIENCE_TYPES = [
  'inactive_patients', 'no_show_recovery', 'unpaid_deposit_followup', 'failed_payment_recovery',
  'insurance_update_request', 'appointment_request_followup', 'review_request',
] as const;
export type AudienceType = typeof AUDIENCE_TYPES[number];

// Audiences that are intentionally STAFF-facing (never patient-blaming outreach).
export const STAFF_FACING_AUDIENCES = new Set(['prior_auth_followup']);

export type CommChannel = 'sms' | 'email' | 'voice' | 'whatsapp';
const INACTIVE_DAYS_DEFAULT = 180;

export function maskDestination(value?: string | null): string | null {
  if (!value) return null;
  const v = value.trim();
  if (v.includes('@')) { const [u, d] = v.split('@'); return `${u.slice(0, 2)}***@${d ?? ''}`; }
  return v.length <= 4 ? '****' : `***${v.slice(-4)}`;
}

function channelField(channel: CommChannel): 'phone' | 'email' {
  return channel === 'email' ? 'email' : 'phone';
}

// --- Provider configuration status (truthful; never fakes a send) ----------
export interface ChannelStatus { channel: CommChannel; provider: string; configured: boolean; mock: boolean; setupRequired: boolean; missing: string[] }

export function channelStatus(channel: CommChannel): ChannelStatus {
  if (channel === 'sms' || channel === 'whatsapp') {
    const missing = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'].filter(k => !env[k as keyof typeof env]);
    const configured = missing.length === 0;
    return { channel, provider: 'twilio', configured, mock: (env.TWILIO_ACCOUNT_SID ?? '').startsWith('mock'), setupRequired: !configured, missing };
  }
  if (channel === 'email') {
    const missing = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'].filter(k => !env[k as keyof typeof env]);
    const configured = missing.length === 0;
    return { channel, provider: 'smtp', configured, mock: (env.SMTP_HOST ?? '').startsWith('mock'), setupRequired: !configured, missing };
  }
  // voice reuses the Retell receptionist configuration.
  const missing = ['RETELL_API_KEY', 'RETELL_FROM_NUMBER'].filter(k => !env[k as keyof typeof env]);
  const configured = missing.length === 0;
  return { channel, provider: 'retell', configured, mock: (env.RETELL_API_KEY ?? '').startsWith('mock'), setupRequired: !configured, missing };
}

// Delivery status for one recipient given suppression, contact info, provider.
export type DeliveryStatus = 'sent' | 'skipped' | 'failed' | 'setup_required' | 'suppressed' | 'pending';

export function resolveDeliveryStatus(opts: { suppressed: boolean; hasContact: boolean; status: ChannelStatus }): DeliveryStatus {
  if (opts.suppressed) return 'suppressed';
  if (!opts.hasContact) return 'skipped';
  if (opts.status.setupRequired) return 'setup_required';
  // Mock provider (dev/test): a real, clearly-mock "send". Never in production.
  if (opts.status.mock && env.NODE_ENV !== 'production') return 'sent';
  // Real provider configured but no concrete sender wired yet — queue, never fake.
  return 'pending';
}

// --- Consent + suppression gating ------------------------------------------
export async function isSuppressed(tenantId: string, target: { patientId?: string | null; leadId?: string | null }, channel: CommChannel): Promise<boolean> {
  const where = { tenantId, patientId: target.patientId ?? null, leadId: target.leadId ?? null };
  const [optedOut, suppressed] = await Promise.all([
    db.communicationConsent.count({ where: { ...where, channel, status: 'opted_out' } }),
    db.campaignSuppression.count({ where: { ...where, channel, active: true } }),
  ]);
  return optedOut > 0 || suppressed > 0;
}

// --- Audience candidates ---------------------------------------------------
export interface AudienceCandidate { patientId: string | null; leadId: string | null; name: string; email: string | null; phone: string | null; reason: string }

export async function buildAudience(tenantId: string, audienceType: AudienceType, opts: { inactiveDays?: number } = {}): Promise<AudienceCandidate[]> {
  const now = Date.now();
  switch (audienceType) {
    case 'inactive_patients': {
      const cutoff = new Date(now - (opts.inactiveDays ?? INACTIVE_DAYS_DEFAULT) * 86400000);
      const rows = await db.patient.findMany({
        where: { tenantId, deletedAt: null, lifecycleStage: { not: 'LOST' }, OR: [{ lastVisitAt: { lt: cutoff } }, { lastVisitAt: null, createdAt: { lt: cutoff } }] },
        select: { id: true, firstName: true, lastName: true, email: true, phone: true }, take: 500,
      });
      return rows.map(p => ({ patientId: p.id, leadId: null, name: `${p.firstName} ${p.lastName}`, email: p.email, phone: p.phone, reason: 'No recent visit' }));
    }
    case 'no_show_recovery': {
      const appts = await db.appointment.findMany({ where: { tenantId, status: 'NO_SHOW', deletedAt: null }, select: { patientId: true, patient: { select: { firstName: true, lastName: true, email: true, phone: true } } }, orderBy: { startsAt: 'desc' }, take: 500 });
      const seen = new Set<string>();
      const out: AudienceCandidate[] = [];
      for (const a of appts) { if (seen.has(a.patientId)) continue; seen.add(a.patientId); out.push({ patientId: a.patientId, leadId: null, name: `${a.patient.firstName} ${a.patient.lastName}`, email: a.patient.email, phone: a.patient.phone, reason: 'Missed appointment' }); }
      return out;
    }
    case 'unpaid_deposit_followup': {
      const reqs = await db.depositRequirement.findMany({ where: { tenantId, status: { in: ['required', 'requested', 'link_sent'] }, patientId: { not: null } }, select: { patientId: true, patient: { select: { firstName: true, lastName: true, email: true, phone: true } } }, take: 500 });
      const seen = new Set<string>();
      const out: AudienceCandidate[] = [];
      for (const r of reqs) { if (!r.patientId || seen.has(r.patientId)) continue; seen.add(r.patientId); out.push({ patientId: r.patientId, leadId: null, name: r.patient ? `${r.patient.firstName} ${r.patient.lastName}` : 'Patient', email: r.patient?.email ?? null, phone: r.patient?.phone ?? null, reason: 'Unpaid deposit' }); }
      return out;
    }
    case 'failed_payment_recovery': {
      const prs = await db.paymentRequest.findMany({ where: { tenantId, status: { in: ['failed', 'expired'] }, patientId: { not: null } }, select: { patientId: true, patient: { select: { firstName: true, lastName: true, email: true, phone: true } } }, orderBy: { createdAt: 'desc' }, take: 500 });
      const seen = new Set<string>();
      const out: AudienceCandidate[] = [];
      for (const r of prs) { if (!r.patientId || seen.has(r.patientId)) continue; seen.add(r.patientId); out.push({ patientId: r.patientId, leadId: null, name: r.patient ? `${r.patient.firstName} ${r.patient.lastName}` : 'Patient', email: r.patient?.email ?? null, phone: r.patient?.phone ?? null, reason: 'Failed/expired payment' }); }
      return out;
    }
    case 'insurance_update_request': {
      // Patient-facing "please update your insurance" — uses ineligible checks.
      const vers = await db.eligibilityVerification.findMany({ where: { tenantId, coverageActive: false }, select: { patientId: true, patient: { select: { firstName: true, lastName: true, email: true, phone: true } } }, orderBy: { checkedAt: 'desc' }, take: 500 });
      const seen = new Set<string>();
      const out: AudienceCandidate[] = [];
      for (const v of vers) { if (seen.has(v.patientId)) continue; seen.add(v.patientId); out.push({ patientId: v.patientId, leadId: null, name: `${v.patient.firstName} ${v.patient.lastName}`, email: v.patient.email, phone: v.patient.phone, reason: 'Insurance needs update' }); }
      return out;
    }
    case 'appointment_request_followup': {
      const reqs = await db.appointmentRequest.findMany({ where: { tenantId, status: { in: ['PENDING_REVIEW', 'MISSING_INFO'] } }, select: { id: true, patientId: true, leadId: true, collectedName: true, collectedPhone: true, collectedEmail: true, patient: { select: { firstName: true, lastName: true, email: true, phone: true } } }, take: 500 });
      return reqs.map(r => ({ patientId: r.patientId, leadId: r.leadId, name: r.patient ? `${r.patient.firstName} ${r.patient.lastName}` : (r.collectedName ?? 'Lead'), email: r.patient?.email ?? r.collectedEmail, phone: r.patient?.phone ?? r.collectedPhone, reason: 'Pending appointment request' }));
    }
    case 'review_request': {
      const appts = await db.appointment.findMany({ where: { tenantId, status: 'COMPLETED', deletedAt: null }, select: { patientId: true, patient: { select: { firstName: true, lastName: true, email: true, phone: true } } }, orderBy: { startsAt: 'desc' }, take: 500 });
      const seen = new Set<string>();
      const out: AudienceCandidate[] = [];
      for (const a of appts) { if (seen.has(a.patientId)) continue; seen.add(a.patientId); out.push({ patientId: a.patientId, leadId: null, name: `${a.patient.firstName} ${a.patient.lastName}`, email: a.patient.email, phone: a.patient.phone, reason: 'Completed visit' }); }
      return out;
    }
    default:
      return [];
  }
}

// Preview: deterministic counts after consent/suppression + contact gating.
export interface AudiencePreview { audienceType: AudienceType; channel: CommChannel; total: number; eligible: number; suppressed: number; missingContact: number; sample: Array<{ name: string; reason: string; destinationMasked: string | null }> }

export async function previewAudience(tenantId: string, audienceType: AudienceType, channel: CommChannel): Promise<AudiencePreview> {
  const candidates = await buildAudience(tenantId, audienceType);
  let eligible = 0, suppressed = 0, missingContact = 0;
  const sample: AudiencePreview['sample'] = [];
  const field = channelField(channel);
  for (const c of candidates) {
    const contact = field === 'email' ? c.email : c.phone;
    if (!contact) { missingContact++; continue; }
    if (await isSuppressed(tenantId, c, channel)) { suppressed++; continue; }
    eligible++;
    if (sample.length < 5) sample.push({ name: c.name, reason: c.reason, destinationMasked: maskDestination(contact) });
  }
  return { audienceType, channel, total: candidates.length, eligible, suppressed, missingContact, sample };
}

// --- Rule-based message drafts (no LLM; no clinical advice) -----------------
export interface CampaignDraft { subject: string; body: string; channel: CommChannel; reason: string; draftSource: 'rule_based' | 'ai'; requiresApproval: true; warnings: string[]; sourceSummary: string }

const TEMPLATES: Record<string, { subject: string; body: string }> = {
  appointment_reminder: { subject: 'Appointment reminder', body: 'Hi {{firstName}}, this is a reminder of your upcoming appointment at {{clinicName}}. Reply or call us to confirm or reschedule.' },
  appointment_confirmation: { subject: 'Please confirm your appointment', body: 'Hi {{firstName}}, please confirm your upcoming appointment at {{clinicName}}. Reply or call us to confirm, or to reschedule if needed.' },
  no_show_recovery: { subject: 'We missed you', body: 'Hi {{firstName}}, we missed you at your recent appointment with {{clinicName}}. We’d love to help you rebook at a time that works for you.' },
  unpaid_deposit_followup: { subject: 'Complete your booking', body: 'Hi {{firstName}}, your appointment with {{clinicName}} has an outstanding deposit. You can complete payment using the secure link our team will share.' },
  failed_payment_recovery: { subject: 'Payment didn’t go through', body: 'Hi {{firstName}}, a recent payment for your visit with {{clinicName}} didn’t complete. Our team can share a fresh secure payment link whenever you’re ready.' },
  insurance_update_request: { subject: 'Update your insurance', body: 'Hi {{firstName}}, to keep your records current, please share your latest insurance information with {{clinicName}} before your next visit.' },
  inactive_patient_reactivation: { subject: 'We’d love to see you again', body: 'Hi {{firstName}}, it’s been a while since your last visit to {{clinicName}}. Reach out whenever you’d like to schedule a visit.' },
  missed_call_recovery: { subject: 'Sorry we missed your call', body: 'Hi {{firstName}}, we saw we missed your call to {{clinicName}}. Let us know how we can help or when you’d like to book.' },
  appointment_request_followup: { subject: 'Let’s finish booking', body: 'Hi {{firstName}}, thanks for your appointment request with {{clinicName}}. Our team will follow up to confirm the details.' },
  review_request: { subject: 'How was your visit?', body: 'Hi {{firstName}}, thank you for visiting {{clinicName}}. We’d appreciate your feedback when you have a moment.' },
  custom: { subject: 'A message from {{clinicName}}', body: 'Hi {{firstName}}, {{clinicName}} would like to get in touch.' },
};

export function generateDraft(campaignType: CampaignType, channel: CommChannel, audienceType: AudienceType): CampaignDraft {
  const tpl = TEMPLATES[campaignType] ?? TEMPLATES.custom;
  const warnings: string[] = [];
  if (STAFF_FACING_AUDIENCES.has(audienceType)) warnings.push('This audience is staff-facing; route to staff review rather than patient outreach.');
  warnings.push('Rule-based draft — review before approval. No clinical advice; do not add diagnosis or treatment instructions.');
  return {
    subject: tpl.subject, body: tpl.body, channel, reason: `${campaignType} via ${channel}`,
    draftSource: 'rule_based', requiresApproval: true, warnings,
    sourceSummary: `Generated from the ${campaignType} template for the ${audienceType} audience (rule-based, no PHI).`,
  };
}
