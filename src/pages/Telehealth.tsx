import { Video, CheckCircle2, Clock, ArrowRight, Sparkles, Phone, CalendarDays, Zap, Users } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApiResource } from '../hooks/useApiResource';
import { mapTelehealthSession, type ApiTelehealthSession, type TelehealthSession } from '../lib/apiAdapters';
import { formatCurrency } from '../utils/formatters';

const fallbackSessions: TelehealthSession[] = [
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
  Confirmed: { dot: 'bg-emerald-500', text: 'text-emerald-v', bg: 'badge badge-emerald' },
  Pending:   { dot: 'bg-amber-400',   text: 'text-amber-v',   bg: 'badge badge-amber' },
};

export default function Telehealth() {
  const navigate = useNavigate();
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sentIntakeIds, setSentIntakeIds] = useState<string[]>([]);
  const { data: sessions } = useApiResource<ApiTelehealthSession, TelehealthSession>(
    '/v1/telehealth/sessions?limit=100',
    fallbackSessions,
    mapTelehealthSession,
  );

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
          <button type="button" onClick={() => navigate('/scheduling')} className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--indigo-mid)] transition">
            <Video className="w-4 h-4" /> Launch Video Room
          </button>
        }
      />

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Virtual Sessions" value={sessions.length} subtitle="Booked today" icon={<Video className="w-4 h-4" />} accent="blue" />
        <StatCard title="Confirmed" value={confirmedCount} subtitle="Ready to start" icon={<CheckCircle2 className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Intake Complete" value={`${Math.round((intakeComplete / sessions.length) * 100)}%`} subtitle="Pre-visit forms" icon={<Users className="w-4 h-4" />} accent="violet" />
        <StatCard title="Session Revenue" value={formatCurrency(totalValue)} subtitle="Today's virtual visits" icon={<CalendarDays className="w-4 h-4" />} accent="amber" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        {/* Session queue */}
        <BentoCard title="Virtual Waiting Room" subtitle="Today's sessions · All providers">
          <div className="space-y-3">
            {sessions.map((session) => {
              const sc = statusColors[session.status];
              return (
                <div key={session.id} className={`p-4 rounded-2xl border transition-all hover:bg-[var(--s3)] ${
                  session.status === 'Confirmed' ? 'border-[var(--b1)] bg-[var(--emerald-soft)]' : 'border-[var(--b1)] bg-[var(--amber-soft)]'
                }`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-400 to-violet-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0">
                        {session.initials}
                      </div>
                      <div>
                        <p className="text-sm font-bold text-t1">{session.patient}</p>
                        <p className="text-[11px] text-t3">{session.service}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <Clock className="w-3 h-3 text-t3" />
                          <span className="text-[11px] text-t3">{session.time} · {session.provider}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-2 shrink-0">
                      <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${sc.bg}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${sc.dot}`} />
                        {session.status}
                      </span>
                      <span className="text-xs font-bold text-t2">{formatCurrency(session.value)}</span>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {session.intakeComplete
                        ? <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-v"><CheckCircle2 className="w-3 h-3" /> Intake complete</span>
                        : <span className="flex items-center gap-1 text-[10px] font-semibold text-amber-v"><Clock className="w-3 h-3" /> Intake pending</span>
                      }
                    </div>
                    <div className="flex items-center gap-2">
                      {!session.intakeComplete && (
                        <button type="button" disabled={sentIntakeIds.includes(session.id)} onClick={() => setSentIntakeIds(current => current.includes(session.id) ? current : [...current, session.id])} className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-v bg-[var(--amber-soft)] px-2 py-1 rounded-lg hover:bg-[var(--s3)] transition-colors disabled:opacity-40">
                          <Zap className="w-3 h-3" /> {sentIntakeIds.includes(session.id) ? 'Sent' : 'Send intake'}
                        </button>
                      )}
                      <button type="button" onClick={() => setActiveSessionId(session.id)} className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-white bg-[var(--indigo)] px-2.5 py-1 rounded-lg hover:bg-[var(--indigo-mid)] transition-colors">
                        <Video className="w-3 h-3" /> {activeSessionId === session.id ? 'Starting…' : 'Start'}
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
                <div key={opp.patient} className="p-3.5 rounded-xl border border-[var(--b1)] bg-[var(--violet-soft)] hover:border-[var(--b2)] transition-all">
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <p className="text-xs font-bold text-t1">{opp.patient}</p>
                    <span className="text-xs font-bold text-violet-v shrink-0">+{formatCurrency(opp.value)}</span>
                  </div>
                  <p className="text-[11px] text-t3 mb-2">{opp.suggestion}</p>
                  <button type="button" onClick={() => navigate('/scheduling')} className="inline-flex items-center gap-1 text-[10px] font-semibold text-indigo hover:text-blue-v">
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
                <div key={item.step} className="flex items-start gap-3 p-3 rounded-xl border border-[var(--b1)] hover:bg-[var(--s3)] transition-colors">
                  <div className={`w-6 h-6 rounded-full ${item.color} flex items-center justify-center text-white text-[10px] font-bold shrink-0`}>{item.step}</div>
                  <div>
                    <p className="text-xs font-bold text-t1">{item.title}</p>
                    <p className="text-[11px] text-t3 mt-0.5">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* Post-visit follow-ups */}
          <div className="rounded-2xl bg-[var(--s2)] border border-[var(--b1)] p-4">
            <div className="flex items-center gap-2 mb-2">
              <Phone className="w-4 h-4 text-t3" />
              <p className="text-[10px] font-bold uppercase tracking-widest text-t3">Post-Visit Automation</p>
            </div>
            <p className="text-2xl font-bold text-t1 mb-1">6 follow-ups</p>
            <p className="text-xs text-t3 mb-3">Triggered automatically after virtual sessions this month.</p>
            <button type="button" onClick={() => navigate('/crm')} className="w-full py-2 rounded-xl bg-[var(--s3)] hover:bg-[var(--indigo-soft)] text-t2 hover:text-indigo text-xs font-semibold transition-colors flex items-center justify-center gap-1.5">
              <ArrowRight className="w-3.5 h-3.5" /> View follow-up queue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
