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
    const r = await intakeApi.publicSubmit(token);
    setSubmitted(r.message);
  }

  if (loading) return <CenterCard><Loader2 className="w-6 h-6 animate-spin text-indigo" /></CenterCard>;
  if (error || !view) return <CenterCard><div className="text-center"><AlertCircle className="w-8 h-8 text-red-v mx-auto mb-2" /><p className="text-sm text-t2">{error}</p></div></CenterCard>;
  if (submitted) return <CenterCard><div className="text-center"><CheckCircle2 className="w-10 h-10 text-emerald-v mx-auto mb-3" /><p className="text-base font-semibold text-t1 mb-1">All set!</p><p className="text-sm text-t3 max-w-sm">{submitted}</p></div></CenterCard>;

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

        <div className="cc-card p-4">
          <div className="flex items-center justify-between text-xs text-t3 mb-2"><span>Readiness</span><span className="font-semibold text-t2">{view.readinessScore}%</span></div>
          <div className="h-2 rounded-full bg-[var(--s3)] overflow-hidden"><div className="h-full bg-emerald-v" style={{ width: `${view.readinessScore}%` }} /></div>
        </div>

        {view.sections.map(s => (
          <SectionCard key={s.sectionType} section={s} storage={view.objectStorageEnabled} onSave={saveSection} />
        ))}

        <button type="button" disabled={!allDone} onClick={finish} className="w-full rounded-xl bg-indigo px-4 py-3 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">
          {allDone ? 'Submit to clinic' : 'Complete all sections to submit'}
        </button>
        <p className="text-center text-[10px] text-t3">Your information is sent securely to the clinic for review. This is not a medical or emergency service.</p>
      </div>
    </div>
  );
}

function CenterCard({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen grid place-items-center bg-[var(--s1)] p-4"><div className="cc-card p-8">{children}</div></div>;
}

function SectionCard({ section, storage, onSave }: { section: PublicIntakeView['sections'][number]; storage: boolean; onSave: (t: string, d: Record<string, unknown>) => Promise<void> }) {
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
              <input className={input} placeholder="First name" onChange={e => set('firstName', e.target.value)} />
              <input className={input} placeholder="Last name" onChange={e => set('lastName', e.target.value)} />
              <input className={input} placeholder="Email" onChange={e => set('email', e.target.value)} />
              <input className={input} placeholder="Phone" onChange={e => set('phone', e.target.value)} />
            </div>
          )}
          {section.sectionType === 'communication_consent' && (
            <div className="space-y-1.5">
              {(['sms', 'email', 'voice'] as const).map(ch => (
                <label key={ch} className="flex items-center gap-2 text-sm text-t2"><input type="checkbox" onChange={e => set(ch, e.target.checked)} /> Allow {ch.toUpperCase()} reminders</label>
              ))}
            </div>
          )}
          {section.sectionType === 'insurance' && (
            <div className="grid grid-cols-2 gap-2">
              <input className={input} placeholder="Payer name" onChange={e => set('payerName', e.target.value)} />
              <input className={input} placeholder="Plan name" onChange={e => set('planName', e.target.value)} />
              <input className={input} placeholder="Member ID" onChange={e => set('memberId', e.target.value)} />
              <input className={input} placeholder="Group number" onChange={e => set('groupNumber', e.target.value)} />
            </div>
          )}
          {(section.sectionType === 'insurance_card' || section.sectionType === 'photo_id') && (
            <div className="rounded-lg border border-dashed border-[var(--b2)] p-3 text-center text-xs text-t3">
              {storage ? 'Upload enabled.' : 'Secure photo upload is not enabled at this clinic yet — we will record that you have your card/ID ready and collect it at the front desk.'}
              <label className="mt-2 flex items-center justify-center gap-2 text-t2"><input type="checkbox" onChange={e => { set('hasFront', e.target.checked); set('hasBack', e.target.checked); }} /> I have my {section.sectionType === 'photo_id' ? 'photo ID' : 'insurance card'} ready</label>
            </div>
          )}
          {section.sectionType === 'estimate_acknowledgement' && (
            <label className="flex items-start gap-2 text-sm text-t2"><input type="checkbox" className="mt-1" onChange={e => set('accepted', e.target.checked)} /> I understand the amount shown is an <strong>estimate</strong> of my responsibility, not a guarantee, and may change based on my insurance.</label>
          )}
          {section.sectionType === 'payment_policy' && (
            <label className="flex items-start gap-2 text-sm text-t2"><input type="checkbox" className="mt-1" onChange={e => set('accepted', e.target.checked)} /> I have read and accept the clinic payment / deposit policy.</label>
          )}
          {(section.sectionType === 'pre_visit_checklist' || section.sectionType === 'consent_forms' || section.sectionType === 'custom') && (
            <label className="flex items-start gap-2 text-sm text-t2"><input type="checkbox" className="mt-1" onChange={e => set('accepted', e.target.checked)} /> I confirm this section.</label>
          )}
          {err && <p className="text-[11px] text-red-v">{err}</p>}
          <button type="button" disabled={busy || Boolean(section.acknowledgement && form.accepted !== true)} onClick={save} className="rounded-lg bg-indigo px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
        </>
      )}
    </div>
  );
}
