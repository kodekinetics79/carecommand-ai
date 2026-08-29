import { describe, expect, it } from 'vitest';
import {
  AUDIENCE_TYPES, CAMPAIGN_GOALS, CAMPAIGN_TYPES,
  isCampaignGoal, readCampaignHandoff, resolveHandoffDefaults,
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
