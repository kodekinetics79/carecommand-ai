/**
 * RPM billing-code ladder (CY2026).
 *
 * WHAT THIS IS NOT: coding advice, a claim, a medical-necessity determination,
 * or a payment guarantee. It reports which codes the RECORDED EVIDENCE could
 * support so a human coder can decide. Nothing here submits anything.
 *
 * Why a ladder replaced a single READY boolean
 * ────────────────────────────────────────────
 * The previous model was one gate: >=16 device-days AND >=20 review minutes.
 * That was built to pre-2026 rules and is structurally wrong in three ways.
 *
 * 1. CY2026 created two codes that pay for exactly the work the old gate threw
 *    away: 99445 (2-15 device-days, paid at PARITY with 99454) and 99470
 *    (first 10-19 minutes). Effective 2026-01-01.
 * 2. Device supply and treatment management are INDEPENDENT code families with
 *    separate requirements. CMS confirmed the 16-day rule does not apply to the
 *    management codes (88 FR 78884) and declined to make 99454 a precondition
 *    for 99458 (90 FR 49399). ANDing them into one boolean reported $0 for a
 *    patient with a clean, billable device-supply month.
 * 3. There was no ceiling: minutes above 20 produced no additional output, so
 *    99458 could not be represented at all.
 *
 * Under the old gate, 5 of 7 realistic patient-month states reported $0. Real
 * adherence data makes those states the norm, not the exception — which is
 * precisely why CMS created the short-duration codes.
 *
 * Mutual exclusivity is load-bearing
 * ──────────────────────────────────
 * 99445 XOR 99454 — same 30-day period, never both.
 * 99470 XOR 99457 — same calendar month, never both.
 * 99458 attaches to 99457 ONLY. It never attaches to 99470: by construction,
 * reaching 20 minutes moves the month to 99457. Emitting 99470 + 99458 would be
 * a mutually-exclusive pair on one claim — the exact shape that lands a practice
 * on an OIG outlier list. This is asserted by a test, not just a comment.
 *
 * Period semantics differ BY FAMILY
 * ─────────────────────────────────
 * The descriptors are explicit: supply codes are "in a 30-day period", while
 * management codes are "in a calendar month". Treating both as a calendar month
 * splits a patient transmitting across a month boundary into two failing halves
 * and makes February structurally short.
 *
 * Rates are NOT hardcoded here
 * ────────────────────────────
 * A CY2026 correction rule (91 FR 12071) revised the supply-code PE RVUs after
 * publication, and every RPM code is scheduled for RUC resurvey in Jan 2028.
 * Any rate baked into source is a future lie. Amounts live in tenant-editable
 * configuration; this module reports CODES and UNITS only.
 */

export const RPM_CODE_SET_VERSION = 'cms-cy2026';

/** Minimum device-days for the short-duration supply code (99445). */
export const RPM_SUPPLY_MIN_DAYS = 2;
/** Device-days at which supply moves from 99445 to 99454. */
export const RPM_SUPPLY_FULL_DAYS = 16;
/** Minimum minutes for the short-duration management code (99470). */
export const RPM_MGMT_SHORT_MIN_MINUTES = 10;
/** Minutes at which management moves from 99470 to 99457. */
export const RPM_MGMT_FULL_MINUTES = 20;
/** Each additional increment billable as 99458 on top of 99457. */
export const RPM_MGMT_INCREMENT_MINUTES = 20;
/**
 * Medically Unlikely Edit ceiling for 99458 units on a single claim.
 *
 * This is a HARD cap, not a rounding preference: a claim submitted with more
 * than the MUE is denied IN FULL — the whole line, not merely the excess units.
 * Reporting an uncapped unit count would therefore turn a clinic's most
 * productive months into total denials, which is strictly worse than reporting
 * fewer units. Excess minutes are surfaced as a note instead so the time is
 * visible to a coder rather than silently discarded.
 */
