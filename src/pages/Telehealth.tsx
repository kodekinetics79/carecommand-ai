import { Video, CheckCircle2, Clock, ArrowRight, Sparkles, Phone, CalendarDays, Zap, Users } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';

const sessions = [
  { id: 't1', patient: 'Rowan Brooks', initials: 'RB', service: 'Virtual Dermatology Review', date: '2026-05-26', time: '10:00', status: 'Confirmed', provider: 'Dr. Priya Sharma', value: 220, intakeComplete: true },
  { id: 't2', patient: 'Nora Steele', initials: 'NS', service: 'Telehealth Nutrition Follow-up', date: '2026-05-26', time: '14:00', status: 'Pending', provider: 'Dr. Lisa Wong', value: 180, intakeComplete: false },
  { id: 't3', patient: 'Oliver Chen', initials: 'OC', service: 'Virtual GP Consultation', date: '2026-05-27', time: '09:30', status: 'Confirmed', provider: 'Dr. James Okafor', value: 150, intakeComplete: true },
  { id: 't4', patient: 'Isabelle Dubois', initials: 'ID', service: 'Wellness Check-in (Virtual)', date: '2026-05-27', time: '11:00', status: 'Confirmed', provider: 'Dr. Lisa Wong', value: 95, intakeComplete: true },
];

const conversionOpportunities = [
  { patient: 'Rowan Brooks', suggestion: 'Book in-person Botox consultation following virtual review', value: 480 },
  { patient: 'Nora Steele', suggestion: 'Schedule 12-week nutrition programme after follow-up', value: 960 },
  { patient: 'Oliver Chen', suggestion: 'Follow-up blood test at Downtown branch', value: 220 },
];

const statusColors: Record<string, { dot: string; text: string; bg: string }> = {
  Confirmed: { dot: 'bg-emerald-500', text: 'text-emerald-700', bg: 'bg-emerald-100' },
  Pending:   { dot: 'bg-amber-400',   text: 'text-amber-700',   bg: 'bg-amber-100' },
};

