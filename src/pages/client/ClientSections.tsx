import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarDays, ClipboardList, FileText, ShieldCheck, CreditCard, User, Bell, Loader2,
  ChevronRight, Plus, ExternalLink, Info, ShieldAlert,
} from 'lucide-react';
import EmptyStatePremium from '../../components/ui/EmptyStatePremium';
import { formatCurrency } from '../../utils/formatters';
import {
  portalClient, STATE_META,
  type PortalDashboard, type PortalAppt, type PortalRequest, type PortalIntake,
  type PortalInsurance, type PortalPayment, type PortalEstimate, type PortalPreferences,
} from '../../lib/portalClient';

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? (import.meta.env.PROD ? '' : 'http://localhost:3001');
function Skel({ n = 3 }: { n?: number }) { return <div className="space-y-2">{Array.from({ length: n }).map((_, i) => <div key={i} className="skeleton-line h-16 rounded-xl" />)}</div>; }
function H({ icon: Icon, title, sub }: { icon: React.ElementType; title: string; sub?: string }) {
  return <div className="mb-4"><h1 className="text-lg font-bold text-t1 flex items-center gap-2"><Icon className="w-5 h-5 text-indigo" /> {title}</h1>{sub && <p className="text-[13px] text-t3 mt-0.5">{sub}</p>}</div>;
}
function StateBadge({ state }: { state: string }) {
  const m = STATE_META[state] ?? { label: state, badge: 'badge-blue' };
  return <span className={`badge ${m.badge}`}>{m.label}</span>;
}

function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[var(--b1)] bg-white/70 px-4 py-3 shadow-sm backdrop-blur">
      <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-t3">{label}</p>
      <p className="mt-1 text-sm font-semibold text-t1 truncate">{value}</p>
    </div>
  );
}

function LoadError({ title, message }: { title: string; message: string }) {
  return (
    <div className="rounded-2xl border border-[rgba(220,38,38,0.18)] bg-red-soft px-4 py-4">
      <p className="text-sm font-bold text-red-v">{title}</p>
      <p className="mt-1 text-[12px] leading-6 text-t2">{message}</p>
    </div>
  );
}

