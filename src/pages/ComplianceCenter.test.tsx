import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());
const sessionState = vi.hoisted(() => ({ role: 'OWNER' }));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

vi.mock('../hooks/useSession', () => ({
  useSession: () => ({ user: { role: sessionState.role }, loading: false, isAuthenticated: true, signOut: vi.fn() }),
}));

import ComplianceCenter from './ComplianceCenter';

const DASHBOARD = {
  generatedAt: '2026-09-01T18:00:00.000Z',
  readinessAvailable: true,
  controlCount: 16,
  eligibleControlCount: 15,
  evidenceLinkedControlCount: 9,
  overallReadinessScore: 63,
  frameworks: [],
  soc2ReadinessPct: 58,
  hipaaAlignmentPct: 61,
  internalBaselinePct: 69,
  openRisks: 2,
  notImplementedControls: 3,
  missingEvidenceCount: 6,
  expiringEvidenceCount: 1,
  recentAuditEvents: [],
  securityIncidents: { total: 0, open: 0, resolved: 0 },
  backupStatus: { integrated: false, status: 'unverified', lastRunAt: null },
  mfaStatus: { integrated: true, enforced: false, adoptionPct: 40, note: 'TOTP MFA is available but not enforced by policy.' },
};

function renderPage(path = '/compliance') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/compliance/:section?" element={<ComplianceCenter />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  sessionState.role = 'OWNER';
  apiRequestMock.mockReset();
  apiRequestMock.mockResolvedValue(DASHBOARD);
});

describe('Compliance Readiness buyer-safe overview', () => {
  it('shows evidence provenance and action-required states without claiming certification', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Evidence for a pilot decision—not a compliance certificate.' })).toBeInTheDocument();
    expect(screen.getByText('15 eligible controls')).toBeInTheDocument();
    expect(screen.getByText('9 of 15')).toBeInTheDocument();
    expect(screen.getByText('Action required')).toBeInTheDocument();
    expect(screen.getByText('Unverified')).toBeInTheDocument();
    expect(screen.getByText('63%')).toBeInTheDocument();
    expect(screen.getByText(/does not replace a legal review, external audit/i)).toBeInTheDocument();
  });

  it('renders missing control evidence as not assessed instead of a misleading zero score', async () => {
    apiRequestMock.mockResolvedValue({
      ...DASHBOARD,
      readinessAvailable: false,
      controlCount: 0,
      eligibleControlCount: 0,
      evidenceLinkedControlCount: 0,
      overallReadinessScore: 0,
      soc2ReadinessPct: 0,
      hipaaAlignmentPct: 0,
      internalBaselinePct: 0,
    });
    renderPage();

    expect(await screen.findByText('Readiness is not assessed.')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(screen.getByText('No eligible control baseline is recorded for this tenant. Percentages stay hidden until controls exist.')).toBeInTheDocument();
  });

  it('keeps auditors read-only while preserving the same evidence view', async () => {
    sessionState.role = 'AUDITOR';
    renderPage();

    expect(await screen.findByText('Read only')).toBeInTheDocument();
    expect(screen.getByText('15 eligible controls')).toBeInTheDocument();
  });

  it('renders the shareable pilot snapshot from aggregate-only fields', async () => {
    apiRequestMock.mockResolvedValue({
      generatedAt: '2026-09-01T18:00:00.000Z',
      tenantName: 'Bright Health LLC',
      dataClassification: 'aggregate_only',
      controlStatus: { available: true, completionPct: 62, eligibleControls: 15, evidenceBackedControls: 9 },
      accessProtection: { mfaEnforced: false, adoptionPct: 40 },
      recoveryEvidence: { latestStatus: 'failed', latestRunAt: '2026-09-01T17:00:00.000Z', latestVerified: false },
      accountability: { auditEventsLast30Days: 84 },
      openGaps: { risks: 2, incidents: 1, notImplementedControls: 3, controlsWithoutCurrentApprovedEvidence: 6 },
      limitations: ['Control status is self-recorded.'],
    });
    renderPage('/compliance/proof');

    expect(await screen.findByRole('heading', { name: 'Pilot Readiness Snapshot' })).toBeInTheDocument();
    expect(screen.getByText('Bright Health LLC pilot evidence')).toBeInTheDocument();
    expect(screen.getByText('Aggregate-only · no patient records')).toBeInTheDocument();
    expect(screen.getByText('9 of 15')).toBeInTheDocument();
    expect(screen.getByText('84 audit events · 30d')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Audit Logs' })).not.toBeInTheDocument();
    expect(apiRequestMock).toHaveBeenCalledWith('/v1/compliance/buyer-proof');
  });

  it('keeps every control-coverage value unassessed when the proof has no baseline', async () => {
    apiRequestMock.mockResolvedValue({
      generatedAt: '2026-09-01T18:00:00.000Z', tenantName: 'Bright Health LLC', dataClassification: 'aggregate_only',
      controlStatus: { available: false, completionPct: 0, eligibleControls: 0, evidenceBackedControls: 0 },
      accessProtection: { mfaEnforced: false, adoptionPct: 0 },
      recoveryEvidence: { latestStatus: 'unverified', latestRunAt: null, latestVerified: false },
      accountability: { auditEventsLast30Days: 0 },
      openGaps: { risks: 0, incidents: 0, notImplementedControls: 0, controlsWithoutCurrentApprovedEvidence: 0 },
      limitations: ['No baseline.'],
    });
    renderPage('/compliance/proof');

    expect(await screen.findAllByText('Not assessed')).toHaveLength(2);
    expect(screen.getByText('Missing control baseline')).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(2);
    expect(screen.queryByText('0 of 0')).not.toBeInTheDocument();
  });
});
