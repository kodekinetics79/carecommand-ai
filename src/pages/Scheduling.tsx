import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { CalendarDays, Zap, AlertCircle, CheckCircle2, Clock, Users, DollarSign, RefreshCw, CreditCard, LogIn, UserX, CheckCheck, XCircle, CalendarClock } from 'lucide-react';
import AppointmentPaymentCard from '../components/payments/AppointmentPaymentCard';
import PaymentRequestsPanel from '../components/payments/PaymentRequestsPanel';
import InsuranceIntakeCard from '../components/insurance/InsuranceIntakeCard';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import RiskBadge from '../components/ui/RiskBadge';
import ProgressBar from '../components/ui/ProgressBar';
import { formatCurrency } from '../utils/formatters';
import { useApiResource } from '../hooks/useApiResource';
import { mapAppointment, mapProviderProfile, mapPatient, type ApiAppointment, type ApiProviderProfile, type ApiPatient } from '../lib/apiAdapters';
import { apiRequest, ApiError } from '../lib/api';
import { appointmentsApi, schedulingApi, type LifecycleStatus, type ProviderSlot } from '../lib/appointments';
import { intakeApi } from '../lib/intake';
import { useSession } from '../hooks/useSession';
import { checkEligibility, fetchAppointmentVerificationQueue, type AppointmentVerificationQueueRow } from '../lib/revenueProtection';

