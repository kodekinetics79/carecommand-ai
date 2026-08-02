import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { ShieldCheck, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { intakeApi, SECTION_LABEL, type PublicIntakeView } from '../lib/intake';

// Patient-facing intake page reached via a hashed, expiring token. Shows ONLY
// patient-safe data (no tenant/internal IDs). Documents are metadata-only when
// object storage is absent — never a fake upload.
export default function PublicIntake() {
  const { token = '' } = useParams();
  const [view, setView] = useState<PublicIntakeView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const v = await intakeApi.publicGet(token);
        if (active) setView(v);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'This intake link is invalid or has expired.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [token]);

  async function saveSection(sectionType: string, data: Record<string, unknown>) {
    const v = await intakeApi.publicSubmitSection(token, sectionType, data);
    setView(v);
  }

  async function finish() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const r = await intakeApi.publicSubmit(token);
      setSubmitted(r.message);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Could not submit this intake. Please try again or contact the clinic.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <CenterCard><Loader2 className="w-6 h-6 animate-spin text-indigo" /></CenterCard>;
  if (error || !view) return <CenterCard><div role="alert" className="text-center"><AlertCircle className="w-8 h-8 text-red-v mx-auto mb-2" /><p className="text-sm text-t2">{error}</p></div></CenterCard>;
  if (submitted) return <CenterCard><div role="status" aria-live="polite" className="text-center"><CheckCircle2 className="w-10 h-10 text-emerald-v mx-auto mb-3" /><p className="text-base font-semibold text-t1 mb-1">Intake submitted for review</p><p className="text-sm text-t3 max-w-sm">{submitted}</p><p className="mt-2 text-xs text-t3">Submission does not confirm clinical review, insurance coverage, or payment.</p></div></CenterCard>;

  const allDone = view.sections.every(s => s.status === 'completed');

  return (
    <div className="min-h-screen bg-[var(--s1)] py-10 px-4">
      <div className="max-w-xl mx-auto space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo grid place-items-center"><ShieldCheck className="w-5 h-5 text-white" /></div>
          <div>
            <h1 className="text-lg font-bold text-t1">{view.clinicName}</h1>
            <p className="text-xs text-t3">Pre-visit intake{view.appointment ? ` · ${view.appointment.service} on ${new Date(view.appointment.startsAt).toLocaleDateString()}` : ''}</p>
          </div>
        </div>

        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
          Do not use this form for urgent or emergency concerns. In the United States, call 911 or go to the nearest emergency department. This form is not monitored for immediate response.
        </div>

        <div className="cc-card p-4">
          <div className="flex items-center justify-between text-xs text-t3 mb-2"><span>Intake completion</span><span className="font-semibold text-t2">{view.readinessScore}%</span></div>
          <div className="h-2 rounded-full bg-[var(--s3)] overflow-hidden"><div className="h-full bg-emerald-v" style={{ width: `${view.readinessScore}%` }} /></div>
          <p className="mt-2 text-[10.5px] text-t3">This percentage tracks completed form sections only. It does not mean you are medically cleared or financially approved for the visit.</p>
        </div>

        {view.sections.map(s => (
          <SectionCard key={s.sectionType} section={s} clinicName={view.clinicName} onSave={saveSection} />
        ))}

        {submitError && <p role="alert" aria-live="assertive" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-semibold text-red-700">{submitError}</p>}
        <button type="button" disabled={!allDone || submitting} aria-busy={submitting} onClick={finish} className="w-full rounded-xl bg-indigo px-4 py-3 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">
          {submitting ? 'Submitting…' : allDone ? 'Submit to clinic' : 'Complete all sections to submit'}
        </button>
        <p className="text-center text-[10px] text-t3">Your information is submitted to the clinic for review. Do not include information that the form does not request. This is not a medical or emergency service.</p>
      </div>
    </div>
  );
}

function CenterCard({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen grid place-items-center bg-[var(--s1)] p-4"><div className="cc-card p-8">{children}</div></div>;
}

function SectionCard({ section, clinicName, onSave }: { section: PublicIntakeView['sections'][number]; clinicName: string; onSave: (t: string, d: Record<string, unknown>) => Promise<void> }) {
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const done = section.status === 'completed';
  const set = (k: string, v: unknown) => setForm(p => ({ ...p, [k]: v }));

  async function save() {
    setBusy(true); setErr(null);
    const data = section.acknowledgement ? { ...form, acknowledgementId: section.acknowledgement.id } : form;
    try { await onSave(section.sectionType, data); } catch (e) { setErr(e instanceof Error ? e.message : 'Could not save'); } finally { setBusy(false); }
  }

  const input = 'w-full rounded-lg border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-sm text-t1 outline-none focus:border-indigo';
  return (
    <div className="cc-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-t1">{SECTION_LABEL[section.sectionType] ?? section.sectionType}</h3>
        {done && <span className="badge badge-emerald inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Done</span>}
      </div>
      <p className="text-xs text-t3">{section.acknowledgement?.text ?? section.prompt}</p>
      {!done && (
        <>
          {section.sectionType === 'demographics' && (
            <div className="grid grid-cols-2 gap-2">
              <input className={input} aria-label="First name" autoComplete="given-name" placeholder="First name" onChange={e => set('firstName', e.target.value)} />
              <input className={input} aria-label="Last name" autoComplete="family-name" placeholder="Last name" onChange={e => set('lastName', e.target.value)} />
              <input className={input} aria-label="Email" autoComplete="email" placeholder="Email" onChange={e => set('email', e.target.value)} />
              <input className={input} aria-label="Phone" autoComplete="tel" placeholder="Phone" onChange={e => set('phone', e.target.value)} />
            </div>
          )}
          {section.sectionType === 'communication_consent' && (
            <div className="space-y-2">
              <p className="text-[11px] text-t3">This intake does not grant permission for outbound messages or calls. Use these controls only to record channels you do not want {clinicName} to use. Any future opt-in requires the clinic's purpose-specific disclosure and consent process.</p>
              {(['sms', 'email', 'voice'] as const).map(ch => (
                <label key={ch} className="flex items-center gap-2 text-sm text-t2"><input type="checkbox" onChange={e => set(ch, e.target.checked ? false : undefined)} /> Opt out of {ch === 'voice' ? 'voice calls' : ch.toUpperCase()}</label>
              ))}
              <p className="text-[10.5px] text-t3">Leaving a box unchecked does not create or imply outbound authority.</p>
            </div>
          )}
          {section.sectionType === 'insurance' && (
            <div className="grid grid-cols-2 gap-2">
              <input className={input} aria-label="Insurance payer name" placeholder="Payer name" onChange={e => set('payerName', e.target.value)} />
              <input className={input} aria-label="Insurance plan name" placeholder="Plan name" onChange={e => set('planName', e.target.value)} />
              <input className={input} aria-label="Insurance member ID" autoComplete="off" placeholder="Member ID" onChange={e => set('memberId', e.target.value)} />
              <input className={input} aria-label="Insurance group number" autoComplete="off" placeholder="Group number" onChange={e => set('groupNumber', e.target.value)} />
            </div>
          )}
          {(section.sectionType === 'insurance_card' || section.sectionType === 'photo_id') && (
            <div className="rounded-lg border border-dashed border-[var(--b2)] p-3 text-center text-xs text-t3">
              This page records whether you have the document ready; it does not upload or store an image. The clinic will use its approved document workflow or collect it at the front desk.
              <label className="mt-2 flex items-center justify-center gap-2 text-t2"><input type="checkbox" onChange={e => { set('hasFront', e.target.checked); set('hasBack', e.target.checked); }} /> I have my {section.sectionType === 'photo_id' ? 'photo ID' : 'insurance card'} ready</label>
            </div>
          )}
          {section.sectionType === 'estimate_acknowledgement' && (
            <label className="flex items-start gap-2 text-sm text-t2"><input type="checkbox" className="mt-1" onChange={e => set('accepted', e.target.checked)} /> I understand the amount shown is an <strong>estimate</strong> of my responsibility, not a guarantee, and may change based on my insurance.</label>
          )}
          {section.sectionType === 'payment_policy' && (
            <p role="status" className="rounded-lg border border-[var(--b1)] bg-[var(--amber-soft)] p-3 text-sm text-amber-v">No versioned clinic payment policy is available in this packet, so this section cannot record an acknowledgment.</p>
          )}
          {(section.sectionType === 'pre_visit_checklist' || section.sectionType === 'consent_forms' || section.sectionType === 'custom') && (
            <label className="flex items-start gap-2 text-sm text-t2"><input type="checkbox" className="mt-1" onChange={e => set('accepted', e.target.checked)} /> I confirm this section.</label>
          )}
          {err && <p role="alert" aria-live="assertive" className="text-[11px] text-red-v">{err}</p>}
          <button type="button" disabled={busy || section.sectionType === 'payment_policy' || Boolean(section.acknowledgement && form.accepted !== true)} onClick={save} className="rounded-lg bg-indigo px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
        </>
      )}
    </div>
  );
}
