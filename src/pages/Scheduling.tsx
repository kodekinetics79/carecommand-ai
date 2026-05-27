import { useMemo, useState } from 'react';
import { CalendarDays, Sparkles, Zap, AlertCircle, CheckCircle2, Clock, Users, DollarSign, ArrowRight } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import RiskBadge from '../components/ui/RiskBadge';
import ProgressBar from '../components/ui/ProgressBar';
import { appointments } from '../data/mockAppointments';
import { branches } from '../data/mockClinics';
import { doctors } from '../data/mockClinics';

const todayDate = '2025-05-26';

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
  { name: 'Isabelle Dubois', service: 'Nutrition Consultation', preferred: 'Mon–Wed afternoon', value: '£180' },
  { name: 'Jack Harrison', service: 'Annual Wellness Review', preferred: 'Any weekday AM', value: '£200' },
  { name: 'Sara Montero', service: 'Skin Consultation', preferred: 'Thu or Fri', value: '£320' },
];

const aiRecommendations = [
  { title: 'Fill 6 empty Downtown slots', desc: 'Target 90-day inactive dermatology customers. Est. £1,680.', impact: '£1,680', action: 'Create offer campaign' },
  { title: 'Westside: 31 slots at risk this week', desc: 'Utilisation at 61%. Activate a slot-filling offer immediately.', impact: '£6,200', action: 'Launch fill campaign' },
  { title: '3 high no-show risk appointments today', desc: 'Marcus Thompson (74%), Mohammed Al-Farsi (61%), Yuki Tanaka (78%). AI reminders sent.', impact: '£660', action: 'Review risk queue' },
];

export default function Scheduling() {
  const [selectedBranch, setSelectedBranch] = useState('all');
  const [selectedDate, setSelectedDate] = useState(todayDate);

  const todayAppts = useMemo(() =>
    appointments.filter(a => a.date === selectedDate && (selectedBranch === 'all' || a.branchId === selectedBranch))
      .sort((a, b) => a.time.localeCompare(b.time)),
    [selectedBranch, selectedDate]
  );

  const totalValue = todayAppts.reduce((s, a) => s + a.value, 0);
  const riskyCount = todayAppts.filter(a => a.status === 'risky').length;
  const confirmedCount = todayAppts.filter(a => a.status === 'confirmed' || a.status === 'arrived').length;

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Smart Scheduling"
        subtitle="AI-optimised appointment calendar with no-show prediction and slot-filling intelligence."
        actions={
          <div className="flex gap-2">
            <button type="button" className="inline-flex items-center gap-2 rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-4 py-2 text-sm font-semibold text-t1 hover:bg-[var(--s3)] transition">
              <CalendarDays className="w-4 h-4" /> Export Schedule
            </button>
            <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition">
              <Zap className="w-4 h-4" /> Fill Empty Slots
            </button>
          </div>
        }
      />

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Today's Appointments" value={todayAppts.length} subtitle="All branches" icon={<CalendarDays className="w-4 h-4" />} accent="blue" />
        <StatCard title="Confirmed / Arrived" value={confirmedCount} subtitle="On track" icon={<CheckCircle2 className="w-4 h-4" />} accent="emerald" />
        <StatCard title="No-Show Risk" value={riskyCount} subtitle="AI flagged today" icon={<AlertCircle className="w-4 h-4" />} accent="red" />
        <StatCard title="Today's Value" value={`£${totalValue.toLocaleString()}`} subtitle="Appointment revenue" icon={<DollarSign className="w-4 h-4" />} accent="violet" />
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1 bg-[var(--s2)] border border-[var(--b1)] p-1 rounded-xl">
          <button type="button" onClick={() => setSelectedDate('2025-05-26')} className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${selectedDate === '2025-05-26' ? 'bg-[var(--indigo)] text-white' : 'text-t3 hover:text-t1'}`}>Today</button>
          <button type="button" onClick={() => setSelectedDate('2025-05-27')} className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${selectedDate === '2025-05-27' ? 'bg-[var(--indigo)] text-white' : 'text-t3 hover:text-t1'}`}>Tomorrow</button>
          <button type="button" onClick={() => setSelectedDate('2025-05-28')} className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${selectedDate === '2025-05-28' ? 'bg-[var(--indigo)] text-white' : 'text-t3 hover:text-t1'}`}>Wed 28</button>
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
          <BentoCard title="Appointment Timeline" subtitle={`${selectedDate === todayDate ? "Today's" : ""} schedule`} headerRight={
            <span className="text-xs font-semibold text-t3">{todayAppts.length} appointments · £{totalValue.toLocaleString()}</span>
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
                      <p className="text-[10px] text-t3">{appt.value ? `£${appt.value}` : ''}</p>
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
                          <button type="button" className="inline-flex items-center gap-1 text-[10px] font-semibold text-indigo bg-[var(--indigo-soft)] px-2 py-0.5 rounded-full hover:opacity-80 transition-colors">
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
                  <button type="button" className="inline-flex items-center gap-1.5 text-xs font-semibold text-indigo hover:opacity-80">
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
                  <button type="button" className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-indigo bg-[var(--indigo-soft)] px-2 py-1 rounded-lg hover:opacity-80 transition-colors">
                    <CalendarDays className="w-3 h-3" /> Match & Book
                  </button>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* Provider utilisation */}
          <BentoCard title="Provider Utilisation" subtitle="Today's capacity">
            <div className="space-y-3">
              {doctors.slice(0, 5).map((doc) => (
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
              <button type="button" className="w-full text-xs font-semibold text-indigo flex items-center justify-center gap-1 py-2 border border-dashed border-[var(--b2)] rounded-xl hover:bg-[var(--s3)] transition-colors">
                <Users className="w-3.5 h-3.5" /> View all providers
              </button>
            </div>
          </BentoCard>

          {/* Empty slot value */}
          <div className="rounded-2xl bg-[var(--s2)] border border-[var(--b1)] p-4">
            <p className="text-[10px] font-bold uppercase tracking-widest text-blue-v mb-1">Empty Slot Value</p>
            <p className="text-2xl font-bold text-t1 mb-0.5">£6,200</p>
            <p className="text-xs text-t2 mb-3">31 unfilled slots this week across Westside</p>
            <button type="button" className="w-full py-2 rounded-xl bg-[var(--s3)] hover:bg-[var(--b1)] text-t1 text-xs font-semibold transition-colors flex items-center justify-center gap-1.5">
              <Zap className="w-3.5 h-3.5" /> Activate slot-fill campaign
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