const isoDate = (offsetDays: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};
const dateOptions = [0, 1, 2].map(offset => ({
  value: isoDate(offset),
  label: offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : new Date(isoDate(offset)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' }),
}));
const todayDate = dateOptions[0].value;
const emptyBooking = { patientId: '', providerId: '', service: '', date: todayDate, time: '10:00', channel: 'EMAIL', value: '150', slotStart: '', slotEnd: '' };

// Client mirror of the backend lifecycle transition rules (appointments/routes.ts)
// so we only offer actions the server will accept; a race still surfaces as a 409.
function availableActions(status: string): { checkIn: boolean; noShow: boolean; complete: boolean; cancel: boolean; reschedule: boolean } {
  return {
    checkIn: ['confirmed', 'risky', 'waitlist'].includes(status),
    noShow: ['confirmed', 'risky', 'waitlist'].includes(status),
    complete: ['arrived', 'confirmed', 'risky'].includes(status),
    cancel: !['canceled', 'completed'].includes(status),
    reschedule: !['canceled', 'completed'].includes(status),
  };
}

const statusConfig: Record<string, { label: string; dot: string; bg: string; text: string }> = {
  confirmed:  { label: 'Confirmed',  dot: 'bg-emerald-500', bg: 'bg-[var(--emerald-soft)]',  text: 'text-emerald-v' },
  arrived:    { label: 'Arrived',    dot: 'bg-blue-500',    bg: 'bg-[var(--blue-soft)]',     text: 'text-blue-v' },
  risky:      { label: 'High Risk',  dot: 'bg-red-500 animate-pulse', bg: 'bg-[var(--red-soft)]', text: 'text-red-v' },
  'no-show':  { label: 'No-Show',   dot: 'bg-[var(--b2)]',   bg: 'bg-[var(--s3)]',   text: 'text-t3' },
  completed:  { label: 'Completed', dot: 'bg-teal-500',     bg: 'bg-[var(--emerald-soft)]',     text: 'text-emerald-v' },
  canceled:   { label: 'Canceled',  dot: 'bg-[var(--b1)]',   bg: 'bg-[var(--s2)]',    text: 'text-t3' },
  waitlist:   { label: 'Waitlist',  dot: 'bg-amber-500',   bg: 'bg-[var(--amber-soft)]',    text: 'text-amber-v' },
};

interface ApiBranchOption { id: string; name: string }

export default function Scheduling() {
  const navigate = useNavigate();
  const { user } = useSession();
  const isFrontDesk = user?.role === 'FRONT_DESK';
  const [selectedBranch, setSelectedBranch] = useState('all');
  const [selectedDate, setSelectedDate] = useState(todayDate);
  const [insuranceQueue, setInsuranceQueue] = useState<AppointmentVerificationQueueRow[]>([]);
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [queueBusy, setQueueBusy] = useState<string | null>(null);
  // Server-side day/branch filtering: fetch only the selected UTC day (and branch)
  // instead of the first 100 rows ordered by id — so a busy day past the first 100
  // rows is no longer silently dropped. UTC bounds match mapAppointment's date.
  const appointmentsPath = useMemo(() => {
    const from = `${selectedDate}T00:00:00.000Z`;
    const to = `${selectedDate}T23:59:59.999Z`;
    const branchParam = selectedBranch === 'all' ? '' : `&branchId=${selectedBranch}`;
    return `/v1/appointments?limit=100&from=${from}&to=${to}${branchParam}`;
  }, [selectedDate, selectedBranch]);
  const { data: appointmentRecords, source, error: appointmentError, reload } = useApiResource<ApiAppointment, ReturnType<typeof mapAppointment>>(appointmentsPath, [], mapAppointment);
  const { data: providerRecords, error: providerError } = useApiResource<ApiProviderProfile, ReturnType<typeof mapProviderProfile>>('/v1/providers/overview?limit=100', [], mapProviderProfile);
  const { data: patientRecords, error: patientError } = useApiResource<ApiPatient, ReturnType<typeof mapPatient>>('/v1/patients?limit=100', [], mapPatient);
  const { data: branchRecords, error: branchError } = useApiResource<ApiBranchOption, ApiBranchOption>('/v1/branches?limit=100', [], row => row);

  const [showBooking, setShowBooking] = useState(false);
  const [paymentApptId, setPaymentApptId] = useState<string | null>(null);
  const [booking, setBooking] = useState(emptyBooking);
  const [saving, setSaving] = useState(false);
  const [bookingError, setBookingError] = useState<string | null>(null);
  // Real provider slots for the conflict-safe booking path.
  const [slots, setSlots] = useState<ProviderSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  // Per-row lifecycle action state.
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowNotice, setRowNotice] = useState<{ id: string; kind: 'error' | 'ok'; text: string } | null>(null);
  const [rescheduleFor, setRescheduleFor] = useState<string | null>(null);
  const [rescheduleForm, setRescheduleForm] = useState({ date: todayDate, time: '10:00' });
  const [intakeBusy, setIntakeBusy] = useState<string | null>(null);

  // Providers bookable for the chosen patient (same branch — the book route
  // requires the patient to belong to the provider's clinic).
  const bookingPatient = patientRecords.find(p => p.id === booking.patientId);
  const bookableProviders = useMemo(
    () => (bookingPatient ? providerRecords.filter(p => p.branchId === bookingPatient.branchId) : []),
    [providerRecords, bookingPatient],
  );

  // Load real open slots whenever a provider + date are chosen.
  useEffect(() => {
    if (!showBooking || !booking.providerId || !booking.date) {
      return;
    }
    let active = true;
    void (async () => {
      setSlotsLoading(true);
      setSlotsError(null);
      try {
        const res = await schedulingApi.slots(booking.providerId, booking.date);
        if (!active) return;
        setSlots(res.slots);
        if (res.slots.length === 0) setSlotsError('No open slots for this provider on this day. Set availability, pick another day, or use manual time entry below.');
      } catch (err) {
        if (!active) return;
        setSlots([]);
        setSlotsError(err instanceof Error ? err.message : 'Unable to load slots');
      } finally {
        if (active) setSlotsLoading(false);
      }
    })();
    return () => { active = false; };
  }, [showBooking, booking.providerId, booking.date]);

  useEffect(() => {
    let active = true;
    void (async () => {
      setQueueLoading(true);
      setQueueError(null);
      try {
        const response = await fetchAppointmentVerificationQueue(selectedBranch === 'all' ? undefined : selectedBranch);
        if (!active) return;
        setInsuranceQueue(response.appointments);
      } catch (err) {
        if (!active) return;
        setQueueError(err instanceof Error ? err.message : 'Unable to load insurance verification queue');
      } finally {
        if (active) setQueueLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [selectedBranch]);

  function closeBooking() {
    setBooking(emptyBooking);
    setShowBooking(false);
    setSlots([]);
    setSlotsError(null);
  }

  async function bookAppointment() {
    const patient = patientRecords.find(p => p.id === booking.patientId);
    if (!patient || !patient.branchId || !booking.service.trim()) {
      setBookingError('Pick a customer and enter a service.');
      return;
    }
    setSaving(true);
    setBookingError(null);
    try {
      // Preferred path: a provider + a real open slot → conflict-safe booking that
      // sets providerProfileId and is guarded by the DB exclusion constraint.
      if (booking.providerId && booking.slotStart) {
        const durationMin = booking.slotEnd
          ? Math.max(5, Math.round((new Date(booking.slotEnd).getTime() - new Date(booking.slotStart).getTime()) / 60000))
          : 30;
        await schedulingApi.book(booking.providerId, {
          patientId: patient.id,
          startsAt: booking.slotStart,
          durationMin,
          service: booking.service.trim(),
          channel: booking.channel,
        });
      } else {
        // Fallback (noted): no provider availability configured yet, so fall back to
        // an unconstrained free-time booking. Not cross-path conflict-guarded.
        const startsAt = new Date(`${booking.date}T${booking.time}:00`);
        await apiRequest('/v1/appointments', {
          method: 'POST',
          body: JSON.stringify({
            branchId: patient.branchId,
            patientId: patient.id,
            service: booking.service.trim(),
            startsAt: startsAt.toISOString(),
            endsAt: new Date(startsAt.getTime() + 30 * 60000).toISOString(),
            channel: booking.channel,
            value: Number(booking.value) || 0,
            status: 'CONFIRMED',
          }),
        });
      }
      const bookedDate = booking.date;
      closeBooking();
      setSelectedDate(bookedDate);
      reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setBookingError('That slot was just taken. Pick another open slot.');
        // Refresh slots so the taken one drops off.
        if (booking.providerId) {
          try {
            const res = await schedulingApi.slots(booking.providerId, booking.date);
            setSlots(res.slots);
          } catch { /* keep prior slots */ }
        }
      } else {
        setBookingError(err instanceof Error ? err.message : 'Failed to book appointment');
      }
    } finally {
      setSaving(false);
    }
  }

  // ----- Lifecycle actions (check-in / no-show / complete / cancel / reschedule)
  async function runRowAction(id: string, fn: () => Promise<unknown>, okText: string) {
    setRowBusy(id);
    setRowNotice(null);
    try {
      await fn();
      setRowNotice({ id, kind: 'ok', text: okText });
      reload();
    } catch (err) {
      const text = err instanceof ApiError && err.status === 409
        ? (err.message.startsWith('API request failed') ? "You can't do that from the appointment's current state." : err.message)
        : err instanceof Error ? err.message : 'Action failed';
      setRowNotice({ id, kind: 'error', text });
    } finally {
      setRowBusy(null);
    }
  }

  const setLifecycle = (id: string, status: LifecycleStatus, ok: string) => runRowAction(id, () => appointmentsApi.setStatus(id, status), ok);
  const cancelAppointment = (id: string) => runRowAction(id, () => appointmentsApi.cancel(id), 'Appointment cancelled.');

  async function submitReschedule(id: string) {
    const startsAt = new Date(`${rescheduleForm.date}T${rescheduleForm.time}:00`);
    const endsAt = new Date(startsAt.getTime() + 30 * 60000);
    await runRowAction(id, () => appointmentsApi.reschedule(id, startsAt.toISOString(), endsAt.toISOString()), 'Appointment rescheduled.');
    setRescheduleFor(null);
    setSelectedDate(rescheduleForm.date);
  }

  // ----- Originate an intake link for an appointment's patient ---------------
  async function sendIntake(appt: ReturnType<typeof mapAppointment>) {
    setIntakeBusy(appt.id);
    setRowNotice(null);
    try {
      const packet = await intakeApi.createPacket({ appointmentId: appt.id, source: 'staff' });
      const link = packet.publicUrl || (packet.publicToken ? `/intake/${packet.publicToken}` : null);
      if (link) await navigator.clipboard.writeText(link).catch(() => undefined);
      setRowNotice({ id: appt.id, kind: 'ok', text: link ? 'Intake link created and copied to clipboard.' : 'Intake packet created.' });
    } catch (err) {
      setRowNotice({ id: appt.id, kind: 'error', text: err instanceof Error ? err.message : 'Failed to create intake' });
    } finally {
      setIntakeBusy(null);
    }
  }

  // Date + branch are now filtered server-side (see appointmentsPath); just order
  // the returned day by time.
  const todayAppts = useMemo(() =>
    [...appointmentRecords].sort((a, b) => a.time.localeCompare(b.time)),
    [appointmentRecords]
  );

  const totalValue = todayAppts.reduce((s, a) => s + a.value, 0);
  const riskyCount = todayAppts.filter(a => a.status === 'risky').length;
  const confirmedCount = todayAppts.filter(a => a.status === 'confirmed' || a.status === 'arrived').length;
  const queueMode = insuranceQueue.some(row => row.providerMode !== 'mock') ? 'Sandbox Active' : 'Mock Mode';
  const loadError = appointmentError || providerError || patientError || branchError;

  async function verifyInsurance(row: AppointmentVerificationQueueRow) {
    setQueueBusy(row.id);
    setQueueError(null);
    try {
      await checkEligibility({
        patientId: row.patientId,
        appointmentId: row.id,
        branchId: row.branchId,
        serviceType: row.serviceType,
      });
      const refreshed = await fetchAppointmentVerificationQueue(selectedBranch === 'all' ? undefined : selectedBranch);
      setInsuranceQueue(refreshed.appointments);
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : 'Unable to verify insurance');
    } finally {
      setQueueBusy(null);
    }
  }

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Smart Scheduling"
        subtitle="AI-optimised appointment calendar with no-show prediction and slot-filling intelligence."
        badge={loadError ? 'Live Data Error' : source === 'live' ? 'Live DB' : 'Loading'}
        badgeColor={loadError ? 'red' : source === 'live' ? 'emerald' : 'blue'}
        actions={
          <div className="flex gap-2">
            <button type="button" onClick={() => setShowBooking(true)} className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition">
              <CalendarDays className="w-4 h-4" /> Book Appointment
            </button>
          </div>
        }
      />

      {showBooking && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={closeBooking}>
          <div className="w-full max-w-md rounded-2xl bg-[var(--s1)] border border-[var(--b2)] p-5 shadow-xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <p className="text-sm font-bold text-t1 mb-3">Book Appointment</p>
            {bookingError && <p className="text-[11px] text-red-v mb-2">{bookingError}</p>}
            <div className="space-y-2.5">
              <select aria-label="Customer" title="Customer" value={booking.patientId} onChange={e => setBooking(b => ({ ...b, patientId: e.target.value, providerId: '', slotStart: '', slotEnd: '' }))} className="w-full px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)]">
                <option value="">Select customer…</option>
                {patientRecords.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <input value={booking.service} onChange={e => setBooking(b => ({ ...b, service: e.target.value }))} placeholder="Service (e.g. Dermatology Review)" className="w-full px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
              <div className="grid grid-cols-2 gap-2.5">
                <select aria-label="Provider" title="Provider" disabled={!booking.patientId} value={booking.providerId} onChange={e => setBooking(b => ({ ...b, providerId: e.target.value, slotStart: '', slotEnd: '' }))} className="px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)] disabled:opacity-40">
                  <option value="">{booking.patientId ? 'Select provider…' : 'Pick customer first'}</option>
                  {bookableProviders.map(p => <option key={p.id} value={p.id}>{p.name} · {p.specialty}</option>)}
                </select>
                <input type="date" aria-label="Date" value={booking.date} onChange={e => setBooking(b => ({ ...b, date: e.target.value, slotStart: '', slotEnd: '' }))} className="px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
                <select aria-label="Channel" title="Channel" value={booking.channel} onChange={e => setBooking(b => ({ ...b, channel: e.target.value }))} className="px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)]">
                  {['WHATSAPP', 'SMS', 'EMAIL', 'CALL', 'VIDEO'].map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>

              {/* Conflict-safe slot picker (real backend availability) */}
              {booking.providerId && (
                <div className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-t3 mb-2">Open slots</p>
                  {slotsLoading ? (
                    <p className="text-[11px] text-t3">Loading open slots…</p>
                  ) : slots.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {slots.map(s => {
                        const label = new Date(s.startsAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
                        const active = booking.slotStart === s.startsAt;
                        return (
                          <button key={s.startsAt} type="button" onClick={() => setBooking(b => ({ ...b, slotStart: s.startsAt, slotEnd: s.endsAt }))} className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition ${active ? 'bg-[var(--indigo)] text-white' : 'bg-[var(--s3)] text-t2 hover:bg-[var(--b1)]'}`}>{label}</button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-[11px] text-amber-v">{slotsError ?? 'No open slots.'}</p>
                  )}
                </div>
              )}

              {/* Fallback: manual time entry when no provider/slot is used */}
              {(!booking.providerId || slots.length === 0) && (
                <div className="grid grid-cols-2 gap-2.5">
                  <input type="time" aria-label="Time (manual)" value={booking.time} onChange={e => setBooking(b => ({ ...b, time: e.target.value }))} className="px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
                  <input type="number" aria-label="Value" value={booking.value} onChange={e => setBooking(b => ({ ...b, value: e.target.value }))} placeholder="Value ($)" className="px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
                  <p className="col-span-2 text-[10px] text-t3">Manual time is an unconstrained fallback (no cross-path conflict guard). Prefer a provider slot above.</p>
                </div>
              )}
            </div>
            <div className="flex gap-2 mt-4">
              <button type="button" disabled={saving} onClick={bookAppointment} className="flex-1 py-2 rounded-lg bg-[var(--indigo)] text-white text-xs font-semibold hover:opacity-90 transition disabled:opacity-40">{saving ? 'Booking…' : booking.providerId && booking.slotStart ? 'Book slot' : 'Book Appointment'}</button>
              <button type="button" onClick={closeBooking} className="px-4 py-2 rounded-lg border border-[var(--b1)] text-t2 text-xs font-semibold hover:bg-[var(--s3)] transition">Cancel</button>
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Today's Appointments" value={todayAppts.length} subtitle="All branches" icon={<CalendarDays className="w-4 h-4" />} accent="blue" />
        <StatCard title="Confirmed / Arrived" value={confirmedCount} subtitle="On track" icon={<CheckCircle2 className="w-4 h-4" />} accent="emerald" />
        <StatCard title="No-Show Risk" value={riskyCount} subtitle="AI flagged today" icon={<AlertCircle className="w-4 h-4" />} accent="red" />
        <StatCard title="Today's Value" value={formatCurrency(totalValue)} subtitle="Appointment revenue" icon={<DollarSign className="w-4 h-4" />} accent="violet" />
      </div>

      {loadError && (
        <div className="rounded-2xl border border-[rgba(220,38,38,0.18)] bg-red-soft px-4 py-3 text-xs font-semibold text-red-v">
          Scheduling data could not be loaded from the live API: {loadError}
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1 bg-[var(--s2)] border border-[var(--b1)] p-1 rounded-xl">
          {dateOptions.map(opt => (
            <button key={opt.value} type="button" onClick={() => setSelectedDate(opt.value)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${selectedDate === opt.value ? 'bg-[var(--indigo)] text-white' : 'text-t3 hover:text-t1'}`}>{opt.label}</button>
          ))}
          {/* Pick any day server-side (not just Today/Tomorrow/+2). */}
          <input type="date" aria-label="Pick a date" value={selectedDate} onChange={e => setSelectedDate(e.target.value || todayDate)} className={`px-2 py-1.5 rounded-lg text-xs font-semibold bg-transparent outline-none ${dateOptions.some(o => o.value === selectedDate) ? 'text-t3' : 'bg-[var(--indigo)] text-white'}`} />
        </div>
        <div className="flex items-center gap-1 bg-[var(--s2)] border border-[var(--b1)] p-1 rounded-xl">
          <button type="button" onClick={() => setSelectedBranch('all')} className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${selectedBranch === 'all' ? 'bg-[var(--s3)] text-t1' : 'text-t3 hover:text-t1'}`}>All Branches</button>
          {branchRecords.map(b => (
            <button key={b.id} type="button" onClick={() => setSelectedBranch(b.id)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all truncate max-w-[120px] ${selectedBranch === b.id ? 'bg-[var(--s3)] text-t1' : 'text-t3 hover:text-t1'}`}>
              {b.name.split(' ')[0]}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        {/* Appointment timeline */}
        <div className="space-y-4">
          <BentoCard
            title="Insurance Verification Queue"
            subtitle="Patient appointments that need a real eligibility check"
            headerRight={<span className="text-xs font-semibold text-t3">{queueMode}</span>}
          >
            {queueError && <p className="mb-3 text-xs text-red-v">{queueError}</p>}
            {queueLoading ? (
              <div className="py-8 text-center text-sm text-t3">Loading verification queue…</div>
            ) : insuranceQueue.length === 0 ? (
              <div className="py-8 text-center text-sm text-t3">No appointments found for this clinic scope.</div>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-[var(--b1)]">
                <table className="min-w-full text-sm">
                  <thead className="bg-[var(--s2)] text-left text-xs text-t3">
                    <tr>
                      <th className="px-4 py-3">Patient</th>
                      <th className="px-4 py-3">Appointment</th>
                      <th className="px-4 py-3">Payer</th>
                      <th className="px-4 py-3">Member ID</th>
                      <th className="px-4 py-3">Eligibility</th>
                      <th className="px-4 py-3">Copay</th>
                      <th className="px-4 py-3">Deductible</th>
                      <th className="px-4 py-3">Prior Auth</th>
                      <th className="px-4 py-3">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {insuranceQueue.map(row => {
                      const active = row.eligibilityStatus === 'Active';
                      return (
                        <tr key={row.id} className="border-t border-[var(--b1)]">
                          <td className="px-4 py-3">
                            <p className="font-semibold text-t1">{row.patientName}</p>
                            <p className="text-[11px] text-t3">{row.branchName}</p>
                          </td>
                          <td className="px-4 py-3">
                            <p className="font-semibold text-t1">{new Date(row.appointmentTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</p>
                            <p className="text-[11px] text-t3">{row.serviceType}</p>
                          </td>
                          <td className="px-4 py-3 text-t2">{row.payerName}</td>
                          <td className="px-4 py-3 text-t2">{row.memberId}</td>
                          <td className="px-4 py-3">
                            <span className={`badge ${active ? 'badge-emerald' : 'badge-amber'}`}>{row.eligibilityStatus}</span>
                            <p className="mt-1 text-[11px] text-t3">{row.coverageStatus}</p>
                          </td>
                          <td className="px-4 py-3 text-t2">{active ? formatCurrency(row.copay) : '—'}</td>
                          <td className="px-4 py-3 text-t2">{active ? formatCurrency(row.deductibleRemaining) : '—'}</td>
                          <td className="px-4 py-3">
                            <span className={`badge ${row.priorAuthStatus === 'Not Required' ? 'badge-emerald' : row.priorAuthStatus.toLowerCase().includes('pending') ? 'badge-amber' : 'badge-blue'}`}>{row.priorAuthStatus}</span>
                          </td>
                          <td className="px-4 py-3">
                            <button
                              type="button"
                              disabled={queueBusy === row.id}
                              onClick={() => void verifyInsurance(row)}
                              className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-3 py-2 text-xs font-semibold text-white hover:opacity-90 transition disabled:opacity-50"
                            >
                              <RefreshCw className="w-3.5 h-3.5" />
                              {queueBusy === row.id ? 'Verifying…' : row.eligibilityStatus === 'Active' ? 'Re-verify' : 'Verify Insurance'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </BentoCard>

          <BentoCard title="Appointment Timeline" subtitle={`${selectedDate === todayDate ? "Today's" : ""} schedule`} headerRight={
            <span className="text-xs font-semibold text-t3">{todayAppts.length} appointments · {formatCurrency(totalValue)}</span>
          }>
            <div className="space-y-2">
              {todayAppts.length === 0 ? (
                <div className="py-8 text-center text-sm text-t3">No appointments for this date / branch.</div>
              ) : todayAppts.map((appt) => {
                const sc = statusConfig[appt.status] ?? statusConfig['confirmed'];
                const isRisky = appt.noShowRisk >= 50;
                return (
                  <div key={appt.id} data-appointment-id={appt.id} className={`flex items-start gap-3 p-3.5 rounded-xl border transition-all hover:bg-[var(--s3)] ${isRisky ? 'border-[var(--b2)] bg-[var(--red-soft)]' : 'border-[var(--b1)]'}`}>
                    <div className="text-center shrink-0 w-14">
                      <p className="text-sm font-bold text-t1">{appt.time}</p>
                      <p className="text-[10px] text-t3">{appt.value ? formatCurrency(Number(appt.value)) : ''}</p>
                    </div>
                    <div className="w-px self-stretch bg-[var(--b1)] shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2 mb-0.5">
                        <p className="text-sm font-bold text-t1">{appt.patientName}</p>
                        <div className="flex items-center gap-2">
                          {isRisky && <RiskBadge level="high" label={`${appt.noShowRisk}% risk`} size="sm" />}
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${sc.bg} ${sc.text}`}>{sc.label}</span>
                        </div>
                      </div>
                      <p className="text-xs text-t3">{appt.service} · {appt.doctorName}</p>
                      {(() => {
                        const act = availableActions(appt.status);
                        const busy = rowBusy === appt.id;
                        return (
                          <>
                            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                              <span className="text-[10px] text-t3 capitalize mr-1">{appt.channel}</span>
                              {act.checkIn && (
                                <button type="button" disabled={busy} onClick={() => void setLifecycle(appt.id, 'ARRIVED', 'Checked in.')} className="inline-flex items-center gap-1 text-[10px] font-semibold text-blue-v bg-[var(--blue-soft)] px-2 py-0.5 rounded-full hover:opacity-80 transition-colors disabled:opacity-40">
                                  <LogIn className="w-2.5 h-2.5" /> Check-in
                                </button>
                              )}
                              {act.complete && (
                                <button type="button" disabled={busy} onClick={() => void setLifecycle(appt.id, 'COMPLETED', 'Marked completed.')} className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-v bg-[var(--emerald-soft)] px-2 py-0.5 rounded-full hover:opacity-80 transition-colors disabled:opacity-40">
                                  <CheckCheck className="w-2.5 h-2.5" /> Complete
                                </button>
                              )}
                              {act.noShow && (
                                <button type="button" disabled={busy} onClick={() => void setLifecycle(appt.id, 'NO_SHOW', 'Marked no-show.')} className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-v bg-[var(--amber-soft)] px-2 py-0.5 rounded-full hover:opacity-80 transition-colors disabled:opacity-40">
                                  <UserX className="w-2.5 h-2.5" /> No-show
                                </button>
                              )}
                              {act.reschedule && (
                                <button type="button" disabled={busy} onClick={() => { setRescheduleFor(prev => (prev === appt.id ? null : appt.id)); setRescheduleForm({ date: appt.date, time: appt.time }); }} className="inline-flex items-center gap-1 text-[10px] font-semibold text-t2 bg-[var(--s2)] border border-[var(--b1)] px-2 py-0.5 rounded-full hover:bg-[var(--s3)] transition-colors disabled:opacity-40">
                                  <CalendarClock className="w-2.5 h-2.5" /> {rescheduleFor === appt.id ? 'Close' : 'Reschedule'}
                                </button>
                              )}
                              {act.cancel && (
                                <button type="button" disabled={busy} onClick={() => void cancelAppointment(appt.id)} className="inline-flex items-center gap-1 text-[10px] font-semibold text-red-v bg-[var(--red-soft)] px-2 py-0.5 rounded-full hover:opacity-80 transition-colors disabled:opacity-40">
                                  <XCircle className="w-2.5 h-2.5" /> Cancel
                                </button>
                              )}
                              <button type="button" disabled={intakeBusy === appt.id} onClick={() => void sendIntake(appt)} className="inline-flex items-center gap-1 text-[10px] font-semibold text-violet-v bg-[var(--violet-soft)] px-2 py-0.5 rounded-full hover:opacity-80 transition-colors disabled:opacity-40">
                                <Zap className="w-2.5 h-2.5" /> {intakeBusy === appt.id ? 'Sending…' : 'Send intake'}
                              </button>
                              {/* Deposit-evaluate excludes FRONT_DESK by design — hide rather than 403. */}
                              {!isFrontDesk && (
                                <button type="button" onClick={() => setPaymentApptId(prev => (prev === appt.id ? null : appt.id))} className="inline-flex items-center gap-1 text-[10px] font-semibold text-t2 bg-[var(--s2)] border border-[var(--b1)] px-2 py-0.5 rounded-full hover:bg-[var(--s3)] transition-colors">
                                  <CreditCard className="w-2.5 h-2.5" /> {paymentApptId === appt.id ? 'Hide deposit' : 'Deposit'}
                                </button>
                              )}
                            </div>
                            {rowNotice?.id === appt.id && (
                              <p className={`mt-1.5 text-[10px] font-semibold ${rowNotice.kind === 'ok' ? 'text-emerald-v' : 'text-red-v'}`}>{rowNotice.text}</p>
                            )}
                            {rescheduleFor === appt.id && (
                              <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                                <input type="date" aria-label="New date" value={rescheduleForm.date} onChange={e => setRescheduleForm(f => ({ ...f, date: e.target.value }))} className="px-2 py-1 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-[11px] text-t1 outline-none focus:border-[var(--b3)]" />
                                <input type="time" aria-label="New time" value={rescheduleForm.time} onChange={e => setRescheduleForm(f => ({ ...f, time: e.target.value }))} className="px-2 py-1 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-[11px] text-t1 outline-none focus:border-[var(--b3)]" />
                                <button type="button" disabled={busy} onClick={() => void submitReschedule(appt.id)} className="px-2.5 py-1 rounded-lg bg-[var(--indigo)] text-white text-[11px] font-semibold hover:opacity-90 disabled:opacity-40">{busy ? 'Saving…' : 'Confirm'}</button>
                              </div>
                            )}
                          </>
                        );
                      })()}
                      {!isFrontDesk && paymentApptId === appt.id && (
                        <div className="mt-2.5 space-y-2.5">
                          <InsuranceIntakeCard appointmentId={appt.id} />
                          <AppointmentPaymentCard appointmentId={appt.id} />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </BentoCard>
        </div>

        {/* Right sidebar */}
        <div className="space-y-4">
          {/* Deposit payment requests queue */}
          <PaymentRequestsPanel />

          {/* Provider utilisation */}
          <BentoCard title="Provider Utilisation" subtitle="Today's capacity">
            <div className="space-y-3">
              {providerRecords.slice(0, 5).map((doc) => (
                <div key={doc.id}>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-[var(--indigo-soft)] flex items-center justify-center text-indigo text-[9px] font-bold shrink-0">
                        {doc.name.split(' ').slice(-1)[0][0]}
                      </div>
                      <p className="text-xs font-semibold text-t1 truncate max-w-[120px]">{doc.name}</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Clock className="w-3 h-3 text-t3" />
                      <span className="text-xs font-bold text-t2">{doc.utilization}%</span>
                    </div>
                  </div>
                  <ProgressBar value={doc.utilization} />
                  <div className="flex items-center justify-between mt-1">
                    <p className="text-[10px] text-t3">{doc.specialty}</p>
                    <p className="text-[10px] text-t3">{doc.appointmentsToday} appts today</p>
                  </div>
                </div>
              ))}
              <button type="button" onClick={() => navigate('/doctor-workspace')} className="w-full text-xs font-semibold text-indigo flex items-center justify-center gap-1 py-2 border border-dashed border-[var(--b2)] rounded-xl hover:bg-[var(--s3)] transition-colors">
                <Users className="w-3.5 h-3.5" /> View all providers
              </button>
            </div>
          </BentoCard>

        </div>
      </div>
    </div>
  );
}
