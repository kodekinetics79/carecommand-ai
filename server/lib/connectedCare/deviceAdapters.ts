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

const CANONICAL_UNITS: Partial<Record<string, ReadonlyArray<string>>> = {
  glucose: ['mg/dL'], blood_pressure: ['mmHg'], oxygen: ['%'], weight: ['kg', 'lb'],
  temperature: ['°C'], heart_rate: ['bpm'],
};

// How far back a provider may date a reading at ingest. A real device or
// gateway reports continuously; a generous window still lets one catch up after
// being offline for a few days. Without a LOWER bound, a single signed webhook
// could carry readings backdated across 16 distinct calendar days and mint a
// full CMS device-day requirement instantly — the HMAC secret is held by the
// tenant, so provenance proves "somebody with this tenant's key asserted this",
// not "the vendor observed this".
export const MAX_READING_BACKDATE_HOURS = 7 * 24;

/** Fail closed on impossible or non-canonical provider measurements. */
export function isPlausibleNormalizedReading(reading: NormalizedReading, now = new Date()): boolean {
  const capturedMs = reading.capturedAt.getTime();
  if (!Number.isFinite(capturedMs) || capturedMs > now.getTime() + 5 * 60_000) return false;
  if (capturedMs < now.getTime() - MAX_READING_BACKDATE_HOURS * 36e5) return false;
  if (reading.readingType === 'ecg') return reading.value.trim().length > 0;
  const allowedUnits = CANONICAL_UNITS[reading.readingType];
  if (!allowedUnits || !reading.unit || !allowedUnits.includes(reading.unit)) return false;
  const numeric = reading.numericValue;
  if (numeric == null || !Number.isFinite(numeric)) return false;
  if (reading.readingType === 'blood_pressure') {
    const diastolic = reading.valueSecondary;
    return diastolic != null && Number.isFinite(diastolic) && numeric >= 40 && numeric <= 300 && diastolic >= 20 && diastolic <= 200 && numeric > diastolic;
  }
  if (reading.readingType === 'glucose') return numeric >= 10 && numeric <= 1000;
  if (reading.readingType === 'oxygen') return numeric >= 50 && numeric <= 100;
  if (reading.readingType === 'weight') return reading.unit === 'lb' ? numeric >= 2 && numeric <= 1100 : numeric >= 1 && numeric <= 500;
  if (reading.readingType === 'temperature') return numeric >= 25 && numeric <= 45;
  if (reading.readingType === 'heart_rate') return numeric >= 20 && numeric <= 300;
  return false;
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
