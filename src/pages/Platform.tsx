import { useState } from 'react';
import { ShieldAlert, KeyRound, Building2, Check, X, Loader2, Power } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import { platformConsole, type PlatformTenant, type PlatformRequest } from '../lib/platformConsole';

// Platform operator console. Separate from tenant roles: the operator pastes a
// platform token (held in memory only). Tenant users cannot use this — the
// backend rejects requests without a valid platform token. No PHI is shown.
export default function Platform() {
  const [token, setToken] = useState('');
  const [connected, setConnected] = useState(false);
  const [tenants, setTenants] = useState<PlatformTenant[]>([]);
  const [requests, setRequests] = useState<PlatformRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh(t = token) {
    setBusy(true); setError(null);
    try {
      const [ts, rs] = await Promise.all([platformConsole.tenants(t), platformConsole.requests(t, 'PENDING')]);
      setTenants(ts); setRequests(rs); setConnected(true);
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); setConnected(false); }
    finally { setBusy(false); }
  }

  async function review(id: string, decision: 'approve' | 'reject') {
    setBusy(true);
    try { await platformConsole.reviewRequest(token, id, decision); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  }

  async function toggle(tenantId: string, action: 'suspend' | 'reactivate') {
    setBusy(true);
    try { await platformConsole.setTenantStatus(token, tenantId, action); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed'); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-6 pb-10">
      <PageHeader title="Platform Control Plane" subtitle="Operator-only. Separate from tenant roles — authenticate with the platform token. No patient/PHI data is shown here." badge="Operator" badgeColor="violet" />

      <div className="cc-card p-4 flex flex-wrap items-end gap-3">
        <label className="flex-1 min-w-[260px]">
          <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-wide text-t3">Platform operator token</span>
          <div className="flex items-center gap-2 rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2">
            <KeyRound className="w-4 h-4 text-t3 shrink-0" />
            <input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="Held in memory only — never stored" className="w-full bg-transparent text-sm text-t1 outline-none placeholder:text-t3" />
          </div>
        </label>
        <button type="button" disabled={!token || busy} onClick={() => refresh()} className="rounded-xl bg-indigo px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Connect'}
        </button>
      </div>

      {error && <div className="cc-card p-4 text-sm text-red-v inline-flex items-center gap-2"><ShieldAlert className="w-4 h-4" /> {error}</div>}

      {connected && (
        <>
          <div className="cc-card p-5 space-y-3">
            <h3 className="text-sm font-bold text-t1">Pending subscription requests ({requests.length})</h3>
            {requests.length === 0 ? <p className="text-xs text-t3">No pending requests.</p> : requests.map(r => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--b1)] px-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-t1 truncate">{r.tenantName} <span className="text-[10px] text-t3">({r.slug})</span></p>
                  <p className="text-[11px] text-t3">{r.requestType.toLowerCase()}{r.requestedPlanKey ? ` → ${r.requestedPlanKey}` : ''}{r.notes ? ` · ${r.notes}` : ''}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" disabled={busy} onClick={() => review(r.id, 'approve')} className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-emerald-v hover:bg-[var(--emerald-soft)]"><Check className="w-3 h-3" /> Approve</button>
                  <button type="button" disabled={busy} onClick={() => review(r.id, 'reject')} className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-red-v hover:bg-[var(--red-soft)]"><X className="w-3 h-3" /> Reject</button>
                </div>
              </div>
            ))}
          </div>

          <div className="cc-card p-5 space-y-3">
            <h3 className="text-sm font-bold text-t1 inline-flex items-center gap-2"><Building2 className="w-4 h-4 text-indigo" /> Tenants ({tenants.length})</h3>
            <div className="divide-y divide-[var(--b0)]">
              {tenants.map(t => (
                <div key={t.tenant?.id} className="py-2.5 flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-t1 truncate">{t.tenant?.name} <span className="text-[10px] text-t3">({t.tenant?.slug})</span></p>
                    <p className="text-[11px] text-t3">{t.subscription?.planName ?? 'no plan'} · {t.activeUsers} users · {t.branches} branches · {t.enabledFeatures} features</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`badge ${t.subscription?.status === 'ACTIVE' ? 'badge-emerald' : t.subscription?.status === 'TRIAL' ? 'badge-blue' : t.subscription?.status === 'SUSPENDED' ? 'badge-red' : 'badge-amber'}`}>{t.subscription?.status ?? 'none'}</span>
                    {t.tenant && t.subscription?.status !== 'SUSPENDED' && <button type="button" disabled={busy} onClick={() => toggle(t.tenant!.id, 'suspend')} className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] px-2 py-1 text-[10px] font-semibold text-red-v hover:bg-[var(--red-soft)]"><Power className="w-3 h-3" /> Suspend</button>}
                    {t.tenant && t.subscription?.status === 'SUSPENDED' && <button type="button" disabled={busy} onClick={() => toggle(t.tenant!.id, 'reactivate')} className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] px-2 py-1 text-[10px] font-semibold text-emerald-v hover:bg-[var(--emerald-soft)]"><Power className="w-3 h-3" /> Reactivate</button>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
