// RPM billing readiness rules engine. OPERATIONAL readiness only — this never
// submits a claim and is not billing/coding advice. Thresholds mirror common
// CMS RPM expectations (≥16 device-days, ≥20 clinical minutes per period) but
// the final decision is a human's (provider signoff).

export const RPM_MIN_READING_DAYS = 16;
export const RPM_MIN_REVIEW_MINUTES = 20;

export type ReadinessStatus = 'READY' | 'NEEDS_REVIEW' | 'MISSING_REQUIREMENTS';

export interface ReadinessInput {
  consentGranted: boolean;
  enrollmentActive: boolean;
  readingDays: number;
  reviewMinutes: number;
  communicationFlag: boolean;
  providerSignoff: boolean;
}

export interface ReadinessResult {
  status: ReadinessStatus;
  missing: string[];
  requirements: { key: string; label: string; met: boolean }[];
}

export function computeRpmReadiness(i: ReadinessInput): ReadinessResult {
  const requirements = [
    { key: 'consent', label: 'Active RPM consent', met: i.consentGranted },
    { key: 'enrollment', label: 'Active enrollment', met: i.enrollmentActive },
    { key: 'reading_days', label: `${RPM_MIN_READING_DAYS} device-days of valid readings`, met: i.readingDays >= RPM_MIN_READING_DAYS },
    { key: 'review_minutes', label: `${RPM_MIN_REVIEW_MINUTES} clinical review minutes`, met: i.reviewMinutes >= RPM_MIN_REVIEW_MINUTES },
    { key: 'communication', label: 'Patient communication this period', met: i.communicationFlag },
  ];
  const missing = requirements.filter(r => !r.met).map(r => r.label);

  // Hard data requirements unmet → cannot bill yet.
  if (missing.length > 0) {
    return { status: 'MISSING_REQUIREMENTS', missing, requirements };
  }
  // Data complete but a human must sign off before it's billable.
  if (!i.providerSignoff) {
    return { status: 'NEEDS_REVIEW', missing: ['Provider signoff'], requirements };
  }
  return { status: 'READY', missing: [], requirements };
}
