import { createHmac, timingSafeEqual } from 'node:crypto';

// Provider-agnostic device adapter layer. Real provider payloads (Dexcom EGV,
// Withings measure groups, Validic/Terra/Tenovi events) normalize into the
// canonical reading shape below. Until per-provider credentials exist, every
// provider shares the canonical webhook path so the pipeline is exercised.

export interface NormalizedReading {
  patientExternalRef?: string;
  patientId?: string;
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
 *   - returns null when the provider does not sign (sandbox / manual)
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

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
  return undefined;
}

interface RawItem {
  patientExternalRef?: string; patient_id?: string; userId?: string; patientId?: string;
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
