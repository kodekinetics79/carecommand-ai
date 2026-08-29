import { db } from './db';

// ── Operational alerting bands ───────────────────────────────────────────────
// IMPORTANT: these are OPERATIONAL "review needed" thresholds used to route work
// to staff — NOT diagnosis or treatment guidance. They flag readings a human
// should look at. Real clinical thresholds belong in patient-specific
// MonitoringRule rows configured by the care team.
// `edgeWarn` names WHICH edges of the safe band deserve a "monitor the next
// reading" warning. It is not cosmetic: a band edge that coincides with a
// physiological ceiling (SpO2 100%) is the BEST possible result, and warning on
// it manufactures false alerts that crowd real ones out of the queue.
//   'both' — approaching either edge is meaningful (glucose, heart rate)
//   'low'  — only the low edge is meaningful (oxygen: 100% is ideal)
//   'high' — only the high edge is meaningful
//   'none' — never warn on proximity, only on leaving the band
export type EdgeWarn = 'both' | 'low' | 'high' | 'none';
export interface ThresholdBand { min: number; max: number; critMin: number; critMax: number; unit: string; label: string; edgeWarn: EdgeWarn }
export const DEFAULT_THRESHOLDS: Record<string, ThresholdBand> = {
  glucose:        { min: 70,  max: 180, critMin: 54,  critMax: 300, unit: 'mg/dL', label: 'Glucose', edgeWarn: 'both' },
  blood_pressure: { min: 90,  max: 140, critMin: 80,  critMax: 180, unit: 'mmHg',  label: 'Blood pressure (systolic)', edgeWarn: 'both' },
  // Diastolic bands mirror standard hypertensive-crisis thresholds: ≥120 is a
  // crisis (critical), 90–119 is elevated/stage-2 (high), <60 is hypotensive.
  // Evaluated ALONGSIDE systolic — the worst of the two wins for blood_pressure.
  blood_pressure_diastolic: { min: 60, max: 90, critMin: 40, critMax: 120, unit: 'mmHg', label: 'Blood pressure (diastolic)', edgeWarn: 'both' },
  // SpO2 tops out at 100%. The high edge is the ideal result, never a warning —
  // only desaturation toward 92% is worth surfacing.
  oxygen:         { min: 92,  max: 100, critMin: 88,  critMax: 101, unit: '%',     label: 'Oxygen saturation', edgeWarn: 'low' },
  heart_rate:     { min: 50,  max: 110, critMin: 40,  critMax: 130, unit: 'bpm',   label: 'Heart rate', edgeWarn: 'both' },
  temperature:    { min: 35.5, max: 38, critMin: 35,  critMax: 39.5, unit: '°C',   label: 'Temperature', edgeWarn: 'both' },
};

// ── Weight change bands (CHF fluid-overload early warning) ───────────────────
// Congestive-heart-failure guidance treats rapid weight gain as a fluid-overload
// signal. Standard patient-education thresholds: ≥3 lb (1.4 kg) in a day or ≥5 lb
// (2.3 kg) in a week over the patient's recent baseline warrants clinical review.
// LIMITATION: weight has no single absolute "safe band" — a reading is only
// meaningful as a DELTA vs the patient's own recent readings, so this requires a
// baseline. With no baseline we record for trend tracking (no alert). Absolute
// values are compared in kg; readings in lb are converted before comparison.
export const WEIGHT_DAILY_GAIN_KG = 1.4;   // ~3 lb / 24h
export const WEIGHT_WEEKLY_GAIN_KG = 2.3;  // ~5 lb / 7d
export const WEIGHT_DAILY_WINDOW_HOURS = 36;   // "recent" baseline must be within ~1.5 days
export const WEIGHT_WEEKLY_WINDOW_HOURS = 8 * 24; // weekly baseline drawn from up to 8 days back

// ── ECG abnormal classifications ─────────────────────────────────────────────
// ECG has no numeric band — it alerts on the device-supplied rhythm
// classification. AFib / flutter are the highest-acuity single-lead findings and
// route as critical; other irregular rhythms route as high for nurse review.
const ECG_CRITICAL = ['afib', 'atrial fibrillation', 'a-fib', 'flutter', 'vfib', 'v-fib', 'ventricular fibrillation', 'vtach', 'ventricular tachycardia'];
const ECG_HIGH = ['irregular', 'abnormal', 'bradycardia', 'brady', 'tachycardia', 'tachy', 'pause', 'pvc', 'ectopic', 'inconclusive'];
const ECG_NORMAL = ['normal', 'sinus', 'sinus rhythm', 'nsr', 'ok', 'regular'];

export type Severity = 'normal' | 'warning' | 'high' | 'critical';

