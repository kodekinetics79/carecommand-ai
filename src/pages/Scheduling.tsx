import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, Sparkles, Zap, AlertCircle, CheckCircle2, Clock, Users, DollarSign, ArrowRight, RefreshCw } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import RiskBadge from '../components/ui/RiskBadge';
import ProgressBar from '../components/ui/ProgressBar';
import { appointments, patients, branches, doctors } from '../data/seedData';
import { formatCurrency } from '../utils/formatters';
import { useApiResource } from '../hooks/useApiResource';
import { mapAppointment, mapProviderProfile, mapPatient, type ApiAppointment, type ApiProviderProfile, type ApiPatient } from '../lib/apiAdapters';
import { apiRequest } from '../lib/api';
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
const emptyBooking = { patientId: '', service: '', date: todayDate, time: '10:00', channel: 'WHATSAPP', value: '150' };

const statusConfig: Record<string, { label: string; dot: string; bg: string; text: string }> = {
  confirmed:  { label: 'Confirmed',  dot: 'bg-emerald-500', bg: 'bg-[var(--emerald-soft)]',  text: 'text-emerald-v' },
  arrived:    { label: 'Arrived',    dot: 'bg-blue-500',    bg: 'bg-[var(--blue-soft)]',     text: 'text-blue-v' },
  risky:      { label: 'High Risk',  dot: 'bg-red-500 animate-pulse', bg: 'bg-[var(--red-soft)]', text: 'text-red-v' },
  'no-show':  { label: 'No-Show',   dot: 'bg-[var(--b2)]',   bg: 'bg-[var(--s3)]',   text: 'text-t3' },
  completed:  { label: 'Completed', dot: 'bg-teal-500',     bg: 'bg-[var(--emerald-soft)]',     text: 'text-emerald-v' },
  canceled:   { label: 'Canceled',  dot: 'bg-[var(--b1)]',   bg: 'bg-[var(--s2)]',    text: 'text-t3' },
  waitlist:   { label: 'Waitlist',  dot: 'bg-amber-500',   bg: 'bg-[var(--amber-soft)]',    text: 'text-amber-v' },
};

const waitlistSlots = [
  { name: 'Isabelle Dubois', service: 'Nutrition Consultation', preferred: 'Mon–Wed afternoon', value: formatCurrency(180) },
  { name: 'Jack Harrison', service: 'Annual Wellness Review', preferred: 'Any weekday AM', value: formatCurrency(200) },
  { name: 'Sara Montero', service: 'Skin Consultation', preferred: 'Thu or Fri', value: formatCurrency(320) },
];

const aiRecommendations = [
  { title: 'Fill 6 empty Downtown slots', desc: 'Target 90-day inactive dermatology customers. Est. ' + formatCurrency(1680) + '.', impact: formatCurrency(1680), action: 'Create offer campaign' },
  { title: 'Westside: 31 slots at risk this week', desc: 'Utilisation at 61%. Activate a slot-filling offer immediately.', impact: formatCurrency(6200), action: 'Launch fill campaign' },
  { title: '3 high no-show risk appointments today', desc: 'Marcus Thompson (74%), Mohammed Al-Farsi (61%), Yuki Tanaka (78%). AI reminders sent.', impact: formatCurrency(660), action: 'Review risk queue' },
];

