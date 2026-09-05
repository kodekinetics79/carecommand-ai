import { env } from '../config/env';
import { db } from './db';
import { decryptSecret } from './security';

/**
 * One place that decides which provider credential the product actually uses.
 *
 * Before this, the Control Tower encrypted credentials into PlatformIntegration
 * and reported "connected - via db - test ok" while every sender read
 * process.env directly. An operator rotating a leaked Twilio token got a green
 * badge, a passing connection test, and messages still going out on the old
 * key. Precedence is now stated once, here, and both the console and the
 * senders read it:
 *
 *     a COMPLETE saved credential  >  the environment  >  unset
 *
 * "Complete" matters: a half-filled vault row must not shadow working env
 * configuration, or saving one field of three would take the product offline.
 *
 * Reads are served from an in-process snapshot rather than a query per message.
 * Provider config changes when an operator saves it - not per request - and the
 * senders are hot paths (every SMS, every call). The snapshot refreshes at
 * boot, when the console writes, and on a TTL for other instances.
 */

export interface ProviderField { k: string; label: string; secret: boolean }
export interface ProviderDef {
  label: string;
  required: string[];
  fields: ProviderField[];
  env: Record<string, string>;
}

export const PROVIDER_CATALOG: Record<string, ProviderDef> = {
  sms: {
    label: 'SMS (Twilio)', required: ['accountSid', 'authToken', 'fromNumber'],
    fields: [{ k: 'accountSid', label: 'Account SID', secret: false }, { k: 'authToken', label: 'Auth Token', secret: true }, { k: 'fromNumber', label: 'From Number', secret: false }],
    env: { accountSid: 'TWILIO_ACCOUNT_SID', authToken: 'TWILIO_AUTH_TOKEN', fromNumber: 'TWILIO_FROM_NUMBER' },
  },
  email: {
    label: 'Email (HTTP API)', required: ['apiUrl', 'apiKey', 'fromAddress'],
    fields: [{ k: 'provider', label: 'Adapter (generic or sendgrid)', secret: false }, { k: 'apiUrl', label: 'API URL', secret: false }, { k: 'apiKey', label: 'API Key', secret: true }, { k: 'fromAddress', label: 'From Address', secret: false }],
    env: { apiUrl: 'EMAIL_HTTP_API_URL', apiKey: 'EMAIL_HTTP_API_KEY', fromAddress: 'EMAIL_FROM_ADDRESS' },
  },
  payments: {
    label: 'Payments (Stripe)', required: ['secretKey'],
    fields: [{ k: 'secretKey', label: 'Secret Key', secret: true }],
    env: { secretKey: 'STRIPE_SECRET_KEY' },
  },
  payments_webhook: {
    label: 'Payment webhook', required: ['webhookSecret'],
    fields: [{ k: 'webhookSecret', label: 'Webhook Secret', secret: true }],
    env: { webhookSecret: 'STRIPE_WEBHOOK_SECRET' },
  },
  insurance: {
    label: 'Insurance (Stedi)', required: ['apiKey'],
    fields: [{ k: 'apiKey', label: 'API Key', secret: true }],
    env: { apiKey: 'STEDI_API_KEY' },
  },
  voice: {
    label: 'Voice (Retell)', required: ['apiKey', 'fromNumber'],
    fields: [{ k: 'apiKey', label: 'API Key', secret: true }, { k: 'fromNumber', label: 'From Number', secret: false }],
    env: { apiKey: 'RETELL_API_KEY', fromNumber: 'RETELL_FROM_NUMBER' },
  },
};

export type ProviderKey = keyof typeof PROVIDER_CATALOG & string;
export const PROVIDER_KEYS = Object.keys(PROVIDER_CATALOG) as ProviderKey[];

const SNAPSHOT_TTL_MS = 60_000;

let snapshot = new Map<string, Record<string, string>>();
let loadedAtMs = 0;
let inFlight: Promise<void> | null = null;

interface CredentialRow { key: string; configEnc: string | null; status: string | null; setFields: string[] | null }

