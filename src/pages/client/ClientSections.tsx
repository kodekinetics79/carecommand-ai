import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  CalendarDays, ClipboardList, FileText, ShieldCheck, CreditCard, User, Bell, Loader2,
  ChevronRight, Plus, ExternalLink, X, CheckCircle2,
} from 'lucide-react';
import EmptyStatePremium from '../../components/ui/EmptyStatePremium';
import { formatCurrency } from '../../utils/formatters';
import {
  portalClient, STATE_META,
  type PortalDashboard, type PortalAppt, type PortalRequest, type PortalIntake,
  type PortalIntakePacket, type PortalIntakeSection,
  type PortalInsurance, type PortalPayment, type PortalEstimate, type PortalPreferences,
  type PortalBookingProvider, type PortalBookingSlot,
} from '../../lib/portalClient';
import { clinicDateOffset, clinicLocalDateTimeToIso, formatClinicDateTime, formatClinicTime } from '../../lib/portalTime';

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
    <div role="alert" className="rounded-2xl border border-[rgba(220,38,38,0.18)] bg-red-soft px-4 py-4">
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
            <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-t3">Patient dashboard</p>
            <h1 className="mt-1 text-2xl sm:text-[2rem] font-black tracking-tight text-t1">Hi {d.displayName.split(' ')[0]}, your care is in one place.</h1>
            <p className="mt-2 text-[13px] text-t2 leading-relaxed">You can review appointments, request visits, update insurance, and manage reminders in the same portal the clinic configured for your account.</p>
          </div>
          <span className="badge badge-blue">Clinic-managed access</span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <StatPill label="Clinic" value={`${d.clinicName}${d.branchName ? ` · ${d.branchName}` : ''}`} />
          <StatPill label="Available actions" value={`${nextSteps.length} shown by the clinic`} />
          <StatPill label="Action set" value={`${nextSteps.length} next steps available`} />
        </div>
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
                  {c.key === 'nextAppointment' && card.service ? `${card.service} · ${card.startsAt ? formatClinicDateTime(card.startsAt, d.clinicTimezone) : ''}` :
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
// A single upcoming appointment card with self-service cancel + reschedule.
// The provider slot picker is used only with the canonical provider id. Older
// appointments without that relationship go through a staff-reviewed request.
function UpcomingApptRow({ appt, onChanged }: { appt: PortalAppt; onChanged: () => Promise<void> | void }) {
  const [mode, setMode] = useState<'idle' | 'cancel' | 'reschedule'>('idle');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const providerId = appt.providerProfileId;
  const durationMin = Math.max(5, Math.round((new Date(appt.endsAt).getTime() - new Date(appt.startsAt).getTime()) / 60000));
  const [date, setDate] = useState(() => clinicDateOffset(0, appt.clinicTimezone, new Date(appt.startsAt)));
  const [slots, setSlots] = useState<PortalBookingSlot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState('');

  useEffect(() => {
    if (mode !== 'reschedule' || !providerId) return;
    let a = true;
    void (async () => {
      try {
        const data = await portalClient.bookingSlots(providerId, date);
        if (a) { setSlots(data.slots); setSelectedSlot(data.slots[0]?.startsAt ?? ''); }
      } catch { if (a) { setSlots([]); setSelectedSlot(''); } }
    })();
    return () => { a = false; };
  }, [mode, providerId, date]);

  async function doCancel() {
    setBusy(true); setErr(null); setMsg(null);
    try { await portalClient.cancelAppointment(appt.id); await onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not cancel'); setBusy(false); }
  }
  async function doReschedule() {
    const startsAt = providerId ? selectedSlot : '';
    if (!startsAt) { setErr('Please choose a new time.'); return; }
    setBusy(true); setErr(null); setMsg(null);
    try { await portalClient.rescheduleAppointment(appt.id, { startsAt, durationMin }); setMsg('Appointment updated.'); await onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not reschedule'); setBusy(false); }
  }

  const inp = 'w-full rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm text-t1 outline-none focus:border-[var(--indigo)]';
  return (
    <div className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0"><p className="text-[13px] font-bold text-t1">{appt.service}</p><p className="text-[12px] text-t3">{formatClinicDateTime(appt.startsAt, appt.clinicTimezone)}{appt.providerName ? ` · ${appt.providerName}` : ''}</p></div>
        <span className="badge badge-blue capitalize shrink-0">{appt.status.toLowerCase().replace('_', ' ')}</span>
      </div>
      {mode === 'idle' && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {providerId ? (
            <button type="button" onClick={() => { setMode('reschedule'); setErr(null); setMsg(null); }} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-3 py-1.5 text-[12px] font-semibold text-t2 hover:bg-[var(--s2)]"><CalendarDays className="w-3.5 h-3.5" /> Reschedule</button>
          ) : (
            <Link to="/client/requests" className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-3 py-1.5 text-[12px] font-semibold text-t2 hover:bg-[var(--s2)]"><CalendarDays className="w-3.5 h-3.5" /> Ask clinic to reschedule</Link>
          )}
          <button type="button" onClick={() => { setMode('cancel'); setErr(null); setMsg(null); }} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-3 py-1.5 text-[12px] font-semibold text-red-v hover:bg-red-soft"><X className="w-3.5 h-3.5" /> Cancel</button>
        </div>
      )}
      {mode === 'cancel' && (
        <div className="mt-3 rounded-lg border border-[rgba(220,38,38,0.18)] bg-red-soft px-3 py-2.5">
          <p className="text-[12px] text-t2">Cancel this appointment? You can request or book a new time afterward.</p>
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={busy} onClick={doCancel} className="rounded-lg bg-red-v px-3 py-1.5 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50">{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Yes, cancel'}</button>
            <button type="button" disabled={busy} onClick={() => setMode('idle')} className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-[12px] font-semibold text-t2">Keep it</button>
          </div>
        </div>
      )}
      {mode === 'reschedule' && (
        <div className="mt-3 rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-2.5 space-y-2">
          {providerId ? (
            <>
              <label className="block space-y-1"><span className="text-[11px] font-bold uppercase tracking-wide text-t3">New date</span><input className={inp} type="date" value={date} onChange={e => { setSlots([]); setSelectedSlot(''); setDate(e.target.value); }} /></label>
              <label className="block space-y-1"><span className="text-[11px] font-bold uppercase tracking-wide text-t3">Open slots</span>
                <select className={inp} value={selectedSlot} onChange={e => setSelectedSlot(e.target.value)} aria-label="Open slots">
                  {slots.length === 0 ? <option value="">No open slots on this date</option> : slots.map(s => <option key={s.startsAt} value={s.startsAt}>{formatClinicTime(s.startsAt, appt.clinicTimezone)}</option>)}
                </select>
              </label>
              <p className="text-[11px] text-t3">Times shown in {appt.clinicTimezone} for {appt.branchName}.</p>
            </>
          ) : <p className="text-[12px] text-t2">This appointment needs clinic review before it can be moved. Submit a request and the front desk will confirm an available time.</p>}
          <div className="flex gap-2">
            <button type="button" disabled={busy || !providerId || !selectedSlot} onClick={doReschedule} className="rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50">{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Confirm new time'}</button>
            <button type="button" disabled={busy} onClick={() => setMode('idle')} className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-[12px] font-semibold text-t2">Back</button>
          </div>
        </div>
      )}
      {err && <p className="text-[12px] text-red-v mt-2">{err}</p>}
      {msg && <p className="text-[12px] text-emerald-v mt-2">{msg}</p>}
    </div>
  );
}

export function ClientAppointments() {
  const navigate = useNavigate();
  const [data, setData] = useState<{ upcoming: PortalAppt[]; past: PortalAppt[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  async function load() { setData(await portalClient.appointments()); }
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
  const PastRow = (a: PortalAppt) => (
    <div key={a.id} className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3.5 flex items-center justify-between gap-3">
      <div><p className="text-[13px] font-bold text-t1">{a.service}</p><p className="text-[12px] text-t3">{formatClinicDateTime(a.startsAt, a.clinicTimezone)}{a.providerName ? ` · ${a.providerName}` : ''}</p></div>
      <span className="badge badge-blue capitalize">{a.status.toLowerCase().replace('_', ' ')}</span>
    </div>
  );
  return (
    <div>
      <H icon={CalendarDays} title="Appointments" sub="Your upcoming and past visits" />
      <p className="text-[11px] font-bold uppercase tracking-wide text-t3 mb-2">Upcoming</p>
      {data.upcoming.length ? <div className="space-y-2">{data.upcoming.map(a => <UpcomingApptRow key={a.id} appt={a} onChanged={load} />)}</div> : <EmptyStatePremium icon={<CalendarDays className="w-5 h-5" />} title="No upcoming appointments" description="Request one and the clinic will confirm a time." cta={{ label: 'Request appointment', onClick: () => navigate('/client/requests') }} />}
      {data.past.length > 0 && <><p className="text-[11px] font-bold uppercase tracking-wide text-t3 mt-5 mb-2">Past</p><div className="space-y-2">{data.past.map(PastRow)}</div></>}
    </div>
  );
}

/* ------------------------------------------------------------------ Requests */
export function ClientRequests() {
  const [rows, setRows] = useState<PortalRequest[] | null>(null);
  const [providers, setProviders] = useState<PortalBookingProvider[] | null>(null);
  const [slots, setSlots] = useState<PortalBookingSlot[]>([]);
  const [providerId, setProviderId] = useState('');
  const [bookingDate, setBookingDate] = useState('');
  const [clinicContext, setClinicContext] = useState<{ name: string; timezone: string } | null>(null);
  const selectedProvider = providers?.find(provider => provider.id === providerId) ?? providers?.[0];
  const clinicTimezone = selectedProvider?.clinicTimezone ?? clinicContext?.timezone;
  const [selectedSlot, setSelectedSlot] = useState('');
  const [bookingReason, setBookingReason] = useState('');
  const [service, setService] = useState(''); const [when, setWhen] = useState(''); const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const [msgIsError, setMsgIsError] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bookingMsg, setBookingMsg] = useState<string | null>(null);
  const [bookingMsgIsError, setBookingMsgIsError] = useState(false);
  const [bookingBusy, setBookingBusy] = useState(false);
  async function load() { setRows(await portalClient.requests()); }
  async function loadSlots(nextProviderId = providerId, nextDate = bookingDate) {
    if (!nextProviderId || !nextDate) { setSlots([]); setSelectedSlot(''); return; }
    const data = await portalClient.bookingSlots(nextProviderId, nextDate);
    setSlots(data.slots);
    setSelectedSlot(data.slots[0]?.startsAt ?? '');
  }
  useEffect(() => {
    let a = true;
    void (async () => {
      setLoadError(null);
      try {
        const [x, p, dashboard] = await Promise.all([portalClient.requests(), portalClient.bookingProviders(), portalClient.dashboard()]);
        if (a) {
          setRows(x);
          setProviders(p);
          setClinicContext({ name: dashboard.branchName ?? dashboard.clinicName, timezone: dashboard.clinicTimezone });
          setProviderId(p[0]?.id ?? '');
          if (p[0]) setBookingDate(clinicDateOffset(7, p[0].clinicTimezone));
        }
      } catch (e) {
        if (a) setLoadError(e instanceof Error ? e.message : 'Failed to load requests');
      }
    })();
    return () => { a = false; };
  }, []);
  useEffect(() => {
    let a = true;
    void (async () => {
      if (!providerId || !bookingDate) { setSlots([]); setSelectedSlot(''); return; }
      try {
        const data = await portalClient.bookingSlots(providerId, bookingDate);
        if (a) {
          setSlots(data.slots);
          setSelectedSlot(data.slots[0]?.startsAt ?? '');
        }
      } catch (e) {
        if (a) { setSlots([]); setSelectedSlot(''); setBookingMsgIsError(true); setBookingMsg(e instanceof Error ? e.message : 'Could not load slots'); }
      }
    })();
    return () => { a = false; };
  }, [providerId, bookingDate]);
  async function submit() {
    setBusy(true); setMsg(null); setMsgIsError(false);
    const converted = when && clinicTimezone ? clinicLocalDateTimeToIso(when, clinicTimezone) : null;
    if (converted?.error) {
      setBusy(false); setMsgIsError(true);
      setMsg(converted.error === 'ambiguous' ? 'That local time occurs twice because clocks change. Choose another time or leave it flexible.' : converted.error === 'nonexistent' ? 'That local time does not exist because clocks change. Choose another time.' : 'Enter a valid preferred date and time.');
      return;
    }
    try { const r = await portalClient.createRequest({ service: service.trim(), requestedDateTime: converted?.iso ?? undefined, notes: notes.trim() || undefined }); setMsg(r.deduped ? 'You already have a matching request pending staff review.' : 'Request recorded for staff review. This is not a confirmed appointment, and no response time is promised.'); setService(''); setWhen(''); setNotes(''); await load(); }
    catch (e) { setMsgIsError(true); setMsg(e instanceof Error ? e.message : 'Could not submit'); } finally { setBusy(false); }
  }
  async function book() {
    setBookingBusy(true); setBookingMsg(null); setBookingMsgIsError(false);
    try {
      const appt = await portalClient.bookSlot(providerId, { startsAt: selectedSlot, durationMin: 30, reason: bookingReason.trim(), channel: 'EMAIL' });
      setBookingMsg(`The scheduling system confirmed ${appt.service} for ${formatClinicDateTime(appt.startsAt, appt.clinicTimezone)}.`);
      setBookingReason('');
      await loadSlots(providerId, bookingDate);
    } catch (e) {
      setBookingMsgIsError(true);
      setBookingMsg(e instanceof Error ? e.message : 'Could not book this slot');
    } finally {
      setBookingBusy(false);
    }
  }
  const inp = 'w-full rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm text-t1 outline-none focus:border-[var(--indigo)]';
  return (
    <div>
      <H icon={ClipboardList} title="Appointments" sub="Book an available slot or ask staff to find a time" />
      <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4 space-y-3 mb-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[13px] font-bold text-t1">Book an available slot</p>
            <p className="text-[12px] text-t3 mt-0.5">Choose a provider, date, and open appointment time for your clinic branch.</p>
          </div>
          <StateBadge state={providers && providers.length > 0 ? 'scheduled' : 'unavailable'} />
        </div>
        {!providers ? <Skel n={2} /> : providers.length === 0 ? (
          <p className="text-[12px] text-t3">Online booking is not configured for your clinic yet. Use the request form below.</p>
        ) : (
          <>
            <div className="grid gap-2.5 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-[11px] font-bold uppercase tracking-wide text-t3">Provider</span>
                <select
                  className={inp}
                  value={providerId}
                  onChange={e => { const next = providers.find(provider => provider.id === e.target.value); setSlots([]); setSelectedSlot(''); setProviderId(e.target.value); if (next) setBookingDate(clinicDateOffset(7, next.clinicTimezone)); }}
                  aria-label="Provider"
                >
                  {providers.map(p => <option key={p.id} value={p.id}>{p.name}{p.specialty ? ` - ${p.specialty}` : ''}</option>)}
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] font-bold uppercase tracking-wide text-t3">Date</span>
                <input className={inp} type="date" value={bookingDate} onChange={e => { setSlots([]); setSelectedSlot(''); setBookingDate(e.target.value); }} />
              </label>
            </div>
            <label className="block space-y-1">
              <span className="text-[11px] font-bold uppercase tracking-wide text-t3">Open slots</span>
              <select className={inp} value={selectedSlot} onChange={e => setSelectedSlot(e.target.value)} aria-label="Open slots">
                {slots.length === 0 ? <option value="">No open slots on this date</option> : slots.map(s => (
                  <option key={s.startsAt} value={s.startsAt}>{clinicTimezone ? formatClinicTime(s.startsAt, clinicTimezone) : 'Time unavailable'}</option>
                ))}
              </select>
            </label>
            {selectedProvider && <p className="text-[11px] text-t3">Times shown in {selectedProvider.clinicTimezone} for {selectedProvider.branchName}.</p>}
            <label className="block space-y-1">
              <span className="text-[11px] font-bold uppercase tracking-wide text-t3">Reason for visit</span>
              <input className={inp} value={bookingReason} onChange={e => setBookingReason(e.target.value)} placeholder="e.g. Annual physical" />
            </label>
            <button
              type="button"
              disabled={bookingBusy || !providerId || !selectedSlot || bookingReason.trim().length < 2}
              onClick={book}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {bookingBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CalendarDays className="w-4 h-4" />} Book appointment
            </button>
            {bookingMsg && <p role={bookingMsgIsError ? 'alert' : 'status'} aria-live={bookingMsgIsError ? 'assertive' : 'polite'} className={`text-[12px] ${bookingMsgIsError ? 'text-red-v' : 'text-emerald-v'}`}>{bookingMsg}</p>}
          </>
        )}
      </div>
      <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4 space-y-2.5 mb-5">
        <p className="text-[13px] font-bold text-t1">Ask staff to find a time</p>
        <input className={inp} value={service} onChange={e => setService(e.target.value)} placeholder="What do you need? (e.g. Dental check-up)" />
        <div className="grid grid-cols-2 gap-2.5">
          <input className={inp} type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} aria-label="Preferred date and time" />
          <input className={inp} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes (optional)" />
        </div>
        {clinicTimezone && <p className="text-[11px] text-t3">Preferred time is interpreted in {clinicTimezone} for {selectedProvider?.branchName ?? clinicContext?.name ?? 'your clinic'}.</p>}
        <button type="button" disabled={busy || service.trim().length < 2} onClick={submit} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"><Plus className="w-4 h-4" /> Submit request</button>
        {msg && <p role={msgIsError ? 'alert' : 'status'} aria-live={msgIsError ? 'assertive' : 'polite'} className={`text-[12px] ${msgIsError ? 'text-red-v' : 'text-emerald-v'}`}>{msg}</p>}
      </div>
      {loadError ? <LoadError title="Appointment requests unavailable" message={loadError} /> : !rows ? <Skel /> : rows.length === 0 ? <EmptyStatePremium icon={<ClipboardList className="w-5 h-5" />} title="No requests yet" description="Submit a request above and track its status here." /> :
        <div className="space-y-2">{rows.map(r => (
          <div key={r.id} className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3.5 flex items-center justify-between gap-3">
            <div><p className="text-[13px] font-bold text-t1">{r.service ?? 'Appointment request'}</p><p className="text-[12px] text-t3">{r.requestedDateTime ? formatClinicDateTime(r.requestedDateTime, r.clinicTimezone) : 'Flexible'} · submitted {formatClinicDateTime(r.createdAt, r.clinicTimezone)}</p></div>
            <span className="badge badge-amber capitalize">{r.status.toLowerCase().replace(/_/g, ' ')}</span>
          </div>
        ))}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------- Intake */
// Fillable in-portal intake. Documents remain metadata-only (no image upload):
// insurance_card / photo_id capture confirmation + a reference note, never a file.
type IntakeField = { key: string; label: string; type: 'text' | 'email' | 'tel' | 'checkbox' };
const INTAKE_FIELDS: Record<string, IntakeField[]> = {
  demographics: [
    { key: 'firstName', label: 'First name', type: 'text' },
    { key: 'lastName', label: 'Last name', type: 'text' },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'phone', label: 'Phone', type: 'tel' },
  ],
  insurance: [
    { key: 'planName', label: 'Plan name', type: 'text' },
    { key: 'memberId', label: 'Member ID', type: 'text' },
    { key: 'groupNumber', label: 'Group number (optional)', type: 'text' },
    { key: 'payerName', label: 'Insurer / payer (optional)', type: 'text' },
  ],
  communication_consent: [
    { key: 'sms', label: 'Opt out of SMS reminders', type: 'checkbox' },
    { key: 'email', label: 'Opt out of email updates', type: 'checkbox' },
    { key: 'voice', label: 'Opt out of voice calls', type: 'checkbox' },
  ],
  insurance_card: [
    { key: 'hasFront', label: 'I have my insurance card details ready', type: 'checkbox' },
    { key: 'fileName', label: 'Reference / note (optional)', type: 'text' },
  ],
  photo_id: [
    { key: 'hasFront', label: 'I have a valid photo ID', type: 'checkbox' },
    { key: 'fileName', label: 'ID type (e.g. Driver license)', type: 'text' },
  ],
};
// Sections without structured fields are a single acknowledgement.
const ACK_SECTIONS = new Set(['payment_policy', 'estimate_acknowledgement', 'pre_visit_checklist', 'consent_forms', 'custom']);

// Renders one packet's sections as fillable forms and a final submit.
function IntakePacketDetail({ packetId, onClose }: { packetId: string; onClose: () => void }) {
  const [packet, setPacket] = useState<PortalIntakePacket | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function load() {
    try { setPacket(await portalClient.intakePacket(packetId)); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not load this form'); }
  }
  useEffect(() => {
    let active = true;
    void portalClient.intakePacket(packetId)
      .then(next => { if (active) setPacket(next); })
      .catch(e => { if (active) setErr(e instanceof Error ? e.message : 'Could not load this form'); });
    return () => { active = false; };
  }, [packetId]);
  if (err) return <LoadError title="Form unavailable" message={err} />;
  if (!packet) return <Skel n={3} />;
  const submitted = ['submitted', 'needs_review', 'approved', 'reviewed'].includes(packet.status);
  async function submitPacket() {
    setSubmitting(true); setMsg(null);
    try { await portalClient.submitIntakePacket(packetId); await load(); setMsg('Submitted — your clinic will review it.'); }
    catch (e) { setMsg(e instanceof Error ? e.message : 'Could not submit'); } finally { setSubmitting(false); }
  }
  return (
    <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div><p className="text-[13px] font-bold text-t1">{packet.clinicName} intake</p><p className="text-[11px] text-t3">{packet.readinessScore}% complete{packet.appointment ? ` · for ${packet.appointment.service}` : ''}</p></div>
        <button type="button" onClick={onClose} className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] px-2.5 py-1.5 text-[12px] font-semibold text-t2 hover:bg-[var(--s1)]"><X className="w-3.5 h-3.5" /> Close</button>
      </div>
      <div className="space-y-2.5">
        {packet.sections.map(s => <IntakeSection key={s.sectionType} packetId={packetId} section={s} disabled={submitted} onSaved={load} />)}
      </div>
      {!submitted ? (
        <div className="mt-4 flex items-center gap-3">
          <button type="button" disabled={submitting} onClick={submitPacket} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">{submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Submit for review</button>
          {msg && <span className="text-[12px] text-emerald-v">{msg}</span>}
        </div>
      ) : <p className="mt-4 text-[12px] text-emerald-v flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" /> {msg ?? 'This form has been submitted for review.'}</p>}
    </div>
  );
}

function IntakeSection({ packetId, section, disabled, onSaved }: { packetId: string; section: PortalIntakeSection; disabled: boolean; onSaved: () => Promise<void> | void }) {
  const fields = INTAKE_FIELDS[section.sectionType];
  const isAck = !fields && ACK_SECTIONS.has(section.sectionType);
  const isDoc = section.sectionType === 'insurance_card' || section.sectionType === 'photo_id';
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const done = section.status === 'completed';
  const label = section.sectionType.replace(/_/g, ' ');
  const inp = 'w-full rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm text-t1 outline-none focus:border-[var(--indigo)]';

  async function save() {
    setBusy(true); setErr(null);
    const data: Record<string, unknown> = fields
      ? { ...values }
      : { accepted: ack, ...(section.acknowledgement ? { acknowledgementId: section.acknowledgement.id } : {}) };
    try { await portalClient.submitIntakeSection(packetId, section.sectionType, data); await onSaved(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not save'); setBusy(false); }
  }

  return (
    <div className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-bold text-t1 capitalize">{label}</p>
        {done ? <span className="badge badge-emerald">Completed</span> : <span className="badge badge-amber">Action required</span>}
      </div>
      <p className="text-[12px] text-t3 mt-0.5">{section.acknowledgement?.text ?? section.prompt}</p>
      {isDoc && <p className="text-[11px] text-t3 mt-1 italic">Details only — no image is uploaded or stored.</p>}
      {!done && !disabled && (
        <div className="mt-2.5 space-y-2">
          {fields ? fields.map(f => (
            f.type === 'checkbox' ? (
              <label key={f.key} className="flex items-center gap-2 text-[13px] text-t2">
                <input
                  type="checkbox"
                  checked={section.sectionType === 'communication_consent' ? values[f.key] === false : Boolean(values[f.key])}
                  onChange={e => setValues(v => {
                    const next = { ...v };
                    if (section.sectionType === 'communication_consent') {
                      if (e.target.checked) next[f.key] = false;
                      else delete next[f.key];
                    } else next[f.key] = e.target.checked;
                    return next;
                  })}
                /> {f.label}
              </label>
            ) : (
              <label key={f.key} className="block space-y-1">
                <span className="text-[11px] font-bold uppercase tracking-wide text-t3">{f.label}</span>
                <input className={inp} type={f.type} value={String(values[f.key] ?? '')} onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))} />
              </label>
            )
          )) : isAck ? (
            <label className="flex items-center gap-2 text-[13px] text-t2">
              <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /> I confirm / acknowledge the above.
            </label>
          ) : (
            <label className="flex items-center gap-2 text-[13px] text-t2">
              <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /> I confirm this section.
            </label>
          )}
          <button type="button" disabled={busy || (isAck && !ack)} onClick={save} className="rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50">{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Save section'}</button>
          {err && <p className="text-[12px] text-red-v">{err}</p>}
        </div>
      )}
    </div>
  );
}

export function ClientIntake() {
  const [rows, setRows] = useState<PortalIntake[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  async function load() { setRows(await portalClient.intake()); }
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
          openId === p.id ? (
            <IntakePacketDetail key={p.id} packetId={p.id} onClose={() => { setOpenId(null); void load(); }} />
          ) : (
            <div key={p.id} className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[13px] font-bold text-t1">Intake packet</p>
                <StateBadge state={p.label} />
              </div>
              <div className="prog-track md mt-2"><div className={`prog-fill ${p.readinessScore >= 80 ? 'pf-emerald' : 'pf-amber'}`} style={{ width: `${p.readinessScore}%` }} /></div>
              <p className="text-[11px] text-t3 mt-1.5">{p.readinessScore}% complete · started {new Date(p.createdAt).toLocaleDateString()}</p>
              <button type="button" onClick={() => setOpenId(p.id)} className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-[12px] font-semibold text-white hover:opacity-90">
                <FileText className="w-3.5 h-3.5" /> {p.label === 'completed' ? 'View form' : 'Complete form'}
              </button>
            </div>
          )
        ))}</div>}
      <p className="text-[11px] text-t3 mt-4">Fill in the sections above and submit for review. You can also use the intake link your clinic provided. Submitted forms are reviewed by staff.</p>
    </div>
  );
}

/* ----------------------------------------------------------------- Insurance */
export function ClientInsurance() {
  const [rows, setRows] = useState<PortalInsurance[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ planName: '', memberId: '', groupNumber: '', subscriberName: '' });
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<string | null>(null);
  const [msgIsError, setMsgIsError] = useState(false);
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
  async function save() { setBusy(true); setMsg(null); setMsgIsError(false); try { await portalClient.saveInsurance(form); setMsg('Policy details saved for clinic review. This does not confirm eligibility, coverage, or payment.'); setAdding(false); setForm({ planName: '', memberId: '', groupNumber: '', subscriberName: '' }); await load(); } catch (e) { setMsgIsError(true); setMsg(e instanceof Error ? e.message : 'Could not save'); } finally { setBusy(false); } }
  const inp = 'w-full rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm text-t1 outline-none focus:border-[var(--indigo)]';
  if (loadError) return <LoadError title="Insurance unavailable" message={loadError} />;
  if (!rows) return <Skel />;
  return (
    <div>
      <H icon={ShieldCheck} title="Insurance" sub="Policy records on file · not a coverage or payment guarantee" />
      <div className="space-y-2 mb-4">
        {rows.length === 0 ? <EmptyStatePremium icon={<ShieldCheck className="w-5 h-5" />} title="No insurance policy on file" description="Add policy details for clinic review. Saving them does not verify eligibility or coverage." cta={{ label: 'Add insurance', onClick: () => setAdding(true) }} /> :
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
          <input aria-label="Plan name" className={inp} value={form.planName} onChange={e => setForm(f => ({ ...f, planName: e.target.value }))} placeholder="Plan name (e.g. Aetna Core)" />
          <input aria-label="Member ID" className={inp} value={form.memberId} onChange={e => setForm(f => ({ ...f, memberId: e.target.value }))} placeholder="Member ID" />
          <div className="grid grid-cols-2 gap-2.5">
            <input aria-label="Group number" className={inp} value={form.groupNumber} onChange={e => setForm(f => ({ ...f, groupNumber: e.target.value }))} placeholder="Group # (optional)" />
            <input aria-label="Subscriber name" className={inp} value={form.subscriberName} onChange={e => setForm(f => ({ ...f, subscriberName: e.target.value }))} placeholder="Subscriber name (optional)" />
          </div>
          <div className="flex gap-2"><button type="button" disabled={busy || form.planName.trim().length < 1 || form.memberId.trim().length < 2} onClick={save} className="rounded-lg bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">Save</button><button type="button" onClick={() => setAdding(false)} className="rounded-lg border border-[var(--b1)] px-4 py-2 text-sm font-semibold text-t2">Cancel</button></div>
        </div>
      )}
      {msg && <p role={msgIsError ? 'alert' : 'status'} aria-live={msgIsError ? 'assertive' : 'polite'} className={`text-[12px] mt-2 ${msgIsError ? 'text-red-v' : 'text-emerald-v'}`}>{msg}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ Payments */
export function ClientPayments() {
  const [payments, setPayments] = useState<PortalPayment[] | null>(null);
  const [estimates, setEstimates] = useState<PortalEstimate[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  async function load() { const [p, e] = await Promise.all([portalClient.payments(), portalClient.estimates()]); setPayments(p); setEstimates(e); }
  useEffect(() => {
    let a = true;
    void (async () => {
      setLoadError(null);
      try {
        const [p, e] = await Promise.all([portalClient.payments(), portalClient.estimates()]);
        if (a) { setPayments(p); setEstimates(e); }
      } catch (err) {
        if (a) setLoadError(err instanceof Error ? err.message : 'Failed to load payments');
      }
    })();
    return () => { a = false; };
  }, []);
  async function ackEstimate(id: string) { setBusy(id); try { await portalClient.acknowledgeEstimate(id); await load(); } finally { setBusy(null); } }
  if (loadError) return <LoadError title="Payments unavailable" message={loadError} />;
  if (!payments) return <Skel />;
  return (
    <div>
      <H icon={CreditCard} title="Payments & estimates" sub="Provider-hosted payment links and recorded status · final cost may differ from an estimate" />
      <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4 mb-4">
        <p className="text-[13px] font-semibold text-t1">Payment policy acknowledgment unavailable</p>
        <p className="text-[12px] text-t3 mt-0.5">The clinic has not published versioned payment-policy text in this portal. No acknowledgment can be recorded until the exact policy and version are displayed.</p>
      </div>
      <p className="text-[11px] font-bold uppercase tracking-wide text-t3 mb-2">Balances</p>
      {payments.length === 0 ? <p className="text-[13px] text-t3">No payment requests are currently shown in this portal.</p> :
        <div className="space-y-2">{payments.map(p => (
          <div key={p.id} className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3.5 flex items-center justify-between gap-3">
            <div><p className="text-[13px] font-bold text-t1">{formatCurrency(p.amount)} <span className="text-[11px] font-normal text-t3">{p.currency}</span></p><p className="text-[12px] text-t3">{p.reason} · {p.status}</p></div>
            {p.payLink
              // payLink is the provider-hosted checkout page (absolute URL) — open it directly.
              ? <a href={p.payLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-[12px] font-semibold text-white hover:opacity-90">Open payment page <ExternalLink className="w-3.5 h-3.5" /></a>
              : p.payLinkUnavailable
                // A payment request exists, but a provider-hosted page is unavailable.
                ? <span className="text-[11px] text-t3 text-right max-w-[10rem]">Payment page unavailable — please contact the clinic.</span>
                : <span className="badge badge-blue">{p.status}</span>}
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
  const [msgIsError, setMsgIsError] = useState(false);
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
  async function save() { setBusy(true); setMsg(null); setMsgIsError(false); try { await portalClient.saveProfile({ email: email.trim() || undefined, phone: phone.trim() || undefined }); setMsg('Contact details saved.'); } catch (e) { setMsgIsError(true); setMsg(e instanceof Error ? e.message : 'Could not save'); } finally { setBusy(false); } }
  const inp = 'w-full rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm text-t1 outline-none focus:border-[var(--indigo)]';
  if (!p) return <Skel n={2} />;
  return (
    <div>
      <H icon={User} title="Profile" sub="Your contact details" />
      <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s1)] p-4 space-y-3 max-w-md">
        <div><p className="text-[11px] uppercase tracking-wide text-t3">Name</p><p className="text-sm font-semibold text-t1">{p.firstName} {p.lastName}</p></div>
        <label className="block space-y-1"><span className="text-[11px] font-semibold text-t3">Email</span><input className={inp} type="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label className="block space-y-1"><span className="text-[11px] font-semibold text-t3">Phone</span><input className={inp} value={phone} onChange={e => setPhone(e.target.value)} /></label>
        <div className="flex items-center gap-3"><button type="button" disabled={busy} onClick={save} className="rounded-lg bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">Save changes</button>{msg && <span role={msgIsError ? 'alert' : 'status'} aria-live={msgIsError ? 'assertive' : 'polite'} className={`text-[12px] ${msgIsError ? 'text-red-v' : 'text-emerald-v'}`}>{msg}</span>}</div>
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
  type TogglePreference = 'email' | 'sms' | 'whatsapp' | 'marketing';
  type AuthorizationStatusKey = 'emailAuthorizationStatus' | 'smsAuthorizationStatus' | 'whatsappAuthorizationStatus' | 'marketingAuthorizationStatus';
  async function optOut(key: TogglePreference) { if (!prefs) return; setBusy(key); try { await portalClient.savePreferences({ [key]: false }); await load(); } finally { setBusy(null); } }
  async function optOutVoice() { setBusy('voice'); try { await portalClient.savePreferences({ voice: false }); await load(); } finally { setBusy(null); } }
  if (loadError) return <LoadError title="Preferences unavailable" message={loadError} />;
  if (!prefs) return <Skel n={2} />;
  const ROWS: Array<{ key: TogglePreference; statusKey: AuthorizationStatusKey; label: string; desc: string }> = [
    { key: 'email', statusKey: 'emailAuthorizationStatus', label: 'Email', desc: 'Appointment reminders & updates by email' },
    { key: 'sms', statusKey: 'smsAuthorizationStatus', label: 'SMS', desc: 'Text message reminders' },
    { key: 'whatsapp', statusKey: 'whatsappAuthorizationStatus', label: 'WhatsApp', desc: 'WhatsApp messages' },
    { key: 'marketing', statusKey: 'marketingAuthorizationStatus', label: 'Marketing', desc: 'Offers & news' },
  ];
  return (
    <div>
      <H icon={Bell} title="Communication preferences" sub="Review recorded contact preferences and add opt-outs" />
      <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s1)] divide-y divide-[var(--b1)] mb-5">
        {ROWS.map(r => (
          <div key={r.key} className="flex items-center justify-between gap-3 px-4 py-3">
            <div><p className="text-[13px] font-semibold text-t1">{r.label}</p><p className="text-[11px] text-t3">{r.desc}</p><p className="text-[11px] text-t3 mt-0.5">{prefs[r.statusKey] === 'opted_out' ? 'Opt-out recorded' : prefs[r.statusKey] === 'opted_in' ? 'Prior affirmative preference recorded; live authority is checked separately' : 'No authorization recorded'}</p></div>
            {prefs[r.statusKey] === 'opted_out'
              ? <span className="badge badge-red">Opted out</span>
              : <button type="button" aria-label={`Opt out of ${r.label}`} disabled={busy === r.key} onClick={() => optOut(r.key)} className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-[12px] font-semibold text-red-v hover:bg-[var(--red-soft)] disabled:opacity-50">{busy === r.key ? 'Recording…' : 'Opt out'}</button>}
          </div>
        ))}
      </div>
      <p className="text-[11px] text-t3 -mt-3 mb-5">This portal records opt-outs only. Purpose-specific, versioned authorization must be captured through the clinic's approved disclosure workflow.</p>
      <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4 mb-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[13px] font-semibold text-t1">Voice calls</p>
            <p className="text-[11px] text-t3 mt-0.5">{prefs.voiceOptedOut ? 'A global voice-call opt-out is recorded.' : 'No portal voice-call opt-out is recorded.'}</p>
          </div>
          {prefs.voiceOptedOut ? <span className="badge badge-red">Opted out</span> : (
            <button type="button" disabled={busy === 'voice'} onClick={optOutVoice} className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-[12px] font-semibold text-red-v hover:bg-[var(--red-soft)] disabled:opacity-50">
              {busy === 'voice' ? 'Recording…' : 'Opt out of voice calls'}
            </button>
          )}
        </div>
        <p className="text-[11px] text-t3 mt-2">This portal can record an opt-out only. It cannot grant, restore, or imply permission for outbound calls; the clinic must use a purpose-specific disclosure and consent process.</p>
      </div>
      <p className="text-[11px] font-bold uppercase tracking-wide text-t3 mb-2">Preference and opt-out history</p>
      {history.length === 0 ? <p className="text-[12px] text-t3">No preference or opt-out changes recorded yet.</p> :
        <div className="space-y-1">{history.slice(0, 12).map((h, i) => (
          <div key={i} className="flex items-center justify-between text-[11px] rounded-lg border border-[var(--b1)] px-3 py-1.5"><span className="text-t2 capitalize">{h.purpose.toLowerCase()} {h.granted ? 'prior preference recorded (not current authority)' : 'opted out'}</span><span className="text-t3">{new Date(h.at).toLocaleDateString()}</span></div>
        ))}</div>}
    </div>
  );
}
