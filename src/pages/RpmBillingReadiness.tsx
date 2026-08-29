import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { RefreshCw, Loader2, Check, X, PenLine, DollarSign, Timer, ShieldCheck } from 'lucide-react';
import BentoCard from '../components/ui/BentoCard';
import PageHeader from '../components/ui/PageHeader';
import ResourceSection from '../components/ui/ResourceSection';
import ConfirmationModal from '../components/workflow/ConfirmationModal';
import ReviewSessionModal from '../components/connectedCare/ReviewSessionModal';
import { useResource } from '../hooks/useResource';
import { apiRequest } from '../lib/api';

interface Requirement { key: string; label: string; met: boolean }
interface CandidateCode {
  code: string;
  family: 'setup' | 'supply' | 'management';
  units: number;
  rationale: string;
  periodBasis: 'rolling_30_day' | 'calendar_month';
}
interface Billing {
  codeSetVersion: string;
  candidates: CandidateCode[];
  blockers: string[];
  nextActions: string[];
}
interface ReadinessRow {
  patientId: string; patientName: string; status: string; missing: string[]; requirements: Requirement[];
  readingDays: number; reviewMinutes: number; communicationFlag: boolean; providerSignoffAt: string | null; minReadingDays: number;
  evidenceVersion: string; evidenceHash: string; signoffAttestationRevision: string;
  qualifyingReadingCount: number; excludedReadingCount: number;
  deviceExceptions: Array<{ reason: string; count: number }>;
  interactiveCommunication: boolean;
  sessionsMissingNarrative: number;
  billing: Billing;
}
interface ReadinessPage { items: ReadinessRow[]; total: number; limit: number; offset: number; hasMore: boolean }

const STATUS_BADGE: Record<string, string> = { READY: 'badge-emerald', NEEDS_REVIEW: 'badge-amber', MISSING_REQUIREMENTS: 'badge-red' };
const STATUS_LABEL: Record<string, string> = { READY: 'Prerequisites recorded', NEEDS_REVIEW: 'Needs review', MISSING_REQUIREMENTS: 'Missing requirements' };

// Where a clinic goes to fix each unmet requirement. Previously each red X was
// inert text: five failures and no way to act on any of them.
const REMEDY: Record<string, { label: string; kind: 'route' | 'review'; to?: string }> = {
  consent: { label: 'Capture consent', kind: 'route', to: '/enrollments' },
  enrollment: { label: 'Manage enrollment', kind: 'route', to: '/enrollments' },
  reading_days: { label: 'Check device', kind: 'route', to: '/devices' },
  review_minutes: { label: 'Start review', kind: 'review' },
  communication: { label: 'Log a live contact', kind: 'review' },
};

