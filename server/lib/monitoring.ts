import { db } from './db';

// ── Operational alerting bands ───────────────────────────────────────────────
// IMPORTANT: these are OPERATIONAL "review needed" thresholds used to route work
// to staff — NOT diagnosis or treatment guidance. They flag readings a human
// should look at. Real clinical thresholds belong in patient-specific
// MonitoringRule rows configured by the care team.
export interface ThresholdBand { min: number; max: number; critMin: number; critMax: number; unit: string; label: string }
export const DEFAULT_THRESHOLDS: Record<string, ThresholdBand> = {
  glucose:        { min: 70,  max: 180, critMin: 54,  critMax: 300, unit: 'mg/dL', label: 'Glucose' },
  blood_pressure: { min: 90,  max: 140, critMin: 80,  critMax: 180, unit: 'mmHg',  label: 'Blood pressure (systolic)' },
  oxygen:         { min: 92,  max: 100, critMin: 88,  critMax: 101, unit: '%',     label: 'Oxygen saturation' },
  heart_rate:     { min: 50,  max: 110, critMin: 40,  critMax: 130, unit: 'bpm',   label: 'Heart rate' },
  temperature:    { min: 35.5, max: 38, critMin: 35,  critMax: 39.5, unit: '°C',   label: 'Temperature' },
};

export type Severity = 'normal' | 'warning' | 'high' | 'critical';

export interface RuleLike {
  minValue: number | null; maxValue: number | null; criticalMin: number | null; criticalMax: number | null;
}

/**
 * Resolve the most specific active threshold rule for a reading.
 * Precedence: patient-specific > device-type > branch > organization default.
 */
export async function resolveRule(tenantId: string, opts: { readingType: string; patientId?: string | null; deviceType?: string | null; branchId?: string | null }) {
  const rules = await db.monitoringRule.findMany({
    where: { tenantId, readingType: opts.readingType, active: true },
  });
  const score = (r: typeof rules[number]): number => {
    if (r.scope === 'patient' && r.patientId && r.patientId === opts.patientId) return 4;
    if (r.scope === 'device_type' && r.deviceType && r.deviceType === opts.deviceType) return 3;
    if (r.scope === 'branch' && r.branchId && r.branchId === opts.branchId) return 2;
    if (r.scope === 'organization') return 1;
    return 0;
  };
  return rules
    .map(r => ({ r, s: score(r) }))
    .filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || b.r.priority - a.r.priority)[0]?.r ?? null;
}

/**
 * Decide severity for a numeric reading. Backend-only — the frontend never
 * computes this. Returns severity + a human-readable operational reason.
 */
export function evaluateSeverity(readingType: string, numericValue: number | null, rule: RuleLike | null): { severity: Severity; reason: string } {
  const band = DEFAULT_THRESHOLDS[readingType];
  if (numericValue == null || (!band && !rule)) {
    return { severity: 'normal', reason: 'No threshold configured — recorded for trend tracking.' };
  }
  const min = rule?.minValue ?? band?.min ?? -Infinity;
  const max = rule?.maxValue ?? band?.max ?? Infinity;
  const critMin = rule?.criticalMin ?? band?.critMin ?? -Infinity;
  const critMax = rule?.criticalMax ?? band?.critMax ?? Infinity;
  const unit = band?.unit ?? '';
  const label = band?.label ?? readingType;

  if (numericValue <= critMin || numericValue >= critMax) {
    return { severity: 'critical', reason: `${label} ${numericValue}${unit} is in the critical range (safe band ${min}–${max}${unit}). Doctor review needed.` };
  }
  if (numericValue < min || numericValue > max) {
    return { severity: 'high', reason: `${label} ${numericValue}${unit} is outside the expected range (${min}–${max}${unit}). Nurse follow-up recommended.` };
  }
  // Borderline within 5% of a bound → warning.
  const span = (max - min) || 1;
  if (numericValue - min < span * 0.05 || max - numericValue < span * 0.05) {
    return { severity: 'warning', reason: `${label} ${numericValue}${unit} is near the edge of the expected range (${min}–${max}${unit}). Monitor next reading.` };
  }
  return { severity: 'normal', reason: `${label} ${numericValue}${unit} within expected range.` };
}

export const SEVERITY_RANK: Record<string, number> = { normal: 0, warning: 1, high: 2, critical: 3 };

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
