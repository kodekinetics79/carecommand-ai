import { describe, expect, it } from 'vitest';
import { mapReview, mapTelehealthSession, type ApiReview, type ReviewRow } from './apiAdapters';

/**
 * `GET /v1/reviews` returns the stored Review row and nothing else: no author
 * relation, and `platform` / `sentiment` are free-text columns. The previous
 * mapping invented what it could not read — one canned author name on every
 * row, every non-Google platform folded into "internal", and any unrecognised
 * sentiment relabelled "neutral". Each of those turned an absence into a claim.
 *
 * These are the cheapest tests in the suite and they guard the two figures the
 * Reviews screen prints: the average rating and the positive-sentiment share.
 */

const KNOWN_ROW_KEYS = [
  'id', 'branchId', 'rating', 'text', 'platform', 'date', 'responded', 'storedResponse', 'sentiment',
].sort();

function apiReview(overrides: Partial<ApiReview> = {}): ApiReview {
  return {
    id: 'review-1',
    branchId: 'branch-1',
    rating: 5,
    text: 'The nurse explained everything clearly.',
    platform: 'google',
    createdAt: '2026-08-02T09:30:00.000Z',
    responded: false,
    aiDraftResponse: null,
    sentiment: 'positive',
    ...overrides,
  };
}

describe('mapReview platform', () => {
  it('keeps a non-Google platform exactly as it was stored', () => {
    // A Yelp review displayed as "internal" tells staff a stranger's public
    // review is a first-party comment they can quietly deal with in-house.
    const row = mapReview(apiReview({ platform: 'yelp' }));

    expect(row.platform).toBe('yelp');
    expect(row.platform).not.toBe('internal');
  });

  it('keeps every other stored platform verbatim too', () => {
    for (const platform of ['facebook', 'trustpilot', 'healthgrades', 'google']) {
      expect(mapReview(apiReview({ platform })).platform).toBe(platform);
    }
  });

  it('reports a blank platform as blank rather than picking one', () => {
    expect(mapReview(apiReview({ platform: '   ' })).platform).toBe('');
  });
});

describe('mapReview sentiment', () => {
  it('keeps the three sentiments the product actually defines', () => {
    for (const sentiment of ['positive', 'neutral', 'negative'] as const) {
      expect(mapReview(apiReview({ sentiment })).sentiment).toBe(sentiment);
    }
  });

  it('reports an unrecognised sentiment as unclassified, never as neutral', () => {
    for (const sentiment of ['mixed', 'unknown', '', 'POSITIVE']) {
      const row = mapReview(apiReview({ sentiment }));
      expect(row.sentiment).toBeNull();
      expect(row.sentiment).not.toBe('neutral');
    }
  });

  it('leaves an unclassified row out of the positive share instead of counting against it', () => {
    // The screen's arithmetic, run over a mapped set: the denominator is the
    // rows that carry a known sentiment. Relabelling the unrecognised row
    // "neutral" would put it in the denominator and halve a 100% positive
    // reading to 50% — a fabricated complaint.
    const rows: ReviewRow[] = [
      mapReview(apiReview({ id: 'r-1', sentiment: 'positive' })),
      mapReview(apiReview({ id: 'r-2', sentiment: 'mixed' })),
    ];

    const classified = rows.filter(row => row.sentiment != null);
    const positive = rows.filter(row => row.sentiment === 'positive');

    expect(classified).toHaveLength(1);
    expect(Math.round((positive.length / classified.length) * 100)).toBe(100);
  });
});

describe('mapReview rating', () => {
  it('keeps a stored numeric rating', () => {
    expect(mapReview(apiReview({ rating: 4 })).rating).toBe(4);
  });

  it('reports a non-numeric rating as absent rather than NaN', () => {
    // NaN reaches the screen as "NaN", flows into the average, and makes every
    // rated figure on the page unreadable. Absent is the honest reading.
    const row = mapReview(apiReview({ rating: 'not recorded' as unknown as number }));

    expect(row.rating).toBeNull();
    expect(Number.isNaN(row.rating as unknown as number)).toBe(false);
  });

  it('reports every unparseable shape the free-text column can hold as absent', () => {
    for (const rating of ['five', 'n/a', '4.5 stars', undefined, {}] as unknown as number[]) {
      expect(mapReview(apiReview({ rating })).rating).toBeNull();
    }
  });
});

describe('mapReview author', () => {
  it('carries no author field, because the endpoint returns no author', () => {
    const row = mapReview(apiReview());

    for (const invented of ['author', 'authorName', 'reviewer', 'reviewerName', 'patientName', 'name', 'customerName']) {
      expect(row).not.toHaveProperty(invented);
    }
  });

  it('exposes only the fields the stored row can support', () => {
    // An exact key set on purpose. Adding a key here is a decision about
    // whether the API really answers it; it should not be possible to slip a
    // display name back in as an incidental extra property.
    expect(Object.keys(mapReview(apiReview())).sort()).toEqual(KNOWN_ROW_KEYS);
  });

  it('invents no value for the absent draft response', () => {
    expect(mapReview(apiReview({ aiDraftResponse: null })).storedResponse).toBeUndefined();
    expect(mapReview(apiReview({ aiDraftResponse: 'A stored draft.' })).storedResponse).toBe('A stored draft.');
  });
});

describe('mapTelehealthSession', () => {
  it('keeps canceled and no-show appointments distinct from pending work', () => {
    const base = {
      id: 'visit-1', patientName: 'Synthetic Patient', service: 'Video consultation',
      startsAt: '2026-09-02T13:00:00.000Z', provider: 'Dr Synthetic', providerProfileId: 'provider-1',
      branchName: 'Bright Health Arlington', branchTimezone: 'America/New_York', value: '125',
      noShowRisk: 0, intakeComplete: false,
    };
    expect(mapTelehealthSession({ ...base, status: 'CANCELED' }).status).toBe('Canceled');
    expect(mapTelehealthSession({ ...base, status: 'NO_SHOW' }).status).toBe('No-show');
  });

  it('formats the visit in the clinic timezone rather than the browser timezone', () => {
    const row = mapTelehealthSession({
      id: 'visit-1', patientName: 'Synthetic Patient', service: 'Video consultation',
      startsAt: '2026-09-03T01:30:00.000Z', status: 'CONFIRMED', provider: 'Dr Synthetic',
      providerProfileId: 'provider-1', branchName: 'Bright Health Arlington', branchTimezone: 'America/New_York',
      value: '125', noShowRisk: 0, intakeComplete: true,
    });
    expect(row.date).toBe('2026-09-02');
    expect(row.time).toBe('9:30 PM');
  });
});