/* ----------------------------------------------------------------- Dashboard */
export function ClientDashboard() {
  const [d, setD] = useState<PortalDashboard | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let a = true;
    void (async () => {
      setLoadError(null);
      try {
        const x = await portalClient.dashboard();
        if (a) setD(x);
      } catch (e) {
        if (a) setLoadError(e instanceof Error ? e.message : 'Failed to load portal dashboard');
      }
    })();
    return () => { a = false; };
  }, []);
  if (loadError) return <LoadError title="Dashboard unavailable" message={loadError} />;
  if (!d) return <Skel n={4} />;
  const nextSteps: Array<{ action: string; label: string }> = [
    { action: 'request_appointment', label: 'Request an appointment' },
    { action: 'continue_intake', label: 'Continue intake' },
    { action: 'update_insurance', label: 'Update insurance' },
    { action: 'view_payments', label: 'Review payments' },
    { action: 'acknowledge_estimate', label: 'Acknowledge estimate' },
    { action: 'update_preferences', label: 'Update preferences' },
  ].filter(step => d.allowedActions.includes(step.action));
  const CARDS: Array<{ key: string; label: string; to: string }> = [
    { key: 'nextAppointment', label: 'Next appointment', to: '/client/appointments' },
    { key: 'appointmentRequests', label: 'Appointment requests', to: '/client/requests' },
    { key: 'intake', label: 'Intake forms', to: '/client/intake' },
    { key: 'insurance', label: 'Insurance', to: '/client/insurance' },
    { key: 'payment', label: 'Payments', to: '/client/payments' },
    { key: 'estimate', label: 'Cost estimate', to: '/client/payments' },
  ];
  return (
    <div>
      <div className="rounded-[2rem] border border-[var(--b1)] bg-[linear-gradient(135deg,rgba(255,255,255,0.92),rgba(245,247,255,0.88))] p-5 sm:p-6 mb-5 shadow-[0_18px_55px_rgba(15,23,42,0.08)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 max-w-2xl">
            <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-t3">Pilot dashboard</p>
            <h1 className="mt-1 text-2xl sm:text-[2rem] font-black tracking-tight text-t1">Hi {d.displayName.split(' ')[0]}, your care is in one place.</h1>
            <p className="mt-2 text-[13px] text-t2 leading-relaxed">You can review appointments, request visits, update insurance, and manage reminders in the same portal the clinic configured for your account.</p>
          </div>
          <StateBadge state={d.paymentPolicyAcknowledged ? 'completed' : 'action_required'} />
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <StatPill label="Clinic" value={`${d.clinicName}${d.branchName ? ` · ${d.branchName}` : ''}`} />
          <StatPill label="Portal state" value={d.paymentPolicyAcknowledged ? 'Billing policy acknowledged' : 'Billing policy pending'} />
          <StatPill label="Action set" value={`${nextSteps.length} next steps available`} />
        </div>
        {!d.paymentPolicyAcknowledged && (
          <div className="mt-4 rounded-2xl border border-[var(--b1)] bg-white/75 px-4 py-3">
            <p className="text-[12px] text-t2 flex items-start gap-2">
              <Info className="w-4 h-4 text-indigo shrink-0 mt-0.5" />
              The payments module will still show balances and estimates, but the portal has not yet recorded the policy acknowledgment step.
            </p>
          </div>
        )}
        {nextSteps.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {nextSteps.slice(0, 4).map(step => (
              <Link
                key={step.action}
                to={d.deepLinkTargets[step.action === 'request_appointment' ? 'requests' :
                  step.action === 'continue_intake' ? 'intake' :
                  step.action === 'update_insurance' ? 'insurance' :
                  step.action === 'view_payments' ? 'payments' :
                  step.action === 'acknowledge_estimate' ? 'payments' : 'preferences']}
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--b1)] bg-white/80 px-3 py-1.5 text-[12px] font-semibold text-t2 shadow-sm hover:bg-[var(--s2)]"
              >
                <ChevronRight className="w-3.5 h-3.5" /> {step.label}
              </Link>
            ))}
          </div>
        )}
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        {CARDS.map(c => {
          const card = d.cards[c.key] ?? { state: 'unavailable' };
          return (
            <Link key={c.key} to={c.to} className="hover-lift rounded-2xl border border-[var(--b1)] bg-[var(--s1)] p-4 flex items-center justify-between gap-3 focus-visible:outline-2 focus-visible:outline-[var(--indigo)]">
              <div className="min-w-0">
                <p className="text-[13px] font-bold text-t1">{c.label}</p>
                <p className="text-[12px] text-t3 mt-0.5">
                  {c.key === 'nextAppointment' && card.service ? `${card.service} · ${card.startsAt ? new Date(card.startsAt).toLocaleDateString() : ''}` :
                   c.key === 'payment' && card.amount ? `${formatCurrency(card.amount)} due` :
                   c.key === 'appointmentRequests' && card.count ? `${card.count} awaiting review` : ' '}
                </p>
                <div className="mt-2"><StateBadge state={card.detail && c.key === 'insurance' ? card.detail : card.state} /></div>
              </div>
              <ChevronRight className="w-4 h-4 text-t3 shrink-0" aria-hidden="true" />
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- Appointments */
export function ClientAppointments() {
  const [data, setData] = useState<{ upcoming: PortalAppt[]; past: PortalAppt[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let a = true;
    void (async () => {
      setLoadError(null);
      try {
        const x = await portalClient.appointments();
        if (a) setData(x);
      } catch (e) {
        if (a) setLoadError(e instanceof Error ? e.message : 'Failed to load appointments');
      }
    })();
    return () => { a = false; };
  }, []);
  if (loadError) return <LoadError title="Appointments unavailable" message={loadError} />;
  if (!data) return <Skel />;
  const Row = (a: PortalAppt) => (
    <div key={a.id} className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3.5 flex items-center justify-between gap-3">
      <div><p className="text-[13px] font-bold text-t1">{a.service}</p><p className="text-[12px] text-t3">{new Date(a.startsAt).toLocaleString()}{a.provider ? ` · ${a.provider}` : ''}</p></div>
      <span className="badge badge-blue capitalize">{a.status.toLowerCase().replace('_', ' ')}</span>
    </div>
  );
  return (
    <div>
      <H icon={CalendarDays} title="Appointments" sub="Your upcoming and past visits" />
      <p className="text-[11px] font-bold uppercase tracking-wide text-t3 mb-2">Upcoming</p>
      {data.upcoming.length ? <div className="space-y-2">{data.upcoming.map(Row)}</div> : <EmptyStatePremium icon={<CalendarDays className="w-5 h-5" />} title="No upcoming appointments" description="Request one and the clinic will confirm a time." cta={{ label: 'Request appointment', onClick: () => { window.location.assign('/client/requests'); } }} />}
      {data.past.length > 0 && <><p className="text-[11px] font-bold uppercase tracking-wide text-t3 mt-5 mb-2">Past</p><div className="space-y-2">{data.past.map(Row)}</div></>}
    </div>
  );
}

/* ------------------------------------------------------------------ Requests */
export function ClientRequests() {
  const [rows, setRows] = useState<PortalRequest[] | null>(null);
  const [service, setService] = useState(''); const [when, setWhen] = useState(''); const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  async function load() { setRows(await portalClient.requests()); }
  useEffect(() => {
    let a = true;
    void (async () => {
      setLoadError(null);
      try {
        const x = await portalClient.requests();
        if (a) setRows(x);
      } catch (e) {
        if (a) setLoadError(e instanceof Error ? e.message : 'Failed to load requests');
      }
    })();
    return () => { a = false; };
  }, []);
  async function submit() {
    setBusy(true); setMsg(null);
    try { const r = await portalClient.createRequest({ service: service.trim(), requestedDateTime: when || undefined, notes: notes.trim() || undefined }); setMsg(r.deduped ? 'You already have a matching request pending review.' : 'Request submitted — the clinic will be in touch.'); setService(''); setWhen(''); setNotes(''); await load(); }
    catch (e) { setMsg(e instanceof Error ? e.message : 'Could not submit'); } finally { setBusy(false); }
  }
  const inp = 'w-full rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm text-t1 outline-none focus:border-[var(--indigo)]';
  return (
    <div>
      <H icon={ClipboardList} title="Appointment requests" sub="Ask for a time — staff confirm availability (no auto-booking)" />
      <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4 space-y-2.5 mb-5">
        <input className={inp} value={service} onChange={e => setService(e.target.value)} placeholder="What do you need? (e.g. Dental check-up)" />
        <div className="grid grid-cols-2 gap-2.5">
          <input className={inp} type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} aria-label="Preferred date and time" />
          <input className={inp} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes (optional)" />
        </div>
        <button type="button" disabled={busy || service.trim().length < 2} onClick={submit} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"><Plus className="w-4 h-4" /> Submit request</button>
        {msg && <p className="text-[12px] text-emerald-v">{msg}</p>}
      </div>
      {loadError ? <LoadError title="Appointment requests unavailable" message={loadError} /> : !rows ? <Skel /> : rows.length === 0 ? <EmptyStatePremium icon={<ClipboardList className="w-5 h-5" />} title="No requests yet" description="Submit a request above and track its status here." /> :
        <div className="space-y-2">{rows.map(r => (
          <div key={r.id} className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3.5 flex items-center justify-between gap-3">
            <div><p className="text-[13px] font-bold text-t1">{r.service ?? 'Appointment request'}</p><p className="text-[12px] text-t3">{r.requestedDateTime ? new Date(r.requestedDateTime).toLocaleString() : 'Flexible'} · {new Date(r.createdAt).toLocaleDateString()}</p></div>
            <span className="badge badge-amber capitalize">{r.status.toLowerCase().replace(/_/g, ' ')}</span>
          </div>
        ))}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------- Intake */
export function ClientIntake() {
  const [rows, setRows] = useState<PortalIntake[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let a = true;
    void (async () => {
      setLoadError(null);
      try {
        const x = await portalClient.intake();
        if (a) setRows(x);
      } catch (e) {
        if (a) setLoadError(e instanceof Error ? e.message : 'Failed to load intake forms');
      }
    })();
    return () => { a = false; };
  }, []);
  if (loadError) return <LoadError title="Intake unavailable" message={loadError} />;
  if (!rows) return <Skel />;
  return (
    <div>
      <H icon={FileText} title="Intake forms" sub="Complete your pre-visit information" />
      {rows.length === 0 ? <EmptyStatePremium icon={<FileText className="w-5 h-5" />} title="No intake forms" description="When your clinic sends an intake form, it will appear here." /> :
        <div className="space-y-2">{rows.map(p => (
          <div key={p.id} className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[13px] font-bold text-t1">Intake packet</p>
              <StateBadge state={p.label} />
            </div>
            <div className="prog-track md mt-2"><div className={`prog-fill ${p.readinessScore >= 80 ? 'pf-emerald' : 'pf-amber'}`} style={{ width: `${p.readinessScore}%` }} /></div>
            <p className="text-[11px] text-t3 mt-1.5">{p.readinessScore}% complete · started {new Date(p.createdAt).toLocaleDateString()}</p>
          </div>
        ))}</div>}
      <p className="text-[11px] text-t3 mt-4">To complete a form, use the secure link your clinic sent. Submitted forms are reviewed by staff.</p>
    </div>
  );
}

/* ----------------------------------------------------------------- Insurance */
export function ClientInsurance() {
  const [rows, setRows] = useState<PortalInsurance[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ planName: '', memberId: '', groupNumber: '', subscriberName: '' });
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  async function load() { setRows(await portalClient.insurance()); }
  useEffect(() => {
    let a = true;
    void (async () => {
      setLoadError(null);
      try {
        const x = await portalClient.insurance();
        if (a) setRows(x);
      } catch (e) {
        if (a) setLoadError(e instanceof Error ? e.message : 'Failed to load insurance');
      }
    })();
    return () => { a = false; };
  }, []);
  async function save() { setBusy(true); setMsg(null); try { await portalClient.saveInsurance(form); setMsg('Saved — the clinic will verify your coverage.'); setAdding(false); setForm({ planName: '', memberId: '', groupNumber: '', subscriberName: '' }); await load(); } catch (e) { setMsg(e instanceof Error ? e.message : 'Could not save'); } finally { setBusy(false); } }
  const inp = 'w-full rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm text-t1 outline-none focus:border-[var(--indigo)]';
  if (loadError) return <LoadError title="Insurance unavailable" message={loadError} />;
  if (!rows) return <Skel />;
  return (
    <div>
      <H icon={ShieldCheck} title="Insurance" sub="Your coverage on file (the clinic verifies eligibility)" />
      <div className="space-y-2 mb-4">
        {rows.length === 0 ? <EmptyStatePremium icon={<ShieldCheck className="w-5 h-5" />} title="No insurance on file" description="Add your plan so the clinic can verify your coverage." cta={{ label: 'Add insurance', onClick: () => setAdding(true) }} /> :
          rows.map(p => (
            <div key={p.id} className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3.5 flex items-center justify-between gap-3">
              <div><p className="text-[13px] font-bold text-t1">{p.planName}</p><p className="text-[12px] text-t3">Member {p.memberId}{p.groupNumber ? ` · Group ${p.groupNumber}` : ''}</p></div>
              <StateBadge state={p.status} />
            </div>
          ))}
      </div>
      {!adding && rows.length > 0 && <button type="button" onClick={() => setAdding(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-3 py-2 text-sm font-semibold text-t2 hover:bg-[var(--s2)]"><Plus className="w-4 h-4" /> Add / update insurance</button>}
      {adding && (
        <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4 space-y-2.5">
          <input className={inp} value={form.planName} onChange={e => setForm(f => ({ ...f, planName: e.target.value }))} placeholder="Plan name (e.g. Aetna Core)" />
          <input className={inp} value={form.memberId} onChange={e => setForm(f => ({ ...f, memberId: e.target.value }))} placeholder="Member ID" />
          <div className="grid grid-cols-2 gap-2.5">
            <input className={inp} value={form.groupNumber} onChange={e => setForm(f => ({ ...f, groupNumber: e.target.value }))} placeholder="Group # (optional)" />
            <input className={inp} value={form.subscriberName} onChange={e => setForm(f => ({ ...f, subscriberName: e.target.value }))} placeholder="Subscriber name (optional)" />
          </div>
          <div className="flex gap-2"><button type="button" disabled={busy || form.planName.trim().length < 1 || form.memberId.trim().length < 2} onClick={save} className="rounded-lg bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">Save</button><button type="button" onClick={() => setAdding(false)} className="rounded-lg border border-[var(--b1)] px-4 py-2 text-sm font-semibold text-t2">Cancel</button></div>
        </div>
      )}
      {msg && <p className="text-[12px] text-emerald-v mt-2">{msg}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ Payments */
export function ClientPayments() {
  const [payments, setPayments] = useState<PortalPayment[] | null>(null);
  const [estimates, setEstimates] = useState<PortalEstimate[]>([]);
  const [dashboard, setDashboard] = useState<PortalDashboard | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  async function load() { const [p, e, d] = await Promise.all([portalClient.payments(), portalClient.estimates(), portalClient.dashboard()]); setPayments(p); setEstimates(e); setDashboard(d); }
  useEffect(() => {
    let a = true;
    void (async () => {
      setLoadError(null);
      try {
        const [p, e, d] = await Promise.all([portalClient.payments(), portalClient.estimates(), portalClient.dashboard()]);
        if (a) { setPayments(p); setEstimates(e); setDashboard(d); }
      } catch (err) {
        if (a) setLoadError(err instanceof Error ? err.message : 'Failed to load payments');
      }
    })();
    return () => { a = false; };
  }, []);
  async function ackEstimate(id: string) { setBusy(id); try { await portalClient.acknowledgeEstimate(id); await load(); } finally { setBusy(null); } }
  async function ackPolicy() { setBusy('policy'); try { await portalClient.acknowledgePaymentPolicy(); await load(); } finally { setBusy(null); } }
  if (loadError) return <LoadError title="Payments unavailable" message={loadError} />;
  if (!payments) return <Skel />;
  return (
    <div>
      <H icon={CreditCard} title="Payments & estimates" sub="Pay securely — payments are confirmed by your provider, never marked paid here" />
      {dashboard && !dashboard.paymentPolicyAcknowledged && (
        <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4 mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-t1">Payment policy acknowledgment needed</p>
            <p className="text-[12px] text-t3 mt-0.5">This is part of the live portal handoff. It keeps the billing flow honest before a customer starts testing scenarios.</p>
          </div>
          <button type="button" disabled={busy === 'policy'} onClick={ackPolicy} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-3 py-2 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
            {busy === 'policy' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldAlert className="w-3.5 h-3.5" />} Acknowledge
          </button>
        </div>
      )}
      <p className="text-[11px] font-bold uppercase tracking-wide text-t3 mb-2">Balances</p>
      {payments.length === 0 ? <p className="text-[13px] text-t3">No payments due.</p> :
        <div className="space-y-2">{payments.map(p => (
          <div key={p.id} className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3.5 flex items-center justify-between gap-3">
            <div><p className="text-[13px] font-bold text-t1">{formatCurrency(p.amount)} <span className="text-[11px] font-normal text-t3">{p.currency}</span></p><p className="text-[12px] text-t3">{p.reason} · {p.status}</p></div>
            {p.payLink ? <a href={`${API}${p.payLink}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-[12px] font-semibold text-white hover:opacity-90">Pay <ExternalLink className="w-3.5 h-3.5" /></a> : <span className="badge badge-blue">{p.status}</span>}
          </div>
        ))}</div>}
      <p className="text-[11px] font-bold uppercase tracking-wide text-t3 mt-5 mb-2">Cost estimates</p>
      {estimates.length === 0 ? <p className="text-[13px] text-t3">No estimates available.</p> :
        <div className="space-y-2">{estimates.map(e => (
          <div key={e.id} className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[13px] font-bold text-t1">Your estimated portion: {formatCurrency(e.estimatedPatientResponsibility)}</p>
              {e.acknowledged ? <span className="badge badge-emerald">Acknowledged</span> : <button type="button" disabled={busy === e.id} onClick={() => ackEstimate(e.id)} className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-[12px] font-semibold text-t2 hover:bg-[var(--s2)] disabled:opacity-50">{busy === e.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Acknowledge'}</button>}
            </div>
            <p className="text-[11px] text-t3 mt-1">{e.disclaimer}</p>
          </div>
        ))}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------- Profile */
export function ClientProfile() {
  const [p, setP] = useState<{ firstName: string; lastName: string; email: string; phone: string } | null>(null);
  const [email, setEmail] = useState(''); const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let a = true;
    void (async () => {
      setLoadError(null);
      try {
        const x = await portalClient.profile();
        if (a) { setP(x); setEmail(x.email); setPhone(x.phone); }
      } catch (e) {
        if (a) setLoadError(e instanceof Error ? e.message : 'Failed to load profile');
      }
    })();
    return () => { a = false; };
  }, []);
  if (loadError) return <LoadError title="Profile unavailable" message={loadError} />;
  async function save() { setBusy(true); setMsg(null); try { await portalClient.saveProfile({ email: email.trim() || undefined, phone: phone.trim() || undefined }); setMsg('Saved.'); } catch (e) { setMsg(e instanceof Error ? e.message : 'Could not save'); } finally { setBusy(false); } }
  const inp = 'w-full rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm text-t1 outline-none focus:border-[var(--indigo)]';
  if (!p) return <Skel n={2} />;
  return (
    <div>
      <H icon={User} title="Profile" sub="Your contact details" />
      <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s1)] p-4 space-y-3 max-w-md">
        <div><p className="text-[11px] uppercase tracking-wide text-t3">Name</p><p className="text-sm font-semibold text-t1">{p.firstName} {p.lastName}</p></div>
        <label className="block space-y-1"><span className="text-[11px] font-semibold text-t3">Email</span><input className={inp} type="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label className="block space-y-1"><span className="text-[11px] font-semibold text-t3">Phone</span><input className={inp} value={phone} onChange={e => setPhone(e.target.value)} /></label>
        <div className="flex items-center gap-3"><button type="button" disabled={busy} onClick={save} className="rounded-lg bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">Save changes</button>{msg && <span className="text-[12px] text-emerald-v">{msg}</span>}</div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- Preferences */
export function ClientPreferences() {
  const [prefs, setPrefs] = useState<PortalPreferences | null>(null);
  const [history, setHistory] = useState<Array<{ purpose: string; granted: boolean; at: string }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  async function load() { const [p, h] = await Promise.all([portalClient.preferences(), portalClient.consents()]); setPrefs(p); setHistory(h); }
  useEffect(() => {
    let a = true;
    void (async () => {
      setLoadError(null);
      try {
        const [p, h] = await Promise.all([portalClient.preferences(), portalClient.consents()]);
        if (a) { setPrefs(p); setHistory(h); }
      } catch (e) {
        if (a) setLoadError(e instanceof Error ? e.message : 'Failed to load preferences');
      }
    })();
    return () => { a = false; };
  }, []);
  async function toggle(key: keyof PortalPreferences) { if (!prefs) return; setBusy(key); try { await portalClient.savePreferences({ [key]: !prefs[key] }); await load(); } finally { setBusy(null); } }
  if (loadError) return <LoadError title="Preferences unavailable" message={loadError} />;
  if (!prefs) return <Skel n={2} />;
  const ROWS: Array<{ key: keyof PortalPreferences; label: string; desc: string }> = [
    { key: 'email', label: 'Email', desc: 'Appointment reminders & updates by email' },
    { key: 'sms', label: 'SMS', desc: 'Text message reminders' },
    { key: 'whatsapp', label: 'WhatsApp', desc: 'WhatsApp messages' },
    { key: 'voice', label: 'Voice calls', desc: 'Phone calls and voice reminders' },
    { key: 'marketing', label: 'Marketing', desc: 'Offers & news (opting out stops all campaigns)' },
  ];
  return (
    <div>
      <H icon={Bell} title="Communication preferences" sub="Choose how your clinic can contact you" />
      <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s1)] divide-y divide-[var(--b1)] mb-5">
        {ROWS.map(r => (
          <div key={r.key} className="flex items-center justify-between gap-3 px-4 py-3">
            <div><p className="text-[13px] font-semibold text-t1">{r.label}</p><p className="text-[11px] text-t3">{r.desc}</p></div>
            <button type="button" role="switch" aria-checked={prefs[r.key] ? 'true' : 'false'} aria-label={`${prefs[r.key] ? 'Disable' : 'Enable'} ${r.label}`} disabled={busy === r.key} onClick={() => toggle(r.key)}
              className={`relative w-10 h-6 rounded-full shrink-0 transition-colors ${prefs[r.key] ? 'bg-[var(--indigo)]' : 'bg-[var(--b2)]'}`}>
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${prefs[r.key] ? 'left-[18px]' : 'left-0.5'}`} />
            </button>
          </div>
        ))}
      </div>
      <p className="text-[11px] font-bold uppercase tracking-wide text-t3 mb-2">Consent history</p>
      {history.length === 0 ? <p className="text-[12px] text-t3">No consent changes recorded yet.</p> :
        <div className="space-y-1">{history.slice(0, 12).map((h, i) => (
          <div key={i} className="flex items-center justify-between text-[11px] rounded-lg border border-[var(--b1)] px-3 py-1.5"><span className="text-t2 capitalize">{h.purpose.toLowerCase()} {h.granted ? 'opted in' : 'opted out'}</span><span className="text-t3">{new Date(h.at).toLocaleDateString()}</span></div>
        ))}</div>}
    </div>
  );
}