/**
 * Reload the vault snapshot. Never throws: a database that cannot answer must
 * leave the product running on its environment configuration, not take voice
 * and SMS down with it.
 */
export async function refreshProviderCredentials(): Promise<{ providers: number; ok: boolean }> {
  try {
    const rows = await db.$queryRaw<CredentialRow[]>`SELECT * FROM app_provider_credentials()`;
    const next = new Map<string, Record<string, string>>();
    for (const row of rows) {
      if (!row.configEnc) continue;
      try {
        const parsed = JSON.parse(decryptSecret(row.configEnc) ?? '{}') as Record<string, string>;
        const values = Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string' && v.length > 0));
        if (Object.keys(values).length) next.set(row.key, values);
      } catch {
        // A row we cannot decrypt (rotated AUTH_ENCRYPTION_KEY) is treated as
        // absent so the sender falls back to env rather than failing closed.
      }
    }
    snapshot = next;
    loadedAtMs = Date.now();
    return { providers: next.size, ok: true };
  } catch {
    loadedAtMs = Date.now(); // don't hammer a database that is refusing
    return { providers: snapshot.size, ok: false };
  }
}

/** Drop the snapshot so the next read reloads. Call after the console writes. */
export function invalidateProviderCredentials(): void {
  loadedAtMs = 0;
}

/** Refresh in the background when the snapshot has aged out. */
function refreshIfStale(): void {
  if (Date.now() - loadedAtMs < SNAPSHOT_TTL_MS || inFlight) return;
  inFlight = refreshProviderCredentials().then(() => { inFlight = null; }, () => { inFlight = null; });
}

function envValues(key: string): Record<string, string> {
  const def = PROVIDER_CATALOG[key];
  if (!def) return {};
  const values: Record<string, string> = {};
  for (const field of def.fields) {
    const value = (env as unknown as Record<string, unknown>)[def.env[field.k]];
    if (typeof value === 'string' && value.length > 0) values[field.k] = value;
  }
  return values;
}

function isComplete(key: string, values: Record<string, string>): boolean {
  const def = PROVIDER_CATALOG[key];
  if (!def) return Object.keys(values).length > 0;
  return def.required.length > 0 && def.required.every(field => !!values[field]);
}

/**
 * The credential set a sender should use, and where it came from. A saved
 * credential wins only when it is complete; anything else falls back to env.
 */
export function providerConfig(key: string): { values: Record<string, string>; source: 'db' | 'env' | null } {
  refreshIfStale();
  return resolveCredentialPrecedence(key, snapshot.get(key), envValues(key));
}

/**
 * The precedence rule itself, as a pure function of its two inputs.
 *
 * Split out from providerConfig deliberately: the rule is the thing worth
 * pinning, and pinning it through providerConfig means asserting against
 * whatever provider credentials happen to be in the ambient environment. That
 * passes on a laptop with a populated .env and fails in CI which has none - a
 * test that reports the machine it ran on rather than the behaviour.
 */
export function resolveCredentialPrecedence(
  key: string,
  stored: Record<string, string> | undefined,
  fromEnv: Record<string, string>,
): { values: Record<string, string>; source: 'db' | 'env' | null } {
  if (stored && isComplete(key, stored)) return { values: stored, source: 'db' };
  if (Object.keys(fromEnv).length) return { values: fromEnv, source: 'env' };
  // A partial saved credential is still worth reporting rather than pretending
  // nothing is set - the console shows it as not configured.
  if (stored) return { values: stored, source: 'db' };
  return { values: {}, source: null };
}

/** One field, resolved through the same precedence. */
export function providerValue(key: string, field: string): string | undefined {
  return providerConfig(key).values[field];
}

/** True when every required field for this provider resolves to something. */
export function providerConfigured(key: string): boolean {
  return isComplete(key, providerConfig(key).values);
}

/** Test seam: replace the snapshot without a database. */
export function __setProviderSnapshotForTests(entries: Record<string, Record<string, string>>): void {
  snapshot = new Map(Object.entries(entries));
  loadedAtMs = Date.now();
}
