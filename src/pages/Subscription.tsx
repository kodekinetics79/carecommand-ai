import { useCallback, useEffect, useState } from 'react';
import { CreditCard, Check, Lock, Loader2, Sparkles, Boxes } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import { useSession } from '../hooks/useSession';
import {
  subscriptionApi as api, availabilityLabel, STATUS_LABEL, STATUS_BADGE,
  type CurrentSubscription, type Entitlement, type AdminOverview, type SubscriptionRequest,
} from '../lib/subscriptions';

export default function Subscription() {
  const { user } = useSession();
  const isAdmin = !!user && ['OWNER', 'ADMIN'].includes(user.role);
  const [current, setCurrent] = useState<CurrentSubscription | null>(null);
  const [features, setFeatures] = useState<Entitlement[]>([]);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [requests, setRequests] = useState<SubscriptionRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState<string | null>(null);
  const [requestInfo, setRequestInfo] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [cur, feats] = await Promise.all([api.current(), api.features()]);
      setCurrent(cur); setFeatures(feats);
      if (isAdmin) { setOverview(await api.adminOverview().catch(() => null)); setRequests(await api.requests().catch(() => [])); }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load subscription');
    } finally { setLoading(false); }
  }, [isAdmin]);

  useEffect(() => {
    let active = true;
    (async () => { try { const [cur, feats] = await Promise.all([api.current(), api.features()]); if (!active) return; setCurrent(cur); setFeatures(feats); if (isAdmin) { setOverview(await api.adminOverview().catch(() => null)); setRequests(await api.requests().catch(() => [])); } } catch (e) { if (active) setError(e instanceof Error ? e.message : 'Failed to load'); } finally { if (active) setLoading(false); } })();
    return () => { active = false; };
  }, [isAdmin]);

  async function requestPlan(planKey: string) {
    setRequesting(planKey); setRequestInfo(null);
    try {
      const res = await api.createRequest({ planKey });
      setRequestInfo(`Request submitted (${res.requestType.toLowerCase()}). A platform operator will review it.`);
      await load();
    } catch (e) { setRequestInfo(e instanceof Error ? e.message : 'Request failed'); }
    finally { setRequesting(null); }
  }

  if (loading) return <div className="flex items-center justify-center py-24 text-sm text-t3"><Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading subscription…</div>;

  const status = current?.status ?? 'none';

  return (
    <div className="space-y-6 pb-10">
      <PageHeader
        title="Subscription & Plan"
        subtitle="Your clinic's plan, add-ons, and feature availability. Feature access is enforced by the backend, not just the UI."
        badge={STATUS_LABEL[status]}
        badgeColor={status === 'ACTIVE' ? 'emerald' : status === 'PAST_DUE' ? 'amber' : status === 'SUSPENDED' || status === 'CANCELLED' ? 'red' : 'blue'}
      />

      {error && <div className="cc-card p-4 text-sm text-red-v">{error}</div>}

      {/* Current plan */}
      <div className="cc-card p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center text-white shrink-0"><CreditCard className="w-5 h-5" /></div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-t3">Current plan</p>
            <p className="text-lg font-bold text-t1">{current?.plan?.name ?? 'No plan assigned'}</p>
            <p className="text-xs text-t3">{current?.plan?.description ?? current?.note ?? ''}</p>
          </div>
        </div>
        <span className={STATUS_BADGE[status]}>{STATUS_LABEL[status]}</span>
      </div>

      {/* Add-ons */}
      <div className="cc-card p-5 space-y-3">
        <h3 className="text-sm font-bold text-t1 inline-flex items-center gap-2"><Boxes className="w-4 h-4 text-violet-v" /> Add-ons</h3>
        {(current?.addons ?? []).filter(a => a.active).length === 0 ? (
          <p className="text-xs text-t3">No add-ons active on this plan.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {current!.addons.filter(a => a.active).map(a => (
              <span key={a.key} className="badge badge-violet inline-flex items-center gap-1"><Sparkles className="w-3 h-3" /> {a.name}{a.quantity > 1 ? ` ×${a.quantity}` : ''}</span>
            ))}
          </div>
        )}
      </div>

      {/* Feature availability matrix */}
      <div className="cc-card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-t1">Feature availability</h3>
          <div className="flex items-center gap-1.5 text-[10px] text-t3">
            <span className="badge badge-emerald">Included</span><span className="badge badge-violet">Add-on</span><span className="badge badge-amber">Usage limited</span><span className="badge badge-red">Locked</span>
          </div>
        </div>
        <div className="divide-y divide-[var(--b0)]">
          {features.map(ent => {
            const a = availabilityLabel(ent);
            return (
              <div key={ent.featureKey} className="py-2.5 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  {ent.enabled ? <Check className="w-3.5 h-3.5 text-emerald-v shrink-0" /> : <Lock className="w-3.5 h-3.5 text-red-v shrink-0" />}
                  <span className={`text-sm ${ent.enabled ? 'text-t1' : 'text-t3'}`}>{ent.label}</span>
                </div>
                <span className={a.cls}>{a.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Pending requests */}
      {isAdmin && requests.filter(r => r.status === 'PENDING').length > 0 && (
        <div className="cc-card p-5 space-y-2">
          <h3 className="text-sm font-bold text-t1">Pending plan requests</h3>
          {requests.filter(r => r.status === 'PENDING').map(r => (
            <div key={r.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--b1)] px-3 py-2">
              <span className="text-xs text-t2">{r.requestType.toLowerCase()}{r.requestedPlanKey ? ` → ${r.requestedPlanKey}` : ''}</span>
              <span className="badge badge-amber">Awaiting platform approval</span>
            </div>
          ))}
        </div>
      )}

      {/* Tenant-admin: request a plan change (no free self-upgrade) */}
      {isAdmin && overview && (
        <div className="cc-card p-5 space-y-3">
          <h3 className="text-sm font-bold text-t1">Request a plan change</h3>
          <p className="text-[11px] text-t3">{overview.note} Plan changes are submitted for platform-operator approval — they are not applied directly. Billing/checkout is not connected in this phase.</p>
          {requestInfo && <div className="rounded-xl border border-[var(--b1)] bg-[var(--blue-soft)] px-3 py-2 text-[11px] font-semibold text-blue-v">{requestInfo}</div>}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {overview.plans.map(plan => {
              const isCurrent = overview.current?.planKey === plan.key;
              return (
                <div key={plan.key} className={`rounded-2xl border p-4 ${isCurrent ? 'border-indigo bg-[var(--indigo-soft)]' : 'border-[var(--b1)]'}`}>
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-bold text-t1">{plan.name}</p>
                    {isCurrent && <span className="badge badge-indigo">Current</span>}
                  </div>
                  <p className="text-[11px] text-t3 mt-0.5 mb-2">{plan.description}</p>
                  <p className="text-[10px] text-t3 mb-3">{plan.featureKeys.length} features</p>
                  <button
                    type="button"
                    disabled={isCurrent || requesting === plan.key}
                    onClick={() => requestPlan(plan.key)}
                    className="w-full rounded-xl bg-indigo px-3 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
                  >
                    {requesting === plan.key ? 'Submitting…' : isCurrent ? 'Current plan' : 'Request this plan'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
