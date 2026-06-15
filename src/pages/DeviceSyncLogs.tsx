import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, X, FileJson, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import type { ElementType } from 'react';
import BentoCard from '../components/ui/BentoCard';
import EmptyStatePremium from '../components/ui/EmptyStatePremium';
import { apiRequest } from '../lib/api';

interface SyncLog {
  id: string; providerKind: string; providerKey: string; direction: string; event: string; status: string;
  httpStatus: number | null; signatureValid: boolean | null; readingsIngested: number; alertsCreated: number; message: string | null; createdAt: string;
}
interface SyncLogDetail extends SyncLog { payload: unknown }

const STATUS_META: Record<string, { cls: string; icon: ElementType }> = {
  processed: { cls: 'badge-emerald', icon: CheckCircle2 },
  received: { cls: 'badge-blue', icon: CheckCircle2 },
  error: { cls: 'badge-red', icon: XCircle },
  rejected: { cls: 'badge-red', icon: AlertTriangle },
};
function fmt(iso: string): string { return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

export default function DeviceSyncLogs() {
  const [rows, setRows] = useState<SyncLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<SyncLogDetail | null>(null);

  const load = useCallback(async () => {
    try { setRows(await apiRequest<SyncLog[]>('/v1/connected-care/sync-logs')); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to load sync logs'); }
    finally { setLoading(false); }
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  async function viewRaw(id: string) {
    try { setDetail(await apiRequest<SyncLogDetail>(`/v1/connected-care/sync-logs/${id}`)); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to load raw payload'); }
  }

  return (
    <div className="space-y-4 pb-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-t3">Every inbound provider event — webhooks, syncs, and health checks — is logged here.</p>
        <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] bg-white px-3 py-1.5 text-[13px] font-semibold text-t1 hover:bg-[var(--s2)] transition"><RefreshCw className="w-3.5 h-3.5 text-t3" /> Refresh</button>
      </div>
      {error && <div className="rounded-xl border border-[var(--b1)] bg-[var(--amber-soft)] p-3 text-[13px] text-amber-v">{error}</div>}

      <BentoCard title="Provider Sync Logs" subtitle="Inbound event log · click a row to view the raw payload">
        {loading ? <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton-line h-11 rounded-lg" />)}</div>
          : rows.length === 0 ? <EmptyStatePremium icon={<FileJson className="w-5 h-5" />} title="No sync events yet" description="Inbound provider webhooks and syncs will appear here once a provider sends data." />
          : (
            <div className="overflow-x-auto rounded-xl border border-[var(--b1)]">
              <table className="w-full border-collapse text-left">
                <thead><tr className="bg-[var(--s2)] border-b border-[var(--b1)]"><th className={thCls}>Provider</th><th className={thCls}>Event</th><th className={thCls}>Status</th><th className={thCls}>Signature</th><th className={`${thCls} text-right`}>Readings</th><th className={`${thCls} text-right`}>Alerts</th><th className={thCls}>When</th><th className={thCls} /></tr></thead>
                <tbody className="divide-y divide-[var(--b1)]">
                  {rows.map(r => {
                    const meta = STATUS_META[r.status] ?? STATUS_META.error;
                    const SIcon = meta.icon;
                    return (
                      <tr key={r.id} onClick={() => viewRaw(r.id)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') viewRaw(r.id); }} className="cursor-pointer hover:bg-[var(--s2)] focus-visible:bg-[var(--s2)] outline-none transition-colors">
                        <td className="px-4 py-2 text-[12px] font-semibold text-t1 capitalize whitespace-nowrap">{r.providerKey}</td>
                        <td className="px-4 py-2 text-[12px] text-t2 whitespace-nowrap">{r.event}</td>
                        <td className="px-4 py-2 whitespace-nowrap"><span className={`badge ${meta.cls} inline-flex items-center gap-1`}><SIcon className="w-3 h-3" />{r.status}</span></td>
                        <td className="px-4 py-2 text-[12px] whitespace-nowrap">{r.signatureValid === null ? <span className="text-t3">n/a</span> : r.signatureValid ? <span className="text-emerald-v">valid</span> : <span className="text-red-v">invalid</span>}</td>
                        <td className="px-4 py-2 text-right text-[12px] text-t1 tabular-nums">{r.readingsIngested}</td>
                        <td className="px-4 py-2 text-right text-[12px] text-t1 tabular-nums">{r.alertsCreated}</td>
                        <td className="px-4 py-2 text-[12px] text-t3 whitespace-nowrap">{fmt(r.createdAt)}</td>
                        <td className="px-4 py-2 text-right"><FileJson className="w-4 h-4 text-t3 inline" /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
      </BentoCard>

      {detail && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Raw sync payload">
          <button type="button" aria-label="Close" onClick={() => setDetail(null)} className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-fade-in" />
          <div className="relative w-full max-w-lg glass-surface h-full overflow-y-auto animate-fade-up flex flex-col">
            <header className="sticky top-0 z-10 flex items-start justify-between gap-3 px-5 py-4 border-b border-[var(--b1)] glass-surface-head">
              <div><p className="text-base font-bold text-t1 capitalize">{detail.providerKey} · {detail.event}</p><p className="text-[11px] text-t3">{fmt(detail.createdAt)} · {detail.message}</p></div>
              <button type="button" onClick={() => setDetail(null)} aria-label="Close" className="text-t3 hover:text-t1"><X className="w-5 h-5" /></button>
            </header>
            <div className="p-5 space-y-3">
              <div className="grid grid-cols-2 gap-2 text-[12px]">
                <Info label="Status" value={detail.status} /><Info label="HTTP" value={String(detail.httpStatus ?? '—')} />
                <Info label="Signature" value={detail.signatureValid === null ? 'n/a' : detail.signatureValid ? 'valid' : 'invalid'} /><Info label="Readings" value={String(detail.readingsIngested)} />
              </div>
              <p className="text-[11px] font-bold uppercase tracking-wide text-t3 inline-flex items-center gap-1.5"><FileJson className="w-3.5 h-3.5" /> Raw payload</p>
              <pre className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] p-3 text-[11px] text-t1 overflow-x-auto font-mono leading-relaxed">{JSON.stringify(detail.payload ?? {}, null, 2)}</pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const thCls = 'px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-t3';
function Info({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-2.5 py-1.5"><p className="text-[10px] uppercase tracking-wide text-t3">{label}</p><p className="text-[12px] font-semibold text-t1">{value}</p></div>;
}
