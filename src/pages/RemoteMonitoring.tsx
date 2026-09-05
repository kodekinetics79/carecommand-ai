import { useCallback, useEffect, useRef, useState, type ElementType } from 'react';
import {
  Activity, AlertOctagon, CalendarX, WifiOff, HeartPulse, RefreshCw, TrendingUp,
  TrendingDown, Minus, Bell, ShieldCheck, Sunrise, CheckCircle2, UserPlus, Check, Stethoscope,
} from 'lucide-react';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import EmptyStatePremium from '../components/ui/EmptyStatePremium';
import { apiRequest } from '../lib/api';
import { useApiResource } from '../hooks/useApiResource';
import { useSession } from '../hooks/useSession';

// ── Types (mirror the monitoring API responses) ─────────────────────────────
interface Overview {
  summary: { readingsToday: number; openAlerts: number; criticalAlerts: number; missedReadings: number; offlineDevices: number; patientsAtRisk: number; dayDefinition?: string };
  recentReadings: { id: string; patientName: string; deviceName: string; readingType: string; value: string; unit: string | null; capturedAt: string; validationStatus: string; source: string; trend: string }[];
  deviceHealth: { id: string; name: string; deviceType: string; status: string; location: string | null; lastSeenAt: string | null; patientsMonitored: number }[];
  notifications: { id: string; recipientType: string; recipientName: string | null; patientName: string | null; channel: string; status: string; attempts: number; failureReason: string | null; consentChecked: boolean; consentResult: string | null; createdAt: string }[];
  assignableUsers: { id: string; name: string; role: string; branchId: string | null }[];
}
interface Alert {
  id: string; patientName: string; readingType: string | null; value: string | null; unit: string | null;
  severity: string; alertType: string; status: string; branchId: string | null; assignedTo: string | null; generatedReason: string | null; createdAt: string;
}
/**
 * GET /v1/monitoring/alerts answers with a page, not a bare list.
 *
 * The route orders by acuity IN THE DATABASE and then truncates, so the rows it
 * returns are the most severe ones rather than the most recent — and it reports
 * `total` precisely so this screen can say how many it is NOT showing. Reading
 * the envelope as an array threw `alerts.filter is not a function` on render,
 * which took the whole staff workspace down to a blank page; the queue is now
 * read from `items`, and truncation is stated instead of implied.
 */
interface AlertPage { items: Alert[]; total: number; limit: number; truncated: boolean }
interface RiskRow {
  patientId: string; patientName: string; riskScore: number; reasons: string[]; missedReadings: number;
  lastReadingType: string | null; lastReadingAt: string | null; assignedTo: string | null; recommendedAction: string;
}
interface Briefing {
  generatedAt: string; counts: { criticalOpen: number; missedHigh: number; offlineDevices: number };
  dayDefinition?: string;
  signals: { id: string; signalType: string; title: string; detail: string | null; severity: string; metricValue: number | null; patientName: string | null }[];
  disclaimer: string;
}
interface ClinicOption { id: string; name: string; location?: string | null }
interface MonitoringRecords {
  scope: string;
  overview: Overview;
  alerts: Alert[];
  alertTotal: { total: number; truncated: boolean };
  risk: RiskRow[];
  briefing: Briefing;
}

const SEVERITY: Record<string, string> = { critical: 'badge-red', high: 'badge-amber', warning: 'badge-blue', normal: 'badge-emerald' };
const READING_LABEL: Record<string, string> = { glucose: 'Glucose', blood_pressure: 'Blood pressure', oxygen: 'Oxygen', weight: 'Weight', temperature: 'Temperature', heart_rate: 'Heart rate', ecg: 'ECG' };
const ALERT_TYPE_LABEL: Record<string, string> = { abnormal_reading: 'Abnormal reading', missed_reading: 'Missed reading', device_offline: 'Device offline', device_error: 'Device error', trend_risk: 'Trend risk' };
const NOTIF_STATUS: Record<string, string> = { delivered: 'text-emerald-v', sent: 'text-blue-v', queued: 'text-t3', retrying: 'text-amber-v', failed: 'text-red-v' };
const SIGNAL_ICON: Record<string, ElementType> = { critical_review: Stethoscope, nurse_followup: HeartPulse, missed_high_risk: CalendarX, offline_impact: WifiOff, trending_worse: TrendingUp, rpm_opportunity: TrendingUp };

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
function TrendIcon({ trend }: { trend: string }) {
  if (trend === 'up') return <TrendingUp className="w-3.5 h-3.5 text-amber-v" aria-label="Trending up" />;
  if (trend === 'down') return <TrendingDown className="w-3.5 h-3.5 text-blue-v" aria-label="Trending down" />;
  return <Minus className="w-3.5 h-3.5 text-t3" aria-label="Flat" />;
}