export default function Scheduling() {
  const navigate = useNavigate();
  const [selectedBranch, setSelectedBranch] = useState('all');
  const [selectedDate, setSelectedDate] = useState(todayDate);
  const [insuranceQueue, setInsuranceQueue] = useState<AppointmentVerificationQueueRow[]>([]);
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [queueBusy, setQueueBusy] = useState<string | null>(null);
  const { data: appointmentRecords, source, reload } = useApiResource<ApiAppointment, typeof appointments[number]>('/v1/appointments?limit=100', appointments, mapAppointment);
  const { data: providerRecords } = useApiResource<ApiProviderProfile, typeof doctors[number]>('/v1/providers/overview?limit=100', doctors, mapProviderProfile);
  const { data: patientRecords } = useApiResource<ApiPatient, typeof patients[number]>('/v1/patients?limit=100', patients, mapPatient);

  const [showBooking, setShowBooking] = useState(false);
  const [booking, setBooking] = useState(emptyBooking);
  const [saving, setSaving] = useState(false);
  const [bookingError, setBookingError] = useState<string | null>(null);

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

  async function bookAppointment() {
    const patient = patientRecords.find(p => p.id === booking.patientId);
    if (!patient || !patient.branchId || !booking.service.trim()) {
      setBookingError('Pick a customer and enter a service.');
      return;
    }
    setSaving(true);
    setBookingError(null);
    try {
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
      setBooking(emptyBooking);
      setShowBooking(false);
      setSelectedDate(booking.date);
      reload();
    } catch (err) {
      setBookingError(err instanceof Error ? err.message : 'Failed to book appointment');
    } finally {
      setSaving(false);
    }
  }

  const todayAppts = useMemo(() =>
    appointmentRecords.filter(a => a.date === selectedDate && (selectedBranch === 'all' || a.branchId === selectedBranch))
      .sort((a, b) => a.time.localeCompare(b.time)),
    [appointmentRecords, selectedBranch, selectedDate]
  );

  const totalValue = todayAppts.reduce((s, a) => s + a.value, 0);
  const riskyCount = todayAppts.filter(a => a.status === 'risky').length;
  const confirmedCount = todayAppts.filter(a => a.status === 'confirmed' || a.status === 'arrived').length;
  const queueMode = insuranceQueue.some(row => row.providerMode !== 'mock') ? 'Sandbox Active' : 'Mock Mode';

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
        badge={source === 'live' ? 'Live DB' : 'Demo'}
        badgeColor={source === 'live' ? 'emerald' : 'blue'}
        actions={
          <div className="flex gap-2">
            <button type="button" onClick={() => setShowBooking(true)} className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition">
              <CalendarDays className="w-4 h-4" /> Book Appointment
            </button>
          </div>
        }
      />

      {showBooking && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowBooking(false)}>
          <div className="w-full max-w-md rounded-2xl bg-[var(--s1)] border border-[var(--b2)] p-5 shadow-xl" onClick={e => e.stopPropagation()}>
            <p className="text-sm font-bold text-t1 mb-3">Book Appointment</p>
            {bookingError && <p className="text-[11px] text-red-v mb-2">{bookingError}</p>}
            <div className="space-y-2.5">
              <select aria-label="Customer" title="Customer" value={booking.patientId} onChange={e => setBooking(b => ({ ...b, patientId: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)]">
                <option value="">Select customer…</option>
                {patientRecords.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <input value={booking.service} onChange={e => setBooking(b => ({ ...b, service: e.target.value }))} placeholder="Service (e.g. Dermatology Review)" className="w-full px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
              <div className="grid grid-cols-2 gap-2.5">
                <input type="date" aria-label="Date" value={booking.date} onChange={e => setBooking(b => ({ ...b, date: e.target.value }))} className="px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
                <input type="time" aria-label="Time" value={booking.time} onChange={e => setBooking(b => ({ ...b, time: e.target.value }))} className="px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
                <select aria-label="Channel" title="Channel" value={booking.channel} onChange={e => setBooking(b => ({ ...b, channel: e.target.value }))} className="px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)]">
                  {['WHATSAPP', 'SMS', 'EMAIL', 'CALL', 'VIDEO'].map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <input type="number" aria-label="Value" value={booking.value} onChange={e => setBooking(b => ({ ...b, value: e.target.value }))} placeholder="Value ($)" className="px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <button type="button" disabled={saving} onClick={bookAppointment} className="flex-1 py-2 rounded-lg bg-[var(--indigo)] text-white text-xs font-semibold hover:opacity-90 transition disabled:opacity-40">{saving ? 'Booking…' : 'Book Appointment'}</button>
              <button type="button" onClick={() => setShowBooking(false)} className="px-4 py-2 rounded-lg border border-[var(--b1)] text-t2 text-xs font-semibold hover:bg-[var(--s3)] transition">Cancel</button>
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

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1 bg-[var(--s2)] border border-[var(--b1)] p-1 rounded-xl">
          {dateOptions.map(opt => (
            <button key={opt.value} type="button" onClick={() => setSelectedDate(opt.value)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${selectedDate === opt.value ? 'bg-[var(--indigo)] text-white' : 'text-t3 hover:text-t1'}`}>{opt.label}</button>
          ))}
        </div>
        <div className="flex items-center gap-1 bg-[var(--s2)] border border-[var(--b1)] p-1 rounded-xl">
          <button type="button" onClick={() => setSelectedBranch('all')} className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${selectedBranch === 'all' ? 'bg-[var(--s3)] text-t1' : 'text-t3 hover:text-t1'}`}>All Branches</button>
          {branches.map(b => (
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
                  <div key={appt.id} className={`flex items-start gap-3 p-3.5 rounded-xl border transition-all hover:bg-[var(--s3)] ${isRisky ? 'border-[var(--b2)] bg-[var(--red-soft)]' : 'border-[var(--b1)]'}`}>
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
                      <div className="flex items-center gap-2 mt-1.5">
                        <span className="text-[10px] text-t3 capitalize">{appt.channel}</span>
                        {isRisky && (
                          <button type="button" onClick={() => navigate('/ai-receptionist')} className="inline-flex items-center gap-1 text-[10px] font-semibold text-indigo bg-[var(--indigo-soft)] px-2 py-0.5 rounded-full hover:opacity-80 transition-colors">
                            <Zap className="w-2.5 h-2.5" /> Send reminder
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </BentoCard>
        </div>

        {/* Right sidebar */}
        <div className="space-y-4">
          {/* AI Slot-Filling Panel */}
          <BentoCard title="AI Slot-Filling Engine" subtitle="Optimisation recommendations" headerRight={<Sparkles className="w-4 h-4 text-violet-v" />}>
            <div className="space-y-3">
              {aiRecommendations.map((rec) => (
                <div key={rec.title} className="p-3.5 rounded-xl border border-[var(--b1)] hover:border-[var(--b2)] hover:bg-[var(--s3)] transition-all">
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <p className="text-xs font-bold text-t1 leading-tight">{rec.title}</p>
                    <span className="badge badge-emerald shrink-0">{rec.impact}</span>
                  </div>
                  <p className="text-[11px] text-t3 mb-2 leading-relaxed">{rec.desc}</p>
                  <button type="button" onClick={() => navigate('/campaigner')} className="inline-flex items-center gap-1.5 text-xs font-semibold text-indigo hover:opacity-80">
                    <Zap className="w-3 h-3" /> {rec.action} <ArrowRight className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* Waitlist */}
          <BentoCard title="Waitlist Queue" subtitle="Customers ready to book" headerRight={
            <span className="badge badge-amber">{waitlistSlots.length} waiting</span>
          }>
            <div className="space-y-2.5">
              {waitlistSlots.map((w) => (
                <div key={w.name} className="p-3 rounded-xl border border-[var(--b1)] hover:border-[var(--b2)] hover:bg-[var(--s3)] transition-all">
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <p className="text-xs font-bold text-t1">{w.name}</p>
                    <span className="text-[10px] font-bold text-emerald-v">{w.value}</span>
                  </div>
                  <p className="text-[11px] text-t3">{w.service}</p>
                  <p className="text-[10px] text-t3 mt-0.5">Pref: {w.preferred}</p>
                  <button type="button" onClick={() => setShowBooking(true)} className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-indigo bg-[var(--indigo-soft)] px-2 py-1 rounded-lg hover:opacity-80 transition-colors">
                    <CalendarDays className="w-3 h-3" /> Match & Book
                  </button>
                </div>
              ))}
            </div>
          </BentoCard>

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

          {/* Empty slot value */}
          <div className="rounded-2xl bg-[var(--s2)] border border-[var(--b1)] p-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-blue-v mb-1">Empty Slot Value</p>
            <p className="text-2xl font-bold text-t1 mb-0.5">{formatCurrency(6200)}</p>
            <p className="text-xs text-t2 mb-3">31 unfilled slots this week across Westside</p>
            <button type="button" onClick={() => navigate('/campaigner')} className="w-full py-2 rounded-xl bg-[var(--s3)] hover:bg-[var(--b1)] text-t1 text-xs font-semibold transition-colors flex items-center justify-center gap-1.5">
              <Zap className="w-3.5 h-3.5" /> Activate slot-fill campaign
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
