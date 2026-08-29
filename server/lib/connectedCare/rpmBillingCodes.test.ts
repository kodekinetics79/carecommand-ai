import { describe, it, expect } from 'vitest';
import {
  resolveRpmCodeLadder,
  hasBillableEvidence,
  RPM_CODE_SET_VERSION,
  type RpmLadderInput,
} from './rpmBillingCodes';

const base: RpmLadderInput = {
  readingDays: 0,
  reviewMinutes: 0,
  interactiveCommunication: false,
  setupAlreadyBilled: true,
  consentGranted: true,
  enrollmentActive: true,
};
const codes = (i: Partial<RpmLadderInput>) =>
  resolveRpmCodeLadder({ ...base, ...i }).candidates.map(c => c.code).sort();
const unitsFor = (i: Partial<RpmLadderInput>, code: string) =>
  resolveRpmCodeLadder({ ...base, ...i }).candidates.find(c => c.code === code)?.units ?? 0;

describe('supply codes — 99445 XOR 99454', () => {
  it('16+ device-days → 99454', () => {
    expect(codes({ readingDays: 16 })).toEqual(['99454']);
    expect(codes({ readingDays: 30 })).toEqual(['99454']);
  });

  // The entire point of the CY2026 change. The old boolean gate reported these
  // months as failures; they are billable, at parity with a full month.
  it('2-15 device-days → 99445, which the old 16-day gate reported as $0', () => {
    expect(codes({ readingDays: 2 })).toEqual(['99445']);
    expect(codes({ readingDays: 9 })).toEqual(['99445']);
    expect(codes({ readingDays: 15 })).toEqual(['99445']);
  });

  it('never emits both supply codes — they are mutually exclusive, not a ladder', () => {
    for (const readingDays of [2, 8, 15, 16, 25, 31]) {
      const emitted = codes({ readingDays });
      expect(emitted.filter(c => c === '99445' || c === '99454')).toHaveLength(1);
    }
  });

  it('0-1 device-days supports no supply code', () => {
    expect(codes({ readingDays: 0 })).toEqual([]);
    expect(codes({ readingDays: 1 })).toEqual([]);
  });

  it('tells the clinic how far off it is rather than just failing', () => {
    const r = resolveRpmCodeLadder({ ...base, readingDays: 1 });
    expect(r.nextActions.join(' ')).toContain('1 more device-day');
  });
});

describe('management codes — 99470 XOR (99457 + 99458xN)', () => {
  it('20+ minutes with a live communication → 99457', () => {
    expect(codes({ reviewMinutes: 20, interactiveCommunication: true })).toEqual(['99457']);
  });

  it('10-19 minutes with a live communication → 99470', () => {
    expect(codes({ reviewMinutes: 10, interactiveCommunication: true })).toEqual(['99470']);
    expect(codes({ reviewMinutes: 19, interactiveCommunication: true })).toEqual(['99470']);
  });

  it('under 10 minutes supports no management code', () => {
    expect(codes({ reviewMinutes: 9, interactiveCommunication: true })).toEqual([]);
  });

  it('99458 units count only COMPLETE additional 20-minute increments', () => {
    expect(unitsFor({ reviewMinutes: 39, interactiveCommunication: true }, '99458')).toBe(0);
    expect(unitsFor({ reviewMinutes: 40, interactiveCommunication: true }, '99458')).toBe(1);
    expect(unitsFor({ reviewMinutes: 59, interactiveCommunication: true }, '99458')).toBe(1);
    expect(unitsFor({ reviewMinutes: 60, interactiveCommunication: true }, '99458')).toBe(2);
  });

  // THE CLAIM-INTEGRITY TEST. 99458 is an add-on to 99457 only. Pairing it with
  // 99470 would put mutually exclusive codes on one claim — the exact shape that
  // lands a practice on an OIG outlier list. Reaching 20 minutes moves the month
  // to 99457, so the pair is unreachable by construction. Asserted, not assumed.
  it('NEVER pairs 99458 with 99470, at any minute count', () => {
    for (let reviewMinutes = 0; reviewMinutes <= 200; reviewMinutes++) {
      const emitted = codes({ reviewMinutes, interactiveCommunication: true });
      if (emitted.includes('99458')) {
        expect(emitted).toContain('99457');
        expect(emitted).not.toContain('99470');
      }
      expect(emitted.includes('99470') && emitted.includes('99457')).toBe(false);
    }
  });

  // CMS adopted CPT's "live, interactive communication" language in CY2026 and
  // declined to extend it to asynchronous messaging.
  it('withholds every management code without a live interactive communication', () => {
    expect(codes({ reviewMinutes: 45, interactiveCommunication: false })).toEqual([]);
    const r = resolveRpmCodeLadder({ ...base, reviewMinutes: 45, interactiveCommunication: false });
    expect(r.nextActions.join(' ')).toContain('live interactive communication');
    expect(r.nextActions.join(' ')).toContain('Texts and voicemails do not qualify');
  });
});

