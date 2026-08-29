import { useEffect, useState } from 'react';
import { ShieldCheck, AlertCircle, Loader2, RefreshCw, FileWarning } from 'lucide-react';
import {
  insuranceApi, RISK_META, ELIGIBILITY_STATUS_META, REASON_LABEL,
  type DenialPreventionReview, type DenialRiskAssessment,
} from '../../lib/insurance';

// One line per real outcome of a denial-prevention run. No branch of this map
// claims a task that was not written.
const REVIEW_NOTICE: Record<DenialPreventionReview['reason'], string> = {
  task_created: 'Flagged for billing review — a task was created in Staff Tasks and a revenue alert was opened.',
  task_already_open: 'Already flagged — the open Staff Tasks review for this appointment was reused, not duplicated.',
  task_write_failed: 'The risk was assessed but the review task could not be written. Re-run the flag or raise it in Staff Tasks manually.',
  review_not_required: 'Risk recorded. It does not meet this clinic’s staff-review threshold, so no task was created.',
  no_risk_detected: 'No denial risk was detected for this appointment. Nothing was flagged and no task was created.',
  no_branch_on_appointment: 'The risk was recorded but this appointment has no branch, so no branch queue could receive a task.',
};

// Pre-visit insurance / denial-risk card for an appointment. Truthful states
// only: setup_required, not_checked, eligible, ineligible, needs_review, prior-
// auth, denial risk. No fake eligible / payer approval shown.
export default function InsuranceIntakeCard({ appointmentId }: { appointmentId: string }) {
  const [data, setData] = useState<DenialRiskAssessment | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const v = await insuranceApi.getIntake(appointmentId);
        if (active) setData(v);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Failed to load insurance intake');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [appointmentId]);

  async function runCheck() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await insuranceApi.runEligibilityCheck({ appointmentId });
      if (res.status === 'setup_required' || res.setupRequired) {
        setNotice(`Eligibility provider not configured (${res.provider ?? 'provider'}). Configure it before requesting a payer response.`);
      } else {
        setNotice('Eligibility response recorded. Review the response; coverage and payment are not guaranteed.');
        setData(await insuranceApi.getIntake(appointmentId));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Eligibility check failed');
    } finally {
      setBusy(false);
    }
  }

  async function flagForReview() {
    setBusy(true); setError(null); setNotice(null);
    try {
      // Report what the run actually wrote. A NONE-risk appointment creates
      // nothing, and a re-run reuses the open task — claiming "task and alert
      // created" either way was the control asserting work it had not done.
      const result = await insuranceApi.runDenialPrevention(appointmentId);
      setNotice(REVIEW_NOTICE[result.review?.reason ?? 'review_not_required']);
      setData(await insuranceApi.getIntake(appointmentId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to flag for review');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div role="status" aria-live="polite" aria-busy="true" className="rounded-xl border border-[var(--b1)] p-3 text-xs text-t3"><Loader2 className="inline w-4 h-4 animate-spin" /> Loading insurance status…</div>;
  if (error && !data) return <div role="alert" className="rounded-xl border border-[var(--b1)] p-3 text-xs text-red-v">Insurance status is unavailable. Refresh the appointment before taking action. {error}</div>;
  if (!data) return null;

  const risk = RISK_META[data.denialRiskLevel];
  const elig = ELIGIBILITY_STATUS_META[data.eligibilityStatus] ?? { label: data.eligibilityStatus, badge: 'badge-blue' };

  return (
    <div className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-indigo" />
          <span className="text-xs font-bold text-t1">Insurance and billing review</span>
        </div>
        <span className={`badge ${risk.badge}`}>{risk.label}{data.denialRiskLevel !== 'NONE' ? ` · ${data.denialRiskScore}` : ''}</span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className={`badge ${elig.badge}`}>{elig.label}</span>
        {data.priorAuthStatus !== 'not_required' && <span className="badge badge-violet">PA: {data.priorAuthStatus.replace('_', ' ')}</span>}
        {data.estimatedPatientResponsibility != null && <span className="text-t2">Est. responsibility ${data.estimatedPatientResponsibility.toFixed(2)}</span>}
        {data.staffReviewRequired && <span className="text-red-v font-semibold inline-flex items-center gap-1"><FileWarning className="w-3 h-3" /> Staff review</span>}
      </div>

      {data.setupRequired && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-v/40 bg-amber-v/5 px-2.5 py-1.5 text-[11px] text-amber-v">
          <AlertCircle className="w-3.5 h-3.5" /> Eligibility provider not configured. No payer response is available.
        </div>
      )}
      {data.reasons.length > 0 && (
        <ul className="space-y-0.5">
          {data.reasons.map(r => <li key={r} className="text-[11px] text-t3">• {REASON_LABEL[r] ?? r}</li>)}
        </ul>
      )}
      <p className="text-[11px] text-t3">The risk score supports staff review; it is not a payer decision or a coverage guarantee.</p>
      {notice && <p role="status" aria-live="polite" className="text-[11px] text-t2">{notice}</p>}
      {error && <p role="alert" className="text-[11px] text-red-v">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {data.allowedActions.includes('run_eligibility_check') && (
          <button type="button" disabled={busy} onClick={runCheck} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo px-2.5 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Run eligibility check
          </button>
        )}
        {data.allowedActions.includes('flag_for_billing_review') && (
          <button type="button" disabled={busy} onClick={flagForReview} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1.5 text-[11px] font-semibold text-t2 hover:bg-[var(--s3)] disabled:opacity-50">
            <FileWarning className="w-3.5 h-3.5" /> Flag for billing review
          </button>
        )}
      </div>
    </div>
  );
}
