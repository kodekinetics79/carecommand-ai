import { env } from '../config/env';
import { isIP } from 'node:net';
import { sendAuthenticationEmail, type SendResult } from './commsProvider';
import { providerConfigured } from './providerCredentials';

function configuredAppOrigin(): URL | null {
  if (!env.PUBLIC_APP_URL) return null;
  try {
    const url = new URL(env.PUBLIC_APP_URL);
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) return null;
    if (env.NODE_ENV === 'production') {
      const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
      const blockedSuffixes = ['.localhost', '.local', '.internal', '.test', '.example', '.invalid'];
      if (url.protocol !== 'https:' || hostname === 'localhost' || isIP(hostname) !== 0 || !hostname.includes('.') || blockedSuffixes.some(suffix => hostname.endsWith(suffix))) return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url;
  } catch {
    return null;
  }
}

export function passwordResetDeliveryConfigured(): boolean {
  return configuredAppOrigin() !== null && providerConfigured('email');
}

export interface PasswordResetDeliveryInput {
  email: string;
  tenantName: string;
  token: string;
  deliveryId: string;
}

/** Deliver a raw reset token only inside a URL fragment through the email provider. */
export async function deliverPasswordReset(input: PasswordResetDeliveryInput): Promise<SendResult> {
  const appOrigin = configuredAppOrigin();
  if (!appOrigin) {
    return { ok: false, status: 'setup_required', mode: 'setup_required', failureReason: 'public_app_url_not_configured' };
  }

  // A fragment is not sent to the web server and therefore keeps the raw
  // credential out of access logs and Referer headers. The browser removes it
  // from the address bar immediately after the login page reads it.
  const resetUrl = new URL('/login', appOrigin);
  resetUrl.hash = `reset=${encodeURIComponent(input.token)}`;

  const ttl = env.PASSWORD_RESET_TTL_MINUTES;
  const subject = `Reset your ${input.tenantName} CareCommand password`;
  const body = [
    `A password reset was requested for your ${input.tenantName} CareCommand account.`,
    '',
    `Reset your password: ${resetUrl.toString()}`,
    '',
    `This link expires in ${ttl} minutes and can be used once. If you did not request it, you can ignore this email.`,
    'CareCommand support will never ask you to share this link or your password.',
  ].join('\n');

  try {
    return await sendAuthenticationEmail(input.email, subject, body, `password-reset-${input.deliveryId}`);
  } catch {
    return { ok: false, status: 'failed', mode: 'live', failureReason: 'password_reset_provider_exception' };
  }
}
