import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('regulated product content guardrails', () => {
  it('does not present payer acceptance or eligibility as guaranteed coverage', () => {
    const insurance = source('src/pages/Insurance.tsx');
    const eligibility = source('src/pages/InsuranceEligibility.tsx');

    expect(insurance).toContain('Payer acceptance and an eligibility response do not guarantee coverage or payment.');
    expect(insurance).not.toContain("confirming they're covered before they ever call");
    expect(insurance).not.toContain('checked in real time during booking');
    expect(eligibility).toContain('a point-in-time response, not a coverage or payment guarantee');
    expect(eligibility).toContain('may not equal the final patient responsibility after adjudication');
  });

  it('keeps a suggested appointment time distinct from a confirmed booking', () => {
    const frontDesk = source('src/pages/AIReceptionist.tsx');

    expect(frontDesk).toContain('Suggested time — not booked');
    expect(frontDesk).toContain('Review in scheduling');
    expect(frontDesk).not.toContain('Confirm & Book');
    expect(frontDesk).toContain('Provider acceptance does not confirm delivery');
    expect(frontDesk).toContain('Submit reviewed reply');
  });

  it('requires tool evidence for booking and message-delivery claims', () => {
    const prompt = source('server/modules/receptionist/promptService.ts');

    expect(prompt).toContain('booked=true with a canonical appointment ID');
    expect(prompt).toContain('provider-accepted only when the tool reports accepted');
    expect(prompt).toContain('delivered only when the tool reports delivered');
    expect(prompt).toContain('If delivery is queued, failed, suppressed, or unknown, state that accurately');
    expect(prompt).not.toContain('then texts a confirm');
  });

  it('uses reviewable in-app controls for receptionist configuration and high-impact actions', () => {
    const studio = source('src/pages/ReceptionistStudio.tsx');
    const confirmation = source('src/components/workflow/ConfirmationModal.tsx');
    const form = source('src/components/workflow/FormDialog.tsx');

    expect(studio).not.toContain('window.prompt');
    expect(studio).not.toContain('window.confirm');
    expect(studio).toContain('role="tablist"');
    expect(studio).toContain('useSearchParams');
    expect(studio).toContain('Emergency stop reason');
    expect(confirmation).toContain('aria-modal="true"');
    expect(confirmation).toContain("e.key !== 'Tab'");
    expect(studio).toContain('No live provider is contacted.');
    expect(form).toContain('role="dialog"');
  });

  it('uses accessible in-app confirmation for evidence deletion and deposit waivers', () => {
    const compliance = source('src/pages/ComplianceCenter.tsx');
    const revenue = source('src/pages/RevenueProtection.tsx');
    const payment = source('src/components/payments/AppointmentPaymentCard.tsx');

    for (const guardedSurface of [compliance, revenue, payment]) {
      expect(guardedSurface).not.toContain('window.prompt');
      expect(guardedSurface).not.toContain('window.confirm');
      expect(guardedSurface).toContain('ConfirmationModal');
    }
    expect(revenue).toContain('reasonLabel="Waiver reason"');
    expect(payment).toContain('reasonLabel="Waiver reason"');
    expect(compliance).toContain('This does not erase the record');
  });

  it('does not fabricate campaign consent, audience, or ROI evidence', () => {
    const campaigner = source('src/pages/Campaigner.tsx');

    expect(campaigner).toContain('No ROI forecast is available');
    expect(campaigner).toContain('No audience is inferred on this page');
    expect(campaigner).toContain('Activation requirements · not verified on this page');
    expect(campaigner).not.toContain('187 customers in final audience');
    expect(campaigner).not.toContain('Consent check: <span className="font-semibold text-emerald-v">Active');
    expect(campaigner).not.toContain('Launch Campaign Now');
    expect(campaigner).toContain('Open approved campaign workflow');
    expect(campaigner).not.toContain("setCampaignStatus(c.id, 'ACTIVE')");

    const engine = source('src/pages/CampaignEngine.tsx');
    const crm = source('src/lib/crm.ts');
    expect(engine).toContain('provider-accepted');
    expect(engine).toContain('Provider acceptance is not confirmed delivery');
    expect(engine).toContain('Dispatch evidence is unavailable. Do not infer that no dispatch occurred');
    expect(engine).not.toContain('window.confirm');
    expect(engine).not.toContain('badge="New"');
    expect(crm).toContain("sent: { label: 'Provider accepted (legacy)'");
    expect(crm).toContain("accepted: { label: 'Provider accepted'");
  });

  it('keeps compliance metrics as readiness evidence rather than certification', () => {
    const center = source('src/pages/ComplianceCenter.tsx');
    const catalog = source('server/modules/subscriptions/catalog.ts');

    expect(center).toContain('a readiness posture, not a certification');
    expect(center).toContain('Self-Assessed Overall Readiness');
    expect(center).toContain('Self-Assessed SOC 2 Readiness');
    expect(center).toContain('Self-Assessed HIPAA Alignment');
    expect(center.toLowerCase()).toContain('not an audit opinion');
    expect(center.toLowerCase()).toContain('not a legal determination');
    expect(catalog).toContain('self-assessment tooling; not certification');
  });

  it('shows emergency and sole-reliance warnings on intake and RPM surfaces', () => {
    const intake = source('src/pages/PublicIntake.tsx');
    const monitoring = source('src/pages/RemoteMonitoring.tsx');
    const billing = source('src/pages/RpmBillingReadiness.tsx');

    expect(intake).toContain('This form is not monitored for immediate response.');
    expect(intake).not.toContain('Secure photo upload');
    expect(monitoring).toContain('Do not rely on CareCommand as the only way');
    expect(billing).toContain('must not be the sole basis for clinical decisions');
  });

  it('separates clinical workflow and billing prerequisites from clinician and payer decisions', () => {
    const labs = source('src/pages/Labs.tsx');
    const telehealth = source('src/pages/Telehealth.tsx');
    const rpm = source('src/pages/RpmBillingReadiness.tsx');

    expect(labs).toContain('results require review by an authorized clinician');
    expect(labs).toContain('not clinical interpretation');
    expect(labs).toContain('File upload is not available on this page');
    expect(labs).not.toContain('Upload Document');
    expect(telehealth).toContain('does not by itself prove intake, telehealth consent, payment, technical readiness');
    expect(rpm).toContain('not coding, medical necessity, claim eligibility, or payment approval');
  });

  it('uses truthful patient-portal outcomes and accessible async feedback', () => {
    const portal = source('src/pages/client/ClientSections.tsx');
    const login = source('src/pages/client/ClientLogin.tsx');
    const publicIntake = source('src/pages/PublicIntake.tsx');

    expect(portal).toContain('Request recorded for staff review. This is not a confirmed appointment, and no response time is promised.');
    expect(portal).toContain('No payment requests are currently shown in this portal.');
    expect(portal).not.toContain('No payments due.');
    expect(portal).toContain("if (e.target.checked) next[f.key] = false;");
    expect(portal).toContain("role={msgIsError ? 'alert' : 'status'}");
    expect(login).toContain('role="alert" aria-live="assertive"');
    expect(publicIntake).toContain('aria-busy={submitting}');
    expect(publicIntake).toContain('Could not submit this intake. Please try again or contact the clinic.');
  });

  it('does not turn unavailable operational evidence into zero or live claims', () => {
    const revenue = source('src/pages/Revenue.tsx');
    const telehealth = source('src/pages/Telehealth.tsx');
    const monitoring = source('src/pages/RemoteMonitoring.tsx');

    expect(revenue).toContain('Unavailable metrics are shown as —; do not interpret them as zero or as a healthy state.');
    expect(revenue).toContain("rpLive && rpSummary ? formatCurrency(rpSummary.revenueProtected) : '—'");
    expect(telehealth).toContain("metricsReady ? sessions.length : '—'");
    expect(telehealth).toContain('Virtual Visit Schedule');
    expect(monitoring).toContain('Latest Recorded Readings');
    expect(monitoring).not.toContain('Live & Recent Readings');
  });
});
