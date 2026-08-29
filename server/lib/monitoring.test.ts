import { describe, it, expect } from 'vitest';
import { evaluateSeverity, evaluateWeight, evaluateEcg, DEFAULT_THRESHOLDS, WEIGHT_DAILY_GAIN_KG } from './monitoring';

// ── Fix 1: diastolic BP is evaluated (worst of systolic/diastolic) ───────────
describe('blood pressure — diastolic is evaluated (hypertensive crisis)', () => {
  it('120/130 → critical (diastolic 130 ≥120 crisis, systolic normal)', () => {
    const r = evaluateSeverity('blood_pressure', 120, null, { valueSecondary: 130 });
    expect(r.severity).toBe('critical');
  });
  it('118/78 → normal (both halves in range)', () => {
    expect(evaluateSeverity('blood_pressure', 118, null, { valueSecondary: 78 }).severity).toBe('normal');
  });
  it('diastolic 110 → high even with a normal systolic', () => {
    expect(evaluateSeverity('blood_pressure', 120, null, { valueSecondary: 110 }).severity).toBe('high');
  });
  it('systolic crisis still fires (worst-of preserved): 190/80 → critical', () => {
    expect(evaluateSeverity('blood_pressure', 190, null, { valueSecondary: 80 }).severity).toBe('critical');
  });
  it('has a dedicated diastolic default band', () => {
    expect(DEFAULT_THRESHOLDS.blood_pressure_diastolic.critMax).toBe(120);
  });
});

// ── Fix 2a: weight alerts on rapid change vs baseline (CHF signal) ────────────
describe('weight — CHF fluid-overload delta', () => {
  it('rapid daily gain ≥1.4kg vs last reading → high', () => {
    expect(evaluateWeight(82, { recentKg: 80 }).severity).toBe('high');
  });
  it('weekly gain ≥2.3kg → high', () => {
    expect(evaluateWeight(82, { recentKg: 81.5, weekAgoKg: 79 }).severity).toBe('high');
  });
  it('stable weight → normal', () => {
    expect(evaluateWeight(80.3, { recentKg: 80, weekAgoKg: 79.5 }).severity).toBe('normal');
  });
  it('no baseline → normal (recorded for trend, never a false alert)', () => {
    expect(evaluateWeight(80, null).severity).toBe('normal');
  });
  it('converts lb→kg before comparing (evaluateSeverity path)', () => {
    // 180 lb ≈ 81.6 kg vs 175 lb ≈ 79.4 kg baseline → +2.2 kg ≥ daily threshold.
    const r = evaluateSeverity('weight', 180, null, { unit: 'lb', weight: { recentKg: 175 * 0.45359237 } });
    expect(r.severity).toBe('high');
    expect(WEIGHT_DAILY_GAIN_KG).toBeLessThan(2.2);
  });
});

// ── Fix 2b: ECG alerts on abnormal rhythm classification ─────────────────────
describe('ecg — rhythm classification', () => {
  it('AFib → critical', () => {
    expect(evaluateSeverity('ecg', null, null, { ecgClassification: 'AFib' }).severity).toBe('critical');
    expect(evaluateEcg('atrial fibrillation').severity).toBe('critical');
  });
  it('irregular → high', () => {
    expect(evaluateEcg('irregular').severity).toBe('high');
  });
  it('normal sinus rhythm → normal', () => {
    expect(evaluateEcg('Normal Sinus Rhythm').severity).toBe('normal');
  });
  it('absent classification → normal (held for review, no false alert)', () => {
    expect(evaluateSeverity('ecg', null, null, {}).severity).toBe('normal');
  });
});

// Regression: previously weight/ecg were accepted types with NO band → always
// normal. Confirm the plain (contextless) call no longer silently passes them
// when the classification/baseline says otherwise, while glucose is unchanged.
describe('regression — existing numeric bands unchanged', () => {
  it('glucose critical/high/normal still hold', () => {
    expect(evaluateSeverity('glucose', 320, null).severity).toBe('critical');
    expect(evaluateSeverity('glucose', 210, null).severity).toBe('high');
    expect(evaluateSeverity('glucose', 110, null).severity).toBe('normal');
  });
});

// ── Fix 3: directional edge warnings ─────────────────────────────────────────
// The proximity warning used to fire on BOTH edges of every band. For oxygen
// the high edge is 100% — a physiologically perfect reading — so every ideal
// pulse-ox result manufactured a `warning` ReadingAlert AND a NotificationEvent.
// Those rows then consumed slots in the alert queue's fixed window, pushing real
// open criticals out of the nurse's view. Normal readings must stay silent.
describe('edge warnings are directional (no alerts on ideal readings)', () => {
  it('SpO2 100% → normal (the high edge is the best possible result)', () => {
    expect(evaluateSeverity('oxygen', 100, null).severity).toBe('normal');
  });
  it('SpO2 99% and 98% → normal', () => {
    expect(evaluateSeverity('oxygen', 99, null).severity).toBe('normal');
    expect(evaluateSeverity('oxygen', 98, null).severity).toBe('normal');
  });
  it('SpO2 92% → warning (the LOW edge still matters — desaturation)', () => {
    expect(evaluateSeverity('oxygen', 92, null).severity).toBe('warning');
  });
  it('SpO2 90% → high, 88% → critical (leaving the band is unchanged)', () => {
    expect(evaluateSeverity('oxygen', 90, null).severity).toBe('high');
    expect(evaluateSeverity('oxygen', 88, null).severity).toBe('critical');
  });
  it('oxygen declares a low-only edge; the other bands stay two-sided', () => {
    expect(DEFAULT_THRESHOLDS.oxygen.edgeWarn).toBe('low');
    expect(DEFAULT_THRESHOLDS.glucose.edgeWarn).toBe('both');
    expect(DEFAULT_THRESHOLDS.heart_rate.edgeWarn).toBe('both');
  });
  it('two-sided bands still warn near BOTH edges (glucose 70 / 178, HR 50)', () => {
    expect(evaluateSeverity('glucose', 70, null).severity).toBe('warning');
    expect(evaluateSeverity('glucose', 178, null).severity).toBe('warning');
    expect(evaluateSeverity('heart_rate', 50, null).severity).toBe('warning');
  });
  it('a rule can override the direction per patient', () => {
    const silent = { minValue: null, maxValue: null, criticalMin: null, criticalMax: null, edgeWarn: 'none' as const };
    expect(evaluateSeverity('glucose', 70, silent).severity).toBe('normal');
    // …without weakening the out-of-band result.
    expect(evaluateSeverity('glucose', 320, silent).severity).toBe('critical');
  });
  it('names which edge drove the warning', () => {
    expect(evaluateSeverity('oxygen', 92, null).reason).toContain('low edge');
    expect(evaluateSeverity('glucose', 178, null).reason).toContain('high edge');
  });
});
