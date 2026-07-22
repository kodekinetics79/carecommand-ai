import { db } from './db';
import { env } from '../config/env';
import { runWithTenantContext } from './tenantContext';
import type { ReceptionistOptOutChannel } from '../generated/prisma/client';

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

// Per-channel provider mode (truthful — never claims live without a real sender).
export type ProviderMode = 'unconfigured' | 'mock_dev' | 'configured_pending_provider' | 'live_supported';

export function providerModeFor(channel: CommChannel): ProviderMode {
  const s = channelStatus(channel);
  if (!s.configured) return 'unconfigured';
  if (s.mock && env.NODE_ENV !== 'production') return 'mock_dev';
  // SMS/WhatsApp have a real Twilio sender wired; email is live only with an HTTP
  // email API; voice campaign sending is not wired (Retell is receptionist-only).
  if (channel === 'sms' || channel === 'whatsapp') return 'live_supported';
  if (channel === 'email') return env.EMAIL_HTTP_API_URL ? 'live_supported' : 'configured_pending_provider';
  return 'configured_pending_provider';
}

// Structured communications readiness (no secret values; env key NAMES only).
export interface ProviderReadiness {
  smsConfigured: boolean;
  emailConfigured: boolean;
  voiceConfigured: boolean;
  providerMode: Record<CommChannel, ProviderMode>;
  missingEnvKeys: string[];
  supportedChannels: CommChannel[];
  unsupportedChannels: CommChannel[];
  schedulerEnforced: boolean;
  liveSendingSupported: boolean;
}

export function providerReadiness(): ProviderReadiness {
  const channels: CommChannel[] = ['sms', 'email', 'voice', 'whatsapp'];
  const statuses = Object.fromEntries(channels.map(c => [c, channelStatus(c)])) as Record<CommChannel, ChannelStatus>;
  const modes = Object.fromEntries(channels.map(c => [c, providerModeFor(c)])) as Record<CommChannel, ProviderMode>;
  const missingEnvKeys = [...new Set(channels.flatMap(c => statuses[c].missing))];
  // "Supported" = can produce a real (mock_dev) or queued delivery; never a
  // live-sent claim, since no concrete provider sender is wired.
  const supportedChannels = channels.filter(c => modes[c] === 'mock_dev' || modes[c] === 'configured_pending_provider' || modes[c] === 'live_supported');
  return {
    smsConfigured: statuses.sms.configured,
    emailConfigured: statuses.email.configured,
    voiceConfigured: statuses.voice.configured,
    providerMode: modes,
    missingEnvKeys,
    supportedChannels,
    unsupportedChannels: channels.filter(c => !supportedChannels.includes(c)),
    schedulerEnforced: true,   // approved SCHEDULED campaigns run via the campaign-scheduler worker
    liveSendingSupported: true, // real Twilio SMS (+ optional HTTP email) senders are wired
  };
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
// Legacy ConsentEvent (patient-level, purpose-based) maps safely to a channel
// only for SMS/EMAIL/WHATSAPP. Voice and cross-channel MARKETING are NOT mapped
// (ambiguous) and remain a carry-forward for the Patient Intake + Consent Engine.
const CONSENT_PURPOSE: Record<CommChannel, 'SMS' | 'EMAIL' | 'WHATSAPP' | null> = {
  sms: 'SMS', email: 'EMAIL', whatsapp: 'WHATSAPP', voice: null,
};

// --- Destination normalization + validation (E.164 / email) ----------------
// Shared by the send-time gate in commsProvider.sendMessage so every send path
// validates the destination before a provider call and matches opt-out rows
// (which may be stored in a different phone format) reliably.
export function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';
  return hasPlus ? `+${digits}` : digits;
}

// Best-effort E.164 coercion. Keeps an existing '+'; assumes NANP for a bare
// 10-digit number and a leading '1' for 11 digits. Never invents a country code
// for other lengths — isValidE164 then rejects anything still malformed.
export function toE164(raw: string | null | undefined, defaultCountry = '1'): string {
  const n = normalizePhone(raw);
  if (!n) return '';
  if (n.startsWith('+')) return n;
  if (n.length === 10) return `+${defaultCountry}${n}`;
  if (n.length === 11 && n.startsWith('1')) return `+${n}`;
  return `+${n}`;
}

export function isValidE164(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((email ?? '').trim());
}

