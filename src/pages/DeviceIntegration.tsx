import { useMemo, useState } from 'react';
import {
  Cpu, Plus, Wifi, WifiOff, AlertTriangle, Clock, Activity, FlaskConical,
  MonitorSmartphone, ScanLine, Radio, Watch, Plug, RefreshCw, ChevronRight, Filter,
} from 'lucide-react';
import type { ElementType } from 'react';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import EmptyStatePremium from '../components/ui/EmptyStatePremium';
import DeviceDetailDrawer from '../components/devices/DeviceDetailDrawer';
import { apiRequest } from '../lib/api';
import { useApiData } from '../hooks/useApiData';

interface Device {
  id: string; name: string; deviceType: string; vendor: string | null; model: string | null;
  serialNumber: string | null; connectionType: string; status: string; location: string | null;
  firmwareVersion: string | null; notes: string | null; lastSeenAt: string | null;
  lastTestStatus: string | null; lastTestedAt: string | null; branchId: string | null; branchName: string | null;
  /**
   * OBSERVED reachability, derived server-side on every read from the newest
   * activity. Distinct from `status`, which is a human-settable record field.
   * Rendering `status` as connectivity is what let a device last seen 71 days
   * ago sit under a green "Online" badge next to its own contradicting
   * timestamp — a clinician reading that believes a patient is being watched.
   */
  connectivity: Connectivity; lastActivityAt: string | null; offlineAfterHours: number;
}
type Connectivity = 'reporting' | 'stale' | 'never_reported' | 'error' | 'retired';
interface Branch { id: string; name: string }
interface DeviceOverview {
  summary: { total: number; reporting: number; stale: number; neverReported: number; error: number };
  devices: Device[];
  branches: Branch[];
}

const fallback: DeviceOverview = { summary: { total: 0, reporting: 0, stale: 0, neverReported: 0, error: 0 }, devices: [], branches: [] };

const TYPE_META: Record<string, { label: string; icon: ElementType }> = {
  vitals_monitor: { label: 'Vitals monitor', icon: Activity },
  lab_analyzer: { label: 'Lab analyzer', icon: FlaskConical },
  check_in_kiosk: { label: 'Check-in kiosk', icon: MonitorSmartphone },
  document_scanner: { label: 'Document scanner', icon: ScanLine },
  imaging: { label: 'Imaging', icon: Radio },
  wearable_gateway: { label: 'Wearable gateway', icon: Watch },
};
const TYPES = Object.keys(TYPE_META);
const CONNECTIONS = ['network', 'usb', 'bluetooth', 'cloud_api'];
const CONNECTION_LABEL: Record<string, string> = { network: 'Network', usb: 'USB', bluetooth: 'Bluetooth', cloud_api: 'Cloud API' };
// Every label here is a statement about what was OBSERVED, never a claim about
// a live connection. "Reporting" says data arrived recently and can be shown
// with its timestamp; "Not reporting" says it did not.
const STATUS_META: Record<Connectivity, { label: string; cls: string; icon: ElementType }> = {
  reporting: { label: 'Reporting', cls: 'badge-emerald', icon: Wifi },
  stale: { label: 'Not reporting', cls: 'badge-amber', icon: WifiOff },
  never_reported: { label: 'Never reported', cls: 'badge', icon: Clock },
  error: { label: 'Error', cls: 'badge-red', icon: AlertTriangle },
  retired: { label: 'Retired', cls: 'badge', icon: WifiOff },
};