export default function RpmBillingReadiness() {
  const navigate = useNavigate();
  const { state, reload } = useResource<ReadinessPage>('/v1/connected-care/rpm-readiness');
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingSignoff, setPendingSignoff] = useState<ReadinessRow | null>(null);
  const [reviewing, setReviewing] = useState<ReadinessRow | null>(null);

  const signoff = useCallback(async (row: ReadinessRow) => {
    setBusy(`${row.patientId}-signoff`);
    setActionError(null);
    try {
      await apiRequest(`/v1/connected-care/rpm-readiness/${row.patientId}/signoff`, {
        method: 'POST',
        body: JSON.stringify({
          expectedEvidenceVersion: row.evidenceVersion,
          expectedEvidenceHash: row.evidenceHash,
          attestationRevision: row.signoffAttestationRevision,
        }),
      });
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Attestation failed');
      throw e;
    } finally { setBusy(null); }
  }, [reload]);

  // Count patients with at least one supportable code, NOT patients at READY.
  // A device-supply month with no review minutes is legitimately billable; the
  // old single gate reported it as nothing.
  const billableCount = useMemo(
    () => (state.status === 'ready' ? state.data.items.filter(r => r.billing.candidates.length > 0).length : 0),
    [state],
  );

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="RPM Billing Readiness"
        subtitle="Recorded workflow prerequisites only — not coding, medical necessity, claim eligibility, or payment approval. A coder still decides what is submitted."
        actions={
          <button type="button" onClick={reload} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] bg-white px-3 py-1.5 text-[13px] font-semibold text-t1 hover:bg-[var(--s2)] transition">
            <RefreshCw className="w-3.5 h-3.5 text-t3" /> Refresh
          </button>
        }
      />

      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[11px] font-medium text-red-700">
        RPM records are not an emergency-monitoring service and must not be the sole basis for clinical decisions. Follow the clinic&rsquo;s approved escalation plan; for an emergency in the United States, call 911.
      </div>

      {actionError && <div role="alert" className="rounded-xl border border-[var(--b1)] bg-[var(--amber-soft)] p-3 text-[13px] text-amber-v">{actionError}</div>}

      <BentoCard
        title="RPM Billing Evidence Review"
        subtitle="Which codes the recorded evidence could support this period"
      >
        <ResourceSection
          label="RPM billing readiness"
          state={state}
          onRetry={reload}
          lines={3}
          rowClassName="h-28 rounded-xl"
          isEmpty={page => page.items.length === 0}
          empty={{
            icon: <DollarSign className="w-5 h-5" />,
            title: 'No patients are enrolled in remote monitoring yet',
            description: 'Enrolling a patient records their consent, starts their billing period, and opens their monitoring record.',
            cta: { label: 'Enroll a patient', onClick: () => navigate('/enrollments') },
          }}
        >
          {page => (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`badge ${billableCount > 0 ? 'badge-emerald' : ''} inline-flex items-center gap-1`}>
                  <DollarSign className="w-3 h-3" />
                  {billableCount} of {page.total} with supportable codes
                </span>
                {page.hasMore && (
                  <span className="text-[11px] text-t3">Showing {page.items.length} of {page.total} — refine by branch to see the rest.</span>
                )}
              </div>

              {page.items.map(r => (
                <div key={r.patientId} className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-4">
                  <div className="flex items-start justify-between gap-3 mb-2.5">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-[14px] font-bold text-t1">{r.patientName}</p>
                        <span className={`badge ${STATUS_BADGE[r.status] ?? 'badge'}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                      </div>
                      <p className="text-[11px] text-t3 mt-0.5">
                        {r.readingDays}/{r.minReadingDays} device-days · {r.reviewMinutes} review min · {r.interactiveCommunication ? 'live contact recorded' : 'no live contact'} · {r.providerSignoffAt ? 'signed off' : 'awaiting signoff'}
                      </p>
                      {r.excludedReadingCount > 0 && (
                        <p className="text-[10px] text-amber-v mt-1">
                          {r.excludedReadingCount} reading{r.excludedReadingCount === 1 ? '' : 's'} excluded: {r.deviceExceptions.map(i => `${i.reason.replaceAll('_', ' ')} (${i.count})`).join(', ')}
                        </p>
                      )}
                      {r.sessionsMissingNarrative > 0 && (
                        <p className="text-[10px] text-amber-v mt-1">
                          {r.sessionsMissingNarrative} review session{r.sessionsMissingNarrative === 1 ? '' : 's'} without an activity description — an auditor needs what was done, not only how long it took.
                        </p>
                      )}
                    </div>
                  </div>

                  {/* What the evidence could support. Empty is a valid answer. */}
                  <div className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] p-3 mb-3">
                    {r.billing.candidates.length > 0 ? (
                      <>
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-t3 mb-1.5">Codes the recorded evidence could support</p>
                        <div className="flex flex-wrap gap-1.5 mb-1.5">
                          {r.billing.candidates.map(c => (
                            <span key={c.code} title={c.rationale} className="inline-flex items-center gap-1 rounded-md border border-[var(--b2)] bg-white px-2 py-0.5 text-[11px] font-semibold text-t1">
                              {c.code}{c.units > 1 ? ` ×${c.units}` : ''}
                            </span>
                          ))}
                        </div>
                        <p className="text-[10px] text-t3">Coding and RCM staff must still validate the service, payer rules, and the claim.</p>
                      </>
                    ) : (
                      <p className="text-[11px] text-t2">
                        {r.billing.blockers.length > 0 ? r.billing.blockers.join('; ') : 'No code is supported by the evidence recorded so far this period.'}
                      </p>
                    )}
                  </div>

                  <div className="grid gap-1.5 sm:grid-cols-2 mb-3">
                    {r.requirements.map(req => {
                      const remedy = REMEDY[req.key];
                      return (
                        <div key={req.key} className="flex items-center gap-2 text-[12px]">
                          {req.met
                            ? <Check className="w-3.5 h-3.5 text-emerald-v shrink-0" aria-hidden="true" />
                            : <X className="w-3.5 h-3.5 text-red-v shrink-0" aria-hidden="true" />}
                          <span className="sr-only">{req.met ? 'Met:' : 'Not met:'}</span>
                          <span className={req.met ? 'text-t2' : 'text-t1 font-medium'}>{req.label}</span>
                          {!req.met && remedy && (
                            <button
                              type="button"
                              onClick={() => (remedy.kind === 'review' ? setReviewing(r) : navigate(remedy.to!))}
                              className="text-[11px] font-semibold text-[var(--indigo)] hover:underline"
                            >
                              {remedy.label}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {r.billing.nextActions.length > 0 && (
                    <ul className="mb-3 space-y-0.5">
                      {r.billing.nextActions.map(action => (
                        <li key={action} className="text-[11px] text-t2">→ {action}</li>
                      ))}
                    </ul>
                  )}

                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      type="button"
                      onClick={() => setReviewing(r)}
                      className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] bg-white px-2.5 py-1 text-[11px] font-semibold text-t1 hover:bg-[var(--s2)]"
                    >
                      <Timer className="w-3 h-3" /> Log review session
                    </button>
                    <button
                      type="button"
                      disabled={busy === `${r.patientId}-signoff` || !!r.providerSignoffAt || r.status === 'MISSING_REQUIREMENTS'}
                      title={r.status === 'MISSING_REQUIREMENTS' ? 'Attestation opens once every requirement is recorded' : undefined}
                      onClick={() => setPendingSignoff(r)}
                      className="inline-flex items-center gap-1 rounded-lg bg-[var(--indigo)] px-2.5 py-1 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
                    >
                      {busy === `${r.patientId}-signoff` ? <Loader2 className="w-3 h-3 animate-spin" /> : <PenLine className="w-3 h-3" />} Review and attest
                    </button>
                    {r.status === 'MISSING_REQUIREMENTS' && (
                      <span className="text-[11px] text-t3">
                        Attestation opens once all {r.requirements.length} requirements are recorded — {r.requirements.filter(x => !x.met).length} remaining.
                      </span>
                    )}
                    {r.providerSignoffAt && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-v">
                        <ShieldCheck className="w-3 h-3" /> Attested against evidence {r.evidenceHash.slice(0, 8)}…
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </ResourceSection>
      </BentoCard>

      {reviewing && (
        <ReviewSessionModal
          patientId={reviewing.patientId}
          patientName={reviewing.patientName}
          onClose={() => setReviewing(null)}
          onRecorded={reload}
        />
      )}

      {pendingSignoff && (
        <ConfirmationModal
          title="Attest to reviewed RPM evidence"
          message={`I attest that I performed and reviewed the remote monitoring recorded for ${pendingSignoff.patientName}, as captured in evidence ${pendingSignoff.evidenceVersion} (${pendingSignoff.evidenceHash.slice(0, 12)}…). This records workflow evidence only and does not determine coding, medical necessity, claim eligibility, or payment. If any underlying evidence changes, this attestation is automatically withdrawn and must be given again.`}
          confirmLabel="Record attestation"
          tone="amber"
          onClose={() => setPendingSignoff(null)}
          onConfirm={() => signoff(pendingSignoff)}
        />
      )}
    </div>
  );
}
