import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('general app content integrity', () => {
  it('does not present a local Autopilot toggle as a tenant-wide pause control', () => {
    const page = source('src/pages/Autopilot.tsx');

    expect(page).toContain('A tenant-wide pause control is not available on this page.');
    expect(page).not.toContain('Pause Autopilot');
    expect(page).not.toContain('Resume Autopilot');
    expect(page).not.toContain('Live Autopilot');
  });

  it('does not mutate inventory while claiming to place a purchase order', () => {
    const page = source('src/pages/Inventory.tsx');

    expect(page).toContain('Purchasing is not configured in this workspace.');
    expect(page).not.toContain('Place All Reorders');
    expect(page).not.toContain('Reorder now');
    expect(page).not.toContain("apiRequest(`/v1/inventory/${id}`");
  });

  it('keeps review records distinct from external publication and removes fixed metrics', () => {
    const page = source('src/pages/Reviews.tsx');

    expect(page).toContain('External delivery is not confirmed here.');
    expect(page).toContain('Record drafted response');
    expect(page).not.toContain('Send AI Response');
    expect(page).not.toContain('Response sent');
    expect(page).not.toContain('18 referrals');
    expect(page).not.toContain('6400');
  });

  it('uses explicit unavailable states instead of fabricated identities and zero KPIs', () => {
    const adapters = source('src/lib/apiAdapters.ts');
    const reviews = source('src/pages/Reviews.tsx');
    const labs = source('src/pages/Labs.tsx');
    const providers = source('src/pages/DoctorWorkspace.tsx');

    expect(adapters).toContain("patientName: 'Reviewer name unavailable'");
    expect(adapters).toContain("patientName: row.patient ? `${row.patient.firstName} ${row.patient.lastName}` : 'Patient not linked'");
    expect(adapters).not.toContain('Live DB Customer');
    expect(adapters).not.toContain("doctorName: row.providerRef ?? 'Assigned provider'");
    expect(reviews).toContain("reviewMetricsReady ? avgRating : '—'");
    expect(reviews).toContain("reputationMetricsReady ? reputation.summary.pendingReviewRequests : '—'");
    expect(labs).toContain("value={metricsReady ? openCount : '—'}");
    expect(providers).toContain("value={metricsReady ? providerRecords.length : '—'}");
  });

  it('keeps patient insurance content point-in-time, masked, and fact based', () => {
    const profile = source('src/pages/PatientProfile.tsx');

    expect(profile).toContain('not a coverage or payment guarantee');
    expect(profile).toContain('maskMemberId(policyRow?.memberId ?? latestEligibility?.memberId)');
    expect(profile).toContain('Run Eligibility Check');
    expect(profile).toContain('No payer message recorded.');
    expect(profile).not.toContain("planName: policyForm.planName.trim() || `${payer.name} Plan`");
    expect(profile).not.toContain('No consent issues detected');
    expect(profile).not.toContain('Follow-up task pending for service rebook');
    expect(profile).not.toContain('strong lifetime value');
    expect(profile).not.toContain('ideal opportunity');
  });

  it('removes fixed trend arrows and unexplained tenant health scoring', () => {
    const staff = source('src/pages/StaffWorkflow.tsx');
    const providers = source('src/pages/DoctorWorkspace.tsx');
    const platform = source('src/pages/PlatformConsole.tsx');

    expect(staff).not.toContain('trend={3}');
    expect(providers).not.toMatch(/trend=\{/);
    expect(platform).not.toContain('healthScore');
    expect(platform).not.toContain('Derived health score');
    expect(platform).toContain('title="Stored setup status"');
  });

  it('uses patient terminology and qualifies portal and credential claims', () => {
    const patients = source('src/pages/Patients.tsx');
    const staff = source('src/pages/StaffWorkflow.tsx');
    const providers = source('src/pages/DoctorWorkspace.tsx');
    const portal = source('src/pages/client/ClientLayout.tsx');
    const platform = source('src/pages/PlatformConsole.tsx');

    expect(patients).toContain('title="Patients"');
    expect(patients).not.toMatch(/Customer|customer/);
    expect(staff).toContain("confirm the patient's identity");
    expect(providers).toContain('repeat patient rates');
    expect(portal).toContain('Patient portal · clinic-managed workspace');
    expect(portal).not.toContain('Secure patient portal');
    expect(platform).toContain('Deployment owners must separately verify encryption-key custody');
    expect(platform).not.toContain('credentials encrypted at rest');
    for (const operationalPage of [patients, staff, providers]) {
      expect(operationalPage).not.toContain('Live DB');
      expect(operationalPage).not.toContain('Live Data Error');
      expect(operationalPage).not.toContain('live API');
    }
    expect(source('src/pages/client/ClientSections.tsx')).not.toContain('live portal handoff');
  });

  it('uses patient terminology in scheduling and patient outreach workflows', () => {
    const scheduling = source('src/pages/Scheduling.tsx');
    const autopilot = source('src/pages/Autopilot.tsx');
    const revenue = source('src/pages/Revenue.tsx');

    expect(scheduling).toContain('Select patient…');
    expect(scheduling).not.toMatch(/customer/i);
    expect(autopilot).toContain('patient fit, recorded signals');
    expect(autopilot).not.toContain('customer fit');
    expect(revenue).toContain('additional associated value after operational follow-up and an approved outreach campaign');
    expect(revenue).toContain('This is not a forecast or causal attribution');
  });

  it('does not fabricate ClinicRadar value, confidence, dates, or control success', () => {
    const page = source('src/pages/ClinicRadar.tsx');

    expect(page).toContain('Signals loaded');
    expect(page).not.toContain('Signal Confidence');
    expect(page).not.toContain('Math.round(caseRow.badReviewRisk * 45)');
    expect(page).not.toContain('theme.length + 2024');
    expect(page).not.toContain('All guardrails operational');
    expect(page).not.toContain('No violations detected');
  });

  it('does not advertise unproven security, autonomy, or outcome claims at sign in', () => {
    const page = source('src/pages/Login.tsx');

    expect(page).toContain('Role-based access · recorded account activity');
    expect(page).toContain('Remember email on this device');
    expect(page).toContain('Account recovery: contact your administrator');
    expect(page).toContain('Generate local reset token');
    expect(page).not.toContain('audit-ready');
    expect(page).not.toContain('Answers calls & books 24/7');
    expect(page).not.toContain('Finds & recovers lost revenue');
    expect(page).not.toContain('Prevent denials before they happen');
  });

  it('does not show fabricated command counts or unsupported keyboard help', () => {
    const palette = source('src/components/ui/CommandPalette.tsx');

    expect(palette).toContain('role="dialog"');
    expect(palette).not.toContain('214 customers at churn risk');
    expect(palette).not.toContain('↑↓</kbd> Navigate');
  });

  it('qualifies control and pilot checklist scores', () => {
    const controlPlane = source('src/pages/ControlPlane.tsx');
    const platformConsole = source('src/pages/PlatformConsole.tsx');
    const platformPilot = source('src/pages/PlatformPilot.tsx');
    const pilotShare = source('src/pages/PilotStatusShare.tsx');

    expect(controlPlane).toContain('It is not a security assessment, compliance certification, or authorization to launch.');
    expect(controlPlane).not.toContain('Security posture is clean');
    expect(platformConsole).not.toContain('monitored live');
    expect(platformConsole).not.toContain('Every operator action recorded');
    expect(platformConsole).not.toContain('Immutable record of operator actions');
    expect(platformConsole).not.toContain('no PHI');
    expect(platformPilot).toContain('This checklist summarizes recorded setup tasks.');
    expect(platformPilot).toContain("item.done ? 'Complete' : 'Pending'");
    expect(platformPilot).not.toContain('Customer-ready onboarding');
    expect(pilotShare).toContain('It is not a security assessment, compliance certification, or authorization to launch.');
    expect(pilotShare).toContain("item.done ? 'Complete' : 'Pending'");
    expect(pilotShare).not.toContain('What’s ready for go-live');
  });

  it('labels advisory output provenance, scores, and estimates truthfully', () => {
    const page = source('src/pages/AdvisoryRoom.tsx');
    const types = source('src/types/index.ts');

    expect(types).toContain("answerSource: 'model' | 'rule-based'");
    expect(page).toContain("currentAnswer.answerSource === 'model'");
    expect(page).toContain('unvalidated planning heuristics');
    expect(page).toContain('Operational assessment');
    expect(page).not.toContain('Live Advisory');
    expect(page).not.toContain('% confidence</span>');
    expect(page).not.toContain('>Diagnosis</p>');
  });
});
