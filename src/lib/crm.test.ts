import { describe, expect, it } from 'vitest';
import {
  AUDIENCE_TYPES, CAMPAIGN_GOALS, CAMPAIGN_TYPES, NO_ATTRIBUTED_PAYMENT_REASON,
  isCampaignGoal, readCampaignHandoff, resolveHandoffDefaults,
  summarizeAttributedRevenue, attributionWindowsObserved, countAttributedOutcomes,
  describeEngagementUnavailability, formatAttributedAmount,
  type CampaignAttributionFigures,
} from './crm';

/**
 * The handoff contract.
 *
 * Every "start a campaign" call to action in the app is a decision the user
 * already made. Navigating with no payload throws it away and asks again one
 * screen later — which is exactly what the planner did to the goal it collected
 * before this module existed. These tests hold the two halves of that shut: a
 * supplied decision survives, and an unsupplied one is never invented.
 */

describe('campaign goals', () => {
  it('offers only goals the engine can actually execute', () => {
    for (const [id, goal] of Object.entries(CAMPAIGN_GOALS)) {
      expect(CAMPAIGN_TYPES, id).toContain(goal.campaignType);
      // The audience must be one the server can preview, or the goal is a dead
      // end dressed as a product: a draft nothing can ever dispatch.
      expect(AUDIENCE_TYPES, id).toContain(goal.audienceType);
    }
  });

  it('recognises its own goal keys and nothing else', () => {
    expect(isCampaignGoal('winback')).toBe(true);
    expect(isCampaignGoal('referrals')).toBe(false);
    expect(isCampaignGoal(null)).toBe(false);
    expect(isCampaignGoal(42)).toBe(false);
  });
});

describe('readCampaignHandoff', () => {
  it('reads a goal and resolves it to a campaign type and audience', () => {
    const handoff = readCampaignHandoff({ goal: 'winback', source: 'CRM' });
    expect(handoff).toEqual({ goal: 'winback', source: 'CRM' });
    expect(resolveHandoffDefaults(handoff)).toEqual({
      campaignType: 'inactive_patient_reactivation',
      audienceType: 'inactive_patients',
      channel: 'sms',
      name: '',
    });
  });

  it('lets an explicit field win over the goal preset', () => {
    const handoff = readCampaignHandoff({ goal: 'winback', audienceType: 'review_request', channel: 'email' });
    expect(resolveHandoffDefaults(handoff)).toMatchObject({
      campaignType: 'inactive_patient_reactivation', audienceType: 'review_request', channel: 'email',
    });
  });

  it('drops values that are not part of the vocabulary rather than guessing', () => {
    // A prefilled audience the sender never chose would be a fabricated
    // decision, and this one ends in someone's phone ringing.
    expect(readCampaignHandoff({ goal: 'referrals' })).toBeNull();
    expect(readCampaignHandoff({ audienceType: 'everyone' })).toBeNull();
    expect(readCampaignHandoff({ campaignType: 'blast' })).toBeNull();
    expect(readCampaignHandoff({ channel: 'carrier_pigeon' })).toBeNull();
    expect(resolveHandoffDefaults(null)).toEqual({
      campaignType: null, audienceType: null, channel: 'sms', name: '',
    });
  });

  it('accepts the payload shapes the existing screens already send', () => {
    // ClinicRadar / the patient drawer.
    expect(readCampaignHandoff({ title: 'Recall rate falling', branchName: 'Northgate' }))
      .toEqual({ contextLabel: 'Recall rate falling · Northgate' });
    // The Advisory Room.
    expect(readCampaignHandoff({ advisorType: 'growth', recommendedAction: 'Reactivate lapsed patients' }))
      .toEqual({ contextLabel: 'Reactivate lapsed patients' });
  });

  it('reads nothing out of a non-object, an empty payload, or unrelated state', () => {
    expect(readCampaignHandoff(null)).toBeNull();
    expect(readCampaignHandoff(undefined)).toBeNull();
    expect(readCampaignHandoff('winback')).toBeNull();
    expect(readCampaignHandoff({})).toBeNull();
    expect(readCampaignHandoff({ from: '/login' })).toBeNull();
  });

  it('bounds free text so a caller cannot paste a page into the header', () => {
    const handoff = readCampaignHandoff({ name: 'x'.repeat(500), contextLabel: 'y'.repeat(500) });
    expect(handoff?.name).toHaveLength(160);
    expect(handoff?.contextLabel).toHaveLength(200);
    expect(readCampaignHandoff({ name: '   ' })).toBeNull();
  });
});


/**
 * Attribution, read honestly.
 *
 * The API sends `attributedValue` as a decimal STRING, and the sum of no rows
 * is '0.00'. Reading that string as the answer is exactly how a workspace with
 * no evidence ends up displaying "$0 attributed" — the claim this product
 * exists not to make. The count of `paid` outcomes is the gate; the value is
 * only consulted once that count says money exists.
 */
