import { env } from '../config/env';
import { channelStatus, type CommChannel } from './campaigns';

// ===========================================================================
// Real communications send abstraction. Dependency-free (raw HTTP, matching the
// Stripe/Stedi/Retell pattern). A message is marked "sent" ONLY when the
// provider call succeeds (or in an explicit dev mock). Never fakes delivery.
//   - sms / whatsapp: real Twilio Messages API (Basic auth).
//   - email: optional HTTP email API (e.g. SendGrid); else pending (no SMTP dep).
//   - voice: pending (reuses Retell config for status; campaign voice not wired).
// ===========================================================================

export type SendMode = 'mock_dev' | 'live' | 'configured_pending_provider' | 'setup_required';
export interface SendResult { ok: boolean; status: 'sent' | 'pending' | 'failed' | 'setup_required'; providerMessageId?: string; mode: SendMode; failureReason?: string }

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
// retry produces the same providerMessageId.
export async function sendMessage(channel: CommChannel, destination: string, subject: string, body: string, idempotencyKey: string): Promise<SendResult> {
  const status = channelStatus(channel);
  if (status.setupRequired) return { ok: false, status: 'setup_required', mode: 'setup_required' };

  // Explicit dev mock (credentials starting with "mock", non-production only).
  if (status.mock && env.NODE_ENV !== 'production') {
    return { ok: true, status: 'sent', providerMessageId: `mock_${idempotencyKey.slice(0, 40)}`, mode: 'mock_dev' };
  }

  if (channel === 'sms' || channel === 'whatsapp') return sendTwilio(destination, body);
  if (channel === 'email') {
    if (env.EMAIL_HTTP_API_URL) return sendEmailHttp(destination, subject, body);
    // SMTP credentials recognized but no HTTP email API / SMTP lib wired.
    return { ok: false, status: 'pending', mode: 'configured_pending_provider' };
  }
  // voice campaign sending is not wired (Retell is used for receptionist calls).
  return { ok: false, status: 'pending', mode: 'configured_pending_provider' };
}