function phoneDigits(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '');
}

// Two numbers match if their full digit strings are equal, or their last 10
// digits are equal (handles a stored '+1 555…' vs a bare 10-digit destination).
// Safe because the comparison is already tenant-scoped by the caller.
function phonesEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = phoneDigits(a);
  const db_ = phoneDigits(b);
  if (!da || !db_) return false;
  if (da === db_) return true;
  const la = da.slice(-10);
  const lb = db_.slice(-10);
  return la.length === 10 && la === lb;
}

// A comm channel maps to the ReceptionistOptOut channels that suppress it.
// ALL suppresses everything; SMS/WHATSAPP -> SMS; EMAIL -> EMAIL; VOICE -> VOICE.
const RECEPTIONIST_OPTOUT_CHANNELS: Record<CommChannel, ReceptionistOptOutChannel[]> = {
  sms: ['ALL', 'SMS'], whatsapp: ['ALL', 'SMS'], email: ['ALL', 'EMAIL'], voice: ['ALL', 'VOICE'],
};

// Cross-module suppression: honor an opt-out captured during an AI receptionist
// call (ReceptionistOptOut, written by the Retell webhook, channel ALL by
// default). Matched on the destination (phone/email), tenant-scoped. This is the
// bridge that makes a receptionist opt-out suppress SMS/CRM sends too.
export async function isDestinationOptedOut(tenantId: string, destination: string | null | undefined, channel: CommChannel): Promise<boolean> {
  const value = (destination ?? '').trim();
  if (!value) return false;
  const isEmail = value.includes('@');
  const channels = RECEPTIONIST_OPTOUT_CHANNELS[channel];
  const rows = await db.receptionistOptOut.findMany({
    where: { tenantId, channel: { in: channels }, ...(isEmail ? { contactEmail: { not: null } } : { contactPhone: { not: null } }) },
    select: { contactPhone: true, contactEmail: true },
  });
  if (isEmail) {
    const target = value.toLowerCase();
    return rows.some(r => (r.contactEmail ?? '').trim().toLowerCase() === target);
  }
  return rows.some(r => phonesEqual(r.contactPhone, value));
}

export async function isSuppressed(tenantId: string, target: { patientId?: string | null; leadId?: string | null; destination?: string | null }, channel: CommChannel): Promise<boolean> {
  // ConsentEvent is RLS-enrolled, so the consent reads run inside a tenant
  // transaction (GUC set on the same connection). Without it the legacy
  // ConsentEvent opt-out check would silently see zero rows under app_rls and
  // fail OPEN (a real opt-out would be missed). CommunicationConsent /
  // CampaignSuppression are not enrolled but are read here for a single context.
  const identitySuppressed = await runWithTenantContext(tenantId, async tx => {
    const where = { tenantId, patientId: target.patientId ?? null, leadId: target.leadId ?? null };
    const [optedOut, suppressed] = await Promise.all([
      tx.communicationConsent.count({ where: { ...where, channel, status: 'opted_out' } }),
      tx.campaignSuppression.count({ where: { ...where, channel, active: true } }),
    ]);
    if (optedOut > 0 || suppressed > 0) return true;

    // Honor an explicit legacy ConsentEvent opt-out (latest event per purpose).
    // Never fabricates opt-in — only an explicit granted=false suppresses.
    // A MARKETING opt-out suppresses ALL channels (cross-channel marketing consent);
    // SMS/EMAIL/WHATSAPP opt-outs suppress their mapped channel.
    if (target.patientId) {
      const purpose = CONSENT_PURPOSE[channel];
      const purposes = purpose ? [purpose, 'MARKETING' as const] : ['MARKETING' as const];
      const events = await tx.consentEvent.findMany({ where: { tenantId, patientId: target.patientId, purpose: { in: purposes } }, orderBy: { occurredAt: 'desc' } });
      const seen = new Set<string>();
      for (const e of events) {
        if (seen.has(e.purpose)) continue; // latest per purpose only
        seen.add(e.purpose);
        if (e.granted === false) return true;
      }
    }
    return false;
  });
  if (identitySuppressed) return true;

  // Cross-module: a receptionist-call opt-out (destination-keyed) suppresses too.
  // ReceptionistOptOut is not RLS-enrolled, so it is read on the global client.
  if (target.destination && await isDestinationOptedOut(tenantId, target.destination, channel)) return true;

  return false;
}

