import { env } from '../config/env';
import { db } from './db';
import { channelStatus, isSuppressed, toE164, isValidE164, isValidEmail, type CommChannel } from './campaigns';

// ===========================================================================
// Real communications send abstraction. Dependency-free (raw HTTP, matching the
// Stripe/Stedi/Retell pattern). A message is marked "sent" ONLY when the
// provider call succeeds (or in an explicit dev mock). Never fakes delivery.
//   - sms / whatsapp: real Twilio Messages API (Basic auth).
//   - email: optional HTTP email API (e.g. SendGrid); else pending (no SMTP dep).
//   - voice: pending (reuses Retell config for status; campaign voice not wired).
//
// Every send passes through ONE consent/suppression + destination gate before a
// provider is ever contacted (see sendMessage). This is the single choke point
// that makes suppression (campaign, CRM, and AI-receptionist opt-outs) apply to
// every outbound path, and rejects a malformed destination before we dial it.
// ===========================================================================

export type SendMode = 'mock_dev' | 'live' | 'configured_pending_provider' | 'setup_required' | 'suppressed';
export interface SendResult { ok: boolean; status: 'sent' | 'pending' | 'failed' | 'setup_required' | 'suppressed'; providerMessageId?: string; mode: SendMode; failureReason?: string }

// Who a message is for, so the send-time gate can resolve suppression. tenantId
// is required — a send with no tenant can never be safely consent-checked, and
// making it required forces every call site to be explicit (fail-closed).
export interface SendContext { tenantId: string; patientId?: string | null; leadId?: string | null }

type ConfirmationAuthorization = {
  tenantId: string;
  eventId: string;
  attemptNumber: number;
};

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: controller.signal }); } finally { clearTimeout(timer); }
}

async function sendTwilio(toNumber: string, body: string): Promise<SendResult> {
  const sid = env.TWILIO_ACCOUNT_SID!;
  const auth = Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const form = new URLSearchParams({ To: toNumber, From: env.TWILIO_FROM_NUMBER!, Body: body });
  try {
    const res = await fetchWithTimeout(`${env.TWILIO_BASE_URL}/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
    });
    const payload = await res.json().catch(() => null) as { sid?: string; message?: string } | null;
    if (!res.ok || !payload?.sid) return { ok: false, status: 'failed', mode: 'live', failureReason: payload?.message ?? `twilio_error_${res.status}` };
    return { ok: true, status: 'sent', providerMessageId: payload.sid, mode: 'live' };
  } catch (error) {
    return { ok: false, status: 'failed', mode: 'live', failureReason: error instanceof Error ? error.message : 'twilio_request_failed' };
  }
}

async function sendEmailHttp(to: string, subject: string, body: string): Promise<SendResult> {
  // Generic HTTP email API path (only used when EMAIL_HTTP_API_URL is configured).
  try {
    const res = await fetchWithTimeout(env.EMAIL_HTTP_API_URL!, {
      method: 'POST', headers: { Authorization: `Bearer ${env.EMAIL_HTTP_API_KEY ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, from: env.EMAIL_FROM_ADDRESS, subject, text: body }),
    });
    const payload = await res.json().catch(() => null) as { id?: string; messageId?: string; message?: string } | null;
    const id = payload?.id ?? payload?.messageId;
    if (!res.ok || !id) return { ok: false, status: 'failed', mode: 'live', failureReason: payload?.message ?? `email_error_${res.status}` };
    return { ok: true, status: 'sent', providerMessageId: id, mode: 'live' };
  } catch (error) {
    return { ok: false, status: 'failed', mode: 'live', failureReason: error instanceof Error ? error.message : 'email_request_failed' };
  }
}

// Send one message. `idempotencyKey` makes the dev-mock id deterministic so a
// retry produces the same providerMessageId. `context` (required) carries the
// tenant + recipient identity used by the consent/suppression gate below.
export async function sendMessage(channel: CommChannel, destination: string, subject: string, body: string, idempotencyKey: string, context: SendContext): Promise<SendResult> {
  const status = channelStatus(channel);
  if (status.setupRequired) return { ok: false, status: 'setup_required', mode: 'setup_required' };

  // ---- Shared suppression gate (runs for EVERY path, incl. the dev mock) ----
  // Honors CommunicationConsent / CampaignSuppression / ConsentEvent (patient or
  // lead identity) AND ReceptionistOptOut (destination, channel ALL) — the last
  // one is what makes an opt-out captured during an AI receptionist call suppress
  // SMS campaigns, CRM sends, and appointment-confirmation texts alike. Tenant-
  // scoped. When suppressed we return WITHOUT contacting any provider or minting
  // a (mock or live) providerMessageId.
  if (await isSuppressed(context.tenantId, { patientId: context.patientId ?? null, leadId: context.leadId ?? null, destination }, channel)) {
    return { ok: false, status: 'suppressed', mode: 'suppressed', failureReason: 'suppressed_or_opted_out' };
  }

  return sendToConfiguredProvider(channel, destination, subject, body, idempotencyKey, status);
}