export default function Telehealth() {
  const intakeComplete = sessions.filter(s => s.intakeComplete).length;
  const confirmedCount = sessions.filter(s => s.status === 'Confirmed').length;
  const totalValue = sessions.reduce((s, sess) => s + sess.value, 0);

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Virtual Visit Booking"
        subtitle="Virtual appointment scheduling, intake management, waiting room, and in-person conversion tracking."
        badge={`${sessions.length} Today`}
        badgeColor="blue"
        actions={
          <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition shadow-md shadow-blue-500/20">
            <Video className="w-4 h-4" /> Launch Video Room
          </button>
        }
      />

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Virtual Sessions" value={sessions.length} subtitle="Booked today" icon={<Video className="w-4 h-4" />} accent="blue" />
        <StatCard title="Confirmed" value={confirmedCount} subtitle="Ready to start" icon={<CheckCircle2 className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Intake Complete" value={`${Math.round((intakeComplete / sessions.length) * 100)}%`} subtitle="Pre-visit forms" icon={<Users className="w-4 h-4" />} accent="violet" />
        <StatCard title="Session Revenue" value={`£${totalValue}`} subtitle="Today's virtual visits" icon={<CalendarDays className="w-4 h-4" />} accent="amber" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        {/* Session queue */}
        <BentoCard title="Virtual Waiting Room" subtitle="Today's sessions · All providers">
          <div className="space-y-3">
            {sessions.map((session) => {
              const sc = statusColors[session.status];
              return (
                <div key={session.id} className={`p-4 rounded-2xl border transition-all hover:shadow-sm ${
                  session.status === 'Confirmed' ? 'border-emerald-200 bg-emerald-50/20' : 'border-amber-200 bg-amber-50/20'
                }`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-400 to-violet-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0">
                        {session.initials}
                      </div>
                      <div>
                        <p className="text-sm font-bold text-slate-900">{session.patient}</p>
                        <p className="text-[11px] text-slate-500">{session.service}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <Clock className="w-3 h-3 text-slate-400" />
                          <span className="text-[11px] text-slate-500">{session.time} · {session.provider}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-2 shrink-0">
                      <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${sc.bg} ${sc.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${sc.dot}`} />
                        {session.status}
                      </span>
                      <span className="text-xs font-bold text-slate-700">£{session.value}</span>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {session.intakeComplete
                        ? <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-700"><CheckCircle2 className="w-3 h-3" /> Intake complete</span>
                        : <span className="flex items-center gap-1 text-[10px] font-semibold text-amber-600"><Clock className="w-3 h-3" /> Intake pending</span>
                      }
                    </div>
                    <div className="flex items-center gap-2">
                      {!session.intakeComplete && (
                        <button type="button" className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-50 px-2 py-1 rounded-lg hover:bg-amber-100 transition-colors">
                          <Zap className="w-3 h-3" /> Send intake
                        </button>
                      )}
                      <button type="button" className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-white bg-blue-600 px-2.5 py-1 rounded-lg hover:bg-blue-700 transition-colors">
                        <Video className="w-3 h-3" /> Start
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </BentoCard>

        <div className="space-y-4">
          {/* Conversion opportunities */}
          <BentoCard title="Convert to In-Person" subtitle="Upsell & booking opportunities" headerRight={<Sparkles className="w-4 h-4 text-violet-500" />}>
            <div className="space-y-3">
              {conversionOpportunities.map((opp) => (
                <div key={opp.patient} className="p-3.5 rounded-xl border border-violet-100 bg-violet-50/40 hover:border-violet-200 transition-all">
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <p className="text-xs font-bold text-slate-900">{opp.patient}</p>
                    <span className="text-xs font-bold text-violet-700 shrink-0">+£{opp.value}</span>
                  </div>
                  <p className="text-[11px] text-slate-500 mb-2">{opp.suggestion}</p>
                  <button type="button" className="inline-flex items-center gap-1 text-[10px] font-semibold text-blue-600 hover:text-blue-700">
                    <CalendarDays className="w-3 h-3" /> Book in-person slot
                  </button>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* Workflow */}
          <BentoCard title="Virtual Visit Workflow" subtitle="3-step patient journey">
            <div className="space-y-2.5">
              {[
                { step: 1, title: 'Pre-visit intake', desc: 'Collect context, consent and payment before the session starts.', color: 'bg-blue-500' },
                { step: 2, title: 'Video waiting room', desc: 'Manage queue, start on time, and take session notes.', color: 'bg-violet-500' },
                { step: 3, title: 'Post-visit follow-up', desc: 'Trigger reminders, in-person bookings and review requests.', color: 'bg-emerald-500' },
              ].map((item) => (
                <div key={item.step} className="flex items-start gap-3 p-3 rounded-xl border border-slate-100 hover:bg-slate-50 transition-colors">
                  <div className={`w-6 h-6 rounded-full ${item.color} flex items-center justify-center text-white text-[10px] font-bold shrink-0`}>{item.step}</div>
                  <div>
                    <p className="text-xs font-bold text-slate-900">{item.title}</p>
                    <p className="text-[11px] text-slate-500 mt-0.5">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* Post-visit follow-ups */}
          <div className="rounded-2xl bg-gradient-to-br from-blue-600 to-violet-600 p-4 text-white shadow-lg shadow-blue-500/20">
            <div className="flex items-center gap-2 mb-2">
              <Phone className="w-4 h-4 text-blue-200" />
              <p className="text-[10px] font-bold uppercase tracking-widest text-blue-200">Post-Visit Automation</p>
            </div>
            <p className="text-2xl font-bold mb-1">6 follow-ups</p>
            <p className="text-xs text-blue-200 mb-3">Triggered automatically after virtual sessions this month.</p>
            <button type="button" className="w-full py-2 rounded-xl bg-white/20 hover:bg-white/30 text-white text-xs font-semibold transition-colors flex items-center justify-center gap-1.5">
              <ArrowRight className="w-3.5 h-3.5" /> View follow-up queue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