// --- Audience candidates ---------------------------------------------------
export interface AudienceCandidate { patientId: string | null; leadId: string | null; name: string; email: string | null; phone: string | null; reason: string }

export async function buildAudience(tenantId: string, audienceType: AudienceType, opts: { inactiveDays?: number } = {}): Promise<AudienceCandidate[]> {
  const now = Date.now();
  // Audience sources read RLS-enrolled PHI tables (Patient, Appointment,
  // PaymentRequest, DepositRequirement, EligibilityVerification). Run inside a
  // tenant transaction so app.current_tenant_id is set on the SAME connection —
  // otherwise, under the enforced app_rls role, these reads fail-closed to ZERO
  // rows and every campaign would silently target nobody.
  return runWithTenantContext(tenantId, async tx => {
    switch (audienceType) {
      case 'inactive_patients': {
        const cutoff = new Date(now - (opts.inactiveDays ?? INACTIVE_DAYS_DEFAULT) * 86400000);
        const rows = await tx.patient.findMany({
          where: { tenantId, deletedAt: null, lifecycleStage: { not: 'LOST' }, OR: [{ lastVisitAt: { lt: cutoff } }, { lastVisitAt: null, createdAt: { lt: cutoff } }] },
          select: { id: true, firstName: true, lastName: true, email: true, phone: true }, take: 500,
        });
        return rows.map(p => ({ patientId: p.id, leadId: null, name: `${p.firstName} ${p.lastName}`, email: p.email, phone: p.phone, reason: 'No recent visit' }));
      }
      case 'no_show_recovery': {
        const appts = await tx.appointment.findMany({ where: { tenantId, status: 'NO_SHOW', deletedAt: null }, select: { patientId: true, patient: { select: { firstName: true, lastName: true, email: true, phone: true } } }, orderBy: { startsAt: 'desc' }, take: 500 });
        const seen = new Set<string>();
        const out: AudienceCandidate[] = [];
        for (const a of appts) { if (seen.has(a.patientId)) continue; seen.add(a.patientId); out.push({ patientId: a.patientId, leadId: null, name: `${a.patient.firstName} ${a.patient.lastName}`, email: a.patient.email, phone: a.patient.phone, reason: 'Missed appointment' }); }
        return out;
      }
      case 'unpaid_deposit_followup': {
        const reqs = await tx.depositRequirement.findMany({ where: { tenantId, status: { in: ['required', 'requested', 'link_sent'] }, patientId: { not: null } }, select: { patientId: true, patient: { select: { firstName: true, lastName: true, email: true, phone: true } } }, take: 500 });
        const seen = new Set<string>();
        const out: AudienceCandidate[] = [];
        for (const r of reqs) { if (!r.patientId || seen.has(r.patientId)) continue; seen.add(r.patientId); out.push({ patientId: r.patientId, leadId: null, name: r.patient ? `${r.patient.firstName} ${r.patient.lastName}` : 'Patient', email: r.patient?.email ?? null, phone: r.patient?.phone ?? null, reason: 'Unpaid deposit' }); }
        return out;
      }
      case 'failed_payment_recovery': {
        const prs = await tx.paymentRequest.findMany({ where: { tenantId, status: { in: ['failed', 'expired'] }, patientId: { not: null } }, select: { patientId: true, patient: { select: { firstName: true, lastName: true, email: true, phone: true } } }, orderBy: { createdAt: 'desc' }, take: 500 });
        const seen = new Set<string>();
        const out: AudienceCandidate[] = [];
        for (const r of prs) { if (!r.patientId || seen.has(r.patientId)) continue; seen.add(r.patientId); out.push({ patientId: r.patientId, leadId: null, name: r.patient ? `${r.patient.firstName} ${r.patient.lastName}` : 'Patient', email: r.patient?.email ?? null, phone: r.patient?.phone ?? null, reason: 'Failed/expired payment' }); }
        return out;
      }
      case 'insurance_update_request': {
        // Patient-facing "please update your insurance" — uses ineligible checks.
        const vers = await tx.eligibilityVerification.findMany({ where: { tenantId, coverageActive: false }, select: { patientId: true, patient: { select: { firstName: true, lastName: true, email: true, phone: true } } }, orderBy: { checkedAt: 'desc' }, take: 500 });
        const seen = new Set<string>();
        const out: AudienceCandidate[] = [];
        for (const v of vers) { if (seen.has(v.patientId)) continue; seen.add(v.patientId); out.push({ patientId: v.patientId, leadId: null, name: `${v.patient.firstName} ${v.patient.lastName}`, email: v.patient.email, phone: v.patient.phone, reason: 'Insurance needs update' }); }
        return out;
      }
      case 'appointment_request_followup': {
        const reqs = await tx.appointmentRequest.findMany({ where: { tenantId, status: { in: ['PENDING_REVIEW', 'MISSING_INFO'] } }, select: { id: true, patientId: true, leadId: true, collectedName: true, collectedPhone: true, collectedEmail: true, patient: { select: { firstName: true, lastName: true, email: true, phone: true } } }, take: 500 });
        return reqs.map(r => ({ patientId: r.patientId, leadId: r.leadId, name: r.patient ? `${r.patient.firstName} ${r.patient.lastName}` : (r.collectedName ?? 'Lead'), email: r.patient?.email ?? r.collectedEmail, phone: r.patient?.phone ?? r.collectedPhone, reason: 'Pending appointment request' }));
      }
      case 'review_request': {
        const appts = await tx.appointment.findMany({ where: { tenantId, status: 'COMPLETED', deletedAt: null }, select: { patientId: true, patient: { select: { firstName: true, lastName: true, email: true, phone: true } } }, orderBy: { startsAt: 'desc' }, take: 500 });
        const seen = new Set<string>();
        const out: AudienceCandidate[] = [];
        for (const a of appts) { if (seen.has(a.patientId)) continue; seen.add(a.patientId); out.push({ patientId: a.patientId, leadId: null, name: `${a.patient.firstName} ${a.patient.lastName}`, email: a.patient.email, phone: a.patient.phone, reason: 'Completed visit' }); }
        return out;
      }
      default:
        return [];
    }
  });
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
    if (await isSuppressed(tenantId, { patientId: c.patientId, leadId: c.leadId, destination: contact }, channel)) { suppressed++; continue; }
    eligible++;
    if (sample.length < 5) sample.push({ name: c.name, reason: c.reason, destinationMasked: maskDestination(contact) });
  }
  return { audienceType, channel, total: candidates.length, eligible, suppressed, missingContact, sample };
}