describe('the two code families are independent', () => {
  // The defect that made the old model structurally wrong: it ANDed supply and
  // management into one boolean, so a clean device-supply month reported $0
  // because nobody had logged 20 minutes.
  it('a device-supply month is billable with ZERO review minutes', () => {
    expect(codes({ readingDays: 20, reviewMinutes: 0 })).toEqual(['99454']);
    expect(hasBillableEvidence(resolveRpmCodeLadder({ ...base, readingDays: 20 }))).toBe(true);
  });

  it('a management month is billable with fewer than 16 device-days', () => {
    expect(codes({ readingDays: 0, reviewMinutes: 25, interactiveCommunication: true })).toEqual(['99457']);
  });

  it('covers the full matrix the old single gate collapsed to two states', () => {
    expect(codes({ readingDays: 20, reviewMinutes: 25, interactiveCommunication: true })).toEqual(['99454', '99457']);
    expect(codes({ readingDays: 20, reviewMinutes: 12, interactiveCommunication: true })).toEqual(['99454', '99470']);
    expect(codes({ readingDays: 8, reviewMinutes: 25, interactiveCommunication: true })).toEqual(['99445', '99457']);
    expect(codes({ readingDays: 8, reviewMinutes: 12, interactiveCommunication: true })).toEqual(['99445', '99470']);
    expect(codes({ readingDays: 8, reviewMinutes: 0 })).toEqual(['99445']);
  });
});

describe('setup / education — 99453', () => {
  it('needs only 2 device-days (CY2026 dropped it from 16)', () => {
    expect(codes({ setupAlreadyBilled: false, readingDays: 2 })).toEqual(['99445', '99453']);
  });
  it('is withheld below 2 device-days', () => {
    expect(codes({ setupAlreadyBilled: false, readingDays: 1 })).toEqual([]);
  });
  it('is not repeated once billed for the episode', () => {
    expect(codes({ setupAlreadyBilled: true, readingDays: 20 })).toEqual(['99454']);
  });
});

describe('blockers suppress everything', () => {
  it('no consent → no codes, whatever the evidence shows', () => {
    const r = resolveRpmCodeLadder({ ...base, consentGranted: false, readingDays: 30, reviewMinutes: 60, interactiveCommunication: true });
    expect(r.candidates).toEqual([]);
    expect(r.blockers).toContain('No active RPM consent on record');
    expect(r.nextActions.join(' ')).toContain('cost-sharing');
  });
  it('no active enrollment → no codes', () => {
    const r = resolveRpmCodeLadder({ ...base, enrollmentActive: false, readingDays: 30 });
    expect(r.candidates).toEqual([]);
    expect(r.blockers).toContain('No active RPM enrollment');
  });
});

describe('output contract', () => {
  it('stamps the code-set version so a stored result is interpretable later', () => {
    expect(resolveRpmCodeLadder(base).codeSetVersion).toBe(RPM_CODE_SET_VERSION);
  });
  it('carries no dollar amounts — rates are revalued and belong in config', () => {
    const serialized = JSON.stringify(resolveRpmCodeLadder({ ...base, readingDays: 20, reviewMinutes: 40, interactiveCommunication: true }));
    expect(serialized).not.toMatch(/\$|amount|rate|usd/i);
  });
  it('every candidate explains itself in plain language', () => {
    for (const c of resolveRpmCodeLadder({ ...base, readingDays: 20, reviewMinutes: 40, interactiveCommunication: true }).candidates) {
      expect(c.rationale.length).toBeGreaterThan(20);
      expect(['setup', 'supply', 'management']).toContain(c.family);
    }
  });
  it('marks supply as 30-day and management as calendar-month — they differ', () => {
    const r = resolveRpmCodeLadder({ ...base, readingDays: 20, reviewMinutes: 25, interactiveCommunication: true });
    expect(r.candidates.find(c => c.code === '99454')?.periodBasis).toBe('rolling_30_day');
    expect(r.candidates.find(c => c.code === '99457')?.periodBasis).toBe('calendar_month');
  });
});

describe('99458 Medically Unlikely Edit ceiling', () => {
  // A claim exceeding the MUE is denied IN FULL — the entire line, not just the
  // excess units. Reporting an uncapped count would convert a clinic's most
  // productive months into total denials.
  it('never reports more than 3 units, however many minutes were worked', () => {
    for (const reviewMinutes of [100, 140, 200, 400, 1000]) {
      expect(unitsFor({ reviewMinutes, interactiveCommunication: true }, '99458'))
        .toBeLessThanOrEqual(3);
    }
  });

  it('still reports the units actually earned below the ceiling', () => {
    expect(unitsFor({ reviewMinutes: 40, interactiveCommunication: true }, '99458')).toBe(1);
    expect(unitsFor({ reviewMinutes: 60, interactiveCommunication: true }, '99458')).toBe(2);
    expect(unitsFor({ reviewMinutes: 80, interactiveCommunication: true }, '99458')).toBe(3);
    expect(unitsFor({ reviewMinutes: 100, interactiveCommunication: true }, '99458')).toBe(3);
  });

  it('surfaces the excess time rather than silently discarding it', () => {
    const r = resolveRpmCodeLadder({ ...base, reviewMinutes: 140, interactiveCommunication: true });
    const notes = r.nextActions.join(' ');
    expect(notes).toContain('Medically Unlikely Edit');
    expect(notes).toContain('denied in full');
  });
});
