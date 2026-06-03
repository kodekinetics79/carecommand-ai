import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock, Phone, TrendingUp, AlertCircle, Sparkles, Zap, ArrowRight } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import { branches, staffMembers as staffFallback } from '../data/seedData';
import { apiRequest } from '../lib/api';
import { mapStaffProfile, mapStaffTask, type ApiStaffProfile, type ApiStaffTask } from '../lib/apiAdapters';
import type { StaffMember } from '../types';

type StaffView = StaffMember & { branch?: string };
type TaskView = ReturnType<typeof mapStaffTask>;

const taskFallback: Array<ApiStaffTask> = [
  { id: 't1', title: 'Follow up: Marcus Thompson (missed call)', branchId: 'b1', priority: 'high', dueAt: '2026-06-02T10:00:00Z', status: 'OPEN', branch: { name: 'Downtown Medical Centre' }, assignedTo: { displayName: 'Aaron Mensah' } },
  { id: 't2', title: 'Send reactivation message to Yuki Tanaka', branchId: 'b2', priority: 'high', dueAt: '2026-06-02T15:00:00Z', status: 'OPEN', branch: { name: 'Westside Family Clinic' }, assignedTo: { displayName: 'Sara Haddad' } },
  { id: 't3', title: 'Confirm Botox reorder with Allergan UK', branchId: 'b1', priority: 'medium', dueAt: '2026-06-02T17:00:00Z', status: 'IN_PROGRESS', branch: { name: 'Downtown Medical Centre' }, assignedTo: { displayName: 'Karen Bloom' } },
  { id: 't4', title: 'Review Dr. Mitchell appointment schedule gaps', branchId: 'b1', priority: 'medium', dueAt: '2026-06-03T10:00:00Z', status: 'OPEN', branch: { name: 'Downtown Medical Centre' }, assignedTo: { displayName: 'Tanya Obi' } },
  { id: 't5', title: 'Send post-visit review request to Sophie Laurent', branchId: 'b3', priority: 'low', dueAt: '2026-06-03T11:00:00Z', status: 'COMPLETED', branch: { name: 'Northgate Derma & Dental' }, assignedTo: { displayName: 'Mia Larsson' } },
  { id: 't6', title: 'Assign 14 follow-up customers to coordinators', branchId: 'b1', priority: 'high', dueAt: '2026-06-02T08:00:00Z', status: 'OPEN', branch: { name: 'Downtown Medical Centre' }, assignedTo: { displayName: 'Blessing Eze' } },
];

const statusStyles: Record<TaskView['status'], { label: string; badge: string; border: string }> = {
  open: { label: 'Open', badge: 'badge badge-blue', border: 'border-l-blue-500' },
  'in-progress': { label: 'In Progress', badge: 'badge badge-amber', border: 'border-l-amber-500' },
  completed: { label: 'Completed', badge: 'badge badge-emerald', border: 'border-l-emerald-500' },
  canceled: { label: 'Canceled', badge: 'badge badge-red', border: 'border-l-red-500' },
};

const priorityStyles = {
  high: { badge: 'badge badge-red', border: 'border-l-red-500' },
  medium: { badge: 'badge badge-amber', border: 'border-l-amber-500' },
  low: { badge: 'badge badge-blue', border: 'border-l-[var(--b2)]' },
};

function mapFallbackStaff(): StaffView[] {
  return staffFallback.map(member => ({
    ...member,
    branch: branches.find(branch => branch.id === member.branchId)?.name ?? 'All branches',
  }));
}

function extractRows<T>(payload: T[] | { data: T[] }) {
  return Array.isArray(payload) ? payload : payload.data;
}

