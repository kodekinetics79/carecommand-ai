import { Clock, Phone, TrendingUp, AlertCircle, Sparkles, Zap, ArrowRight } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import { staffMembers } from '../data/mockStaff';
import { branches } from '../data/mockClinics';

const tasks = [
  { id: 't1', title: 'Follow up: Marcus Thompson (missed call)', branch: 'Downtown', priority: 'high', due: 'Overdue', assignee: 'Aaron Mensah' },
  { id: 't2', title: 'Send reactivation message to Yuki Tanaka', branch: 'Southbank', priority: 'high', due: 'Today 3pm', assignee: 'Sara Haddad' },
  { id: 't3', title: 'Confirm Botox reorder with Allergan UK', branch: 'Downtown', priority: 'medium', due: 'Today 5pm', assignee: 'Karen Bloom' },
  { id: 't4', title: 'Review Dr. Mitchell appointment schedule gaps', branch: 'Downtown', priority: 'medium', due: 'Tomorrow', assignee: 'Tanya Obi' },
  { id: 't5', title: 'Send post-visit review request to Sophie Laurent', branch: 'Northgate', priority: 'low', due: 'Tomorrow', assignee: 'Mia Larsson' },
  { id: 't6', title: 'Assign 14 follow-up customers to coordinators', branch: 'All', priority: 'high', due: 'Overdue', assignee: 'Karen Bloom' },
];

const priorityStyles = {
  high: { dot: 'bg-red-500', badge: 'badge badge-red', border: 'border-l-red-500' },
  medium: { dot: 'bg-amber-500', badge: 'badge badge-amber', border: 'border-l-amber-500' },
  low: { dot: 'bg-[var(--b2)]', badge: 'badge badge-blue', border: 'border-l-[var(--b2)]' },
};

const avgResponse = (staffMembers.reduce((s, m) => s + m.responseTime, 0) / staffMembers.length).toFixed(1);
const avgConversion = Math.round(staffMembers.reduce((s, m) => s + m.bookingConversionRate, 0) / staffMembers.length);
const totalMissed = staffMembers.reduce((s, m) => s + m.missedCalls, 0);
const overdueCount = tasks.filter(t => t.due === 'Overdue').length;