// --- Real open-slot detection (from existing appointment gaps) -------------
// Computes genuinely-open slots from existing bookings — NOT a fake count and
// NOT an automated booking engine. Uses a standard clinic window (09:00–17:00,
// 30-min slots) per branch over the next `days`, counting slots not overlapped
// by an active appointment. This is a recommendation input only.
const SLOT_MINUTES = 30;
const DAY_START_HOUR = 9;
const DAY_END_HOUR = 17;

export async function countOpenSlots(tenantId: string, days = 7): Promise<number> {
  const now = new Date();
  const horizon = new Date(now.getTime() + days * 86400000);
  const [branches, appts] = await Promise.all([
    db.branch.findMany({ where: { tenantId, active: true }, select: { id: true } }),
    db.appointment.findMany({ where: { tenantId, deletedAt: null, startsAt: { gte: now, lt: horizon }, status: { notIn: ['CANCELED', 'NO_SHOW', 'COMPLETED'] } }, select: { branchId: true, startsAt: true, endsAt: true } }),
  ]);
  const busyByBranch = new Map<string, Array<{ start: number; end: number }>>();
  for (const a of appts) {
    const arr = busyByBranch.get(a.branchId) ?? [];
    arr.push({ start: a.startsAt.getTime(), end: a.endsAt.getTime() });
    busyByBranch.set(a.branchId, arr);
  }
  let open = 0;
  for (const b of branches) {
    const busy = busyByBranch.get(b.id) ?? [];
    for (let d = 0; d < days; d++) {
      const day = new Date(now.getTime() + d * 86400000);
      for (let h = DAY_START_HOUR; h < DAY_END_HOUR; h++) {
        for (let m = 0; m < 60; m += SLOT_MINUTES) {
          const slotStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
          const slotEnd = slotStart + SLOT_MINUTES * 60000;
          if (slotStart < now.getTime()) continue;
          if (!busy.some(x => x.start < slotEnd && x.end > slotStart)) open++;
        }
      }
    }
  }
  return open;
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
