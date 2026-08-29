import { describe, expect, it } from 'vitest';
import { campaignRoiFromRow } from './dashboardService';

/**
 * The dashboard's campaign row, read honestly.
 *
 * `Campaign.booked` and `.revenue` are no longer columns any code path writes:
 * database triggers maintain them as a rollup of CampaignAttribution
 * (booked = COUNT of 'booked' outcomes, revenue = SUM of attributed 'paid'
 * value, and a 'paid' row is only ever written for a net above zero). So a
 * positive value is evidence and a zero is the ABSENCE of evidence.
 *
 * The old mapping computed `booked / audienceSize` with a `: 0` fallback, which
 * printed "Stored booking rate 0%" for every campaign that had never dispatched
 * — a measurement-shaped claim over no measurement. Two things are pinned here:
 * the rate is absent unless it can be evidenced, and its denominator is the
 * population that could actually have produced a booking.
 */

const ROW = {
  id: 'campaign-1', name: 'Six-month recall', status: 'ACTIVE',
  audienceSize: 240, sent: 0, booked: 0, revenue: '0',
};

describe('campaignRoiFromRow', () => {
  it('reports no booking rate at all when nothing was accepted by a provider', () => {
    const roi = campaignRoiFromRow({ ...ROW });

    // Not 0. A campaign with an audience and no accepted delivery has no rate.
    expect(roi.conversionRate).toBeNull();
    expect(roi.conversionBasis).toMatch(/no booking rate can be evidenced/);
    expect(roi.attributableDeliveries).toBe(0);
  });

  it('rates attributed bookings against provider-accepted deliveries, not the audience', () => {
    // 180 accepted deliveries, 18 attributed bookings. Against audienceSize
    // (240) the old arithmetic would have reported 8%; the population that
    // could produce an attributed booking is the accepted deliveries, because
    // a delivery no provider accepted is never attributable at all.
    const roi = campaignRoiFromRow({ ...ROW, sent: 180, booked: 18 });

    expect(roi.conversionRate).toBe(10);
    expect(roi.conversionBasis).toBe('Attributed bookings against 180 provider-accepted deliveries.');
  });

  it('reports a real zero rate when deliveries were accepted and nothing was attributed', () => {
    // This zero IS a measurement: 180 accepted deliveries produced no
    // attributed booking. It is reachable only because the denominator exists.
    const roi = campaignRoiFromRow({ ...ROW, sent: 180, booked: 0 });

    expect(roi.conversionRate).toBe(0);
    expect(roi.attributableDeliveries).toBe(180);
  });

  it('has no attributed revenue rather than an attributed zero', () => {
    const none = campaignRoiFromRow({ ...ROW, sent: 180, booked: 18, revenue: '0' });
    // A 'paid' attribution row is only written for a net above zero, so a
    // rollup of 0 means no attributed payment exists. The panel formats
    // `attributedRevenue`, so a null here is what stops it printing "$0".
    expect(none.attributedRevenue).toBeNull();

    // Prisma serialises Decimal as a string; the money must survive that.
    const paid = campaignRoiFromRow({ ...ROW, sent: 180, booked: 18, revenue: '4210.50' });
    expect(paid.attributedRevenue).toBe(4210.5);
  });

  it('keeps planning estimates out of any campaign that has real evidence', () => {
    const launched = campaignRoiFromRow({ ...ROW, sent: 180, booked: 18, estimatedRecoverable: 90000 });
    expect(launched.estimatedRecoverable).toBeNull();
    expect(launched.nextAction).toBe('Review performance');

    const draft = campaignRoiFromRow({
      id: 'campaign-2', name: 'Q3 reactivation', status: 'DRAFT',
      audienceSize: 0, sent: 0, booked: 0, revenue: '0', estimatedAudience: 412, estimatedRecoverable: 18000,
    });
    expect(draft.estimatedAudience).toBe(412);
    expect(draft.conversionRate).toBeNull();
    expect(draft.attributedRevenue).toBeNull();
    expect(draft.nextAction).toBe('Generate & approve');
  });
});
