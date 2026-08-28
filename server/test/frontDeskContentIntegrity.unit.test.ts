import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('AI Front Desk authorization and evidence content', () => {
  it('requires server readiness and uses an accessible in-app submission confirmation', () => {
    const page = readFileSync('src/pages/AIReceptionist.tsx', 'utf8');

    expect(page).toContain('disabled={isSending || !selectedConv.replyReadiness.ready}');
    expect(page).toContain('The server rechecks suppression at submission.');
    expect(page).toContain('Provider acceptance does not confirm delivery');
    expect(page).toContain('<ConfirmationModal');
    expect(page).not.toContain('window.confirm');
    expect(page).toContain('Rule-based draft · staff review required');
  });

  it('labels recorded evidence without inventing missed calls, value provenance, or clinic-local hours', () => {
    const page = readFileSync('src/pages/AIReceptionist.tsx', 'utf8');
    const adapters = readFileSync('src/lib/apiAdapters.ts', 'utf8');

    expect(page).toContain('title="Call records today"');
    expect(page).toContain('title="Follow-up evidence"');
    expect(adapters).toContain('Recorded estimate · source not verified');
    expect(page).toContain('No after-hours metric is calculated.');
    expect(page).toContain('Browser-local time is not used as a substitute for verified clinic hours and timezone.');
    expect(page).not.toContain('afterHoursByDay');
    expect(page).not.toContain('title="Missed Calls Today"');
  });

  it('renders the server-provided identity, destination, consent, authorization, and suppression evidence', () => {
    const page = readFileSync('src/pages/AIReceptionist.tsx', 'utf8');
    const route = readFileSync('server/modules/operations/routes.ts', 'utf8');

    for (const label of ['Channel + masked destination', 'Patient-link identity', 'Explicit consent', 'Operational basis', 'Current suppression state', 'Draft attribution']) {
      expect(page).toContain(label);
    }
    expect(page).toContain('Canonical sender');
    expect(page).toContain('Channel terms');
    expect(page).toContain('A durable claim is recorded before provider contact; an uncertain result blocks retry.');
    for (const field of ['destinationMasked', 'destinationVerificationStatus', 'authorizationBasis', 'explicitConsentStatus', 'consentSource', 'suppressionStatus', 'readinessReason', 'draftSource']) {
      expect(route).toContain(field);
    }
  });
});
