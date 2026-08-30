import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('independent content QA challenge', () => {
  it('does not describe intake-link creation or navigation as completed external actions', () => {
    const profile = source('src/pages/PatientProfile.tsx');

    expect(profile).toContain('Create intake link');
    expect(profile).toContain('No message was sent.');
    expect(profile).toContain('Open scheduling');
    expect(profile).not.toContain("'Intake sent'");
    expect(profile).not.toContain('> Book appointment');
  });

  it('keeps legacy patient channel settings distinct from outreach authority', () => {
    const profile = source('src/pages/PatientProfile.tsx');

    expect(profile).toContain('Historical settings · not purpose-specific outreach authority');
    expect(profile).toContain('Prior affirmative record');
    expect(profile).toContain('This does not authorize another message type.');
    expect(profile).not.toContain('High churn risk — prioritise outreach');
    expect(profile).not.toContain('No marketing consent — limit to transactional messages');
  });

  it('separates patient-profile loading, unavailable, and empty states', () => {
    const profile = source('src/pages/PatientProfile.tsx');

    expect(profile).toContain('aria-busy="true"');
    expect(profile).toContain('Patient profile data is unavailable. Try again or return to Patients.');
    expect(profile).toContain('No patient record was returned.');
    expect(profile).not.toContain("loading ? 'Loading patient profile…' : 'Patient not found.'");
  });

  it('uses evidence-bounded portal and automation language', () => {
    const login = source('src/pages/client/ClientLogin.tsx');
    const portal = source('src/pages/client/ClientSections.tsx');
    const autopilot = source('src/pages/Autopilot.tsx');

    expect(login).toContain('Verify and sign in');
    expect(portal).toContain('intake link your clinic provided');
    expect(portal).toContain('Open payment page');
    expect(portal).not.toContain('Secure payment link not ready');
    expect(autopilot).toContain('Configured execution level');
    // Reworded, same invariant: the configured level is a setting, never
    // evidence of unattended execution.
    expect(autopilot).toContain('not evidence that anything has run unattended');
    expect(autopilot).not.toContain('Configured autonomy level');
  });

  it('does not turn a sandbox eligibility response into confirmed coverage', () => {
    const card = source('src/components/insurance/InsuranceIntakeCard.tsx');
    const service = source('server/lib/connectedCare/eligibilityService.ts');

    expect(card).toContain('coverage and payment are not guaranteed');
    expect(card).toContain('it is not a payer decision or a coverage guarantee');
    expect(service).toContain('Sandbox response reports active benefit information');
    expect(service).not.toContain('Active coverage confirmed for the requested service.');
  });

  it('keeps navigation, campaign outcomes, and associated-value fields evidence bounded', () => {
    const commandDeck = source('src/components/dashboard/CommandDeck.tsx');
    const dashboard = source('src/pages/Dashboard.tsx');
    const campaigns = source('src/components/dashboard/CampaignROIPanel.tsx');
    const revenue = source('src/pages/Revenue.tsx');
    const chart = source('src/components/charts/RevenueChart.tsx');

    expect(commandDeck).toContain('Review campaigns');
    expect(commandDeck).not.toContain('Launch Campaign');
    expect(dashboard).toContain('associated-value fields; causation not established');
    expect(campaigns).toContain('Create campaign draft');
    // This pin has legitimately INVERTED. It banned "attributed" when no
    // attribution machinery existed, so "associated" was the honest hedge.
    // Attribution is now a real evidence chain — delivery → booking → payment,
    // rolled up by a database trigger no caller can override — so the panel may
    // and should say "Attributed revenue", and the guarded invariant moves to
    // the null-vs-value honesty: an absent payment renders its absence, never
    // a fabricated figure.
    expect(campaigns).toContain('Attributed revenue');
    expect(campaigns).toContain('No attributed payment yet');
    expect(campaigns).not.toContain('Recorded associated value');
    expect(revenue).toContain('Values do not establish causal attribution.');
    expect(revenue).toContain('not an attribution or reconciliation report');
    expect(revenue).toContain('Open opportunities');
    expect(revenue).not.toContain('+ Automation Recovery');
    expect(revenue).not.toContain('+ Campaign Revenue');
    expect(chart).toContain("label: 'Associated value field'");
    expect(chart).not.toContain("label: 'Recovered'");
  });

  it('uses the accessible shared form dialog for patient editing', () => {
    const profile = source('src/pages/PatientProfile.tsx');
    const dialog = source('src/components/workflow/FormDialog.tsx');

    expect(profile).toContain('import FormDialog');
    expect(profile).toContain('<FormDialog');
    expect(profile).not.toContain('fixed inset-0 z-50 flex items-center justify-center bg-black/40');
    expect(dialog).toContain("'email' | 'date'");
    expect(dialog).toContain('aria-modal="true"');
    expect(dialog).toContain("event.key !== 'Tab'");
    expect(dialog).toContain('previouslyFocused?.focus()');
  });

  it('qualifies credential-storage wording and follows the pilot US-English standard', () => {
    // The credential-entry screen was removed from the tenant: a clinic does not
    // configure suppliers. The qualification it carried is regulated wording, so it
    // moved with the capability to the platform console rather than being dropped.
    const integration = source('src/pages/PlatformConsole.tsx');
    const settings = source('src/pages/Settings.tsx');
    const protection = source('src/pages/RevenueProtection.tsx');
    const scheduling = source('src/pages/Scheduling.tsx');
    const intake = source('src/lib/intake.ts');
    const receptionist = source('src/lib/receptionist.ts');
    const subscriptions = source('src/lib/subscriptions.ts');

    expect(integration).toContain('Deployment owners must separately verify encryption-key custody, rotation, and provider configuration.');
    expect(integration).not.toContain('Credentials are encrypted and never returned to the browser.');
    expect(settings).toContain('subtitle="Organization details"');
    expect(settings).not.toContain('subtitle="Organisation details"');
    expect(protection).toContain('Which prior authorizations need action?');
    expect(protection).not.toContain('Which prior authorisations need action?');
    expect(scheduling).toContain("'Appointment canceled.'");
    expect(intake).toContain("cancelled: { label: 'Canceled'");
    expect(receptionist).toContain('The launch was canceled');
    expect(subscriptions).toContain("CANCELLED: 'Canceled'");
  });
});
