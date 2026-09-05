import { Video, CheckCircle2, Clock, CalendarDays, Users } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import { useNavigate } from 'react-router';
import { useApiResource } from '../hooks/useApiResource';
import { mapTelehealthSession, type ApiTelehealthSession, type TelehealthSession } from '../lib/apiAdapters';
import { formatCurrency } from '../utils/formatters';

const statusColors: Record<string, { dot: string; text: string; bg: string }> = {
  Confirmed: { dot: 'bg-emerald-500', text: 'text-emerald-v', bg: 'badge badge-emerald' },
  'Needs confirmation': { dot: 'bg-amber-400', text: 'text-amber-v', bg: 'badge badge-amber' },
  Arrived: { dot: 'bg-blue-500', text: 'text-blue-v', bg: 'badge badge-blue' },
  'No-show': { dot: 'bg-red-500', text: 'text-red-v', bg: 'badge badge-red' },
  Canceled: { dot: 'bg-slate-400', text: 'text-t3', bg: 'badge' },
  Completed: { dot: 'bg-violet-500', text: 'text-violet-v', bg: 'badge badge-violet' },
  Waitlist: { dot: 'bg-slate-400', text: 'text-t3', bg: 'badge' },
};

export default function Telehealth() {
  const navigate = useNavigate();
  const { data: sessions, source, loading, error: loadError } = useApiResource<ApiTelehealthSession, TelehealthSession>(
    '/v1/telehealth/sessions?limit=100&page=true',
    [],
    mapTelehealthSession,
    { allPages: true },
  );

  const intakeComplete = sessions.filter(s => s.intakeComplete).length;
  const confirmedCount = sessions.filter(s => s.status === 'Confirmed').length;
  const totalValue = sessions.reduce((s, sess) => s + sess.value, 0);
  const intakePercent = sessions.length > 0 ? Math.round((intakeComplete / sessions.length) * 100) : 0;
  const metricsReady = source === 'live' && !loadError;

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Video Appointments"
        subtitle="Today’s video appointment records and pre-visit intake status. Video-room delivery and the clinical encounter remain in the clinic’s approved systems."
        badge={loadError ? 'Data unavailable' : metricsReady ? `${sessions.length} today` : 'Loading'}
        badgeColor={loadError ? 'red' : 'blue'}
        actions={
          <button type="button" onClick={() => navigate('/scheduling')} className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--indigo-mid)] transition">
            <Video className="w-4 h-4" /> Schedule video appointment
          </button>
        }
      />

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Virtual Sessions" value={metricsReady ? sessions.length : '—'} subtitle={metricsReady ? 'Booked today' : loading ? 'Loading' : 'Unavailable'} icon={<Video className="w-4 h-4" />} accent="blue" />
        <StatCard title="Confirmed" value={metricsReady ? confirmedCount : '—'} subtitle={metricsReady ? 'Appointment record confirmed' : loading ? 'Loading' : 'Unavailable'} icon={<CheckCircle2 className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Intake Complete" value={metricsReady ? `${intakePercent}%` : '—'} subtitle={metricsReady ? 'Pre-visit forms' : loading ? 'Loading' : 'Unavailable'} icon={<Users className="w-4 h-4" />} accent="violet" />
        <StatCard title="Scheduled Value" value={metricsReady ? formatCurrency(totalValue) : '—'} subtitle={metricsReady ? 'Not collected revenue' : loading ? 'Loading' : 'Unavailable'} icon={<CalendarDays className="w-4 h-4" />} accent="amber" />
      </div>

      <div className="rounded-xl border border-[var(--b1)] bg-[var(--blue-soft)] px-4 py-3 text-[11px] text-blue-v">
        A confirmed appointment does not by itself prove intake, telehealth consent, payment, technical readiness, patient arrival, or clinician availability. Verify each requirement before starting care.
      </div>

      {loadError && (
        <div role="alert" className="rounded-2xl border border-[rgba(220,38,38,0.18)] bg-red-soft px-4 py-3 text-xs font-semibold text-red-v">
          Virtual-visit records could not be loaded from the clinic service: {loadError}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        {/* Session queue */}
          <BentoCard title="Virtual Visit Schedule" subtitle="Today's accessible stored appointment records · current clinic scope">
            <div className="space-y-3">
            {loadError ? (
              <div className="rounded-2xl border border-dashed border-red-200 bg-red-50 px-4 py-6 text-center text-sm text-red-700">
                Video appointment records are unavailable. Retry after the clinic service recovers.
              </div>
            ) : sessions.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[var(--b1)] bg-[var(--s2)] px-4 py-6 text-center text-sm text-t3">
                No virtual-visit records are available for this clinic today.
              </div>
            ) : sessions.map((session) => {
              const sc = statusColors[session.status];
              return (
                <div key={session.id} className={`p-4 rounded-2xl border transition-all hover:bg-[var(--s3)] ${
                  session.status === 'Confirmed' ? 'border-[var(--b1)] bg-[var(--emerald-soft)]' : 'border-[var(--b1)] bg-[var(--s2)]'
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
                    <span className="text-[10px] text-t3">Video-room and intake-delivery actions require a configured provider.</span>
                  </div>
                </div>
              );
            })}
            </div>
          </BentoCard>

        <div className="space-y-4">
          {/* Workflow */}
          <BentoCard title="Virtual Visit Workflow" subtitle="3-step patient journey">
            <div className="space-y-2.5">
              {[
                { step: 1, title: 'Pre-visit checks', desc: 'Verify required intake, telehealth consent, payment status, and contact details.', color: 'bg-blue-500' },
                { step: 2, title: 'Video visit', desc: 'Confirm provider availability and use the clinic-approved video and documentation workflow.', color: 'bg-violet-500' },
                { step: 3, title: 'Post-visit follow-up', desc: 'Send only approved reminders or requests and confirm each delivery state separately.', color: 'bg-emerald-500' },
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

        </div>
      </div>
    </div>
  );
}