/**
 * The only suppression-free send path. It is limited to a currently leased
 * appointment-confirmation attempt with an exact committed PROVIDER_INTENT and
 * the destination owned by that event's patient. Suppression was linearized by
 * the database transaction that appended that intent; a later opt-out applies
 * to future attempts and must not rewrite this already-authorized boundary.
 */
export async function sendAuthorizedAppointmentConfirmation(
  channel: 'sms' | 'email',
  destination: string,
  subject: string,
  body: string,
  idempotencyKey: string,
  authorization: ConfirmationAuthorization,
): Promise<SendResult> {
  const intent = await db.notificationDeliveryAttempt.findUnique({
    where: { tenantId_notificationEventId_attemptNumber_phase: {
      tenantId: authorization.tenantId,
      notificationEventId: authorization.eventId,
      attemptNumber: authorization.attemptNumber,
      phase: 'PROVIDER_INTENT',
    } },
    include: { notificationEvent: { include: {
      appointment: { select: { patient: { select: { phone: true, email: true } } } },
      deliveryAttempts: {
        where: { attemptNumber: authorization.attemptNumber, phase: { in: ['RESULT', 'RECEIPT'] } },
        select: { id: true },
      },
    } } },
  });
  const event = intent?.notificationEvent;
  const expectedDestination = channel === 'sms' ? event?.appointment?.patient.phone : event?.appointment?.patient.email;
  const destinationMatches = channel === 'sms'
    ? toE164(expectedDestination ?? '') === toE164(destination)
    : (expectedDestination ?? '').trim().toLowerCase() === destination.trim().toLowerCase();
  if (!intent || intent.status !== 'provider_intent_committed' || !intent.completedAt
    || event?.source !== 'receptionist.appointment_confirmation'
    || event.status !== 'retrying' || event.attempts !== authorization.attemptNumber
    || event?.deliveryAttempts.length !== 0
    || event.channel !== channel || event.idempotencyKey !== idempotencyKey || !destinationMatches) {
    return { ok: false, status: 'failed', mode: 'configured_pending_provider', failureReason: 'durable_authorization_invalid' };
  }
  const status = channelStatus(channel);
  if (status.setupRequired) return { ok: false, status: 'setup_required', mode: 'setup_required' };
  return sendToConfiguredProvider(channel, destination, subject, body, idempotencyKey, status);
}

async function sendToConfiguredProvider(
  channel: CommChannel,
  destination: string,
  subject: string,
  body: string,
  idempotencyKey: string,
  status: ReturnType<typeof channelStatus>,
): Promise<SendResult> {

  // Explicit dev mock (credentials starting with "mock", non-production only).
  if (status.mock && env.NODE_ENV !== 'production') {
    return { ok: true, status: 'sent', providerMessageId: `mock_${idempotencyKey.slice(0, 40)}`, mode: 'mock_dev' };
  }

  if (channel === 'sms' || channel === 'whatsapp') {
    // E.164 destination gate — never dial the provider with a malformed number.
    const to = toE164(destination);
    if (!isValidE164(to)) return { ok: false, status: 'failed', mode: 'live', failureReason: 'invalid_destination' };
    return sendTwilio(to, body);
  }
  if (channel === 'email') {
    if (!env.EMAIL_HTTP_API_URL) return { ok: false, status: 'pending', mode: 'configured_pending_provider' };
    if (!isValidEmail(destination)) return { ok: false, status: 'failed', mode: 'live', failureReason: 'invalid_destination' };
    return sendEmailHttp(destination.trim(), subject, body);
  }
  // voice campaign sending is not wired (Retell is used for receptionist calls).
  return { ok: false, status: 'pending', mode: 'configured_pending_provider' };
}
