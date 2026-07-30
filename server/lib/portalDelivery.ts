import { appendFile } from 'node:fs/promises';

import { env } from '../config/env';
import { sendMessage, type SendResult } from './commsProvider';

export interface PortalTokenDelivery {
  tenantId: string;
  patientId: string;
  accountId: string;
  token: string;
  email?: string | null;
  phone?: string | null;
  purpose: 'request-link' | 'signup' | 'staff-approval';
}

/** Deliver a raw portal token only through an explicit test sink or provider. */
export async function deliverPortalToken(input: PortalTokenDelivery): Promise<SendResult> {
  if (env.PORTAL_TOKEN_OUTBOX_PATH) {
    try {
      await appendFile(
        env.PORTAL_TOKEN_OUTBOX_PATH,
        `${JSON.stringify({ tenantId: input.tenantId, accountId: input.accountId, token: input.token, channel: input.email ? 'email' : 'sms', purpose: input.purpose, createdAt: new Date().toISOString() })}\n`,
        { encoding: 'utf8' },
      );
      return { ok: true, status: 'sent', mode: 'mock_dev', providerMessageId: `test-outbox:${input.accountId}` };
    } catch {
      // Delivery is part of authentication. A broken local/E2E sink must be
      // represented as a failed delivery, never an exception that skips the
      // caller's pending-token cleanup path.
      return { ok: false, status: 'failed', mode: 'mock_dev', failureReason: 'portal_outbox_write_failed' };
    }
  }

  const channel = input.email ? 'email' : input.phone ? 'sms' : null;
  const destination = input.email ?? input.phone;
  if (!channel || !destination) {
    return { ok: false, status: 'setup_required', mode: 'setup_required', failureReason: 'portal_destination_missing' };
  }
  try {
    return await sendMessage(
      channel,
      destination,
      'Your CareCommand patient portal sign-in code',
      `Your one-time CareCommand sign-in code is: ${input.token}\n\nIt expires in 15 minutes. Do not share this code.`,
      `portal-${input.purpose}-${input.accountId}`,
      { tenantId: input.tenantId, patientId: input.patientId },
    );
  } catch {
    // Provider adapters are expected to return SendResult failures, but this
    // outer guard keeps authentication fail-closed if a provider regresses.
    return { ok: false, status: 'failed', mode: 'live', failureReason: 'portal_provider_exception' };
  }
}
