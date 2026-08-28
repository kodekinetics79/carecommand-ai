import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { consentFromCanonicalEvidence } from '../../src/lib/crmService';
import { buildPriorityActions } from '../../src/lib/dashboardService';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('CRM and dashboard truthfulness contracts', () => {
  it('keeps missing consent evidence unknown instead of inferring permission', () => {
    expect(consentFromCanonicalEvidence([], { patientId: 'patient-1' })).toEqual({
      email: 'unknown',
      sms: 'unknown',
      whatsapp: 'unknown',
      voice: 'unknown',
      evidenceAvailable: false,
    });
  });

  it('shows only canonical channel evidence for the requested record', () => {
    expect(consentFromCanonicalEvidence([
      { patientId: 'patient-1', channel: 'email', status: 'opted_in' },
      { patientId: 'patient-1', channel: 'sms', status: 'opted_out' },
      { patientId: 'patient-2', channel: 'voice', status: 'opted_in' },
    ], { patientId: 'patient-1' })).toEqual({
      email: 'opted_in',
      sms: 'opted_out',
      whatsapp: 'unknown',
      voice: 'unknown',
      evidenceAvailable: true,
    });
  });

  it('does not manufacture confidence and gives missed calls an accurate Front Desk CTA', () => {
    const actions = buildPriorityActions([
      { id: 'call-1', title: 'Missed call review', source: 'missed call', estimatedValue: 250 },
      { id: 'opp-2', title: 'Payer follow-up', source: 'insurance', estimatedValue: 500, confidence: 72 },
    ], [{ id: 'leak-1', source: 'payment delay', estimatedValue: 900 }]);

    expect(actions.find(row => row.id === 'opp-call-1')).toMatchObject({
      confidence: null,
      cta: { label: 'Open AI Front Desk', route: '/ai-receptionist' },
    });
    expect(actions.find(row => row.id === 'opp-opp-2')?.confidence).toBe(72);
    expect(actions.find(row => row.id === 'leak-leak-1')?.confidence).toBeNull();
  });

  it('keeps loading, error, and loaded-empty states distinct in all three screens', () => {
    const crm = source('src/pages/CRM.tsx');
    const opportunities = source('src/pages/OpportunityCenter.tsx');
    const dashboard = source('src/pages/Dashboard.tsx');

    expect(crm).toContain('CRM data unavailable');
    expect(opportunities).toContain('Zero leaks or revenue cannot be inferred');
    expect(dashboard).toContain('No zero or healthy-state conclusions should be drawn');
    expect(crm).not.toContain('getLeads().catch(() => [])');
    expect(opportunities).not.toContain('listLeaks().catch(() => [])');
    expect(dashboard).not.toContain('getSummary().catch(() => null)');
  });

  it('labels fixed heuristics as planning assumptions and never presents them as AI scoring', () => {
    const crmService = source('src/lib/crmService.ts');
    const crmPage = source('src/pages/CRM.tsx');
    const dashboardService = source('src/lib/dashboardService.ts');
    const priorityRail = source('src/components/dashboard/PriorityActionRail.tsx');

    expect(crmService).not.toContain('campaignReady');
    expect(crmPage).not.toContain('AI-ranked');
    expect(crmPage).toContain('unvalidated fixed planning heuristic');
    expect(dashboardService).not.toContain('aiConfidence:');
    expect(priorityRail).not.toContain('AI-ranked');
    expect(priorityRail).not.toContain('confidence');
  });
});
