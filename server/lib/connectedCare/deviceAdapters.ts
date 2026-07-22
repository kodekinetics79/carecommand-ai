import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Provider-agnostic device adapter layer. Real provider payloads (Dexcom EGV,
// Withings measure groups, Validic/Terra/Tenovi events) normalize into the
// canonical reading shape below. Until per-provider credentials exist, every
// provider shares the canonical webhook path so the pipeline is exercised.

export interface NormalizedReading {
  patientExternalRef?: string;
  patientId?: string;
  externalId?: string;   // provider's own reading id, when supplied (strongest dedupe key)
  readingType: string;
  value: string;
  numericValue?: number;
  valueSecondary?: number;
  unit?: string;
  capturedAt: Date;
}

export interface WebhookParseResult {
  readings: NormalizedReading[];
  meta: Record<string, unknown>;
}

const READING_TYPES = new Set(['glucose', 'blood_pressure', 'oxygen', 'weight', 'temperature', 'heart_rate', 'ecg']);

/**
 * Verify an HMAC-SHA256 webhook signature.
 *   - returns true/false when the provider supplies a signing secret
 *   - returns null when there is no usable secret (no provider row / none configured)
 *
 * SECURITY: `null` means "cannot verify", NOT "trusted". Callers MUST fail
 * closed — ingest ONLY on an explicit `true`. A public webhook whose signature
 * is `null` or `false` is unauthenticated and must be rejected: the verified
 * secret is what binds the request to its tenant.
 */
export function verifyWebhookSignature(secret: string | null, rawBody: string, signature: string | null): boolean | null {
  if (!secret) return null;
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Deterministic idempotency key for an inbound reading. Webhook redeliveries of
 * the SAME measurement (same provider/patient/type/timestamp/value) collapse to
 * one DeviceReading — preventing duplicate alerts and inflated RPM device-days.
 * Stored on DeviceReading.dedupeKey with a unique (tenantId, dedupeKey) index;
 * manual/keyless readings leave it null (Postgres treats NULLs as distinct).
 */
export function readingDedupeKey(parts: {
  providerKey?: string | null;
  externalId?: string | null;
  patientId?: string | null;
  patientExternalRef?: string | null;
  readingType: string;
  capturedAt: Date;
  value: string;
  numericValue?: number | null;
  valueSecondary?: number | null;
}): string {
  // An explicit external reading id (when a provider supplies one) is the
  // strongest key; otherwise fall back to the natural measurement identity.
  const identity = parts.externalId
    ? ['ext', parts.providerKey ?? '', parts.externalId]
    : [
        parts.providerKey ?? '',
        parts.patientId ?? parts.patientExternalRef ?? '',
        parts.readingType,
        parts.capturedAt.toISOString(),
        parts.value,
        parts.numericValue ?? '',
        parts.valueSecondary ?? '',
      ];
  return createHash('sha256').update(identity.join('|')).digest('hex');
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
  return undefined;
}

interface RawItem {
  patientExternalRef?: string; patient_id?: string; userId?: string; patientId?: string;
  id?: string; externalId?: string; readingId?: string;
  readingType?: string; type?: string; value?: unknown; measure?: unknown; numericValue?: unknown;
  valueSecondary?: unknown; unit?: string; capturedAt?: string; timestamp?: string;
}

/**
 * Normalize an inbound webhook body into canonical readings. Accepts
 * `{ readings: [...] }`, `{ data: [...] }`, or a single reading object.
 * Unknown reading types and unparseable values are dropped (validation).
 */
export function normalizeWebhook(providerKey: string, body: unknown): WebhookParseResult {
  const root = body as { readings?: RawItem[]; data?: RawItem[] } | RawItem | null;
  const items: RawItem[] = Array.isArray((root as { readings?: RawItem[] })?.readings)
    ? (root as { readings: RawItem[] }).readings
    : Array.isArray((root as { data?: RawItem[] })?.data)
      ? (root as { data: RawItem[] }).data
      : root ? [root as RawItem] : [];

  const readings: NormalizedReading[] = [];
  for (const it of items) {
    const readingType = String(it.readingType ?? it.type ?? '').trim();
    if (!READING_TYPES.has(readingType)) continue;
    const rawValue = it.value ?? it.measure;
    const value = rawValue == null ? '' : String(rawValue);
    if (!value) continue;
    readings.push({
      patientExternalRef: it.patientExternalRef ?? it.patient_id ?? it.userId ?? undefined,
      patientId: it.patientId ?? undefined,
      externalId: it.externalId ?? it.readingId ?? it.id ?? undefined,
      readingType,
      value,
      numericValue: toNumber(it.numericValue) ?? toNumber(rawValue),
      valueSecondary: toNumber(it.valueSecondary),
      unit: it.unit ?? undefined,
      capturedAt: it.capturedAt ? new Date(it.capturedAt) : it.timestamp ? new Date(it.timestamp) : new Date(),
    });
  }
  return { readings, meta: { providerKey, count: readings.length } };
}