export default function StaffWorkflow() {
  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Staff Workflow"
        subtitle="Task board, response SLA tracking, booking conversion, and AI coaching recommendations."
        badge={`${overdueCount} Overdue`}
        badgeColor="red"
        actions={
          <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition">
            <Zap className="w-4 h-4" /> Assign AI Tasks
          </button>
        }
      />

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Avg Response Time" value={`${avgResponse} min`} subtitle="Network average" icon={<Clock className="w-4 h-4" />} accent="blue" />
        <StatCard title="Booking Conversion" value={`${avgConversion}%`} subtitle="Across all staff" trend={3} icon={<TrendingUp className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Missed Calls" value={totalMissed} subtitle="This month" icon={<Phone className="w-4 h-4" />} accent="red" />
        <StatCard title="Overdue Tasks" value={overdueCount} subtitle="Need action now" icon={<AlertCircle className="w-4 h-4" />} accent="amber" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        {/* Task board */}
        <div className="space-y-4">
          <BentoCard title="Task Board" subtitle="Open tasks · All branches">
            <div className="space-y-2.5">
              {tasks.map((task) => {
                const p = priorityStyles[task.priority as keyof typeof priorityStyles];
                const isOverdue = task.due === 'Overdue';
                return (
                  <div key={task.id} className={`flex items-start gap-3 p-3.5 rounded-xl border border-l-2 transition-all ${p.border} ${isOverdue ? 'border-[var(--b1)] bg-[var(--red-soft)]' : 'border-[var(--b1)]'}`}>
                    <input type="checkbox" aria-label={`Mark task complete: ${task.title}`} className="mt-0.5 w-4 h-4 rounded border-[var(--b2)] accent-[var(--indigo)]" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-t1">{task.title}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${p.badge}`}>{task.priority}</span>
                        <span className={`text-[10px] font-semibold ${isOverdue ? 'text-red-v' : 'text-t3'}`}>{task.due}</span>
                        <span className="text-[10px] text-t3">· {task.branch} · {task.assignee}</span>
                      </div>
                    </div>
                    <button type="button" className="text-[10px] font-semibold text-indigo bg-[var(--indigo-soft)] px-2 py-1 rounded-lg hover:bg-[var(--s3)] transition-colors shrink-0">
                      Act
                    </button>
                  </div>
                );
              })}
            </div>
          </BentoCard>

          {/* Staff performance table */}
          <BentoCard title="Staff Performance Leaderboard" subtitle="Response time & conversion ranking">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--b1)]">
                    {['Staff Member', 'Branch', 'Response Time', 'Conversion', 'Missed Calls', 'Follow-up', 'Score'].map(h => (
                      <th key={h} className="text-left py-2 px-2 text-[10px] font-bold uppercase tracking-widest text-t3 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--b0)]">
                  {[...staffMembers].sort((a, b) => b.bookingConversionRate - a.bookingConversionRate).map((m) => {
                    const branch = branches.find(b => b.id === m.branchId);
                    const score = Math.round((m.bookingConversionRate * 0.4) + (m.followUpRate * 0.3) + (m.patientFeedbackScore * 10 * 0.3));
                    return (
                      <tr key={m.id} className="hover:bg-[var(--s3)] transition-colors group">
                        <td className="py-2.5 px-2">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-slate-300 to-slate-400 flex items-center justify-center text-white text-[10px] font-bold shrink-0">
                              {m.name.split(' ').map(n => n[0]).join('')}
                            </div>
                            <div>
                              <p className="text-xs font-bold text-t1 group-hover:text-indigo transition-colors">{m.name}</p>
                              <p className="text-[10px] text-t3">{m.role}</p>
                            </div>
                          </div>
                        </td>
                        <td className="py-2.5 px-2 text-xs text-t3">{branch?.name.split(' ')[0]}</td>
                        <td className={`py-2.5 px-2 text-xs font-bold ${m.responseTime > 6 ? 'text-red-v' : m.responseTime > 4 ? 'text-amber-v' : 'text-emerald-v'}`}>{m.responseTime} min</td>
                        <td className="py-2.5 px-2 text-xs font-bold text-t1">{m.bookingConversionRate}%</td>
                        <td className={`py-2.5 px-2 text-xs font-bold ${m.missedCalls > 10 ? 'text-red-v' : 'text-t2'}`}>{m.missedCalls}</td>
                        <td className="py-2.5 px-2 text-xs font-semibold text-t2">{m.followUpRate}%</td>
                        <td className="py-2.5 px-2">
                          <span className={`badge ${score >= 75 ? 'badge-emerald' : score >= 55 ? 'badge-amber' : 'badge-red'}`}>{score}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </BentoCard>
        </div>

        {/* Right sidebar */}
        <div className="space-y-4">
          {/* AI Coaching cards */}
          <BentoCard title="AI Coaching Recommendations" subtitle="For underperforming staff" headerRight={<Sparkles className="w-4 h-4 text-violet-500" />}>
            <div className="space-y-3">
              {staffMembers.filter(m => m.bookingConversionRate < 55 || m.responseTime > 6).map((m) => (
                <div key={m.id} className="p-3.5 rounded-xl border border-[var(--b1)] bg-[var(--amber-soft)]">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <p className="text-xs font-bold text-t1">{m.name}</p>
                    <span className="badge badge-amber">{m.bookingConversionRate}% conv.</span>
                  </div>
                  <div className="space-y-1 mb-3">
                    <div className="flex justify-between text-[10px] text-t3">
                      <span>Booking conversion</span><span className="font-semibold">{m.bookingConversionRate}%</span>
                    </div>
                    <ProgressBar value={m.bookingConversionRate} size="xs" />
                    <div className="flex justify-between text-[10px] text-t3">
                      <span>Response time</span><span className="font-semibold">{m.responseTime} min</span>
                    </div>
                    <ProgressBar value={Math.max(0, 100 - (m.responseTime * 10))} size="xs" />
                  </div>
                  <p className="text-[11px] text-t2 mb-2">
                    AI script: use customer name, reference their last service, and offer a specific time slot.
                  </p>
                  <button type="button" className="inline-flex items-center gap-1 text-[10px] font-semibold text-indigo hover:opacity-80">
                    <Sparkles className="w-3 h-3" /> View AI coaching script <ArrowRight className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* Workload balance */}
          <BentoCard title="Workload Balance" subtitle="Tasks pending per staff">
            <div className="space-y-3">
              {staffMembers.slice(0, 6).map((m) => (
                <div key={m.id}>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <p className="text-xs font-semibold text-t1">{m.name.split(' ')[0]}</p>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-t3">{m.tasksCompleted} done</span>
                      <span className={`text-[10px] font-bold ${m.tasksPending > 10 ? 'text-red-v' : 'text-t2'}`}>{m.tasksPending} pending</span>
                    </div>
                  </div>
                  <ProgressBar value={m.tasksCompleted} max={m.tasksCompleted + m.tasksPending} color={m.tasksPending > 10 ? 'red' : m.tasksPending > 5 ? 'amber' : 'emerald'} size="xs" />
                </div>
              ))}
            </div>
          </BentoCard>

          {/* SLA Alert */}
          <div className="rounded-2xl border border-[var(--b1)] bg-[var(--red-soft)] p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-v shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-bold text-red-v">SLA Breach Alert</p>
                <p className="text-xs text-t2 mt-0.5 leading-relaxed">Jake Williams (Westside) and Sara Haddad (Southbank) are exceeding 6-minute response time SLA. Escalate to branch manager or reassign incoming calls to AI.</p>
                <button type="button" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold badge badge-red px-3 py-1.5 rounded-lg hover:opacity-80 transition-colors">
                  <Zap className="w-3 h-3" /> Enable AI overflow routing
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
