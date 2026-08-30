import { describe, expect, it } from 'vitest';

import {
  REMEDIATION_CODES,
  REMEDIATION_STUDIO_TABS,
  READINESS_KEYS,
  isKnownRemediationCode,
  remediationFor,
} from '../lib/receptionist/remediation';
import { CLINIC_ACTIVATION_BLOCKERS } from '../lib/receptionist/activationReadiness';

// ===========================================================================
// Package B — the remediation catalogue and where its fix links land.
//
// B7: 33 of the 54 entries routed to `deploy` and `agent`, which are not tabs
// and never have been. `number_bound`, `deployment_current`, `agent_verified`,
// `prompt_drift` and `verification_failed` all sent the owner to a screen that
// does not exist, at the exact moment they were stuck.
//
// B6: the five clinic activation blockers `transitionCampaign` throws had no
// entry at all, so the first-run owner got the catalogue's unknown-code fall
// back — "Something went wrong … report the code" — from the catalogue that
// exists to prevent precisely that.
// ===========================================================================

/**
 * The Studio's own tab union (`src/pages/ReceptionistStudio.tsx`). Copied here
 * deliberately: this file owns the server half of the contract, and a copy that
 * has to be edited in lockstep is what makes a mismatch fail a test rather than
 * ship. Package F's client↔server contract test asserts the other direction.
 */
// `deploy`, not the supplier's name. A fix link is a URL the tenant's
// browser shows and may paste into a support email, so the tab id was one
// more place the voice supplier was named — see receptionistVendorNeutrality.
const STUDIO_TABS = ['clinic', 'knowledge', 'campaign', 'intake', 'preview', 'deploy', 'outbound', 'activity'];

function tabOf(fixHref: string | null): string | null {
  if (!fixHref || fixHref.startsWith('/scheduling')) return null;
  return new URL(fixHref, 'https://carecommand.test').searchParams.get('tab');
}

describe('remediation fix links land on a tab that exists (B7)', () => {
  it('never routes to a tab id the Studio does not have', () => {
    const dead: Array<{ code: string; tab: string | null }> = [];
    for (const code of REMEDIATION_CODES) {
      const tab = tabOf(remediationFor(code, { clinicId: 'c1', campaignId: 'k1', agentId: 'a1' }).fixHref);
      if (tab !== null && !STUDIO_TABS.includes(tab)) dead.push({ code, tab });
    }
    expect(dead).toEqual([]);
  });

  it('publishes the same tab list the fix links are allowed to use', () => {
    expect([...REMEDIATION_STUDIO_TABS]).toEqual(STUDIO_TABS);
  });

  it('sends the go-live failures to the deploy screen and the agent failures to the campaign screen', () => {
    // The five the register named: these were the ones pointing at nothing.
    for (const code of ['number_bound', 'deployment_current', 'agent_verified', 'prompt_drift', 'verification_failed']) {
      expect(tabOf(remediationFor(code, { campaignId: 'k1' }).fixHref), code).toBe('deploy');
    }
    for (const code of ['agent_linked', 'agent_inactive', 'engine_not_owned', 'agent_scope_mismatch']) {
      expect(tabOf(remediationFor(code, { campaignId: 'k1' }).fixHref), code).toBe('campaign');
    }
    // Scheduling is a different page, not a Studio tab, and stays one.
    expect(remediationFor('provider_availability').fixHref).toBe('/scheduling');
    expect(remediationFor('provider_resolvable').fixHref).toBe('/scheduling');
  });

  it('carries the clinic and campaign ids the caller supplies', () => {
    expect(remediationFor('number_bound', { clinicId: 'c1', campaignId: 'k1' }).fixHref)
      .toBe('/receptionist-studio?clinic=c1&campaign=k1&tab=deploy');
  });
});

describe('every code a route can throw has copy (B6)', () => {
  it('catalogues all five clinic activation blockers', () => {
    for (const blocker of CLINIC_ACTIVATION_BLOCKERS) {
      expect(isKnownRemediationCode(blocker), blocker).toBe(true);
      const remediation = remediationFor(blocker, { clinicId: 'c1', campaignId: 'k1' });
      expect(remediation.title, blocker).not.toBe('Something went wrong');
      expect(remediation.action.length, blocker).toBeGreaterThan(15);
      expect(remediation.fixHref, blocker).not.toBeNull();
    }
  });

  it('catalogues every readiness key it publishes', () => {
    for (const key of READINESS_KEYS) {
      expect(isKnownRemediationCode(key), key).toBe(true);
      expect(remediationFor(key).title, key).not.toBe('Something went wrong');
    }
  });

  it('keeps the readiness key list in step with the union', () => {
    expect(new Set(READINESS_KEYS).size).toBe(READINESS_KEYS.length);
    // The four clinic prerequisites and the honest provider check are the rows
    // B6 and B3 added; asserting them by name stops a silent removal.
    expect(READINESS_KEYS).toEqual(expect.arrayContaining([
      'clinic_country_set', 'clinic_hours_set', 'locale_pack_approved', 'agent_language_supported',
      'provider_resolvable',
    ]));
  });
});