export const RPM_MGMT_ADDITIONAL_MUE_LIMIT = 3;
/** Minimum device-days before setup/education (99453) may be reported. */
export const RPM_SETUP_MIN_DAYS = 2;

export type RpmCodeFamily = 'setup' | 'supply' | 'management';

export interface RpmCandidateCode {
  code: string;
  family: RpmCodeFamily;
  units: number;
  /** Plain-language reason this code is supported by the recorded evidence. */
  rationale: string;
  /** Period semantics this code is measured over. */
  periodBasis: 'rolling_30_day' | 'calendar_month';
}

export interface RpmLadderInput {
  /** Distinct days with a qualifying reading in the supply period. */
  readingDays: number;
  /** Clinical review minutes recorded in the calendar month. */
  reviewMinutes: number;
  /** A live interactive communication occurred this month. */
  interactiveCommunication: boolean;
  /** Setup/education has not already been billed for this enrollment. */
  setupAlreadyBilled: boolean;
  consentGranted: boolean;
  enrollmentActive: boolean;
}

export interface RpmLadderResult {
  codeSetVersion: typeof RPM_CODE_SET_VERSION;
  /** Codes the recorded evidence could support. Empty is a valid answer. */
  candidates: RpmCandidateCode[];
  /** Blocking conditions that suppress ALL codes. */
  blockers: string[];
  /** Concrete, ranked next steps that would unlock additional codes. */
  nextActions: string[];
}

/**
 * Map recorded evidence to the set of candidate codes. Pure and total — no I/O,
 * no clock. Every branch is covered by tests in rpmBillingCodes.test.ts.
 */