export interface RuleLike {
  minValue: number | null; maxValue: number | null; criticalMin: number | null; criticalMax: number | null;
  /** Optional per-rule override of the band's edge-warning direction. */
  edgeWarn?: EdgeWarn | null;
}

// Optional per-reading context the callers assemble (diastolic value, ECG rhythm
// classification, weight baselines). Keeps evaluateSeverity a pure function while
// letting it evaluate the reading types that need more than a single number.
export interface EvalContext {
  valueSecondary?: number | null;        // diastolic (mmHg) for blood_pressure
  ecgClassification?: string | null;     // rhythm label/flag for ecg
  unit?: string | null;                  // source unit (used to normalize weight)
  weight?: { recentKg?: number | null; weekAgoKg?: number | null } | null;
}

function toKg(value: number, unit: string | null | undefined): number {
  const u = (unit ?? '').toLowerCase();
  if (u === 'lb' || u === 'lbs' || u === 'pound' || u === 'pounds') return value * 0.45359237;
  return value; // assume kg (canonical)
}

/**
 * Resolve the most specific active threshold rule for a reading.
 * Precedence: patient-specific > device-type > branch > organization default.
 */
export async function resolveRule(tenantId: string, opts: { readingType: string; patientId?: string | null; deviceType?: string | null; branchId?: string | null }) {
  // DETERMINISM: the ordering below is load-bearing, not cosmetic. Without a
  // total order, two equally-specific equal-priority rules with different
  // thresholds resolve by Postgres heap order — so the same reading alerts or
  // stays silent depending on physical row placement, and the outcome can flip
  // after any UPDATE or VACUUM. A monitoring rule that fires at random is worse
  // than no rule. `createdAt` then `id` makes the winner stable and explainable:
  // the rule written first wins a tie, forever.
  const rules = await db.monitoringRule.findMany({
    where: { tenantId, readingType: opts.readingType, active: true },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  const score = (r: typeof rules[number]): number => {
    if (r.scope === 'patient' && r.patientId && r.patientId === opts.patientId) return 4;
    if (r.scope === 'device_type' && r.deviceType && r.deviceType === opts.deviceType) return 3;
    if (r.scope === 'branch' && r.branchId && r.branchId === opts.branchId) return 2;
    if (r.scope === 'organization') return 1;
    return 0;
  };
  return rules
    .map((r, index) => ({ r, s: score(r), index }))
    .filter(x => x.s > 0)
    // Specificity first, then priority, then the stable DB order above.
    .sort((a, b) => b.s - a.s || b.r.priority - a.r.priority || a.index - b.index)[0]?.r ?? null;
}

const WORSE = (a: Severity, b: Severity): Severity => (SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b);

/**
 * Score a single numeric value against a named default band (optionally
 * overridden by a patient/branch/org rule). Pure. Used for every scalar reading
 * type and for each half of a blood-pressure reading.
 */
function scoreNumericBand(bandKey: string, value: number, rule: RuleLike | null): { severity: Severity; reason: string } {
  const band = DEFAULT_THRESHOLDS[bandKey];
  const min = rule?.minValue ?? band?.min ?? -Infinity;
  const max = rule?.maxValue ?? band?.max ?? Infinity;
  const critMin = rule?.criticalMin ?? band?.critMin ?? -Infinity;
  const critMax = rule?.criticalMax ?? band?.critMax ?? Infinity;
  const unit = band?.unit ?? '';
  const label = band?.label ?? bandKey;

  if (value <= critMin || value >= critMax) {
    return { severity: 'critical', reason: `${label} ${value}${unit} is in the critical range (safe band ${min}–${max}${unit}). Doctor review needed.` };
  }
  if (value < min || value > max) {
    return { severity: 'high', reason: `${label} ${value}${unit} is outside the expected range (${min}–${max}${unit}). Nurse follow-up recommended.` };
  }
  // Proximity warning, but only on the edges the band says are meaningful.
  // Warning on a physiological ceiling (SpO2 100%) would flood the queue with
  // alerts on ideal readings and bury the ones that need a human.
  const edgeWarn: EdgeWarn = rule?.edgeWarn ?? band?.edgeWarn ?? 'both';
  const span = (max - min) || 1;
  const nearLow = value - min < span * 0.05;
  const nearHigh = max - value < span * 0.05;
  const warnLow = nearLow && (edgeWarn === 'both' || edgeWarn === 'low');
  const warnHigh = nearHigh && (edgeWarn === 'both' || edgeWarn === 'high');
  if (warnLow || warnHigh) {
    return { severity: 'warning', reason: `${label} ${value}${unit} is near the ${warnLow ? 'low' : 'high'} edge of the expected range (${min}–${max}${unit}). Monitor next reading.` };
  }
  return { severity: 'normal', reason: `${label} ${value}${unit} within expected range.` };
}

/**
 * Score an ECG reading from its device-supplied rhythm classification. AFib /
 * flutter → critical; other irregular findings → high; normal/sinus → normal.
 * An unrecognized/absent classification is not scored (recorded for trend).
 */
export function evaluateEcg(classification: string | null | undefined): { severity: Severity; reason: string } {
  const c = (classification ?? '').trim().toLowerCase();
  if (!c) return { severity: 'normal', reason: 'ECG recorded — no rhythm classification supplied, held for clinician review.' };
  if (ECG_CRITICAL.some(k => c.includes(k))) return { severity: 'critical', reason: `ECG rhythm "${classification}" is a high-acuity finding (AFib/flutter class). Doctor review needed.` };
  if (ECG_HIGH.some(k => c.includes(k))) return { severity: 'high', reason: `ECG rhythm "${classification}" is abnormal/irregular. Nurse follow-up recommended.` };
  if (ECG_NORMAL.some(k => c.includes(k))) return { severity: 'normal', reason: `ECG rhythm "${classification}" within normal sinus range.` };
  // Unknown label — do not fabricate a normal result; flag for a human to read.
  return { severity: 'warning', reason: `ECG rhythm "${classification}" unrecognized — monitor and confirm.` };
}

/**
 * Score a weight reading as a CHF fluid-overload delta vs the patient's recent
 * baseline. Rapid gain (≥1.4 kg/day or ≥2.3 kg/week) → high; rapid loss over the
 * weekly window → high (dehydration/over-diuresis). No baseline → normal.
 */
export function evaluateWeight(currentKg: number, ctx: { recentKg?: number | null; weekAgoKg?: number | null } | null | undefined): { severity: Severity; reason: string } {
  const r1 = Math.round(currentKg * 10) / 10;
  if (ctx?.recentKg != null) {
    const delta = currentKg - ctx.recentKg;
    if (delta >= WEIGHT_DAILY_GAIN_KG) return { severity: 'high', reason: `Weight ${r1}kg is up ${(Math.round(delta * 10) / 10)}kg since the last reading (≥${WEIGHT_DAILY_GAIN_KG}kg/day) — possible fluid overload. Nurse follow-up recommended.` };
  }
  if (ctx?.weekAgoKg != null) {
    const delta = currentKg - ctx.weekAgoKg;
    if (delta >= WEIGHT_WEEKLY_GAIN_KG) return { severity: 'high', reason: `Weight ${r1}kg is up ${(Math.round(delta * 10) / 10)}kg over the past week (≥${WEIGHT_WEEKLY_GAIN_KG}kg/week) — possible fluid overload. Nurse follow-up recommended.` };
    if (delta <= -WEIGHT_WEEKLY_GAIN_KG) return { severity: 'high', reason: `Weight ${r1}kg is down ${(Math.round(-delta * 10) / 10)}kg over the past week (≥${WEIGHT_WEEKLY_GAIN_KG}kg/week) — possible dehydration/over-diuresis. Nurse follow-up recommended.` };
  }
  return { severity: 'normal', reason: ctx?.recentKg != null || ctx?.weekAgoKg != null ? `Weight ${r1}kg stable vs recent baseline.` : `Weight ${r1}kg recorded — no baseline yet, held for trend tracking.` };
}

/**
 * Decide severity for a reading. Backend-only — the frontend never computes
 * this. Dispatches by reading type: blood_pressure evaluates systolic AND
 * diastolic (worst wins), ecg uses rhythm classification, weight uses a baseline
 * delta, everything else is a single numeric band. Returns severity + reason.
 */
export function evaluateSeverity(readingType: string, numericValue: number | null, rule: RuleLike | null, ctx?: EvalContext): { severity: Severity; reason: string } {
  if (readingType === 'ecg') {
    // ECG carries no numeric band; the classification (or the raw value string) is the signal.
    return evaluateEcg(ctx?.ecgClassification);
  }
  if (readingType === 'weight') {
    if (numericValue == null) return { severity: 'normal', reason: 'No weight value — recorded for trend tracking.' };
    return evaluateWeight(toKg(numericValue, ctx?.unit), ctx?.weight);
  }
  if (readingType === 'blood_pressure') {
    if (numericValue == null && ctx?.valueSecondary == null) {
      return { severity: 'normal', reason: 'No blood-pressure value — recorded for trend tracking.' };
    }
    const systolic = numericValue != null ? scoreNumericBand('blood_pressure', numericValue, rule) : { severity: 'normal' as Severity, reason: '' };
    // Diastolic uses the dedicated default band (rule min/max target systolic).
    const diastolic = ctx?.valueSecondary != null ? scoreNumericBand('blood_pressure_diastolic', ctx.valueSecondary, null) : { severity: 'normal' as Severity, reason: '' };
    const worst = WORSE(systolic.severity, diastolic.severity);
    if (worst === 'normal') return { severity: 'normal', reason: 'Blood pressure within expected range.' };
    // Surface whichever half drove the severity (prefer the worse; tie → mention both).
    const reason = systolic.severity === worst && diastolic.severity === worst && systolic.reason && diastolic.reason
      ? `${systolic.reason} ${diastolic.reason}`
      : (systolic.severity === worst ? systolic.reason : diastolic.reason);
    return { severity: worst, reason };
  }

  const band = DEFAULT_THRESHOLDS[readingType];
  if (numericValue == null || (!band && !rule)) {
    return { severity: 'normal', reason: 'No threshold configured — recorded for trend tracking.' };
  }
  return scoreNumericBand(readingType, numericValue, rule);
}

export const SEVERITY_RANK: Record<string, number> = { normal: 0, warning: 1, high: 2, critical: 3 };

/** Alert statuses that still represent outstanding work. */
export const OPEN_ALERT_STATUSES = ['open', 'acknowledged', 'assigned'] as const;

/**
 * Numeric acuity for a severity string. Persisted on every ReadingAlert as
 * `severityRank` so the queue can order by acuity IN THE DATABASE, before the
 * row limit — otherwise a burst of low-severity alerts truncates genuinely open
 * criticals out of the nurse's view and the UI shows a false all-clear.
 */
export function severityRank(severity: string): number {
  return SEVERITY_RANK[severity] ?? 0;
}

/**
 * Assemble the recent weight baselines (in kg) for a patient so evaluateWeight
 * can compute a CHF delta. Returns the most recent prior valid weight reading
 * within the daily window and the oldest within the weekly window. Prior
 * readings only (strictly before `before`) so a reading never compares to itself.
 */
export async function weightBaselines(tenantId: string, patientId: string, before: Date): Promise<{ recentKg: number | null; weekAgoKg: number | null }> {
  const weekStart = new Date(before.getTime() - WEIGHT_WEEKLY_WINDOW_HOURS * 36e5);
  const dayStart = new Date(before.getTime() - WEIGHT_DAILY_WINDOW_HOURS * 36e5);
  const rows = await db.deviceReading.findMany({
    where: { tenantId, patientId, readingType: 'weight', validationStatus: 'valid', numericValue: { not: null }, capturedAt: { gte: weekStart, lt: before } },
    orderBy: { capturedAt: 'desc' },
    select: { numericValue: true, unit: true, capturedAt: true },
  });
  if (!rows.length) return { recentKg: null, weekAgoKg: null };
  const kg = (r: { numericValue: number | null; unit: string | null }) => (r.numericValue == null ? null : toKg(r.numericValue, r.unit));
  const recent = rows.find(r => r.capturedAt >= dayStart) ?? null; // most recent within ~1.5 days
  const weekAgo = rows[rows.length - 1]; // oldest in the weekly window
  return { recentKg: recent ? kg(recent) : null, weekAgoKg: kg(weekAgo) };
}

/**
 * Aggregate operational risk per patient from open alerts + recent readings +
 * missed readings. Summary urgency only — not a clinical risk diagnosis.
 */
export interface PatientRiskInput {
  patientId: string;
  openCritical: number;
  openHigh: number;
  abnormal24h: number;
  missedReadings: number;
  trendingWorse: boolean;
}
export function computeRiskScore(i: PatientRiskInput): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  if (i.openCritical > 0) { score += 50 + (i.openCritical - 1) * 10; reasons.push(`${i.openCritical} open critical alert${i.openCritical > 1 ? 's' : ''}`); }
  if (i.openHigh > 0) { score += 20 + (i.openHigh - 1) * 5; reasons.push(`${i.openHigh} open high alert${i.openHigh > 1 ? 's' : ''}`); }
  if (i.abnormal24h > 0) { score += Math.min(20, i.abnormal24h * 5); reasons.push(`${i.abnormal24h} abnormal reading${i.abnormal24h > 1 ? 's' : ''} in 24h`); }
  if (i.missedReadings > 0) { score += Math.min(15, i.missedReadings * 5); reasons.push(`${i.missedReadings} missed reading${i.missedReadings > 1 ? 's' : ''}`); }
  if (i.trendingWorse) { score += 15; reasons.push('readings trending worse'); }
  return { score: Math.min(100, score), reasons };
}
