import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, RefreshCw, Loader2, Check, Settings2, Activity, Cpu } from 'lucide-react';
import BentoCard from '../components/ui/BentoCard';
import { apiRequest } from '../lib/api';

interface ConfigField { key: string; label: string; secret: boolean; required: boolean }
interface Provider {
  key: string; displayName: string; category: string; supportsSandbox: boolean; supportsWebhook?: boolean; note: string;
  configFields: ConfigField[]; status: string; mode: string; configured: boolean;
  lastHealthCheckAt: string | null; lastHealthStatus: string | null; healthMessage: string | null; lastSyncAt?: string | null;
}

const STATUS_BADGE: Record<string, string> = { ACTIVE: 'badge-emerald', SANDBOX: 'badge-blue', NOT_CONFIGURED: 'badge', ERROR: 'badge-red', DISABLED: 'badge' };
const STATUS_LABEL: Record<string, string> = { ACTIVE: 'Active', SANDBOX: 'Sandbox', NOT_CONFIGURED: 'Not configured', ERROR: 'Error', DISABLED: 'Disabled' };
const CATEGORY_LABEL: Record<string, string> = { INSURANCE: 'Insurance', DIRECT_API: 'Direct API', AGGREGATOR: 'Aggregator', RPM_VENDOR: 'RPM vendor', MANUAL: 'Manual' };

function relTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export default function IntegrationSetup() {
  const [insurance, setInsurance] = useState<Provider[]>([]);
  const [devices, setDevices] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [ins, dev] = await Promise.all([
        apiRequest<Provider[]>('/v1/insurance/providers'),
        apiRequest<Provider[]>('/v1/devices/providers'),
      ]);
      setInsurance(ins); setDevices(dev); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load providers'); }
    finally { setLoading(false); }
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4 pb-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-t3">Configure connected-care providers. Secret values are stored using application encryption and are not displayed again in this form. Deployment owners must separately verify encryption-key custody and access.</p>
        <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] bg-white px-3 py-1.5 text-[13px] font-semibold text-t1 hover:bg-[var(--s2)] transition">
          <RefreshCw className="w-3.5 h-3.5 text-t3" /> Refresh
        </button>
      </div>

      {error && <div role="alert" className="rounded-xl border border-[var(--b1)] bg-[var(--amber-soft)] p-3 text-[13px] text-amber-v">{error}</div>}

      <BentoCard title="Insurance Eligibility Providers" subtitle="270/271 eligibility through a configured provider; sandbox mode is supported" headerRight={<ShieldCheck className="w-4 h-4 text-t3" />}>
        {loading ? <SkeletonRows /> : <div className="space-y-2.5">{insurance.map(p => <ProviderRow key={p.key} p={p} kind="insurance" onChanged={load} />)}</div>}
      </BentoCard>

      <BentoCard title="Device & RPM Providers" subtitle="Direct-API, aggregator, and RPM-vendor integrations" headerRight={<Cpu className="w-4 h-4 text-t3" />}>
        {loading ? <SkeletonRows /> : <div className="space-y-2.5">{devices.map(p => <ProviderRow key={p.key} p={p} kind="devices" onChanged={load} />)}</div>}
      </BentoCard>
    </div>
  );
}

function SkeletonRows() {
  return <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="skeleton-line h-16 rounded-lg" />)}</div>;
}

function ProviderRow({ p, kind, onChanged }: { p: Provider; kind: 'insurance' | 'devices'; onChanged: () => Promise<void> }) {
  const base = kind === 'insurance' ? '/v1/insurance/providers' : '/v1/devices/providers';
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState(p.mode);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function configure() {
    setBusy('save'); setMsg(null);
    try {
      await apiRequest(`${base}/${p.key}/configure`, { method: 'POST', body: JSON.stringify({ mode, config }) });
      setOpen(false); setConfig({}); await onChanged();
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Configure failed'); }
    finally { setBusy(null); }
  }
  async function healthCheck() {
    setBusy('health'); setMsg(null);
    try { await apiRequest(`${base}/${p.key}/health-check`, { method: 'POST' }); await onChanged(); }
    catch (e) { setMsg(e instanceof Error ? e.message : 'Health check failed'); }
    finally { setBusy(null); }
  }

  return (
    <div className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[13px] font-bold text-t1">{p.displayName}</p>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-t3 bg-[var(--s3)] rounded px-1.5 py-0.5">{CATEGORY_LABEL[p.category] ?? p.category}</span>
            <span className={`badge ${STATUS_BADGE[p.status] ?? 'badge'}`}>{STATUS_LABEL[p.status] ?? p.status}</span>
            {p.status !== 'NOT_CONFIGURED' && <span className="text-[10.5px] text-t3">· {p.mode}</span>}
          </div>
          <p className="text-[11.5px] text-t3 mt-1 leading-snug max-w-2xl">{p.note}</p>
          {p.lastHealthCheckAt && (
            <p className="text-[10.5px] mt-1">
              <span className={p.lastHealthStatus === 'healthy' ? 'text-emerald-v' : 'text-red-v'}>Health: {p.lastHealthStatus}</span>
              <span className="text-t3"> · {p.healthMessage} · checked {relTime(p.lastHealthCheckAt)}</span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {p.configFields.length > 0 && (
            <button type="button" onClick={() => setOpen(v => !v)} className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-t2 hover:bg-[var(--s3)]"><Settings2 className="w-3 h-3" /> Configure</button>
          )}
          <button type="button" disabled={busy === 'health'} onClick={healthCheck} className="inline-flex items-center gap-1 rounded-lg bg-[var(--indigo)] px-2.5 py-1 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
            {busy === 'health' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Activity className="w-3 h-3" />} Health check
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-3 rounded-lg border border-[var(--b2)] bg-[var(--s2)] p-3 space-y-2.5">
          {p.supportsSandbox && (
            <label className="flex items-center gap-2 text-[12px] text-t2">
              <span className="font-semibold">Mode</span>
              <select aria-label="Provider mode" value={mode} onChange={e => setMode(e.target.value)} className={inputCls + ' w-36'}>
                <option value="sandbox">Sandbox</option>
                <option value="production">Production</option>
              </select>
            </label>
          )}
          {p.configFields.map(f => (
            <label key={f.key} className="block space-y-1">
              <span className="text-[11px] font-semibold text-t2">{f.label}{f.required ? ' *' : ''}</span>
              <input type={f.secret ? 'password' : 'text'} value={config[f.key] ?? ''} onChange={e => setConfig(c => ({ ...c, [f.key]: e.target.value }))}
                placeholder={f.secret ? '••••••••' : ''} autoComplete="off" className={inputCls} />
            </label>
          ))}
          {p.key === 'stedi' && mode === 'sandbox' && <p className="text-[11px] text-t3">Sandbox needs no key — leave blank to enable the deterministic Stedi sandbox.</p>}
          {msg && <p className="text-[11px] text-red-v">{msg}</p>}
          <div className="flex gap-2">
            <button type="button" disabled={busy === 'save'} onClick={configure} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50">{busy === 'save' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Save</button>
            <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-[12px] font-semibold text-t2 hover:bg-[var(--s3)]">Cancel</button>
          </div>
        </div>
      )}
      {msg && !open && <p className="text-[11px] text-red-v mt-2">{msg}</p>}
    </div>
  );
}

const inputCls = 'w-full px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s1)] text-xs text-t1 outline-none focus:border-[var(--b3)]';