export function resolveRpmCodeLadder(input: RpmLadderInput): RpmLadderResult {
  const blockers: string[] = [];
  if (!input.consentGranted) blockers.push('No active RPM consent on record');
  if (!input.enrollmentActive) blockers.push('No active RPM enrollment');

  if (blockers.length > 0) {
    return {
      codeSetVersion: RPM_CODE_SET_VERSION,
      candidates: [],
      blockers,
      nextActions: blockers.includes('No active RPM consent on record')
        ? ['Capture and document RPM consent, including the patient\'s cost-sharing responsibility']
        : ['Enroll the patient in an RPM program and bind the device they were given'],
    };
  }

  const candidates: RpmCandidateCode[] = [];
  const nextActions: string[] = [];

  // ── Setup / education (99453) ──────────────────────────────────────────────
  // CY2026 dropped this from 16 days to 2 (90 FR 49399). One-time per episode.
  if (!input.setupAlreadyBilled) {
    if (input.readingDays >= RPM_SETUP_MIN_DAYS) {
      candidates.push({
        code: '99453', family: 'setup', units: 1, periodBasis: 'rolling_30_day',
        rationale: `Setup and patient education, supported by ${input.readingDays} recorded device-days (requires ${RPM_SETUP_MIN_DAYS}). Reportable once per episode of care.`,
      });
    } else {
      nextActions.push(`${RPM_SETUP_MIN_DAYS - input.readingDays} more device-day(s) would support setup/education (99453).`);
    }
  }

  // ── Device supply: 99445 XOR 99454 ─────────────────────────────────────────
  if (input.readingDays >= RPM_SUPPLY_FULL_DAYS) {
    candidates.push({
      code: '99454', family: 'supply', units: 1, periodBasis: 'rolling_30_day',
      rationale: `${input.readingDays} device-days recorded in the 30-day period (requires ${RPM_SUPPLY_FULL_DAYS}).`,
    });
  } else if (input.readingDays >= RPM_SUPPLY_MIN_DAYS) {
    // The whole point of the CY2026 change: this month is billable, and at the
    // same rate as a full month. The old gate reported it as a failure.
    candidates.push({
      code: '99445', family: 'supply', units: 1, periodBasis: 'rolling_30_day',
      rationale: `${input.readingDays} device-days recorded in the 30-day period (short-duration supply covers ${RPM_SUPPLY_MIN_DAYS}-${RPM_SUPPLY_FULL_DAYS - 1}). Paid at parity with a full month — chasing more days does not increase this line.`,
    });
  } else {
    nextActions.push(`${RPM_SUPPLY_MIN_DAYS - input.readingDays} more device-day(s) would support device supply (99445).`);
  }

  // ── Treatment management: 99470 XOR (99457 + 99458 x N) ────────────────────
  // Both management codes require a live interactive communication. CMS adopted
  // CPT's "live, interactive" language in CY2026 (90 FR 49397) and expressly
  // declined to extend it to asynchronous messaging.
  if (input.reviewMinutes >= RPM_MGMT_FULL_MINUTES) {
    if (input.interactiveCommunication) {
      candidates.push({
        code: '99457', family: 'management', units: 1, periodBasis: 'calendar_month',
        rationale: `${input.reviewMinutes} clinical review minutes with a recorded live interactive communication (requires ${RPM_MGMT_FULL_MINUTES}).`,
      });
      // 99458 attaches HERE and only here.
      const earned = Math.floor((input.reviewMinutes - RPM_MGMT_FULL_MINUTES) / RPM_MGMT_INCREMENT_MINUTES);
      const additional = Math.min(earned, RPM_MGMT_ADDITIONAL_MUE_LIMIT);
      if (additional > 0) {
        candidates.push({
          code: '99458', family: 'management', units: additional, periodBasis: 'calendar_month',
          rationale: `${additional} additional complete ${RPM_MGMT_INCREMENT_MINUTES}-minute increment(s) beyond the first ${RPM_MGMT_FULL_MINUTES}.`,
        });
      }
      if (earned > additional) {
        // Never silently drop it: say so, so a coder can decide.
        nextActions.push(`${earned} additional increments were earned but only ${RPM_MGMT_ADDITIONAL_MUE_LIMIT} are reportable — 99458 has a Medically Unlikely Edit ceiling of ${RPM_MGMT_ADDITIONAL_MUE_LIMIT} units and a claim exceeding it is denied in full. Review the remaining ${(earned - additional) * RPM_MGMT_INCREMENT_MINUTES} minute(s) with your coder.`);
      }
      const towardNext = (input.reviewMinutes - RPM_MGMT_FULL_MINUTES) % RPM_MGMT_INCREMENT_MINUTES;
      if (towardNext > 0) {
        nextActions.push(`${RPM_MGMT_INCREMENT_MINUTES - towardNext} more review minute(s) would support another 99458 increment.`);
      }
    } else {
      nextActions.push('A live interactive communication (phone, video, or live chat) is required before any management code can be supported. Texts and voicemails do not qualify.');
    }
  } else if (input.reviewMinutes >= RPM_MGMT_SHORT_MIN_MINUTES) {
    if (input.interactiveCommunication) {
      candidates.push({
        code: '99470', family: 'management', units: 1, periodBasis: 'calendar_month',
        rationale: `${input.reviewMinutes} clinical review minutes with a recorded live interactive communication (short-duration management covers ${RPM_MGMT_SHORT_MIN_MINUTES}-${RPM_MGMT_FULL_MINUTES - 1}).`,
      });
      nextActions.push(`${RPM_MGMT_FULL_MINUTES - input.reviewMinutes} more review minute(s) would move this month from 99470 to 99457.`);
    } else {
      nextActions.push('A live interactive communication (phone, video, or live chat) is required before any management code can be supported. Texts and voicemails do not qualify.');
    }
  } else {
    nextActions.push(`${RPM_MGMT_SHORT_MIN_MINUTES - input.reviewMinutes} more review minute(s) would support treatment management (99470).`);
  }

  return { codeSetVersion: RPM_CODE_SET_VERSION, candidates, blockers, nextActions };
}

/** True when the recorded evidence supports at least one billable code. */
export function hasBillableEvidence(result: RpmLadderResult): boolean {
  return result.candidates.length > 0;
}