export default function StaffWorkflow() {
  const navigate = useNavigate();
  const [staffRecords, setStaffRecords] = useState<StaffView[]>(mapFallbackStaff());
  const [taskRecords, setTaskRecords] = useState<TaskView[]>(taskFallback.map(mapStaffTask));
  const [source, setSource] = useState<'live' | 'demo'>('demo');

  useEffect(() => {
    let active = true;
    Promise.all([
      apiRequest<ApiStaffProfile[] | { data: ApiStaffProfile[] }>('/v1/staff/overview?limit=100'),
      apiRequest<ApiStaffTask[] | { data: ApiStaffTask[] }>('/v1/tasks?limit=100'),
    ]).then(([staffResponse, taskResponse]) => {
      if (!active) return;
      const staffRows = extractRows(staffResponse).map(row => mapStaffProfile(row));
      const tasks = extractRows(taskResponse).map(row => mapStaffTask(row));
      if (staffRows.length > 0) setStaffRecords(staffRows);
      if (tasks.length > 0) setTaskRecords(tasks);
      setSource('live');
    }).catch(() => undefined);

    return () => { active = false; };
  }, []);

  const totals = useMemo(() => {
    const avgResponse = staffRecords.length > 0 ? (staffRecords.reduce((sum, member) => sum + member.responseTime, 0) / staffRecords.length).toFixed(1) : '0.0';
    const avgConversion = staffRecords.length > 0 ? Math.round(staffRecords.reduce((sum, member) => sum + member.bookingConversionRate, 0) / staffRecords.length) : 0;
    const totalMissed = staffRecords.reduce((sum, member) => sum + member.missedCalls, 0);
    const overdueCount = taskRecords.filter(task => task.due === 'Overdue').length;
    const completedCount = taskRecords.filter(task => task.status === 'completed').length;
    return { avgResponse, avgConversion, totalMissed, overdueCount, completedCount };
  }, [staffRecords, taskRecords]);

  async function markTaskComplete(taskId: string) {
    setTaskRecords(current => current.map(task => task.id === taskId ? { ...task, status: 'completed' } : task));
    try {
      await apiRequest(`/v1/staff/tasks/${taskId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'COMPLETED' }),
      });
    } catch {
      setTaskRecords(current => current.map(task => task.id === taskId ? { ...task, status: 'open' } : task));
    }
  }

  async function markTaskInProgress(taskId: string) {
    setTaskRecords(current => current.map(task => task.id === taskId ? { ...task, status: 'in-progress' } : task));
    try {
      await apiRequest(`/v1/staff/tasks/${taskId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'IN_PROGRESS' }),
      });
    } catch {
      setTaskRecords(current => current.map(task => task.id === taskId ? { ...task, status: 'open' } : task));
    }
  }

  const underperformers = staffRecords.filter(member => member.bookingConversionRate < 55 || member.responseTime > 6);

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Staff Workflow"
        subtitle="Task board, response SLA tracking, booking conversion, and coaching recommendations."
        badge={`${totals.overdueCount} Overdue · ${source === 'live' ? 'Live DB' : 'Demo'}`}
        badgeColor="red"
        actions={
          <button type="button" onClick={() => navigate('/autopilot')} className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition">
            <Zap className="w-4 h-4" /> Assign tasks
          </button>
        }
      />

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Avg Response Time" value={`${totals.avgResponse} min`} subtitle="Network average" icon={<Clock className="w-4 h-4" />} accent="blue" />
        <StatCard title="Booking Conversion" value={`${totals.avgConversion}%`} subtitle="Across all staff" trend={3} icon={<TrendingUp className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Missed Calls" value={totals.totalMissed} subtitle="This month" icon={<Phone className="w-4 h-4" />} accent="red" />
        <StatCard title="Completed Tasks" value={totals.completedCount} subtitle="This session" icon={<AlertCircle className="w-4 h-4" />} accent="amber" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <BentoCard title="Task Board" subtitle="Open tasks · All branches">
            <div className="space-y-2.5">
              {taskRecords.map(task => {
                const priorityStyle = priorityStyles[task.priority as keyof typeof priorityStyles] ?? priorityStyles.low;
                const statusStyle = statusStyles[task.status] ?? statusStyles.open;
                const isOverdue = task.due === 'Overdue';
                return (
                  <div key={task.id} className={`flex items-start gap-3 p-3.5 rounded-xl border border-l-2 transition-all ${priorityStyle.border} ${isOverdue && task.status !== 'completed' ? 'border-[var(--b1)] bg-[var(--red-soft)]' : 'border-[var(--b1)]'}`}>
                    <input
                      type="checkbox"
                      checked={task.status === 'completed'}
                      onChange={() => void markTaskComplete(task.id)}
                      aria-label={`Mark task complete: ${task.title}`}
                      className="mt-0.5 w-4 h-4 rounded border-[var(--b2)] accent-[var(--indigo)]"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-t1">{task.title}</p>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <span className={priorityStyle.badge}>{task.priority}</span>
                        <span className={statusStyle.badge}>{statusStyle.label}</span>
                        <span className={`text-[10px] font-semibold ${isOverdue && task.status !== 'completed' ? 'text-red-v' : 'text-t3'}`}>{task.due}</span>
                        <span className="text-[10px] text-t3">· {task.branch} · {task.assignee}</span>
                      </div>
                    </div>
                    <button type="button" onClick={() => void markTaskInProgress(task.id)} className="text-[10px] font-semibold text-indigo bg-[var(--indigo-soft)] px-2 py-1 rounded-lg hover:bg-[var(--s3)] transition-colors shrink-0">
                      Act
                    </button>
                  </div>
                );
              })}
            </div>
          </BentoCard>

          <BentoCard title="Staff Performance Leaderboard" subtitle="Response time & conversion ranking">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--b1)]">
                    {['Staff Member', 'Branch', 'Response Time', 'Conversion', 'Missed Calls', 'Follow-up', 'Score'].map(header => (
                      <th key={header} className="text-left py-2 px-2 text-[10px] font-bold uppercase tracking-widest text-t3 whitespace-nowrap">{header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--b0)]">
                  {[...staffRecords].sort((a, b) => b.bookingConversionRate - a.bookingConversionRate).map(member => {
                    const branchName = member.branch ?? branches.find(branch => branch.id === member.branchId)?.name ?? 'Live branch';
                    const score = Math.round((member.bookingConversionRate * 0.4) + (member.followUpRate * 0.3) + (member.patientFeedbackScore * 10 * 0.3));
                    return (
                      <tr key={member.id} className="hover:bg-[var(--s3)] transition-colors group">
                        <td className="py-2.5 px-2">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-slate-300 to-slate-400 flex items-center justify-center text-white text-[10px] font-bold shrink-0">
                              {member.name.split(' ').map(n => n[0]).join('')}
                            </div>
                            <div>
                              <p className="text-xs font-bold text-t1 group-hover:text-indigo transition-colors">{member.name}</p>
                              <p className="text-[10px] text-t3">{member.role}</p>
                            </div>
                          </div>
                        </td>
                        <td className="py-2.5 px-2 text-xs text-t3">{branchName.split(' ')[0]}</td>
                        <td className={`py-2.5 px-2 text-xs font-bold ${member.responseTime > 6 ? 'text-red-v' : member.responseTime > 4 ? 'text-amber-v' : 'text-emerald-v'}`}>{member.responseTime} min</td>
                        <td className="py-2.5 px-2 text-xs font-bold text-t1">{member.bookingConversionRate}%</td>
                        <td className={`py-2.5 px-2 text-xs font-bold ${member.missedCalls > 10 ? 'text-red-v' : 'text-t2'}`}>{member.missedCalls}</td>
                        <td className="py-2.5 px-2 text-xs font-semibold text-t2">{member.followUpRate}%</td>
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

        <div className="space-y-4">
          <BentoCard title="Coaching Recommendations" subtitle="For underperforming staff" headerRight={<Sparkles className="w-4 h-4 text-violet-500" />}>
            <div className="space-y-3">
              {underperformers.map(member => (
                <div key={member.id} className="p-3.5 rounded-xl border border-[var(--b1)] bg-[var(--amber-soft)]">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <p className="text-xs font-bold text-t1">{member.name}</p>
                    <span className="badge badge-amber">{member.bookingConversionRate}% conv.</span>
                  </div>
                  <div className="space-y-1 mb-3">
                    <div className="flex justify-between text-[10px] text-t3">
                      <span>Booking conversion</span><span className="font-semibold">{member.bookingConversionRate}%</span>
                    </div>
                    <ProgressBar value={member.bookingConversionRate} size="xs" />
                    <div className="flex justify-between text-[10px] text-t3">
                      <span>Response time</span><span className="font-semibold">{member.responseTime} min</span>
                    </div>
                    <ProgressBar value={Math.max(0, 100 - (member.responseTime * 10))} size="xs" />
                  </div>
                  <p className="text-[11px] text-t2 mb-2">
                    Script: use customer name, reference their last service, and offer a specific time slot.
                  </p>
                  <button type="button" onClick={() => navigate('/autopilot')} className="inline-flex items-center gap-1 text-[10px] font-semibold text-indigo hover:opacity-80">
                    <Sparkles className="w-3 h-3" /> View coaching script <ArrowRight className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </BentoCard>

          <BentoCard title="Workload Balance" subtitle="Tasks pending per staff">
            <div className="space-y-3">
              {[...staffRecords].slice(0, 6).map(member => (
                <div key={member.id}>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <p className="text-xs font-semibold text-t1">{member.name.split(' ')[0]}</p>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-t3">{member.tasksCompleted} done</span>
                      <span className={`text-[10px] font-bold ${member.tasksPending > 10 ? 'text-red-v' : 'text-t2'}`}>{member.tasksPending} pending</span>
                    </div>
                  </div>
                  <ProgressBar value={member.tasksCompleted} max={member.tasksCompleted + member.tasksPending} color={member.tasksPending > 10 ? 'red' : member.tasksPending > 5 ? 'amber' : 'emerald'} size="xs" />
                </div>
              ))}
            </div>
          </BentoCard>

          <div className="rounded-2xl border border-[var(--b1)] bg-[var(--red-soft)] p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-v shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-bold text-red-v">SLA Breach Alert</p>
                <p className="text-xs text-t2 mt-0.5 leading-relaxed">
                  {underperformers.slice(0, 2).map(member => member.name).join(' and ')} are exceeding the 6-minute response-time SLA. Escalate to the branch manager or reassign incoming calls to overflow routing.
                </p>
                <button type="button" onClick={() => navigate('/ai-receptionist')} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold badge badge-red px-3 py-1.5 rounded-lg hover:opacity-80 transition-colors">
                  <Zap className="w-3 h-3" /> Enable overflow routing
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