function notificationStatusLabel(status: string): string {
  if (status === 'sent') return 'provider accepted';
  if (status === 'delivered') return 'delivered';
  if (status === 'queued') return 'queued';
  if (status === 'retrying') return 'retrying';
  if (status === 'failed') return 'failed';
  return status.replace(/_/g, ' ');
}

function monitoringPath(path: string, scope: string): string {
  return scope === 'all' ? path : `${path}?branchId=${encodeURIComponent(scope)}`;
}

function DataUnavailable() {
  return <div className="rounded-lg border border-dashed border-amber-200 bg-[var(--amber-soft)] px-3 py-4 text-center text-[11px] font-medium text-amber-v">Current clinic data is unavailable. Refresh before making an operational decision.</div>;
}

export default function RemoteMonitoring() {
  const { user } = useSession();
  const canManageAlerts = ['OWNER', 'ADMIN', 'MANAGER'].includes(user?.role ?? '');
  const canChooseClinic = !user?.branchId;
  const { data: clinicOptions, error: clinicError, loading: clinicsLoading, reload: reloadClinics } = useApiResource<ClinicOption, ClinicOption>('/v1/branches?limit=100', [], row => row);
  const [selectedClinicId, setSelectedClinicId] = useState<'all' | string>('all');
  const [records, setRecords] = useState<MonitoringRecords | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorState, setErrorState] = useState<{ scope: string; message: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const selectedClinicRef = useRef<string>(selectedClinicId);

  function changeClinic(nextClinicId: string) {
    // Mutation completions consult this ref before reloading. Update it in the
    // same event as the visible scope so an action started in clinic A can
    // never invalidate or overwrite clinic B's in-flight board request.
    selectedClinicRef.current = nextClinicId;
    setSelectedClinicId(nextClinicId);
  }

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setErrorState(null);
    try {
      const [o, a, r, b] = await Promise.all([
        apiRequest<Overview>(monitoringPath('/v1/monitoring/overview', selectedClinicId)),
        apiRequest<AlertPage>(monitoringPath('/v1/monitoring/alerts', selectedClinicId)),
        apiRequest<RiskRow[]>(monitoringPath('/v1/monitoring/patients-at-risk', selectedClinicId)),
        apiRequest<Briefing>(monitoringPath('/v1/monitoring/morning-briefing', selectedClinicId)),
      ]);
      if (generation !== loadGeneration.current) return;
      setRecords({
        scope: selectedClinicId,
        overview: o,
        alerts: a.items,
        alertTotal: { total: a.total, truncated: a.truncated },
        risk: r,
        briefing: b,
      });
      setActionError(null);
    } catch (e) {
      if (generation !== loadGeneration.current) return;
      setErrorState({ scope: selectedClinicId, message: e instanceof Error ? e.message : 'Failed to load monitoring data' });
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [selectedClinicId]);
  // Fetch-on-mount: load() only setState after awaits (same pattern as useApiData).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  async function act(id: string, action: 'acknowledge' | 'resolve', body?: object) {
    const actionScope = selectedClinicRef.current;
    setBusy(id);
    try {
      await apiRequest(`/v1/monitoring/alerts/${id}/${action}`, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined });
      if (selectedClinicRef.current === actionScope) await load();
    }
    catch (e) { setActionError(e instanceof Error ? e.message : 'Action failed'); }
    finally { setBusy(null); }
  }
  async function assign(id: string, assignedToUserId: string) {
    if (!assignedToUserId) return;
    const actionScope = selectedClinicRef.current;
    setBusy(id);
    try {
      await apiRequest(`/v1/monitoring/alerts/${id}/assign`, { method: 'PATCH', body: JSON.stringify({ assignedToUserId }) });
      if (selectedClinicRef.current === actionScope) await load();
    }
    catch (e) { setActionError(e instanceof Error ? e.message : 'Assign failed'); }
    finally { setBusy(null); }
  }

  const error = errorState?.scope === selectedClinicId ? errorState.message : null;
  const current = records?.scope === selectedClinicId && !error ? records : null;
  const overview = current?.overview ?? null;
  const alerts = current?.alerts ?? [];
  const alertTotal = current?.alertTotal ?? { total: 0, truncated: false };
  const risk = current?.risk ?? [];
  const briefing = current?.briefing ?? null;
  const dataLoading = !error && (loading || !current);
  const dataUnavailable = Boolean(error);
  const s = overview?.summary;
  const users = overview?.assignableUsers ?? [];
  const selectedClinic = clinicOptions.find(clinic => clinic.id === selectedClinicId);
  const scopeLabel = user?.branch?.name ?? (selectedClinicId === 'all' ? 'All clinics' : selectedClinic?.name ?? 'Selected clinic');
  const displayError = error && /403|entitle|feature|plan/i.test(error)
    ? 'Remote Monitoring is part of the Device Integration Center add-on. Contact your administrator to enable it.'
    : error;

  return (
    <div className="space-y-4 pb-6">
      {/* Toolbar */}
      <div className="cc-card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`badge inline-flex items-center gap-1 ${dataUnavailable ? 'badge-amber' : 'badge-red'}`}><AlertOctagon className="w-3 h-3" />{dataUnavailable ? 'Critical queue unavailable' : dataLoading ? 'Checking critical queue' : `${s?.criticalAlerts ?? 0} critical-priority open`}</span>
          <span className="text-[11px] font-semibold text-t3">Viewing {scopeLabel}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canChooseClinic ? (
            <label className="inline-flex items-center gap-2 text-[11px] font-semibold text-t3">
              Clinic
              <select
                aria-label="Clinic scope"
                value={selectedClinicId}
                disabled={clinicsLoading || Boolean(clinicError)}
                onChange={event => changeClinic(event.target.value)}
                className="min-w-40 rounded-lg border border-[var(--b1)] bg-white px-2.5 py-1.5 text-[12px] font-semibold text-t1 outline-none focus:border-indigo disabled:opacity-60"
              >
                <option value="all">All clinics</option>
                {clinicOptions.map(clinic => <option key={clinic.id} value={clinic.id}>{clinic.name}</option>)}
              </select>
            </label>
          ) : null}
          <button type="button" onClick={() => { reloadClinics(); void load(); }} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] bg-white px-3 py-1.5 text-[13px] font-semibold text-t1 hover:bg-[var(--s2)] transition disabled:opacity-60">
            <RefreshCw className="w-3.5 h-3.5 text-t3" /> Refresh
          </button>
        </div>
      </div>

      {(displayError || clinicError || actionError) && (
        <div role="alert" className="rounded-xl border border-amber-200 bg-[var(--amber-soft)] p-4 text-[13px] text-amber-v">
          {displayError ?? (clinicError ? 'Clinic choices could not be loaded. Refresh before relying on this operational view.' : actionError)}
        </div>
      )}

      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[11px] font-medium text-red-700">
        Not an emergency-monitoring service. Do not rely on CareCommand as the only way to detect or respond to a clinical change. Follow the clinic's approved escalation plan; for an emergency in the United States, call 911.
      </div>

      {/* 1 · KPI cards */}
      <div className="grid gap-2.5 grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard title="Readings Today" value={s?.readingsToday ?? '—'} subtitle={dataUnavailable ? 'Data unavailable' : dataLoading ? 'Loading current scope' : s?.dayDefinition ?? 'Captured'} icon={<Activity className="w-4 h-4" />} accent="blue" />
        <StatCard title="Open Alerts" value={s?.openAlerts ?? '—'} subtitle={dataUnavailable ? 'Data unavailable' : dataLoading ? 'Loading current scope' : 'Need action'} icon={<Bell className="w-4 h-4" />} accent="amber" />
        <StatCard title="Critical-Priority Alerts" value={s?.criticalAlerts ?? '—'} subtitle={dataUnavailable ? 'Data unavailable' : dataLoading ? 'Loading current scope' : 'Needs clinician review'} icon={<AlertOctagon className="w-4 h-4" />} accent="red" />
        <StatCard title="Missed Readings" value={s?.missedReadings ?? '—'} subtitle={dataUnavailable ? 'Data unavailable' : dataLoading ? 'Loading current scope' : 'Operational data gaps'} icon={<CalendarX className="w-4 h-4" />} accent="violet" />
        <StatCard title="Offline Devices" value={s?.offlineDevices ?? '—'} subtitle={dataUnavailable ? 'Data unavailable' : dataLoading ? 'Loading current scope' : 'Impacting monitoring'} icon={<WifiOff className="w-4 h-4" />} accent="cyan" />
        <StatCard title="Patients Flagged" value={s?.patientsAtRisk ?? '—'} subtitle={dataUnavailable ? 'Data unavailable' : dataLoading ? 'Loading current scope' : 'Operational review queue'} icon={<HeartPulse className="w-4 h-4" />} accent="red" />
      </div>

      {/* 7 · Morning briefing */}
      {briefing && (
        <div className="rounded-xl border border-[var(--b1)] bg-gradient-to-br from-[#F5F6FE] to-white p-5">
          <div className="flex items-center gap-2 mb-3">
            <span className="w-7 h-7 rounded-lg bg-[var(--indigo-soft)] grid place-items-center"><Sunrise className="w-4 h-4 text-indigo" /></span>
            <p className="text-[13px] font-bold text-t1">Morning Briefing</p>
            <span className="text-[11px] text-t3">· generated {relTime(briefing.generatedAt)}{briefing.dayDefinition ? ` · ${briefing.dayDefinition}` : ''}</span>
          </div>
          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {briefing.signals.map(sig => {
              const Icon = SIGNAL_ICON[sig.signalType] ?? Activity;
              const tone = sig.severity === 'critical' ? 'text-red-v' : sig.severity === 'warning' ? 'text-amber-v' : 'text-t3';
              return (
                <div key={sig.id} className="flex items-start gap-2.5 rounded-lg border border-[var(--b1)] bg-white px-3 py-2.5">
                  <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${tone}`} />
                  <div className="min-w-0">
                    <p className="text-[12.5px] font-semibold text-t1 leading-tight">{sig.title}</p>
                    {sig.detail && <p className="text-[11px] text-t3 leading-snug mt-0.5">{sig.detail}</p>}
                    {sig.patientName && <p className="text-[10.5px] text-indigo font-medium mt-0.5">{sig.patientName}</p>}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-[10.5px] text-t3 mt-3 inline-flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> {briefing.disclaimer}</p>
        </div>
      )}

      <div className="grid gap-3 xl:grid-cols-[1fr_360px] items-start">
        {/* Left column */}
        <div className="space-y-3 min-w-0">
          {/* 2 · Alert queue */}
          <BentoCard title="Alert Queue" subtitle="Threshold and workflow alerts · not diagnosis or emergency dispatch">
            {!canManageAlerts && <div className="mb-3 rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-[11px] text-t2"><span className="font-semibold">Read-only clinical view.</span> A clinic owner, administrator, or manager must acknowledge, assign, or close workflow alerts.</div>}
            {dataLoading ? <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton-line h-14 rounded-lg" />)}</div>
              : dataUnavailable ? <DataUnavailable />
              : alerts.length === 0 ? <EmptyStatePremium icon={<CheckCircle2 className="w-5 h-5" />} title="No open workflow alerts" description="No threshold, missed-reading, or device alerts were returned in the current response." />
              : (
                <div className="space-y-2">
                  {/* The route answers with open work only, ordered by acuity
                      before the row limit. Say what is off the end rather than
                      letting the list imply it is the whole queue. */}
                  {alertTotal.truncated && (
                    <p className="text-[11px] text-t3">Showing the {alerts.length} most severe of {alertTotal.total} open alerts.</p>
                  )}
                  {alerts.map(a => (
                    <div key={a.id} data-alert-id={a.id} className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`badge ${SEVERITY[a.severity] ?? 'badge'}`}>{a.severity}</span>
                            <p className="text-[13px] font-bold text-t1 truncate">{a.patientName}</p>
                            <span className="text-[11px] text-t3">{ALERT_TYPE_LABEL[a.alertType] ?? a.alertType}</span>
                          </div>
                          {a.readingType && <p className="text-[12px] text-t2 mt-0.5">{READING_LABEL[a.readingType] ?? a.readingType}: <span className="font-semibold text-t1">{a.value}{a.unit ? ` ${a.unit}` : ''}</span></p>}
                          {a.generatedReason && <p className="text-[11px] text-t3 mt-1 leading-snug">{a.generatedReason}</p>}
                          <p className="text-[10.5px] text-t3 mt-1">{relTime(a.createdAt)} · {a.assignedTo ? `assigned to ${a.assignedTo}` : 'unassigned'} · <span className="capitalize">{a.status}</span></p>
                        </div>
                      </div>
                      {canManageAlerts && <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
                        {a.status === 'open' && (
                          <button type="button" disabled={busy === a.id} onClick={() => act(a.id, 'acknowledge')} className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-t2 hover:bg-[var(--s3)] disabled:opacity-50"><Check className="w-3 h-3" /> Record acknowledged</button>
                        )}
                        <div className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] pl-1.5 pr-1 py-0.5">
                          <UserPlus className="w-3 h-3 text-t3" />
                          <select aria-label="Assign alert" disabled={busy === a.id} value="" onChange={e => assign(a.id, e.target.value)} className="bg-transparent text-[11px] font-semibold text-t2 outline-none cursor-pointer py-0.5">
                            <option value="">Assign…</option>
                            {users.filter(u => u.branchId === null || u.branchId === a.branchId).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                          </select>
                        </div>
                        <button type="button" disabled={busy === a.id} onClick={() => act(a.id, 'resolve')} className="inline-flex items-center gap-1 rounded-lg bg-[var(--indigo)] px-2.5 py-1 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50"><CheckCircle2 className="w-3 h-3" /> Close workflow alert</button>
                      </div>}
                    </div>
                  ))}
                </div>
              )}
          </BentoCard>

          {/* 3 · Live / recent readings */}
          <BentoCard title="Latest Recorded Readings" subtitle="Most recent stored device captures across monitored patients">
            {dataLoading ? <div className="skeleton-line h-40 rounded-lg" />
              : dataUnavailable ? <DataUnavailable />
              : !overview || overview.recentReadings.length === 0 ? <p className="text-xs text-t3 py-4 text-center">No readings captured yet.</p>
              : (
                <div className="overflow-x-auto rounded-xl border border-[var(--b1)]">
                  <table className="w-full border-collapse text-left">
                    <thead><tr className="bg-[var(--s2)] border-b border-[var(--b1)]">
                      <th className={thCls}>Patient</th><th className={thCls}>Reading</th><th className={thCls}>Device</th><th className={thCls}>Captured</th><th className={`${thCls} text-center`}>Trend</th>
                    </tr></thead>
                    <tbody className="divide-y divide-[var(--b1)]">
                      {overview.recentReadings.map(r => (
                        <tr key={r.id} className="hover:bg-[var(--s2)] transition-colors">
                          <td className="px-4 py-2 text-[13px] font-semibold text-t1 whitespace-nowrap">{r.patientName}</td>
                          <td className="px-4 py-2 whitespace-nowrap"><span className="text-[12px] text-t2">{READING_LABEL[r.readingType] ?? r.readingType}</span> <span className="text-[13px] font-bold text-t1">{r.value}{r.unit ? ` ${r.unit}` : ''}</span></td>
                          <td className="px-4 py-2 text-[12px] text-t3 whitespace-nowrap">{r.deviceName}</td>
                          <td className="px-4 py-2 text-[12px] text-t3 whitespace-nowrap">{relTime(r.capturedAt)}</td>
                          <td className="px-4 py-2 text-center"><TrendIcon trend={r.trend} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </BentoCard>

          {/* 4 · Patients at risk */}
          <BentoCard title="Patients Flagged for Review" subtitle="Operational priority score — not a diagnosis or clinical risk determination">
            {dataLoading ? <div className="skeleton-line h-32 rounded-lg" />
              : dataUnavailable ? <DataUnavailable />
              : risk.length === 0 ? <EmptyStatePremium icon={<HeartPulse className="w-5 h-5" />} title="No patients flagged" description="No patients with qualifying open alerts or missed-reading rules were returned." />
              : (
                <div className="space-y-2">
                  {risk.map(r => (
                    <div key={r.patientId} className="flex items-start gap-3 rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3">
                      <div className={`w-11 h-11 rounded-xl grid place-items-center shrink-0 text-[13px] font-bold ${r.riskScore >= 60 ? 'bg-red-soft text-red-v' : r.riskScore >= 30 ? 'bg-amber-soft text-amber-v' : 'bg-emerald-soft text-emerald-v'}`}>{r.riskScore}</div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-bold text-t1">{r.patientName}</p>
                        <p className="text-[11px] text-t3 leading-snug">{r.reasons.join(' · ') || 'Monitoring'}</p>
                        <p className="text-[11px] text-t2 mt-1"><span className="font-semibold text-indigo">Action:</span> {r.recommendedAction}</p>
                        <p className="text-[10.5px] text-t3 mt-0.5">{r.lastReadingType ? `Last: ${READING_LABEL[r.lastReadingType] ?? r.lastReadingType} ${relTime(r.lastReadingAt)}` : 'No recent reading'}{r.assignedTo ? ` · ${r.assignedTo}` : ' · unassigned'}{r.missedReadings > 0 ? ` · ${r.missedReadings} missed` : ''}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
          </BentoCard>
        </div>

        {/* Right column */}
        <div className="space-y-3">
          {/* 5 · Device health visibility */}
          <BentoCard title="Device Health" subtitle="Offline / error devices affecting monitoring" headerRight={<WifiOff className="w-4 h-4 text-t3" />}>
            {dataLoading ? <div className="skeleton-line h-24 rounded-lg" />
              : dataUnavailable ? <DataUnavailable />
              : !overview || overview.deviceHealth.length === 0 ? <p className="text-xs text-t3 py-4 text-center inline-flex items-center gap-1.5 w-full justify-center"><CheckCircle2 className="w-4 h-4 text-emerald-v" /> No offline or error devices were returned.</p>
              : (
                <div className="space-y-2">
                  {overview.deviceHealth.map(d => (
                    <div key={d.id} className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[12.5px] font-semibold text-t1 truncate">{d.name}</p>
                        <span className={`badge ${d.status === 'error' ? 'badge-red' : 'badge-amber'}`}>{d.status}</span>
                      </div>
                      <p className="text-[11px] text-t3 mt-1">{d.location ?? '—'} · last seen {relTime(d.lastSeenAt)}</p>
                      <p className="text-[11px] text-t2 mt-0.5">{d.patientsMonitored} patient{d.patientsMonitored === 1 ? '' : 's'} monitored</p>
                    </div>
                  ))}
                </div>
              )}
          </BentoCard>

          {/* 6 · Notification timeline */}
          <BentoCard title="Notification Timeline" subtitle="Queued, provider-accepted, delivered, and failed are distinct states" headerRight={<Bell className="w-4 h-4 text-t3" />}>
            {dataLoading ? <div className="skeleton-line h-32 rounded-lg" />
              : dataUnavailable ? <DataUnavailable />
              : !overview || overview.notifications.length === 0 ? <p className="text-xs text-t3 py-4 text-center">No notification records are available yet.</p>
              : (
                <div className="space-y-2.5">
                  <p className="text-[10.5px] font-medium text-t3">Historical delivery log · most recent record {relTime(overview.notifications[0]?.createdAt ?? null)}</p>
                  <ol className="space-y-2.5">
                    {overview.notifications.map(n => (
                    <li key={n.id} className="flex items-start gap-2.5">
                      <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${n.status === 'failed' ? 'bg-red-500' : n.status === 'queued' ? 'bg-slate-300' : n.status === 'delivered' ? 'bg-emerald-500' : 'bg-blue-500'}`} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[12px] text-t1">
                          <span className="font-semibold capitalize">{n.recipientType}</span>{n.recipientName ? ` · ${n.recipientName}` : ''}
                          <span className="text-t3"> · {n.channel.replace('_', '-')}</span>
                        </p>
                        <p className="text-[10.5px] mt-0.5">
                          <span className={`font-semibold ${NOTIF_STATUS[n.status] ?? 'text-t3'}`}>{notificationStatusLabel(n.status)}</span>
                          {n.attempts > 1 ? <span className="text-t3"> · {n.attempts} attempts</span> : ''}
                          <span className="text-t3"> · {relTime(n.createdAt)}</span>
                          {n.consentChecked && <span className="text-t3"> · consent {n.consentResult?.replace('_', ' ')}</span>}
                        </p>
                        {n.failureReason && <p className="text-[10.5px] text-red-v mt-0.5">{n.failureReason}</p>}
                      </div>
                    </li>
                    ))}
                  </ol>
                </div>
              )}
          </BentoCard>
        </div>
      </div>
    </div>
  );
}

const thCls = 'px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-t3';
