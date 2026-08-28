import { useCallback, useEffect, useState, type ElementType } from 'react';
import {
  X, Cpu, Wifi, WifiOff, AlertTriangle, Clock, Activity, FlaskConical, MonitorSmartphone,
  ScanLine, Radio, Watch, CheckCircle2, Trash2, Settings, Plus, History, Save, Loader2,
} from 'lucide-react';
import { apiRequest } from '../../lib/api';

interface DeviceDetail {
  id: string; name: string; deviceType: string; vendor: string | null; model: string | null;
  serialNumber: string | null; connectionType: string; status: string; location: string | null;
  firmwareVersion: string | null; notes: string | null; lastSeenAt: string | null;
  lastTestStatus: string | null; lastTestedAt: string | null; branchId: string | null; branchName: string | null;
}
interface DeviceEvent {
  id: string; type: string; fromStatus: string | null; toStatus: string | null;
  message: string | null; actorName: string; createdAt: string;
}
interface DetailResponse { device: DeviceDetail; events: DeviceEvent[] }

const TYPE_META: Record<string, { label: string; icon: ElementType }> = {
  vitals_monitor: { label: 'Vitals monitor', icon: Activity },
  lab_analyzer: { label: 'Lab analyzer', icon: FlaskConical },
  check_in_kiosk: { label: 'Check-in kiosk', icon: MonitorSmartphone },
  document_scanner: { label: 'Document scanner', icon: ScanLine },
  imaging: { label: 'Imaging', icon: Radio },
  wearable_gateway: { label: 'Wearable gateway', icon: Watch },
};
const CONNECTION_LABEL: Record<string, string> = { network: 'Network', usb: 'USB', bluetooth: 'Bluetooth', cloud_api: 'Cloud API' };
const STATUS_META: Record<string, { label: string; cls: string; icon: ElementType }> = {
  online: { label: 'Online', cls: 'badge-emerald', icon: Wifi },
  offline: { label: 'Offline', cls: 'badge', icon: WifiOff },
  error: { label: 'Error', cls: 'badge-red', icon: AlertTriangle },
  pending: { label: 'Pending', cls: 'badge-amber', icon: Clock },
};
const EVENT_META: Record<string, { label: string; icon: ElementType; tone: string }> = {
  registered: { label: 'Registered', icon: Plus, tone: 'text-indigo' },
  status_changed: { label: 'Status changed', icon: Activity, tone: 'text-blue-v' },
  config_updated: { label: 'Config updated', icon: Settings, tone: 'text-violet-v' },
  connection_test: { label: 'Connection test', icon: CheckCircle2, tone: 'text-emerald-v' },
  deactivated: { label: 'Deactivated', icon: Trash2, tone: 'text-red-v' },
};
const STATUSES = ['online', 'offline', 'error', 'pending'];

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function relTime(iso: string | null): string {
  if (!iso) return 'Never';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function DeviceDetailDrawer({ deviceId, onClose, onChanged }: { deviceId: string; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [firmware, setFirmware] = useState('');
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await apiRequest<DetailResponse>(`/v1/devices/${deviceId}`);
      setDetail(res);
      setNotes(res.device.notes ?? '');
      setFirmware(res.device.firmwareVersion ?? '');
      setStatus(res.device.status);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load device');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    // Fetch-on-mount: load() only setStates after an await (same pattern as useApiData).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const d = detail?.device;
  const dirty = !!d && (notes !== (d.notes ?? '') || firmware !== (d.firmwareVersion ?? '') || status !== d.status);

  async function saveConfig() {
    if (!d || !dirty) return;
    setBusy('save'); setError(null);
    try {
      await apiRequest(`/v1/devices/${deviceId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          notes: notes.trim() || null,
          firmwareVersion: firmware.trim() || null,
          ...(status !== d.status ? { status } : {}),
        }),
      });
      await load(); onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to save'); }
    finally { setBusy(null); }
  }
  async function testConnection() {
    setBusy('test'); setError(null);
    try { await apiRequest(`/v1/devices/${deviceId}/test`, { method: 'POST' }); await load(); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Test failed'); }
    finally { setBusy(null); }
  }
  async function deactivate() {
    setBusy('delete');
    try { await apiRequest(`/v1/devices/${deviceId}`, { method: 'DELETE' }); onChanged(); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to deactivate'); setBusy(null); }
  }

  const TIcon = d ? (TYPE_META[d.deviceType]?.icon ?? Cpu) : Cpu;
  const sm = d ? (STATUS_META[d.status] ?? STATUS_META.pending) : STATUS_META.pending;
  const SIcon = sm.icon;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Device details">
      <button type="button" aria-label="Close panel" onClick={onClose} className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-fade-in" />
      <div className="relative w-full max-w-md glass-surface h-full overflow-y-auto animate-fade-up flex flex-col">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 px-5 py-4 border-b border-[var(--b1)] glass-surface-head">
          <div className="flex items-center gap-3 min-w-0">
            <span className="w-10 h-10 rounded-xl bg-[var(--indigo-soft)] grid place-items-center shrink-0"><TIcon className="w-5 h-5 text-indigo" /></span>
            <div className="min-w-0">
              <p className="text-base font-bold text-t1 leading-tight truncate">{d?.name ?? 'Device'}</p>
              <p className="text-[11px] text-t3">{d ? (TYPE_META[d.deviceType]?.label ?? d.deviceType) : ''}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-t3 hover:text-t1 shrink-0"><X className="w-5 h-5" /></button>
        </header>

        {loading ? (
          <div className="p-5 space-y-3">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton-line h-10 rounded-lg" />)}</div>
        ) : !d ? (
          <div className="p-5 text-sm text-red-v">{error ?? 'Device not found'}</div>
        ) : (
          <div className="p-5 space-y-4 flex-1">
            {error && <p className="text-[12px] text-red-v">{error}</p>}

            {/* Status + readiness */}
            <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3.5">
              <div>
                <p className="text-[10px] uppercase tracking-wide text-t3 font-semibold mb-1">Current status</p>
                <span className={`badge ${sm.cls} inline-flex items-center gap-1`}><SIcon className="w-3 h-3" />{sm.label}</span>
              </div>
              <div className="text-right">
                <p className="text-[10px] uppercase tracking-wide text-t3 font-semibold mb-1">Last readiness test</p>
                <p className="text-[12px] font-semibold text-t1">{d.lastTestStatus ? `${d.lastTestStatus === 'passed' ? 'Passed' : 'Failed'} · ${relTime(d.lastTestedAt)}` : 'Never run'}</p>
              </div>
            </div>

            {/* Detail grid */}
            <div className="rounded-xl border border-[var(--b1)] divide-y divide-[var(--b1)]">
              <Row label="Vendor / Model" value={[d.vendor, d.model].filter(Boolean).join(' · ') || '—'} />
              <Row label="Serial number" value={d.serialNumber ?? '—'} mono />
              <Row label="Connection method" value={CONNECTION_LABEL[d.connectionType] ?? d.connectionType} />
              <Row label="Branch" value={d.branchName ?? 'Unassigned'} />
              <Row label="Location" value={d.location ?? '—'} />
              <Row label="Last seen" value={d.lastSeenAt ? `${fmt(d.lastSeenAt)} (${relTime(d.lastSeenAt)})` : 'Never'} />
            </div>

            {/* Config */}
            <div className="space-y-2.5">
              <p className="text-[11px] font-bold uppercase tracking-wide text-t3">Configuration</p>
              <label className="block space-y-1">
                <span className="text-[11px] font-semibold text-t2">Firmware version</span>
                <input value={firmware} onChange={e => setFirmware(e.target.value)} placeholder="e.g. 2.41.00" className={inputCls} />
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] font-semibold text-t2">Status</span>
                <select aria-label="Device status" value={status} onChange={e => setStatus(e.target.value)} className={inputCls}>
                  {STATUSES.map(s => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] font-semibold text-t2">Notes</span>
                <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Maintenance notes, integration details…" rows={3} className={`${inputCls} resize-none`} />
              </label>
              <button type="button" disabled={!dirty || busy === 'save'} onClick={saveConfig}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-3.5 py-2 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-40">
                {busy === 'save' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save configuration
              </button>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2">
              <button type="button" disabled={busy === 'test'} onClick={testConnection}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] bg-white px-3 py-2 text-[13px] font-semibold text-t1 hover:bg-[var(--s2)] disabled:opacity-50">
                {busy === 'test' ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4 text-emerald-v" />} Run readiness check
              </button>
              <button type="button" disabled={busy === 'delete'} onClick={deactivate}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-3 py-2 text-[13px] font-semibold text-t2 hover:text-red-v hover:border-red-v/30 disabled:opacity-50">
                <Trash2 className="w-4 h-4" /> Deactivate
              </button>
            </div>
            <p className="text-[10.5px] text-t3 leading-relaxed">Connection testing is a local readiness check. Live telemetry activates once an HL7 / DICOM / MQTT or vendor integration is configured.</p>

            {/* Timeline */}
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wide text-t3 mb-2 inline-flex items-center gap-1.5"><History className="w-3.5 h-3.5" /> Status &amp; audit timeline</p>
              {detail.events.length === 0 ? (
                <p className="text-xs text-t3">No events recorded yet.</p>
              ) : (
                <ol className="relative border-l border-[var(--b1)] ml-1.5 space-y-3">
                  {detail.events.map(ev => {
                    const em = EVENT_META[ev.type] ?? { label: ev.type, icon: Activity, tone: 'text-t3' };
                    const EIcon = em.icon;
                    return (
                      <li key={ev.id} className="ml-4">
                        <span className="absolute -left-[7px] w-3.5 h-3.5 rounded-full bg-white border border-[var(--b2)] grid place-items-center">
                          <EIcon className={`w-2 h-2 ${em.tone}`} />
                        </span>
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-[12px] font-semibold text-t1">{em.label}</p>
                          <p className="text-[10px] text-t3 shrink-0">{relTime(ev.createdAt)}</p>
                        </div>
                        {ev.message && <p className="text-[11px] text-t2 mt-0.5">{ev.message}</p>}
                        {(ev.fromStatus || ev.toStatus) && (
                          <p className="text-[10.5px] text-t3 mt-0.5">{ev.fromStatus ?? '—'} → {ev.toStatus ?? '—'}</p>
                        )}
                        <p className="text-[10px] text-t3 mt-0.5">{ev.actorName} · {fmt(ev.createdAt)}</p>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const inputCls = 'w-full px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s1)] text-xs text-t1 outline-none focus:border-[var(--b3)]';

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
      <span className="text-[11px] font-semibold text-t3">{label}</span>
      <span className={`text-[12px] text-t1 text-right ${mono ? 'font-mono' : 'font-medium'}`}>{value}</span>
    </div>
  );
}