function figures(overrides: Partial<CampaignAttributionFigures> = {}): CampaignAttributionFigures {
  return {
    outcomes: { engaged: 0, booked: 0, attended: 0, paid: 0 },
    attributedValue: '0.00',
    currency: null,
    windowDaysObserved: [],
    firstAttributedAt: null,
    lastAttributedAt: null,
    engagement: { openRate: null, responseRate: null, unavailableReason: 'no_truthful_open_or_reply_receipt' },
    ...overrides,
  };
}

describe('summarizeAttributedRevenue', () => {
  it('reports absence, not $0, when no campaign has an attributed payment', () => {
    expect(summarizeAttributedRevenue([])).toEqual({ status: 'not_attributed', reason: NO_ATTRIBUTED_PAYMENT_REASON });
    // The shape the server really sends for an unattributed campaign: zero
    // outcomes beside the string '0.00'.
    expect(summarizeAttributedRevenue([figures(), figures()]))
      .toEqual({ status: 'not_attributed', reason: NO_ATTRIBUTED_PAYMENT_REASON });
  });

  it('does not read revenue out of bookings or attendances', () => {
    // Rule 5 of the engine: a booking is not revenue and an attendance is not
    // revenue. Both carry attributedValue 0, so only `paid` can produce money.
    const booked = figures({ outcomes: { engaged: 0, booked: 12, attended: 7, paid: 0 }, windowDaysObserved: [30] });
    expect(summarizeAttributedRevenue([booked]).status).toBe('not_attributed');
    expect(countAttributedOutcomes([booked], 'booked')).toBe(12);
  });

  it('totals the attributed value once paid rows evidence it', () => {
    const rows = [
      figures({ outcomes: { engaged: 0, booked: 4, attended: 2, paid: 2 }, attributedValue: '1200.25', currency: 'usd', windowDaysObserved: [30] }),
      figures({ outcomes: { engaged: 0, booked: 1, attended: 0, paid: 1 }, attributedValue: '300.75', currency: 'USD', windowDaysObserved: [45] }),
      figures(),
    ];
    expect(summarizeAttributedRevenue(rows)).toEqual({
      status: 'attributed', amount: 1501, currency: 'USD', paidOutcomes: 3, campaigns: 2,
    });
    expect(attributionWindowsObserved(rows)).toEqual([30, 45]);
  });

  it('refuses to add amounts recorded in different currencies', () => {
    const result = summarizeAttributedRevenue([
      figures({ outcomes: { engaged: 0, booked: 1, attended: 0, paid: 1 }, attributedValue: '100.00', currency: 'usd' }),
      figures({ outcomes: { engaged: 0, booked: 1, attended: 0, paid: 1 }, attributedValue: '90.00', currency: 'eur' }),
    ]);
    expect(result.status).toBe('not_attributed');
    expect(result).toMatchObject({ reason: expect.stringContaining('USD and EUR') });
  });

  it('states the absence rather than a number when the payload is unreadable', () => {
    expect(summarizeAttributedRevenue([
      figures({ outcomes: { engaged: 0, booked: 1, attended: 0, paid: 1 }, attributedValue: 'not-a-number', currency: 'usd' }),
    ]).status).toBe('not_attributed');
    // A paid row with no recorded currency cannot be labelled, so it is not
    // shown as an amount in some assumed currency.
    expect(summarizeAttributedRevenue([
      figures({ outcomes: { engaged: 0, booked: 1, attended: 0, paid: 1 }, attributedValue: '10.00', currency: null }),
    ]).status).toBe('not_attributed');
  });

  it('formats an amount in the currency the evidence was recorded in', () => {
    expect(formatAttributedAmount(1501, 'USD')).toMatch(/1,501\.00/);
    // An unfamiliar code is still evidence: the amount carries that code
    // rather than being silently rendered as dollars.
    const unfamiliar = formatAttributedAmount(10, 'zzz');
    expect(unfamiliar).toMatch(/10\.00/);
    expect(unfamiliar).toMatch(/ZZZ/);
    expect(unfamiliar).not.toMatch(/\$/);
  });
});

describe('describeEngagementUnavailability', () => {
  it('explains the missing open rate instead of implying a measured 0%', () => {
    const sentence = describeEngagementUnavailability({ unavailableReason: 'no_truthful_open_or_reply_receipt' });
    expect(sentence).toContain('truthful open or reply receipt');
    // The only percentage the sentence may contain is the one it refuses to
    // print. It never reads as a measurement.
    expect(sentence).toContain('no percentage — including 0% — can be shown');
    expect(sentence.replace('including 0%', '')).not.toMatch(/\d+%/);
  });

  it('carries an unknown reason through rather than inventing one', () => {
    expect(describeEngagementUnavailability({ unavailableReason: 'provider_receipts_disabled' }))
      .toContain('provider_receipts_disabled');
    expect(describeEngagementUnavailability(null)).toContain('no reason was stated');
    expect(describeEngagementUnavailability(undefined).replace('including 0%', '')).not.toMatch(/\d+%/);
  });
});