function relTime(iso: string | null): string {
  if (!iso) return 'Never';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const emptyForm = { name: '', deviceType: 'vitals_monitor', vendor: '', model: '', serialNumber: '', connectionType: 'network', branchId: '', location: '' };

export default function DeviceIntegration() {
  const { data, loading, error, reload } = useApiData<DeviceOverview>('/v1/devices/overview', fallback);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [fBranch, setFBranch] = useState('all');
  const [fStatus, setFStatus] = useState('all');
  const [fType, setFType] = useState('all');
  const [fVendor, setFVendor] = useState('all');

  const s = data.summary;
  const vendors = useMemo(() => [...new Set(data.devices.map(d => d.vendor).filter((v): v is string => !!v))].sort(), [data.devices]);
  const filtered = useMemo(() => data.devices.filter(d =>
    (fBranch === 'all' || d.branchId === fBranch) &&
    (fStatus === 'all' || d.connectivity === fStatus) &&
    (fType === 'all' || d.deviceType === fType) &&
    (fVendor === 'all' || d.vendor === fVendor)
  ), [data.devices, fBranch, fStatus, fType, fVendor]);
  const filtersActive = [fBranch, fStatus, fType, fVendor].some(v => v !== 'all');

  async function register() {
    if (form.name.trim().length < 2) { setFormError('Device name is required.'); return; }
    setBusy('new'); setFormError(null);
    try {
      await apiRequest('/v1/devices', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.trim(), deviceType: form.deviceType, connectionType: form.connectionType,
          vendor: form.vendor.trim() || undefined, model: form.model.trim() || undefined,
          serialNumber: form.serialNumber.trim() || undefined, location: form.location.trim() || undefined,
          branchId: form.branchId || undefined,
        }),
      });
      setForm(emptyForm); setShowForm(false);
      await reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to register device');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4 pb-6">
      {/* Slim toolbar — the topbar breadcrumb carries the page title. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`badge ${s.reporting > 0 ? 'badge-emerald' : ''}`}>{s.reporting} of {s.total} reporting</span>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void reload()} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] bg-white px-3 py-1.5 text-[13px] font-semibold text-t1 hover:bg-[var(--s2)] transition">
            <RefreshCw className="w-3.5 h-3.5 text-t3" /> Refresh
          </button>
          <button type="button" onClick={() => setShowForm(v => !v)} className="inline-flex items-center gap-2 rounded-lg bg-[var(--indigo)] px-3.5 py-2 text-[13px] font-semibold text-white hover:opacity-90 transition">
            <Plus className="w-4 h-4" /> Register device
          </button>
        </div>
      </div>

      {/* KPI summary */}
      <div className="grid gap-2.5 grid-cols-2 lg:grid-cols-5">
        <StatCard title="Total Devices" value={s.total} subtitle="Registered" icon={<Cpu className="w-4 h-4" />} accent="indigo" />
        {/* Subtitles say what was measured. "Connected now" asserted a live
            link the product never tested; these describe observed activity. */}
        <StatCard title="Reporting" value={s.reporting} subtitle="Sent data recently" icon={<Wifi className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Not reporting" value={s.stale} subtitle="Silent past the threshold" icon={<WifiOff className="w-4 h-4" />} accent="blue" />
        <StatCard title="Errors" value={s.error} subtitle="Need attention" icon={<AlertTriangle className="w-4 h-4" />} accent="red" />
        <StatCard title="Never reported" value={s.neverReported} subtitle="No data yet" icon={<Clock className="w-4 h-4" />} accent="amber" />
      </div>

      {error && (
        <div className="rounded-xl border border-[var(--b1)] bg-[var(--amber-soft)] p-3 text-[13px] text-amber-v">
          {error.includes('403') || /entitle|feature|plan/i.test(error)
            ? 'Device Integration is part of your plan’s Device Integration Center add-on. Contact your administrator to enable it.'
            : error}
        </div>
      )}

      {/* Register form */}
      {showForm && (
        <div className="rounded-xl border border-[var(--b2)] bg-[var(--s2)] p-4 space-y-3">
          <p className="text-[13px] font-bold text-t1 inline-flex items-center gap-1.5"><Plug className="w-4 h-4 text-indigo" /> Register a new device</p>
          {formError && <p className="text-[12px] text-red-v">{formError}</p>}
          <div className="grid gap-2.5 sm:grid-cols-2">
            <Field label="Device name"><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Triage Vitals Monitor" className={inputCls} /></Field>
            <Field label="Type">
              <select aria-label="Device type" value={form.deviceType} onChange={e => setForm(f => ({ ...f, deviceType: e.target.value }))} className={inputCls}>
                {TYPES.map(t => <option key={t} value={t}>{TYPE_META[t].label}</option>)}
              </select>
            </Field>
            <Field label="Vendor"><input value={form.vendor} onChange={e => setForm(f => ({ ...f, vendor: e.target.value }))} placeholder="e.g. Hillrom" className={inputCls} /></Field>
            <Field label="Model"><input value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} placeholder="e.g. Connex 7100" className={inputCls} /></Field>
            <Field label="Serial number"><input value={form.serialNumber} onChange={e => setForm(f => ({ ...f, serialNumber: e.target.value }))} placeholder="Optional" className={inputCls} /></Field>
            <Field label="Connection">
              <select aria-label="Connection type" value={form.connectionType} onChange={e => setForm(f => ({ ...f, connectionType: e.target.value }))} className={inputCls}>
                {CONNECTIONS.map(c => <option key={c} value={c}>{CONNECTION_LABEL[c]}</option>)}
              </select>
            </Field>
            <Field label="Location"><input value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} placeholder="e.g. Triage Room 1" className={inputCls} /></Field>
            <Field label="Branch">
              <select aria-label="Branch" value={form.branchId} onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))} className={inputCls}>
                <option value="">Unassigned</option>
                {data.branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="flex gap-2">
            <button type="button" disabled={busy === 'new'} onClick={register} className="rounded-lg bg-[var(--indigo)] px-4 py-2 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50">{busy === 'new' ? 'Registering…' : 'Register device'}</button>
            <button type="button" onClick={() => { setShowForm(false); setFormError(null); }} className="rounded-lg border border-[var(--b1)] px-4 py-2 text-[13px] font-semibold text-t2 hover:bg-[var(--s3)]">Cancel</button>
          </div>
        </div>
      )}

      {/* Device registry table */}
      <BentoCard title="Connected Devices" subtitle="Clinical, lab, and front-desk devices integrated with this practice"
        headerRight={<span className="text-[11px] font-semibold text-t3">{filtered.length}{filtersActive ? ` of ${data.devices.length}` : ''} shown</span>}>

        {/* Filters */}
        {data.devices.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <Filter className="w-3.5 h-3.5 text-t3" aria-hidden="true" />
            <FilterSelect label="Branch" value={fBranch} onChange={setFBranch} options={[['all', 'All branches'], ...data.branches.map(b => [b.id, b.name] as [string, string])]} />
            <FilterSelect label="Status" value={fStatus} onChange={setFStatus} options={[['all', 'All statuses'], ...(Object.keys(STATUS_META) as Connectivity[]).map(s2 => [s2, STATUS_META[s2].label] as [string, string])]} />
            <FilterSelect label="Type" value={fType} onChange={setFType} options={[['all', 'All types'], ...TYPES.map(t => [t, TYPE_META[t].label] as [string, string])]} />
            <FilterSelect label="Vendor" value={fVendor} onChange={setFVendor} options={[['all', 'All vendors'], ...vendors.map(v => [v, v] as [string, string])]} />
            {filtersActive && (
              <button type="button" onClick={() => { setFBranch('all'); setFStatus('all'); setFType('all'); setFVendor('all'); }} className="text-[11px] font-semibold text-indigo hover:underline">Clear</button>
            )}
          </div>
        )}

        {loading && data.devices.length === 0 ? (
          <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton-line h-12 rounded-lg" />)}</div>
        ) : data.devices.length === 0 ? (
          <EmptyStatePremium icon={<Cpu className="w-5 h-5" />} title="No devices registered" description="Register your first clinical or front-desk device to start monitoring its connection status." />
        ) : filtered.length === 0 ? (
          <p className="text-xs text-t3 py-6 text-center">No devices match the selected filters.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-[var(--b1)]">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="bg-[var(--s2)] border-b border-[var(--b1)]">
                  <th className={thCls}>Device</th>
                  <th className={thCls}>Type</th>
                  <th className={thCls}>Connection</th>
                  <th className={thCls}>Location</th>
                  <th className={thCls}>Last seen</th>
                  <th className={thCls}>Status</th>
                  <th className={`${thCls} w-8`}><span className="sr-only">Open</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--b1)]">
                {filtered.map(d => {
                  const tm = TYPE_META[d.deviceType] ?? { label: d.deviceType, icon: Cpu };
                  const sm = STATUS_META[d.connectivity] ?? STATUS_META.never_reported;
                  const TIcon = tm.icon;
                  const SIcon = sm.icon;
                  return (
                    <tr key={d.id} onClick={() => setOpenId(d.id)} tabIndex={0}
                      onKeyDown={e => { if (e.key === 'Enter') setOpenId(d.id); }}
                      className="cursor-pointer hover:bg-[var(--s2)] focus-visible:bg-[var(--s2)] outline-none transition-colors">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="w-8 h-8 rounded-lg bg-[var(--indigo-soft)] grid place-items-center shrink-0"><TIcon className="w-4 h-4 text-indigo" /></span>
                          <div className="min-w-0">
                            <p className="text-[13px] font-semibold text-t1 truncate">{d.name}</p>
                            <p className="text-[11px] text-t3 truncate">{[d.vendor, d.model].filter(Boolean).join(' · ') || 'No model info'}{d.serialNumber ? ` · SN ${d.serialNumber}` : ''}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-[12px] text-t2 whitespace-nowrap">{tm.label}</td>
                      <td className="px-4 py-2.5 text-[12px] text-t2 whitespace-nowrap">{CONNECTION_LABEL[d.connectionType] ?? d.connectionType}</td>
                      <td className="px-4 py-2.5 text-[12px] text-t2 whitespace-nowrap">{d.branchName ? `${d.branchName}${d.location ? ' · ' : ''}` : ''}{d.location ?? (d.branchName ? '' : '—')}</td>
                      <td className="px-4 py-2.5 text-[12px] text-t3 whitespace-nowrap">{relTime(d.lastSeenAt)}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap"><span className={`badge ${sm.cls} inline-flex items-center gap-1`}><SIcon className="w-3 h-3" />{sm.label}</span></td>
                      <td className="px-4 py-2.5 text-right"><ChevronRight className="w-4 h-4 text-t3 inline" /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </BentoCard>

      {openId && <DeviceDetailDrawer deviceId={openId} onClose={() => setOpenId(null)} onChanged={() => void reload()} />}
    </div>
  );
}

const inputCls = 'w-full px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s1)] text-xs text-t1 outline-none focus:border-[var(--b3)]';
const thCls = 'px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-t3';

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <select aria-label={`Filter by ${label}`} value={value} onChange={e => onChange(e.target.value)}
      className={`rounded-lg border px-2.5 py-1.5 text-[12px] font-medium outline-none cursor-pointer transition-colors ${value !== 'all' ? 'border-[var(--indigo-mid)] bg-[var(--indigo-soft)] text-indigo' : 'border-[var(--b1)] bg-white text-t2 hover:bg-[var(--s2)]'}`}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-semibold text-t2">{label}</span>
      {children}
    </label>
  );
}
