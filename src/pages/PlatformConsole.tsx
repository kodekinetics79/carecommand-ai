import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  ShieldCheck, Loader2, LogOut, Building2, FileCheck2, Users2, ScrollText, Ban, Play,
  Search, CircleCheck, CircleSlash, Clock3, UserCog, Activity, ChevronRight, ChevronDown,
  Database, Server, Wifi, SlidersHorizontal, RefreshCw, LayoutDashboard, CreditCard, Cpu,
  HardDrive, Lock, Plug, Megaphone, Settings, Gauge, X, Crown, Receipt, Download, Plus, Upload,
} from 'lucide-react';
import {
  platformAdmin, setPlatformToken, downloadAuditCsv, TENANT_STATUS_BADGE, SUB_STATUS_BADGE, FEATURE_LABELS,
  type PlatformMe, type TenantSummary, type SystemHealth, type TenantBilling, type AiUsageView, type SecurityView, type IntegrationView,
  type TenantAccountRecord, type TenantCompany, type TenantRoster,
  type PlatformSettings, type PlatformSettingPreset, type UsageLimitRow,
} from '../lib/platformAdmin';
import PlatformPilot from './PlatformPilot';

type Overview = { tenants: number; activeTenants: number; suspendedTenants: number; pendingRequests: number; platformUsers: number };

type SectionId =
  | 'overview' | 'tenants' | 'pilot' | 'requests' | 'plans' | 'entitlements' | 'billing' | 'ai_usage'
  | 'device_usage' | 'operators' | 'security' | 'integrations' | 'health' | 'audit'
  | 'announcements' | 'settings' | 'account';

interface SectionDef { id: SectionId; label: string; icon: React.ElementType; group: string; live: boolean; premium?: boolean }
const SECTIONS: SectionDef[] = [
  { id: 'overview', label: 'Platform Overview', icon: LayoutDashboard, group: 'Operations', live: true },
  { id: 'tenants', label: 'Tenants', icon: Building2, group: 'Operations', live: true },
  { id: 'pilot', label: 'Pilot Launchpad', icon: Upload, group: 'Operations', live: true },
  { id: 'requests', label: 'Subscription Requests', icon: FileCheck2, group: 'Operations', live: true },
  { id: 'plans', label: 'Plans & Pricing', icon: Receipt, group: 'Commercial', live: true },
  { id: 'entitlements', label: 'Feature Entitlements', icon: SlidersHorizontal, group: 'Commercial', live: true },
  { id: 'billing', label: 'Billing & Invoices', icon: CreditCard, group: 'Commercial', live: true, premium: true },
  { id: 'ai_usage', label: 'AI Usage & Limits', icon: Cpu, group: 'Usage', live: true, premium: true },
  { id: 'device_usage', label: 'Device Usage', icon: HardDrive, group: 'Usage', live: true, premium: true },
  { id: 'operators', label: 'Platform Operators', icon: Users2, group: 'Governance', live: true },
  { id: 'security', label: 'Security & Access', icon: Lock, group: 'Governance', live: true, premium: true },
  { id: 'integrations', label: 'Integrations', icon: Plug, group: 'Governance', live: true },
  { id: 'health', label: 'System Health', icon: Gauge, group: 'Platform', live: true },
  { id: 'audit', label: 'Audit Logs', icon: ScrollText, group: 'Platform', live: true },
  { id: 'announcements', label: 'Announcements', icon: Megaphone, group: 'Platform', live: true },
  { id: 'settings', label: 'Platform Settings', icon: Settings, group: 'Platform', live: true },
  { id: 'account', label: 'My Account', icon: UserCog, group: 'Platform', live: true },
];

export default function PlatformConsole() {
  const navigate = useNavigate();
  const [me, setMe] = useState<PlatformMe | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState<SectionId>('overview');
  const [drawerTenant, setDrawerTenant] = useState<TenantSummary | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [m, o] = await Promise.all([platformAdmin.me(), platformAdmin.overview().catch(() => null)]);
        if (!active) return;
        setMe(m); setOverview(o);
      } catch {
        navigate('/platform/login');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [navigate]);

  async function logout() { try { await platformAdmin.logout(); } catch { /* ignore */ } setPlatformToken(null); navigate('/platform/login'); }

  if (loading) return <div className="min-h-screen grid place-items-center bg-[var(--bg)]"><Loader2 className="w-6 h-6 animate-spin text-indigo" /></div>;

  const canManage = me?.role === 'PLATFORM_OWNER' || me?.role === 'PLATFORM_ADMIN';
  const initials = (me?.name ?? 'OP').split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();
  const groups = Array.from(new Set(SECTIONS.map(s => s.group)));
  const active = SECTIONS.find(s => s.id === section)!;
  const openTenant = (t: TenantSummary) => setDrawerTenant(t);

  return (
    <div className="min-h-screen bg-[var(--bg)] flex">
      {/* ── Control Tower nav ──────────────────────────────── */}
      <aside className="platform-tower-nav hidden lg:flex flex-col w-60 shrink-0 sticky top-0 h-screen overflow-y-auto">
        <div className="flex items-center gap-2.5 px-4 h-14 border-b border-[var(--b1)] shrink-0">
          <div className="w-8 h-8 rounded-lg bg-[var(--indigo-soft)] ring-1 ring-[var(--indigo-mid)] grid place-items-center"><ShieldCheck className="w-4 h-4 text-indigo" /></div>
          <div className="leading-tight">
            <p className="text-[13px] font-bold text-t1 tracking-tight">Control Tower</p>
            <p className="text-[9px] text-t3 font-semibold uppercase tracking-wider">Superadmin</p>
          </div>
        </div>
        <nav className="flex-1 px-2 py-3 space-y-3">
          {groups.map(g => (
            <div key={g}>
              <p className="px-2.5 mb-1 text-[9px] font-bold uppercase tracking-wider text-t3">{g}</p>
              {SECTIONS.filter(s => s.group === g).map(s => {
                const on = s.id === section;
                const badge = s.id === 'requests' ? (overview?.pendingRequests || 0) : 0;
                return (
                  <button key={s.id} type="button" onClick={() => setSection(s.id)}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[12.5px] font-medium transition-colors ${on ? 'bg-[var(--indigo-soft)] text-indigo' : 'text-t2 hover:bg-[var(--s3)] hover:text-t1'}`}>
                    <s.icon className="w-4 h-4 shrink-0" />
                    <span className="flex-1 text-left truncate">{s.label}</span>
                    {s.premium && <Crown className="w-3 h-3 text-[var(--gold-ink)] shrink-0" />}
                    {badge > 0 && <span className="min-w-4 h-4 px-1 grid place-items-center rounded-full bg-[var(--red)] text-[9px] font-bold text-white">{badge}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="px-3 py-3 border-t border-[var(--b1)] flex items-center gap-2 shrink-0">
          <div className="w-8 h-8 rounded-full logo-user grid place-items-center text-[11px] font-bold text-white">{initials}</div>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="text-[12px] font-semibold text-t1 truncate">{me?.name}</p>
            <p className="text-[10px] text-t3 truncate">{me?.role?.replace('PLATFORM_', '')}</p>
          </div>
          <button type="button" onClick={logout} title="Sign out" className="text-t3 hover:text-t1"><LogOut className="w-4 h-4" /></button>
        </div>
      </aside>

      {/* ── Main column ────────────────────────────────────── */}
      <div className="flex-1 min-w-0">
        <header className="platform-topbar sticky top-0 z-20 border-b border-[var(--b1)] px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <active.icon className="w-4 h-4 text-indigo shrink-0" />
            <h1 className="text-sm font-bold text-t1 truncate">{active.label}</h1>
            {active.premium && <span className="badge badge-gold">Premium</span>}
          </div>
          {/* mobile section select */}
          <select aria-label="Section" value={section} onChange={e => setSection(e.target.value as SectionId)} className="lg:hidden rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-2 py-1 text-xs">
            {SECTIONS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </header>

        <div className="max-w-6xl mx-auto px-6 py-6 space-y-6 animate-fade-up">
          {section === 'overview' && <OverviewSection overview={overview} onGo={setSection} />}
          {section === 'tenants' && <TenantsTab canManage={canManage} onOpenTenant={openTenant} />}
          {section === 'pilot' && <PlatformPilot />}
          {section === 'requests' && <RequestsTab />}
          {section === 'plans' && <PlansSection canManage={canManage} />}
          {section === 'entitlements' && <TenantPicker title="Feature entitlements" subtitle={`Open a tenant to toggle any of the ${Object.keys(FEATURE_LABELS).length} premium features (platform override)`} hint="features" onOpenTenant={openTenant} />}
          {section === 'operators' && <UsersTab canManage={canManage} />}
          {section === 'health' && <SystemStatus expanded />}
          {section === 'audit' && <AuditTab />}
          {section === 'billing' && <TenantPicker title="Billing & Invoices" subtitle="Open a tenant → Billing tab to view MRR/ARR, set cycle, payment status, extend trial" hint="billing" onOpenTenant={openTenant} />}
          {section === 'ai_usage' && <TenantPicker title="AI Usage & Limits" subtitle="Open a tenant → AI Controls for credits, model tier, overage, and the emergency kill switch" hint="ai usage" onOpenTenant={openTenant} />}
          {section === 'device_usage' && <TenantPicker title="Device Usage" subtitle="Open a tenant → Usage & Limits to manage the device cap and other limits" hint="devices" onOpenTenant={openTenant} />}
          {section === 'security' && <TenantPicker title="Security & Access" subtitle="Open a tenant → Security for MFA policy, access-token lifetime, planned IP restrictions, and session revocation" hint="security" onOpenTenant={openTenant} />}
          {section === 'integrations' && <IntegrationsSection canManage={canManage} />}
          {section === 'announcements' && <AnnouncementsSection canManage={canManage} />}
          {section === 'settings' && <PlatformSettingsSection canManage={canManage} />}
          {section === 'account' && <MyAccountSection me={me} onReauthenticated={setMe} />}
        </div>
      </div>

      {drawerTenant && <TenantDrawer tenant={drawerTenant} canManage={canManage} onClose={() => setDrawerTenant(null)} />}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────── */
function OverviewSection({ overview, onGo }: { overview: Overview | null; onGo: (section: SectionId) => void }) {
  return (
    <div className="space-y-6">
      {overview && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <Kpi icon={Building2} variant="indigo" label="Total tenants" value={overview.tenants} />
          <Kpi icon={CircleCheck} variant="emerald" label="Active" value={overview.activeTenants} />
          <Kpi icon={CircleSlash} variant="red" label="Suspended" value={overview.suspendedTenants} />
          <Kpi icon={Clock3} variant="amber" label="Pending requests" value={overview.pendingRequests} />
          <Kpi icon={UserCog} variant="violet" label="Operators" value={overview.platformUsers} />
        </div>
      )}
      <SystemStatus />
      <Panel title="Quick actions" subtitle="Jump to the most common operator workflows">
        <div className="grid sm:grid-cols-3 gap-3">
          <button type="button" onClick={() => onGo('tenants')} className="flex items-center gap-3 rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-4 py-3 text-left hover:border-[var(--b2)]">
            <Building2 className="w-5 h-5 text-indigo" /><div><p className="text-sm font-semibold text-t1">Provision a company</p><p className="text-[11px] text-t3">Create a client tenant + owner login</p></div>
          </button>
          <button type="button" onClick={() => onGo('health')} className="flex items-center gap-3 rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-4 py-3 text-left hover:border-[var(--b2)]">
            <Gauge className="w-5 h-5 text-emerald-v" /><div><p className="text-sm font-semibold text-t1">System health</p><p className="text-[11px] text-t3">API, database, queues and providers</p></div>
          </button>
          <button type="button" onClick={() => onGo('audit')} className="flex items-center gap-3 rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-4 py-3 text-left hover:border-[var(--b2)]">
            <ScrollText className="w-5 h-5 text-violet-v" /><div><p className="text-sm font-semibold text-t1">Audit trail</p><p className="text-[11px] text-t3">Every privileged platform action</p></div>
          </button>
        </div>
      </Panel>
    </div>
  );
}

function PlansSection({ canManage }: { canManage: boolean }) {
  const [plans, setPlans] = useState<Array<{ key: string; name: string; monthlyPrice: number; features: string[] }>>([]);
  const [addons, setAddons] = useState<Array<{ key: string; name: string; featureKey: string | null }>>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [price, setPrice] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  async function reloadPlans() { setPlans(await platformAdmin.plans().catch(() => [])); }
  async function savePrice(planKey: string) {
    setBusy(true); setMsg(null);
    try {
      const result = await platformAdmin.setPlanPrice(planKey, price.trim() === '' ? null : Number(price), reason.trim());
      await reloadPlans();
      setEditing(null); setPrice(''); setReason('');
      setMsg({ tone: 'ok', text: result.tenantsRepriced > 0
        ? `Saved. ${result.tenantsRepriced} tenant${result.tenantsRepriced === 1 ? '' : 's'} on this plan had their MRR updated.`
        : 'Saved. No tenants are on this plan yet.' });
    } catch (e) {
      setMsg({ tone: 'bad', text: e instanceof Error ? e.message : 'Could not set the price' });
    } finally { setBusy(false); }
  }
  useEffect(() => { let a = true; void (async () => { const [p, ad] = await Promise.all([platformAdmin.plans().catch(() => []), platformAdmin.addons().catch(() => [])]); if (a) { setPlans(p); setAddons(ad); } })(); return () => { a = false; }; }, []);
  return (
    <div className="space-y-4">
      <Panel title="Plans" subtitle="Subscription tiers, their included features, and what they cost">
        {msg && <p className={`mb-3 text-[12px] ${msg.tone === 'ok' ? 'text-emerald-v' : 'text-red-v'}`} role="status">{msg.text}</p>}
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {plans.map(p => (
            <div key={p.key} className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold text-t1">{p.name}</p>
                {/* An unpriced plan says so. Rendering $0 made every tenant's
                    MRR look like a real number that happened to be zero. */}
                <span className={`text-[11px] font-semibold ${p.monthlyPrice > 0 ? 'text-indigo' : 'text-amber-v'}`}>
                  {p.monthlyPrice > 0 ? `$${p.monthlyPrice}/mo` : 'no price set'}
                </span>
              </div>
              <p className="text-[10px] text-t3 mt-1">{p.features.length} features</p>
              <div className="mt-2 flex flex-wrap gap-1">{p.features.slice(0, 6).map(f => <span key={f} className="badge badge-blue text-[9px]">{FEATURE_LABELS[f] ?? f}</span>)}</div>
              {canManage && (editing === p.key ? (
                <div className="mt-3 space-y-2">
                  <input aria-label={`Monthly price for ${p.name}`} value={price} onChange={e => setPrice(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0.00"
                    className="w-full rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-2 py-1 text-xs text-t1 outline-none" />
                  <input aria-label={`Reason for repricing ${p.name}`} value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (recorded)"
                    className="w-full rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-2 py-1 text-xs text-t1 outline-none" />
                  <div className="flex gap-1.5">
                    <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => void savePrice(p.key)}
                      className="rounded-lg bg-[var(--indigo)] px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50">{busy ? '…' : 'Save price'}</button>
                    <button type="button" onClick={() => { setEditing(null); setReason(''); setPrice(''); }}
                      className="rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-t2">Cancel</button>
                  </div>
                </div>
              ) : (
                <button type="button" onClick={() => { setEditing(p.key); setPrice(p.monthlyPrice ? String(p.monthlyPrice) : ''); setMsg(null); }}
                  className="mt-3 text-[11px] font-semibold text-indigo hover:underline">Set price</button>
              ))}
            </div>
          ))}
        </div>
      </Panel>
      <Panel title="Add-ons" subtitle="Paid feature add-ons available on top of a plan">
        {addons.length === 0 ? <EmptyState icon={Receipt} text="No add-ons configured." /> : (
          <div className="grid sm:grid-cols-3 gap-2">{addons.map(a => <div key={a.key} className="rounded-lg border border-[var(--b1)] px-3 py-2"><p className="text-[12px] font-semibold text-t1">{a.name}</p><p className="text-[10px] text-t3">{a.featureKey ? FEATURE_LABELS[a.featureKey] ?? a.featureKey : 'bundle'}</p></div>)}</div>
        )}
      </Panel>
    </div>
  );
}

function TenantPicker({ title, subtitle, hint, onOpenTenant }: { title: string; subtitle: string; hint: string; onOpenTenant: (t: TenantSummary) => void }) {
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setTenants(await platformAdmin.tenants()); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Tenants could not be loaded'); }
  }, []);
  useEffect(() => { void (async () => { await load(); })(); }, [load]);
  return (
    <Panel title={title} subtitle={subtitle}>
      {error ? <LoadFailure message={error} onRetry={() => void load()} />
        : tenants.length === 0 ? <EmptyState icon={SlidersHorizontal} text="No tenants yet." /> : (
        <div className="space-y-2">
          {tenants.map(t => t.tenant && (
            <button key={t.tenant.id} type="button" onClick={() => onOpenTenant(t)} className="w-full flex items-center justify-between gap-3 rounded-lg border border-[var(--b1)] px-3 py-2.5 hover:bg-[var(--s2)] text-left">
              <span className="flex items-center gap-3 min-w-0">
                <span className="w-8 h-8 rounded-lg bg-indigo-soft grid place-items-center text-[11px] font-bold text-indigo shrink-0">{t.tenant.name.slice(0, 2).toUpperCase()}</span>
                <span className="text-sm font-semibold text-t1 truncate">{t.tenant.name}</span>
              </span>
              <span className="flex items-center gap-2 shrink-0"><span className="text-[11px] text-t3">Manage {hint}</span><ChevronRight className="w-4 h-4 text-t3" /></span>
            </button>
          ))}
        </div>
      )}
    </Panel>
  );
}

function IntegrationsSection({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<IntegrationView[] | null>(null);
  const [failedJobs, setFailedJobs] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [ints, health] = await Promise.all([platformAdmin.integrations(), platformAdmin.providerHealth().catch(() => null)]);
    setRows(ints); if (health) setFailedJobs(health.failedJobs);
  }, []);
  useEffect(() => { let a = true; void (async () => { try { const [ints, health] = await Promise.all([platformAdmin.integrations(), platformAdmin.providerHealth().catch(() => null)]); if (!a) return; setRows(ints); if (health) setFailedJobs(health.failedJobs); } catch { /* ignore */ } })(); return () => { a = false; }; }, []);
  async function retry() { setBusy(true); setMsg(null); try { const r = await platformAdmin.retryJobs(); setMsg(`Retried ${r.retried} failed job(s).`); await load(); } catch (e) { setMsg(e instanceof Error ? e.message : 'Retry failed'); } finally { setBusy(false); } }
  const configured = rows?.filter(p => p.status === 'connected').length ?? 0;
  return (
    <Panel title="Integrations & provider health" subtitle={rows ? `${configured}/${rows.length} providers have a connected status in platform records` : 'Provider credential management and background-job health'}
      action={
        <div className="flex items-center gap-2">
          {canManage && <button type="button" onClick={() => setAdding(v => !v)} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"><Plus className="w-3.5 h-3.5" /> Add service</button>}
          <button type="button" onClick={() => void load()} className="topbar-icon-btn" title="Refresh" aria-label="Refresh"><RefreshCw className="w-3.5 h-3.5" /></button>
        </div>
      }>
      {adding && canManage && <AddServiceForm onCancel={() => setAdding(false)} onCreated={async () => { setAdding(false); await load(); }} />}
      {!rows ? <div className="py-6 text-center"><Loader2 className="inline w-5 h-5 animate-spin text-indigo" /></div> : (
        <div className="space-y-2">
          {rows.map(p => (
            <div key={p.key} className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] overflow-hidden">
              <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                <div className="flex items-center gap-2 min-w-0">
                  <Plug className="w-4 h-4 text-t3 shrink-0" />
                  <span className="text-[12px] font-semibold text-t1 truncate">{p.label}</span>
                  {p.source && <span className="text-[10px] text-t3">· via {p.source}</span>}
                  {p.lastTestStatus && (
                    // "not_verified" is a real answer: the credential is stored
                    // but this provider has no connection test, so claiming a
                    // green "ok" would be the exact lie this console is fixing.
                    <span
                      className={`text-[10px] font-semibold ${p.lastTestStatus === 'ok' ? 'text-emerald-v' : p.lastTestStatus === 'not_verified' ? 'text-amber-v' : 'text-red-v'}`}
                      title={p.lastTestDetail ?? undefined}
                    >
                      · {p.lastTestStatus === 'not_verified' ? 'stored, not verified' : `test ${p.lastTestStatus}`}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className={`badge ${p.status === 'connected' ? 'badge-emerald' : 'badge-amber'}`}>{p.status === 'connected' ? 'connected' : 'setup required'}</span>
                  {canManage && <button type="button" onClick={() => setOpen(open === p.key ? null : p.key)} className="rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-t2 hover:bg-[var(--s1)]">{open === p.key ? 'Close' : 'Configure'}</button>}
                </div>
              </div>
              {open === p.key && canManage && <IntegrationForm provider={p} onChanged={async () => { await load(); }} />}
            </div>
          ))}
          <div className="flex items-center justify-between rounded-lg border border-[var(--b1)] px-3 py-2.5 mt-1">
            <span className="text-[12px] text-t2">Failed background jobs: <span className="font-bold text-t1">{failedJobs < 0 ? 'queue unavailable' : failedJobs}</span></span>
            <button type="button" disabled={busy || failedJobs <= 0} onClick={retry} title={failedJobs <= 0 ? 'No failed jobs to retry' : 'Retry failed jobs'} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-3 py-1.5 text-[11px] font-semibold text-t2 hover:bg-[var(--s1)] disabled:opacity-50"><RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} /> Retry failed jobs</button>
          </div>
          {msg && <p className="text-[11px] text-emerald-v">{msg}</p>}
          <p className="text-[11px] text-t3">This console displays masked credential previews returned by the server. Deployment owners must separately verify encryption-key custody, rotation, and provider configuration. Server environment variables may act as a fallback when no saved credential is configured.</p>
        </div>
      )}
    </Panel>
  );
}

function IntegrationForm({ provider, onChanged }: { provider: IntegrationView; onChanged: () => Promise<void> }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ status: string; detail: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy('save'); setErr(null);
    try { await platformAdmin.saveIntegration(provider.key, vals); setVals({}); await onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Save failed'); } finally { setBusy(null); }
  }
  async function test() { setBusy('test'); setErr(null); setResult(null); try { const r = await platformAdmin.testIntegration(provider.key); setResult({ status: r.status, detail: r.detail }); await onChanged(); } catch (e) { setErr(e instanceof Error ? e.message : 'Test failed'); } finally { setBusy(null); } }
  async function disconnect() { setBusy('disc'); setErr(null); try { await platformAdmin.disconnectIntegration(provider.key); await onChanged(); } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); } finally { setBusy(null); } }
  const field = 'w-full rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm text-t1 outline-none focus:border-[var(--indigo)]';
  return (
    <div className="border-t border-[var(--b1)] bg-[var(--s1)] p-3 space-y-2.5">
      {provider.fields.length === 0 && <p className="text-[11px] text-t3">No configuration fields yet — add one below.</p>}
      <div className="grid sm:grid-cols-2 gap-2.5">
        {provider.fields.map(f => (
          <label key={f.key} className="block space-y-1">
            <span className="text-[10px] font-semibold text-t3">{f.label}{provider.required.includes(f.key) && ' *'}{f.isSet && <span className="text-emerald-v"> · set ({f.masked})</span>}</span>
            <input className={field} type={f.secret ? 'password' : 'text'} value={vals[f.key] ?? ''} placeholder={f.isSet ? 'Leave blank to keep' : `Enter ${f.label.toLowerCase()}`} onChange={e => setVals(s => ({ ...s, [f.key]: e.target.value }))} autoComplete="off" />
          </label>
        ))}
      </div>
      {err && <p className="text-[11px] text-red-v">{err}</p>}
      {result && <p className={`text-[11px] font-semibold ${result.status === 'ok' ? 'text-emerald-v' : 'text-red-v'}`}>Test {result.status}: {result.detail}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy !== null || Object.values(vals).every(v => !v.trim())} onClick={save} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50">{busy === 'save' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />} Save credentials</button>
        <button type="button" disabled={busy !== null} onClick={test} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-3 py-1.5 text-[11px] font-semibold text-t2 hover:bg-[var(--s2)] disabled:opacity-50">{busy === 'test' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wifi className="w-3.5 h-3.5" />} Test connection</button>
        {provider.isCustom && <AddFieldButton serviceKey={provider.key} onChanged={onChanged} />}
        {(provider.source === 'db' || provider.isCustom) && <button type="button" disabled={busy !== null} onClick={disconnect} className="inline-flex items-center gap-1.5 rounded-lg border border-[rgba(220,38,38,0.25)] px-3 py-1.5 text-[11px] font-semibold text-red-v hover:bg-red-soft disabled:opacity-50">{busy === 'disc' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />} {provider.isCustom ? 'Delete service' : 'Disconnect'}</button>}
      </div>
    </div>
  );
}

function AddFieldButton({ serviceKey, onChanged }: { serviceKey: string; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(''); const [secret, setSecret] = useState(false); const [required, setRequired] = useState(true);
  const [busy, setBusy] = useState(false);
  async function add() { setBusy(true); try { await platformAdmin.addIntegrationField(serviceKey, { label: label.trim(), secret, required }); setLabel(''); setOpen(false); await onChanged(); } finally { setBusy(false); } }
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-3 py-1.5 text-[11px] font-semibold text-t2 hover:bg-[var(--s2)]"><Plus className="w-3.5 h-3.5" /> Add configuration</button>;
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Field name" className="rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-2 py-1.5 text-[11px]" />
      <label className="text-[10px] text-t2 flex items-center gap-1"><input type="checkbox" checked={secret} onChange={e => setSecret(e.target.checked)} /> secret</label>
      <label className="text-[10px] text-t2 flex items-center gap-1"><input type="checkbox" checked={required} onChange={e => setRequired(e.target.checked)} /> required</label>
      <button type="button" disabled={busy || label.trim().length < 1} onClick={add} className="rounded-lg bg-[var(--indigo)] px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50">{busy ? '…' : 'Add'}</button>
      <button type="button" onClick={() => setOpen(false)} className="text-[11px] text-t3">cancel</button>
    </div>
  );
}

function AddServiceForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => Promise<void> }) {
  const [label, setLabel] = useState('');
  const [fields, setFields] = useState<Array<{ label: string; secret: boolean; required: boolean; value: string }>>([{ label: '', secret: true, required: true, value: '' }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const upd = (i: number, patch: Partial<{ label: string; secret: boolean; required: boolean; value: string }>) => setFields(fs => fs.map((f, j) => j === i ? { ...f, ...patch } : f));
  async function create() {
    setBusy(true); setErr(null);
    try {
      await platformAdmin.addService(label.trim(), fields.filter(f => f.label.trim()).map(f => ({ label: f.label.trim(), secret: f.secret, required: f.required, value: f.value.trim() || undefined })));
      await onCreated();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed to add service'); } finally { setBusy(false); }
  }
  const cell = 'rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-2.5 py-1.5 text-sm';
  const valid = label.trim().length >= 2 && fields.some(f => f.label.trim());
  return (
    <div className="mb-4 rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3 space-y-3">
      <p className="text-[12px] font-bold uppercase tracking-wide text-t3">New integration service</p>
      <label className="block space-y-1"><span className="text-[10px] font-semibold text-t3">Service name</span>
        <input className={`${cell} w-full`} value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. SendGrid, OpenAI, Slack" /></label>
      <div className="space-y-2">
        <p className="text-[10px] font-semibold text-t3">Configuration fields</p>
        {fields.map((f, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <input className={`${cell} flex-1 min-w-32`} value={f.label} onChange={e => upd(i, { label: e.target.value })} placeholder="Field label (e.g. API Key)" />
            <input className={`${cell} flex-1 min-w-32`} type={f.secret ? 'password' : 'text'} value={f.value} onChange={e => upd(i, { value: e.target.value })} placeholder="Value (optional)" autoComplete="off" />
            <label className="text-[10px] text-t2 flex items-center gap-1"><input type="checkbox" checked={f.secret} onChange={e => upd(i, { secret: e.target.checked })} /> secret</label>
            <label className="text-[10px] text-t2 flex items-center gap-1"><input type="checkbox" checked={f.required} onChange={e => upd(i, { required: e.target.checked })} /> required</label>
            {fields.length > 1 && <button type="button" aria-label="Remove field" title="Remove field" onClick={() => setFields(fs => fs.filter((_, j) => j !== i))} className="text-t3 hover:text-red-v"><X className="w-3.5 h-3.5" /></button>}
          </div>
        ))}
        <button type="button" onClick={() => setFields(fs => [...fs, { label: '', secret: false, required: false, value: '' }])} className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo hover:opacity-80"><Plus className="w-3.5 h-3.5" /> Add configuration field</button>
      </div>
      {err && <p className="text-[11px] text-red-v">{err}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={busy || !valid} onClick={create} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create service</button>
        <button type="button" onClick={onCancel} className="rounded-lg border border-[var(--b1)] px-4 py-2 text-sm font-semibold text-t2 hover:bg-[var(--s1)]">Cancel</button>
      </div>
    </div>
  );
}

function AnnouncementsSection({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<Array<{ id: string; title: string; body: string; severity: string; active: boolean; createdByName: string | null; createdAt: string }>>([]);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState(''); const [body, setBody] = useState(''); const [severity, setSeverity] = useState('info');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setRows(await platformAdmin.announcements()); setLoadError(null); }
    catch (e) { setLoadError(e instanceof Error ? e.message : 'Announcements could not be loaded'); }
  }, []);
  useEffect(() => { void (async () => { await load(); })(); }, [load]);
  async function create() { setBusy(true); try { await platformAdmin.createAnnouncement({ title: title.trim(), body: body.trim(), severity }); setTitle(''); setBody(''); setCreating(false); await load(); } finally { setBusy(false); } }
  const sevBadge = (s: string) => s === 'critical' ? 'badge-red' : s === 'warning' ? 'badge-amber' : 'badge-blue';
  return (
    <Panel title="Announcements" subtitle="Operator + tenant-facing platform notices"
      action={canManage ? <button type="button" onClick={() => setCreating(v => !v)} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"><Plus className="w-3.5 h-3.5" /> New</button> : undefined}>
      {creating && (
        <div className="mb-4 rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3 space-y-2">
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Title" className="w-full rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm" />
          <textarea value={body} onChange={e => setBody(e.target.value)} placeholder="Message…" className="w-full rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm min-h-16" />
          <div className="flex items-center gap-2">
            <select aria-label="Severity" value={severity} onChange={e => setSeverity(e.target.value)} className="rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-2 py-1.5 text-xs"><option value="info">Info</option><option value="warning">Warning</option><option value="critical">Critical</option></select>
            <button type="button" disabled={busy || title.trim().length < 2 || body.trim().length < 2} onClick={create} className="rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50">{busy ? 'Posting…' : 'Post'}</button>
          </div>
        </div>
      )}
      {loadError ? <LoadFailure message={loadError} onRetry={() => void load()} />
        : rows.length === 0 ? <EmptyState icon={Megaphone} text="No announcements yet." /> : (
        <div className="space-y-2">
          {rows.map(a => (
            <div key={a.id} className="rounded-lg border border-[var(--b1)] px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-t1">{a.title}</p>
                <div className="flex items-center gap-1.5">
                  <span className={`badge ${sevBadge(a.severity)}`}>{a.severity}</span>
                  {canManage && <button type="button" onClick={async () => { await platformAdmin.toggleAnnouncement(a.id, !a.active); await load(); }} className={`badge ${a.active ? 'badge-emerald' : 'badge-blue'} cursor-pointer`}>{a.active ? 'active' : 'archived'}</button>}
                </div>
              </div>
              <p className="text-[12px] text-t2 mt-1">{a.body}</p>
              <p className="text-[10px] text-t3 mt-1">{a.createdByName ?? 'operator'} · {new Date(a.createdAt).toLocaleString()}</p>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

type DrawerTab = 'overview' | 'company' | 'subscription' | 'entitlements' | 'usage' | 'billing' | 'ai' | 'security' | 'audit' | 'danger';
function TenantDrawer({ tenant, canManage, onClose }: { tenant: TenantSummary; canManage: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<DrawerTab>('overview');
  const [account, setAccount] = useState<TenantAccountRecord | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [detail, setDetail] = useState<TenantSummary | null>(tenant);
  const [plans, setPlans] = useState<Array<{ key: string; name: string }>>([]);
  const [audit, setAudit] = useState<Array<{ id: string; action: string; targetType: string; tenantId: string | null; createdAt: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tid = tenant.tenant!.id;

  // The account record fails independently of the rest of the drawer: it reads
  // through SECURITY DEFINER windows that can refuse (inactive platform actor),
  // and that must surface as an error in one tab, not blank the whole panel.
  const reloadAccount = useCallback(async () => {
    try { setAccount(await platformAdmin.company(tid)); setAccountError(null); }
    catch (e) { setAccount(null); setAccountError(e instanceof Error ? e.message : 'Could not load the account record'); }
  }, [tid]);

  const reload = useCallback(async () => { setDetail(await platformAdmin.tenant(tid)); await reloadAccount(); }, [tid, reloadAccount]);
  useEffect(() => { let a = true; void (async () => {
    const [d, p, au, acct] = await Promise.all([
      platformAdmin.tenant(tid).catch(() => tenant),
      platformAdmin.plans().catch(() => []),
      platformAdmin.audit(200, tid).catch(() => []),
      // Settled rather than caught-to-null: a failure here is a real error the
      // Company tab must show, not an empty record it would render as "nothing
      // recorded yet".
      platformAdmin.company(tid).then(r => ({ ok: true as const, r })).catch((e: unknown) => ({ ok: false as const, e })),
    ]);
    if (!a) return;
    setDetail(d); setPlans(p); setAudit(au);
    if (acct.ok) { setAccount(acct.r); setAccountError(null); }
    else { setAccount(null); setAccountError(acct.e instanceof Error ? acct.e.message : 'Could not load the account record'); }
  })(); return () => { a = false; }; }, [tid, tenant]);

  async function act(fn: () => Promise<unknown>) { setBusy(true); setError(null); try { await fn(); await reload(); } catch (e) { setError(e instanceof Error ? e.message : 'Action failed'); } finally { setBusy(false); } }

  const d = detail ?? tenant;
  const tabs: Array<{ id: DrawerTab; label: string; live: boolean }> = [
    { id: 'overview', label: 'Overview', live: true }, { id: 'company', label: 'Company & Account', live: true },
    { id: 'subscription', label: 'Subscription', live: true },
    { id: 'entitlements', label: 'Feature Entitlements', live: true }, { id: 'usage', label: 'Usage & Limits', live: true },
    { id: 'billing', label: 'Billing', live: true }, { id: 'ai', label: 'AI Controls', live: true },
    { id: 'security', label: 'Security', live: true }, { id: 'audit', label: 'Audit Trail', live: true },
    { id: 'danger', label: 'Danger Zone', live: true },
  ];
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" aria-label="Close panel" title="Close panel" onClick={onClose} className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-fade-in" />
      <div className="relative w-full max-w-xl glass-surface h-full overflow-y-auto animate-fade-up flex flex-col">
        <header className="platform-brand sticky top-0 z-10 px-5 py-4 flex items-start justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl logo-user grid place-items-center text-[13px] font-bold text-white">{d.tenant!.name.slice(0, 2).toUpperCase()}</div>
            <div>
              <p className="text-base font-bold leading-tight text-t1">{d.tenant!.name}</p>
              <p className="text-[11px] text-t3">/{d.tenant!.slug} · {d.subscription?.planKey ?? '—'} · setup {d.setupStatus}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-t3 hover:text-t1"><X className="w-5 h-5" /></button>
        </header>

        <div className="flex gap-1 px-3 pt-3 flex-wrap border-b border-[var(--b1)] bg-[var(--s1)] shrink-0">
          {tabs.map(tb => (
            <button key={tb.id} type="button" onClick={() => setTab(tb.id)} className={`px-2.5 py-1.5 rounded-t-lg text-[11px] font-semibold ${tab === tb.id ? 'bg-[var(--bg)] text-t1 border-b-2 border-indigo' : 'text-t3 hover:text-t1'}`}>
              {tb.label}{!tb.live && <span className="ml-1 text-[8px] align-top text-amber-v">●</span>}
            </button>
          ))}
        </div>

        <div className="p-5 space-y-3 flex-1">
          {error && <div className="rounded-lg bg-red-soft border border-[rgba(220,38,38,0.18)] px-3 py-2 text-xs text-red-v">{error}</div>}

          {tab === 'overview' && (
            <div className="grid grid-cols-2 gap-3">
              <DCard label="Status" value={d.tenant!.status} />
              <DCard label="Setup status" value={d.setupStatus} />
              <DCard label="Active users" value={String(d.activeUsers)} />
              <DCard label="Branches" value={String(d.branches)} />
              <DCard label="Enabled features" value={`${d.enabledFeatures}/${Object.keys(FEATURE_LABELS).length}`} />
              <DCard label="Last activity" value={new Date(d.tenant!.lastActivityAt).toLocaleDateString()} />
              <DCard label="Plan" value={d.subscription?.planKey ?? '—'} />
              <DCard label="Sub status" value={d.subscription?.status ?? '—'} />
            </div>
          )}

          {tab === 'company' && (
            <CompanyTab
              tid={tid}
              account={account}
              error={accountError}
              canManage={canManage}
              onSaved={reloadAccount}
            />
          )}

          {tab === 'subscription' && (
            <div className="space-y-3">
              <DCard label="Current plan" value={`${d.subscription?.planName ?? d.subscription?.planKey ?? '—'} · ${d.subscription?.status ?? ''}`} />
              {canManage && (
                <label className="block space-y-1"><span className="text-[11px] font-semibold text-t3">Change plan</span>
                  <select aria-label="Change plan" disabled={busy} defaultValue="" onChange={e => e.target.value && act(() => platformAdmin.changePlan(tid, e.target.value))} className="w-full rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-sm">
                    <option value="">Select a plan…</option>{plans.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
                  </select>
                </label>
              )}
              <p className="text-[11px] text-t3">Use the Billing tab to review or change billing cycle, trial, grace-period, renewal, seat, and limit settings. Confirm the resulting state and audit event after each change.</p>
            </div>
          )}

          {tab === 'entitlements' && <TenantFeatureControls tenantId={tid} canManage={canManage} onChanged={reload} />}

          {tab === 'usage' && <UsageTab tid={tid} canManage={canManage} />}
          {tab === 'billing' && <BillingTab tid={tid} canManage={canManage} />}
          {tab === 'ai' && <AiTab tid={tid} canManage={canManage} />}
          {tab === 'security' && <SecurityTab tid={tid} canManage={canManage} />}

          {tab === 'audit' && (
            <div className="space-y-2">
              <button type="button" onClick={() => void downloadAuditCsv({ tenantId: tid })} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-3 py-1.5 text-[11px] font-semibold text-t2 hover:bg-[var(--s2)]"><Download className="w-3.5 h-3.5" /> Export CSV</button>
              {audit.length === 0 ? <p className="text-xs text-t3 py-4 text-center">No audit events for this tenant yet.</p> : audit.map(a => (
                <div key={a.id} className="flex items-center justify-between rounded-lg border border-[var(--b1)] px-3 py-1.5 text-[11px]">
                  <span className="font-mono font-semibold text-t2">{a.action}</span>
                  <span className="text-t3">{a.targetType} · {new Date(a.createdAt).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}

          {tab === 'danger' && canManage && (
            <div className="space-y-3">
              {d.tenant!.status === 'active' ? (
                <DangerRow label="Suspend tenant" desc="Locks all features and blocks tenant login." action="Suspend" onConfirm={() => act(() => platformAdmin.suspend(tid))} busy={busy} />
              ) : d.tenant!.status === 'suspended' ? (
                <DangerRow label="Reactivate tenant" desc="Restores access and re-derives entitlements." action="Reactivate" tone="emerald" onConfirm={() => act(() => platformAdmin.reactivate(tid))} busy={busy} />
              ) : <p className="text-[11px] text-t3">Tenant is archived.</p>}
              <SupportAccessRow tid={tid} />
              <ReasonAction label="Archive tenant" desc="Soft-deletes the tenant (status = archived), cancels its subscription, and blocks all access. Reversible by reactivating." action="Archive" onConfirm={async (reason) => { await platformAdmin.archiveTenant(tid, reason); await reload(); }} />
            </div>
          )}
          {tab === 'danger' && !canManage && <p className="text-xs text-t3">Only Platform Owner/Admin can perform lifecycle actions.</p>}
        </div>
      </div>
    </div>
  );
}

// Company record + the account facts the platform plane is allowed to see.
// Deliberately NOT here by default: the tenant's staff list. app_platform holds
// no grants on "User"/"Branch"; this reads three narrow SECURITY DEFINER windows
// exposing the account owner, aggregate role counts and branches. The roster is
// break-glass only -- see RosterSection.
const COMPANY_GROUPS: Array<{ heading: string; fields: Array<{ k: keyof TenantCompany; label: string; long?: boolean }> }> = [
  { heading: 'Company', fields: [
    { k: 'legalName', label: 'Registered legal name' }, { k: 'companyNumber', label: 'Company / registration no.' },
    { k: 'website', label: 'Website' }, { k: 'mainPhone', label: 'Main phone' },
  ] },
  { heading: 'Registered address', fields: [
    { k: 'addressLine1', label: 'Address line 1' }, { k: 'addressLine2', label: 'Address line 2' },
    { k: 'city', label: 'City' }, { k: 'region', label: 'Region / state' },
    { k: 'postalCode', label: 'Postal code' }, { k: 'country', label: 'Country' },
  ] },
  { heading: 'Primary contact', fields: [
    { k: 'primaryContactName', label: 'Name' }, { k: 'primaryContactEmail', label: 'Email' },
    { k: 'primaryContactPhone', label: 'Phone' },
  ] },
  { heading: 'Billing contact', fields: [
    { k: 'billingContactName', label: 'Name' }, { k: 'billingContactEmail', label: 'Email' },
  ] },
  { heading: 'Account notes', fields: [{ k: 'accountNotes', label: 'Notes', long: true }] },
];

function CompanyTab({ tid, account, error, canManage, onSaved }: {
  tid: string; account: TenantAccountRecord | null; error: string | null;
  canManage: boolean; onSaved: () => Promise<void>;
}) {
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState<Partial<TenantCompany>>({});
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (error) return <div className="rounded-lg bg-red-soft border border-[rgba(220,38,38,0.18)] px-3 py-2 text-xs text-red-v">{error}</div>;
  if (!account) return <p className="text-xs text-t3">Loading account record…</p>;

  const c = account.company;
  const allFields = COMPANY_GROUPS.flatMap(g => g.fields);
  const recorded = allFields.filter(f => c[f.k]).length;

  async function save() {
    setSaving(true); setSaveError(null);
    try { await platformAdmin.updateCompany(tid, { ...draft, reason }); await onSaved(); setEdit(false); setDraft({}); setReason(''); }
    catch (e) { setSaveError(e instanceof Error ? e.message : 'Save failed'); }
    finally { setSaving(false); }
  }

  return (
    <div className="space-y-4">
      {/* Account owner: the one identity the platform plane may see by default. */}
      <section className="space-y-1.5">
        <h4 className="text-[11px] font-semibold text-t3 uppercase tracking-wide">Account owner</h4>
        {account.accountOwner ? (
          <div className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 space-y-0.5">
            <p className="text-sm font-semibold text-t1">{account.accountOwner.displayName}</p>
            <p className="text-xs text-t2">{account.accountOwner.email}</p>
            <p className="text-[11px] text-t3">
              {account.accountOwner.active ? 'Active' : 'Inactive'} · MFA {account.accountOwner.mfaEnabled ? 'on' : 'off'} ·{' '}
              {account.accountOwner.lastLoginAt
                ? `last signed in ${new Date(account.accountOwner.lastLoginAt).toLocaleDateString()}`
                : 'never signed in'}
            </p>
          </div>
        ) : (
          <p className="text-xs text-t3">No owner login recorded for this tenant.</p>
        )}
      </section>

      {/* Seats by role: aggregate counts, never identities. */}
      <section className="space-y-1.5">
        <h4 className="text-[11px] font-semibold text-t3 uppercase tracking-wide">Seats by role</h4>
        {account.roleBreakdown.length ? (
          <div className="flex flex-wrap gap-1.5">
            {account.roleBreakdown.map(r => (
              <span key={r.role} className="rounded-md border border-[var(--b1)] bg-[var(--s2)] px-2 py-1 text-[11px] text-t2">
                <span className="font-semibold text-t1">{r.active}</span> {r.role.replace(/_/g, ' ').toLowerCase()}
                {r.inactive > 0 && <span className="text-t3"> (+{r.inactive} inactive)</span>}
              </span>
            ))}
          </div>
        ) : <p className="text-xs text-t3">No users yet.</p>}
      </section>

      <RosterSection tid={tid} canManage={canManage} />

      <section className="space-y-1.5">
        <h4 className="text-[11px] font-semibold text-t3 uppercase tracking-wide">Branches ({account.branches.length})</h4>
        {account.branches.length ? (
          <div className="space-y-1">
            {account.branches.map(b => (
              <div key={b.id} className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-1.5 flex items-baseline justify-between gap-2">
                <span className="text-xs font-semibold text-t1 truncate">{b.name}{!b.active && <span className="ml-1 text-[10px] text-t3">(inactive)</span>}</span>
                <span className="text-[11px] text-t3 truncate">{b.location} · {b.timezone}</span>
              </div>
            ))}
          </div>
        ) : <p className="text-xs text-t3">No branches yet.</p>}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-[11px] font-semibold text-t3 uppercase tracking-wide">Company record</h4>
          {canManage && !edit && (
            <button type="button" onClick={() => { setDraft({ ...c }); setEdit(true); }} className="text-[11px] font-semibold text-indigo hover:underline">Edit</button>
          )}
        </div>

        {recorded === 0 && !edit && (
          <p className="text-xs text-t3">No company details recorded yet{canManage ? ' — use Edit to add them.' : '.'}</p>
        )}

        {!edit && recorded > 0 && COMPANY_GROUPS.map(g => {
          const present = g.fields.filter(f => c[f.k]);
          if (!present.length) return null;
          return (
            <div key={g.heading} className="space-y-1">
              <p className="text-[10px] text-t3 uppercase tracking-wide">{g.heading}</p>
              {present.map(f => (
                <div key={f.k} className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-1.5">
                  <p className="text-[10px] text-t3">{f.label}</p>
                  <p className="text-xs text-t1 whitespace-pre-wrap break-words">{c[f.k]}</p>
                </div>
              ))}
            </div>
          );
        })}

        {!edit && recorded > 0 && recorded < allFields.length && (
          <p className="text-[10px] text-t3">{allFields.length - recorded} of {allFields.length} fields not recorded.</p>
        )}

        {edit && (
          <div className="space-y-3">
            {COMPANY_GROUPS.map(g => (
              <div key={g.heading} className="space-y-1.5">
                <p className="text-[10px] text-t3 uppercase tracking-wide">{g.heading}</p>
                {g.fields.map(f => (
                  <label key={f.k} className="block space-y-0.5">
                    <span className="text-[10px] text-t3">{f.label}</span>
                    {f.long ? (
                      <textarea rows={3} className={fieldCls} value={draft[f.k] ?? ''} onChange={e => setDraft(d => ({ ...d, [f.k]: e.target.value }))} />
                    ) : (
                      <input className={fieldCls} value={draft[f.k] ?? ''} onChange={e => setDraft(d => ({ ...d, [f.k]: e.target.value }))} />
                    )}
                  </label>
                ))}
              </div>
            ))}
            <label className="block space-y-0.5">
              <span className="text-[10px] text-t3">Reason for this change (recorded in the audit trail)</span>
              <input className={fieldCls} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. updated billing contact after onboarding call" />
            </label>
            {saveError && <div className="rounded-lg bg-red-soft border border-[rgba(220,38,38,0.18)] px-3 py-2 text-xs text-red-v">{saveError}</div>}
            <div className="flex gap-2">
              <button type="button" disabled={saving || reason.trim().length < 3} onClick={() => void save()} className="btn-primary text-xs px-3 py-1.5 disabled:opacity-50">
                {saving ? 'Saving…' : 'Save changes'}
              </button>
              <button type="button" disabled={saving} onClick={() => { setEdit(false); setDraft({}); setReason(''); setSaveError(null); }} className="text-xs px-3 py-1.5 text-t2 hover:text-t1">Cancel</button>
            </div>
            <p className="text-[10px] text-t3">A reason of at least 3 characters is required. Only the field names you change are written to the audit log, never their values.</p>
          </div>
        )}
      </section>
    </div>
  );
}

// Staff roster under break-glass. Closed by default: an operator opens a
// support session with a written reason, the session expires on its own, and
// both the session and every roster view are audited. The server (and the
// database function beneath it) enforce this -- the UI only reflects it.
function RosterSection({ tid, canManage }: { tid: string; canManage: boolean }) {
  const [roster, setRoster] = useState<TenantRoster | null>(null);
  const [needsSession, setNeedsSession] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);

  async function load() {
    setBusy(true); setError(null);
    try { setRoster(await platformAdmin.roster(tid)); setNeedsSession(false); }
    catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not load the staff list';
      // A 403 here is the expected closed state, not a fault.
      if (/support[_ ]session/i.test(msg)) { setNeedsSession(true); setRoster(null); setError(null); }
      else setError(msg);
    } finally { setBusy(false); setOpened(true); }
  }

  async function openSessionAndLoad() {
    setBusy(true); setError(null);
    try { await platformAdmin.startSupport(tid, reason, 60); setReason(''); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not open a support session'); setBusy(false); }
  }

  return (
    <section className="space-y-1.5">
      <h4 className="text-[11px] font-semibold text-t3 uppercase tracking-wide">Staff list</h4>

      {!opened && (
        <div className="space-y-1">
          <button type="button" disabled={busy} onClick={() => void load()} className="text-[11px] font-semibold text-indigo hover:underline disabled:opacity-50">
            {busy ? 'Checking…' : 'Show staff list'}
          </button>
          <p className="text-[10px] text-t3">Individual staff records stay inside the clinic’s workspace. Viewing them needs an open support session, and the reason is recorded.</p>
        </div>
      )}

      {error && <div className="rounded-lg bg-red-soft border border-[rgba(220,38,38,0.18)] px-3 py-2 text-xs text-red-v">{error}</div>}

      {needsSession && (
        <div className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-2.5 space-y-2">
          <p className="text-xs text-t2">No support session is open for this tenant, so its staff list stays closed.</p>
          {canManage ? (
            <>
              <label className="block space-y-0.5">
                <span className="text-[10px] text-t3">Reason for access (recorded, expires after 60 minutes)</span>
                <input className={fieldCls} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. investigating a locked admin account" />
              </label>
              <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => void openSessionAndLoad()} className="btn-primary text-xs px-3 py-1.5 disabled:opacity-50">
                {busy ? 'Opening…' : 'Open support session & show staff'}
              </button>
            </>
          ) : (
            <p className="text-[10px] text-t3">Your role cannot open a support session.</p>
          )}
        </div>
      )}

      {roster && (
        <div className="space-y-1.5">
          <div className="rounded-lg bg-amber-soft border border-[rgba(217,119,6,0.18)] px-3 py-1.5">
            <p className="text-[11px] text-amber-v">
              Support session open until {new Date(roster.supportSession.expiresAt).toLocaleTimeString()} · “{roster.supportSession.reason}”
            </p>
          </div>
          {roster.users.map(u => (
            <div key={u.id} className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-semibold text-t1 truncate">{u.displayName}</span>
                <span className="text-[10px] text-t3 shrink-0">{u.role.replace(/_/g, ' ').toLowerCase()}</span>
              </div>
              <p className="text-[11px] text-t2 truncate">{u.email}</p>
              <p className="text-[10px] text-t3">
                {u.active ? 'Active' : 'Inactive'} · MFA {u.mfaEnabled ? 'on' : 'off'}
                {u.branchName ? ` · ${u.branchName}` : ''}
                {u.lockedUntil && new Date(u.lockedUntil) > new Date() ? ' · locked' : ''}
                {u.lastLoginAt ? ` · last in ${new Date(u.lastLoginAt).toLocaleDateString()}` : ' · never signed in'}
              </p>
            </div>
          ))}
          {!roster.users.length && <p className="text-xs text-t3">This tenant has no staff records.</p>}
        </div>
      )}
    </section>
  );
}

function DCard({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-2"><p className="text-[10px] text-t3 uppercase tracking-wide">{label}</p><p className="text-sm font-semibold text-t1 capitalize truncate">{value}</p></div>;
}
const fieldCls = 'w-full rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm text-t1 outline-none focus:border-[var(--indigo)]';

// Reason-required action (inline): the confirm button stays disabled until a
// reason is entered; on confirm the reason is sent + audited server-side.
function ReasonAction({ label, desc, action, tone = 'red', onConfirm }: { label: string; desc: string; action: string; tone?: 'red' | 'amber'; onConfirm: (reason: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const accent = tone === 'red' ? 'text-red-v' : 'text-amber-v';
  async function go() { setBusy(true); setErr(null); try { await onConfirm(reason.trim()); setOpen(false); setReason(''); } catch (e) { setErr(e instanceof Error ? e.message : 'Action failed'); } finally { setBusy(false); } }
  return (
    <div className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-3">
      <p className={`text-sm font-bold ${accent}`}>{label}</p>
      <p className="text-[11px] text-t2 mt-0.5">{desc}</p>
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className={`mt-2 rounded-lg border border-[var(--b2)] px-3 py-1.5 text-[11px] font-semibold ${accent} hover:bg-[var(--s3)]`}>{action}</button>
      ) : (
        <div className="mt-2 space-y-2">
          <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (required, audited)…" className={fieldCls} />
          {err && <p className="text-[11px] text-red-v">{err}</p>}
          <div className="flex gap-2">
            <button type="button" disabled={busy || reason.trim().length < 3} onClick={go} className={`rounded-lg px-3 py-1.5 text-[11px] font-semibold text-white ${tone === 'red' ? 'bg-[var(--red)]' : 'bg-[var(--amber)]'} hover:opacity-90 disabled:opacity-50`}>{busy ? '…' : `Confirm ${action.toLowerCase()}`}</button>
            <button type="button" onClick={() => { setOpen(false); setErr(null); }} className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-[11px] font-semibold text-t2">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Toggle({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on ? 'true' : 'false'} aria-label={label} onClick={onToggle}
      className={`relative w-9 h-5 rounded-full shrink-0 transition-colors ${on ? 'bg-[var(--indigo)]' : 'bg-[var(--b2)]'}`}>
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  );
}

function UsageTab({ tid, canManage }: { tid: string; canManage: boolean }) {
  const [rows, setRows] = useState<UsageLimitRow[] | null>(null);
  const [periodKey, setPeriodKey] = useState<string>('');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => { const r = await platformAdmin.getUsageLimits(tid); setRows(r.rows); setPeriodKey(r.periodKey); }, [tid]);
  useEffect(() => { let a = true; void (async () => { const r = await platformAdmin.getUsageLimits(tid); if (a) { setRows(r.rows); setPeriodKey(r.periodKey); } })(); return () => { a = false; }; }, [tid]);
  async function save(key: string) {
    setBusy(key);
    const raw = edits[key]; const limit = raw === '' ? null : Number(raw);
    try { await platformAdmin.setUsageLimit(tid, key, limit); await load(); } finally { setBusy(null); }
  }
  const labels: Record<string, string> = { seats: 'Seats', locations: 'Locations', storage_gb: 'Storage (GB)', sms: 'SMS', voice_minutes: 'Voice minutes', ai_credits: 'AI credits', devices: 'Devices' };
  if (!rows) return <div className="py-6 text-center"><Loader2 className="inline w-5 h-5 animate-spin text-indigo" /></div>;
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-t3">
        Usage shown for the current billing period{periodKey ? ` (${periodKey})` : ''}. Limits reset each period.
      </p>
      {rows.map(r => {
        // An unmetered key has no honest bar to draw: a permanent 0% reads as
        // "plenty of headroom" when the truth is "nothing counts this".
        const pct = r.metered && r.limit ? Math.min(100, Math.round((r.used / r.limit) * 100)) : 0;
        return (
          <div key={r.key} className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-semibold text-t1">{labels[r.key] ?? r.key}</span>
              <span className="text-[11px] text-t3">
                {r.metered ? <>{r.used}{r.limit != null ? ` / ${r.limit}` : ' / ∞'}</> : <span title="No meter records this key yet">not measured{r.limit != null ? ` · limit ${r.limit}` : ''}</span>}
              </span>
            </div>
            {r.metered && <div className="prog-track md mt-1.5"><div className={`prog-fill ${pct >= 90 ? 'pf-red' : pct >= 70 ? 'pf-amber' : 'pf-indigo'}`} style={{ width: `${pct}%` }} /></div>}
            {canManage && (
              <div className="mt-2 flex items-center gap-2">
                <input value={edits[r.key] ?? (r.limit ?? '')} onChange={e => setEdits(s => ({ ...s, [r.key]: e.target.value.replace(/[^0-9]/g, '') }))} placeholder="∞" className="w-24 rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-2 py-1 text-xs" />
                <button type="button" disabled={busy === r.key} onClick={() => save(r.key)} className="rounded-lg bg-[var(--indigo)] px-2.5 py-1 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50">{busy === r.key ? '…' : 'Set limit'}</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function BillingTab({ tid, canManage }: { tid: string; canManage: boolean }) {
  const [b, setB] = useState<TenantBilling | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [trialDays, setTrialDays] = useState('14');
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => setB(await platformAdmin.getBilling(tid)), [tid]);
  useEffect(() => { let a = true; void (async () => { const r = await platformAdmin.getBilling(tid); if (a) setB(r); })(); return () => { a = false; }; }, [tid]);
  async function update(patch: { cycle?: 'monthly' | 'annual'; paymentStatus?: 'ok' | 'failed' | 'no_method' }) {
    if (reason.trim().length < 3) { setMsg('Enter a reason first.'); return; }
    setBusy(true); setMsg(null);
    try { await platformAdmin.updateBilling(tid, { ...patch, reason: reason.trim() }); await load(); setMsg('Saved.'); } catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); } finally { setBusy(false); }
  }
  async function extend() {
    if (reason.trim().length < 3) { setMsg('Enter a reason first.'); return; }
    setBusy(true); setMsg(null);
    try { const r = await platformAdmin.extendTrial(tid, Number(trialDays), reason.trim()); setMsg(`Trial now ends ${new Date(r.trialEndsAt).toLocaleDateString()}.`); await load(); } catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); } finally { setBusy(false); }
  }
  if (!b) return <div className="py-6 text-center"><Loader2 className="inline w-5 h-5 animate-spin text-indigo" /></div>;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <DCard label="MRR" value={`$${b.mrr.toLocaleString()}`} />
        <DCard label="ARR" value={`$${b.arr.toLocaleString()}`} />
        <DCard label="Cycle" value={b.cycle} />
        <DCard label="Payment" value={b.paymentStatus} />
        <DCard label="Renewal" value={b.renewalDate ? new Date(b.renewalDate).toLocaleDateString() : '—'} />
        <DCard label="Provider" value={b.provider ?? 'manual'} />
      </div>
      {canManage && (
        <div className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3 space-y-2">
          <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason for change (required, audited)…" className={fieldCls} />
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => update({ cycle: b.cycle === 'monthly' ? 'annual' : 'monthly' })} className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-[11px] font-semibold text-t2 hover:bg-[var(--s1)]">Switch to {b.cycle === 'monthly' ? 'annual' : 'monthly'}</button>
            <button type="button" disabled={busy} onClick={() => update({ paymentStatus: b.paymentStatus === 'ok' ? 'failed' : 'ok' })} className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-[11px] font-semibold text-t2 hover:bg-[var(--s1)]">Mark payment {b.paymentStatus === 'ok' ? 'failed' : 'ok'}</button>
          </div>
          <div className="flex items-center gap-2">
            <input aria-label="Trial extension days" value={trialDays} onChange={e => setTrialDays(e.target.value.replace(/[^0-9]/g, ''))} className="w-16 rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-2 py-1 text-xs" />
            <span className="text-[11px] text-t3">days</span>
            <button type="button" disabled={busy || !trialDays} onClick={extend} className="rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50">Extend trial</button>
          </div>
          {msg && <p className="text-[11px] text-emerald-v">{msg}</p>}
        </div>
      )}
    </div>
  );
}

function AiTab({ tid, canManage }: { tid: string; canManage: boolean }) {
  const [a, setA] = useState<AiUsageView | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => setA(await platformAdmin.getAiUsage(tid)), [tid]);
  useEffect(() => { let a = true; void (async () => { const r = await platformAdmin.getAiUsage(tid); if (a) setA(r); })(); return () => { a = false; }; }, [tid]);
  async function patch(body: { modelTier?: string; overageAllowed?: boolean }) { setBusy(true); try { await platformAdmin.updateAiUsage(tid, body); await load(); } finally { setBusy(false); } }
  if (!a) return <div className="py-6 text-center"><Loader2 className="inline w-5 h-5 animate-spin text-indigo" /></div>;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <DCard label="AI credits used" value={`${a.aiCreditsUsed}${a.aiCreditsLimit != null ? ` / ${a.aiCreditsLimit}` : ''}`} />
        <DCard label="Receptionist mins" value={String(a.receptionistMinutes)} />
        <DCard label="Campaign gens" value={String(a.campaignGenerations)} />
        <DCard label="Report gens" value={String(a.reportGenerations)} />
      </div>
      {canManage && (
        <div className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3 space-y-3">
          <label className="flex items-center justify-between"><span className="text-[12px] font-semibold text-t1">Model tier</span>
            <select aria-label="Model tier" disabled={busy} value={a.modelTier} onChange={e => patch({ modelTier: e.target.value })} className="rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-2 py-1 text-xs"><option value="standard">Standard</option><option value="advanced">Advanced</option><option value="premium">Premium</option></select>
          </label>
          <label className="flex items-center justify-between"><span className="text-[12px] font-semibold text-t1">Allow overage</span>
            <Toggle on={a.overageAllowed} onToggle={() => patch({ overageAllowed: !a.overageAllowed })} label="Allow overage" />
          </label>
          <ReasonAction label={a.killSwitch ? 'AI kill switch is ON' : 'Emergency AI kill switch'} desc={a.killSwitch ? 'All AI features are disabled for this tenant.' : 'Immediately disables all AI features for this tenant.'} action={a.killSwitch ? 'Disable kill switch' : 'Enable kill switch'} tone={a.killSwitch ? 'amber' : 'red'} onConfirm={async (reason) => { await platformAdmin.aiKillSwitch(tid, !a.killSwitch, reason); await load(); }} />
        </div>
      )}
    </div>
  );
}

function SecurityTab({ tid, canManage }: { tid: string; canManage: boolean }) {
  const [s, setS] = useState<SecurityView | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => setS(await platformAdmin.getSecurity(tid)), [tid]);
  useEffect(() => { let a = true; void (async () => { const r = await platformAdmin.getSecurity(tid); if (a) setS(r); })(); return () => { a = false; }; }, [tid]);
  async function patch(body: { forceMfa?: boolean; sessionTimeoutMinutes?: number; failedLoginLockout?: boolean }) {
    if (reason.trim().length < 3) { setMsg('Enter a reason first.'); return; }
    setBusy(true); setMsg(null);
    try { await platformAdmin.updateSecurity(tid, { ...body, reason: reason.trim() }); await load(); setMsg('Saved.'); } catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); } finally { setBusy(false); }
  }
  if (!s) return <div className="py-6 text-center"><Loader2 className="inline w-5 h-5 animate-spin text-indigo" /></div>;
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3 space-y-3">
        <label className="flex items-center justify-between"><span className="text-[12px] font-semibold text-t1">Force MFA for all users</span><Toggle on={s.forceMfa} onToggle={() => canManage && patch({ forceMfa: !s.forceMfa })} label="Force MFA" /></label>
        <label className="flex items-center justify-between"><span className="text-[12px] font-semibold text-t1">Failed-login lockout</span><Toggle on={s.failedLoginLockout} onToggle={() => canManage && patch({ failedLoginLockout: !s.failedLoginLockout })} label="Failed login lockout" /></label>
        <div className="flex items-center justify-between"><span className="text-[12px] font-semibold text-t1">Access-token lifetime</span>
          <select aria-label="Access-token lifetime" disabled={!canManage || busy} value={s.sessionTimeoutMinutes} onChange={e => patch({ sessionTimeoutMinutes: Number(e.target.value) })} className="rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-2 py-1 text-xs"><option value={15}>15 min</option><option value={30}>30 min</option><option value={60}>60 min</option><option value={120}>2 hours</option><option value={480}>8 hours</option></select>
        </div>
        <p className="text-[11px] text-t3">Planned IP restrictions (record only; not enforced): {s.ipAllowlist.length ? s.ipAllowlist.join(', ') : 'none recorded'}</p>
        {canManage && <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason for change (required, audited)…" className={fieldCls} />}
        {msg && <p className="text-[11px] text-emerald-v">{msg}</p>}
      </div>
      {canManage && (
        <ReasonAction label="Revoke all sessions" desc="Immediately invalidates every active access token for this tenant; users must sign in again." action="Revoke sessions" tone="red" onConfirm={async (r) => { await platformAdmin.revokeSessions(tid, r); await load(); }} />
      )}
    </div>
  );
}

function SupportAccessRow({ tid }: { tid: string }) {
  return (
    <ReasonAction label="Enter support mode" desc="Starts a time-limited, audited support session for this tenant (default 60 min)." action="Start support session" tone="amber"
      onConfirm={async (reason) => { await platformAdmin.startSupport(tid, reason, 60); }} />
  );
}
function DangerRow({ label, desc, action, tone = 'red', onConfirm, busy }: { label: string; desc: string; action: string; tone?: 'red' | 'emerald'; onConfirm: () => void; busy: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const isRed = tone === 'red';
  const txt = isRed ? 'text-red-v' : 'text-emerald-v';
  const solid = isRed ? 'bg-[var(--red)]' : 'bg-[var(--emerald)]';
  const outline = isRed ? 'border-[rgba(220,38,38,0.4)]' : 'border-[rgba(5,150,105,0.4)]';
  return (
    <div className={`rounded-xl border px-3 py-3 ${isRed ? 'border-[rgba(220,38,38,0.25)] bg-red-soft' : 'border-[rgba(5,150,105,0.25)] bg-emerald-soft'}`}>
      <p className={`text-sm font-bold ${txt}`}>{label}</p>
      <p className="text-[11px] text-t2 mt-0.5">{desc}</p>
      {!confirm ? (
        <button type="button" onClick={() => setConfirm(true)} className={`mt-2 rounded-lg border px-3 py-1.5 text-[11px] font-semibold ${txt} ${outline} hover:opacity-80`}>{action}</button>
      ) : (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[11px] text-t2">Confirm?</span>
          <button type="button" disabled={busy} onClick={onConfirm} className={`rounded-lg px-3 py-1.5 text-[11px] font-semibold text-white ${solid} hover:opacity-90 disabled:opacity-50`}>{busy ? '…' : `Yes, ${action.toLowerCase()}`}</button>
          <button type="button" onClick={() => setConfirm(false)} className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-[11px] font-semibold text-t2">Cancel</button>
        </div>
      )}
    </div>
  );
}

/**
 * The operator's own account.
 *
 * Changing your own password had no path in the console at all - rotating an
 * operator credential meant a database write - and MFA was unconditional, so an
 * operator could neither turn it off nor see whose decision it was.
 */
function MyAccountSection({ me, onReauthenticated }: { me: PlatformMe | null; onReauthenticated: (me: PlatformMe) => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState<'password' | 'mfa' | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const [mfaPassword, setMfaPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [mfaMsg, setMfaMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const field = 'w-full rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm text-t1 outline-none focus:border-[var(--indigo)]';
  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmitPassword = current.length > 0 && next.length >= 8 && !mismatch && next !== current;

  async function changePassword() {
    setBusy('password'); setMsg(null);
    try {
      const result = await platformAdmin.changeOwnPassword(current, next);
      // The server issues a fresh token because the change signs out every
      // other session; without adopting it we would sign ourselves out too.
      setPlatformToken(result.token);
      onReauthenticated(result.user);
      setCurrent(''); setNext(''); setConfirm('');
      setMsg({ tone: 'ok', text: 'Password changed. Every other session has been signed out.' });
    } catch (e) {
      setMsg({ tone: 'bad', text: e instanceof Error ? e.message : 'Password change failed' });
    } finally { setBusy(null); }
  }

  async function disableMfa() {
    setBusy('mfa'); setMfaMsg(null);
    try {
      await platformAdmin.disableOwnMfa(mfaPassword, mfaCode.trim());
      setMfaPassword(''); setMfaCode('');
      const refreshed = await platformAdmin.me();
      onReauthenticated(refreshed);
      setMfaMsg({ tone: 'ok', text: 'MFA is off for your account. You will sign in with your password alone.' });
    } catch (e) {
      setMfaMsg({ tone: 'bad', text: e instanceof Error ? e.message : 'Could not turn MFA off' });
    } finally { setBusy(null); }
  }

  if (!me) return <div className="py-10 text-center"><Loader2 className="inline w-5 h-5 animate-spin text-indigo" /></div>;
  if (me.legacy) {
    return (
      <Panel title="My account" subtitle="Signed in with the legacy operator token">
        <p className="text-sm text-t2">The legacy operator token is not an account: it has no password and no second factor. Sign in as a platform operator to manage credentials.</p>
      </Panel>
    );
  }

  return (
    <div className="space-y-5">
      <Panel title="My account" subtitle={`${me.name} · ${me.email ?? 'no email on file'} · ${me.role.replace('PLATFORM_', '')}`}>
        <div className="grid sm:grid-cols-2 gap-4 max-w-2xl">
          <label className="block space-y-1"><span className="text-[11px] font-semibold text-t3">Current password</span>
            <input className={field} type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} /></label>
          <div />
          <label className="block space-y-1"><span className="text-[11px] font-semibold text-t3">New password</span>
            <input className={field} type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} />
            <span className="text-[10px] text-t3">At least 8 characters. The server policy is the authority and may require more.</span></label>
          <label className="block space-y-1"><span className="text-[11px] font-semibold text-t3">Confirm new password</span>
            <input className={field} type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} />
            {mismatch && <span className="text-[10px] text-red-v">Those two do not match.</span>}</label>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <button type="button" disabled={busy !== null || !canSubmitPassword} onClick={() => void changePassword()} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
            {busy === 'password' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />} Change password
          </button>
          {msg && <span className={`text-[12px] ${msg.tone === 'ok' ? 'text-emerald-v' : 'text-red-v'}`} role="status">{msg.text}</span>}
        </div>
        <p className="mt-2 text-[11px] text-t3">Changing your password signs out every other session, on every device.</p>
      </Panel>

      <Panel title="Two-factor authentication" subtitle={me.mfaEnabled ? 'Enabled on your account' : 'Not enabled on your account'}>
        {me.mfaRequired ? (
          <p className="text-sm text-t2">
            This platform requires MFA for every operator, so it cannot be turned off here.
            An owner can change that in <span className="font-semibold text-t1">Platform Settings</span> — it applies to all operators, not just you.
          </p>
        ) : !me.mfaEnabled ? (
          <p className="text-sm text-t2">MFA is off for your account and this platform does not require it. Sign out and back in to enrol.</p>
        ) : (
          <>
            <p className="text-sm text-t2 mb-3">
              Turning MFA off means your password alone reaches every tenant&apos;s commercial record. Prove both factors to confirm.
            </p>
            <div className="grid sm:grid-cols-2 gap-4 max-w-2xl">
              <label className="block space-y-1"><span className="text-[11px] font-semibold text-t3">Password</span>
                <input className={field} type="password" autoComplete="current-password" value={mfaPassword} onChange={e => setMfaPassword(e.target.value)} /></label>
              <label className="block space-y-1"><span className="text-[11px] font-semibold text-t3">Current 6-digit code</span>
                <input className={field} inputMode="numeric" value={mfaCode} onChange={e => setMfaCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))} /></label>
            </div>
            <div className="mt-4 flex items-center gap-3">
              <button type="button" disabled={busy !== null || mfaPassword.length === 0 || mfaCode.trim().length < 6} onClick={() => void disableMfa()} className="inline-flex items-center gap-1.5 rounded-lg border border-[rgba(220,38,38,0.25)] px-4 py-2 text-sm font-semibold text-red-v hover:bg-red-soft disabled:opacity-50">
                {busy === 'mfa' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ban className="w-4 h-4" />} Turn MFA off
              </button>
              {mfaMsg && <span className={`text-[12px] ${mfaMsg.tone === 'ok' ? 'text-emerald-v' : 'text-red-v'}`} role="status">{mfaMsg.text}</span>}
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}

function PlatformSettingsSection({ canManage }: { canManage: boolean }) {
  const [cfg, setCfg] = useState<PlatformSettings | null>(null);
  const [presets, setPresets] = useState<PlatformSettingPreset[]>([]);
  const [plans, setPlans] = useState<Array<{ key: string; name: string }>>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  useEffect(() => { let alive = true; void (async () => {
    try {
      const [settings, presetList, planList] = await Promise.all([
        platformAdmin.getSettings(),
        platformAdmin.settingPresets().then(r => r.presets).catch(() => [] as PlatformSettingPreset[]),
        platformAdmin.plans().catch(() => [] as Array<{ key: string; name: string }>),
      ]);
      if (!alive) return;
      setCfg(settings); setPresets(presetList); setPlans(planList);
    } catch (e) {
      // Without this the page was an eternal spinner on any 401/500 - which is
      // exactly what "the settings page is dead" looked like from the outside.
      if (alive) setLoadError(e instanceof Error ? e.message : 'Platform settings could not be loaded');
    }
  })(); return () => { alive = false; }; }, []);

  function patch(next: Partial<PlatformSettings>) { setCfg(prev => (prev ? { ...prev, ...next } : prev)); setMsg(null); }
  function applyPreset(key: string) {
    const preset = presets.find(p => p.key === key);
    // A preset fills the form; it does not lock anything. The operator can edit
    // every field afterwards and only the Save writes.
    if (preset) patch({ ...preset.values, presetKey: preset.key });
    else patch({ presetKey: 'custom' });
  }
  async function save() {
    if (!cfg) return;
    setBusy(true); setMsg(null);
    try {
      const saved = await platformAdmin.updateSettings({
        platformName: cfg.platformName.trim(), supportEmail: cfg.supportEmail?.trim() || null,
        defaultTrialDays: cfg.defaultTrialDays, defaultPlanKey: cfg.defaultPlanKey,
        defaultTimezone: cfg.defaultTimezone.trim(), defaultCountry: cfg.defaultCountry.trim().toUpperCase(),
        defaultBranchName: cfg.defaultBranchName.trim(), defaultVoiceMinutes: cfg.defaultVoiceMinutes,
        requireMfaFloor: cfg.requireMfaFloor, sessionTimeoutMaxMinutes: cfg.sessionTimeoutMaxMinutes,
        requireOperatorMfa: cfg.requireOperatorMfa,
        presetKey: cfg.presetKey,
      });
      setCfg(saved); // show what the server stored, not what we sent
      setMsg({ tone: 'ok', text: 'Saved. New companies provision with these values.' });
    } catch (e) { setMsg({ tone: 'bad', text: e instanceof Error ? e.message : 'Save failed' }); }
    finally { setBusy(false); }
  }

  const field = 'w-full rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm text-t1 outline-none focus:border-[var(--indigo)]';
  const hint = 'text-[10px] text-t3';
  if (loadError) return <Panel title="Platform settings" subtitle="Global configuration applied to new tenant provisioning"><p className="text-sm text-red-v" role="alert">{loadError}</p></Panel>;
  if (!cfg) return <div className="py-10 text-center"><Loader2 className="inline w-5 h-5 animate-spin text-indigo" /></div>;
  return (
    <Panel title="Platform settings" subtitle="Every field here is read when you provision a company. Nothing on this page is decorative.">
      <div className="max-w-3xl space-y-5">
        <label className="block space-y-1">
          <span className="text-[11px] font-semibold text-t3">Start from a preset</span>
          <select aria-label="Settings preset" disabled={!canManage} className={field} value={cfg.presetKey} onChange={e => applyPreset(e.target.value)}>
            <option value="custom">Custom (current values)</option>
            {presets.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
          <span className={hint}>{presets.find(p => p.key === cfg.presetKey)?.description ?? 'A preset fills the fields below; you can edit any of them before saving.'}</span>
        </label>

        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-t3 mb-2">Provisioning defaults</p>
          <div className="grid sm:grid-cols-2 gap-4">
            <label className="block space-y-1"><span className="text-[11px] font-semibold text-t3">Default plan for new companies</span>
              <select aria-label="Default plan" disabled={!canManage || !plans.length} className={field} value={cfg.defaultPlanKey} onChange={e => patch({ defaultPlanKey: e.target.value, presetKey: 'custom' })}>
                {plans.length ? plans.map(p => <option key={p.key} value={p.key}>{p.name}</option>) : <option value={cfg.defaultPlanKey}>{cfg.defaultPlanKey}</option>}
              </select>
              {!plans.length && <span className="text-[10px] text-amber-v">Plan catalog unavailable - showing the stored key.</span>}
            </label>
            <label className="block space-y-1"><span className="text-[11px] font-semibold text-t3">Default trial length (days)</span>
              <input disabled={!canManage} className={field} inputMode="numeric" value={String(cfg.defaultTrialDays)} onChange={e => patch({ defaultTrialDays: Number(e.target.value.replace(/[^0-9]/g, '') || 0), presetKey: 'custom' })} />
              <span className={hint}>0 means the company starts active with no trial.</span></label>
            <label className="block space-y-1"><span className="text-[11px] font-semibold text-t3">Default clinic timezone</span>
              <input disabled={!canManage} className={field} value={cfg.defaultTimezone} onChange={e => patch({ defaultTimezone: e.target.value, presetKey: 'custom' })} placeholder="America/New_York" />
              <span className={hint}>IANA name. Used when the create form leaves timezone blank.</span></label>
            <label className="block space-y-1"><span className="text-[11px] font-semibold text-t3">Default country</span>
              <input disabled={!canManage} className={field} maxLength={2} value={cfg.defaultCountry} onChange={e => patch({ defaultCountry: e.target.value.toUpperCase(), presetKey: 'custom' })} placeholder="US" />
              <span className={hint}>ISO-3166 alpha-2. Drives locale and emergency-number handling.</span></label>
            <label className="block space-y-1"><span className="text-[11px] font-semibold text-t3">Default first branch name</span>
              <input disabled={!canManage} className={field} value={cfg.defaultBranchName} onChange={e => patch({ defaultBranchName: e.target.value, presetKey: 'custom' })} placeholder="Main Branch" /></label>
            <label className="block space-y-1"><span className="text-[11px] font-semibold text-t3">Included voice minutes</span>
              <input disabled={!canManage} className={field} inputMode="numeric" value={String(cfg.defaultVoiceMinutes)} onChange={e => patch({ defaultVoiceMinutes: Number(e.target.value.replace(/[^0-9]/g, '') || 0), presetKey: 'custom' })} />
              <span className={hint}>Seeds the new tenant&apos;s voice quota. Calls are refused once it is reached unless overage is allowed.</span></label>
          </div>
        </div>

        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-t3 mb-2">Security floor for new companies</p>
          <p className="text-[11px] text-t3 mb-2">A floor, not a setting: a clinic can make its own security stricter than this, never weaker.</p>
          <div className="grid sm:grid-cols-2 gap-4">
            <label className="flex items-center gap-2 text-sm text-t2">
              <input type="checkbox" disabled={!canManage} checked={cfg.requireMfaFloor} onChange={e => patch({ requireMfaFloor: e.target.checked, presetKey: 'custom' })} />
              Require MFA from day one
            </label>
            <label className="block space-y-1"><span className="text-[11px] font-semibold text-t3">Maximum session length (minutes)</span>
              <input disabled={!canManage} className={field} inputMode="numeric" value={String(cfg.sessionTimeoutMaxMinutes)} onChange={e => patch({ sessionTimeoutMaxMinutes: Number(e.target.value.replace(/[^0-9]/g, '') || 0), presetKey: 'custom' })} /></label>
          </div>
        </div>

        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-t3 mb-2">Your own operators</p>
          <div className="grid gap-2">
            <label className="flex items-start gap-2 text-sm text-t2">
              <input type="checkbox" className="mt-1" disabled={!canManage} checked={cfg.requireOperatorMfa} onChange={e => patch({ requireOperatorMfa: e.target.checked })} />
              <span>
                Require MFA for every Control Tower operator
                <span className="block text-[11px] text-t3">
                  These accounts reach every tenant&apos;s commercial record. Turning this off lets an operator sign in with a password alone, and lets each
                  operator remove their own second factor from My Account. Operators who have already enrolled keep being asked for their code.
                </span>
              </span>
            </label>
          </div>
        </div>

        <div>
          <p className="text-[11px] font-bold uppercase tracking-wide text-t3 mb-2">Operator branding</p>
          <div className="grid sm:grid-cols-2 gap-4">
            <label className="block space-y-1"><span className="text-[11px] font-semibold text-t3">Platform name</span>
              <input disabled={!canManage} className={field} value={cfg.platformName} onChange={e => patch({ platformName: e.target.value })} /></label>
            <label className="block space-y-1"><span className="text-[11px] font-semibold text-t3">Support email</span>
              <input disabled={!canManage} className={field} type="email" value={cfg.supportEmail ?? ''} onChange={e => patch({ supportEmail: e.target.value })} placeholder="support@…" /></label>
          </div>
        </div>

        {canManage ? (
          <div className="flex items-center gap-3">
            <button type="button" disabled={busy || cfg.platformName.trim().length < 2} onClick={() => void save()} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Settings className="w-4 h-4" />} Save settings</button>
            {msg && <span className={`text-[12px] ${msg.tone === 'ok' ? 'text-emerald-v' : 'text-red-v'}`} role="status">{msg.text}</span>}
            <span className={hint}>Last saved {new Date(cfg.updatedAt).toLocaleString()}</span>
          </div>
        ) : <p className={hint}>Your platform role can view these settings but not change them.</p>}
      </div>
    </Panel>
  );
}

/* ─────────────────────────────────────────────────────────── */
const KPI_ICON: Record<string, string> = {
  indigo: 'stat-icon-indigo', emerald: 'stat-icon-emerald', red: 'stat-icon-red', amber: 'stat-icon-amber', violet: 'stat-icon-violet',
};
function Kpi({ icon: Icon, variant, label, value }: { icon: React.ElementType; variant: string; label: string; value: number }) {
  return (
    <div className="cc-card p-4 flex items-center gap-3">
      <div className={`stat-icon ${KPI_ICON[variant]}`}><Icon className="w-4 h-4" /></div>
      <div className="min-w-0">
        <p className="text-2xl font-bold text-t1 leading-none tracking-tight tabular-nums">{value}</p>
        <p className="text-[11px] text-t3 mt-1 truncate">{label}</p>
      </div>
    </div>
  );
}

function SystemStatus({ expanded }: { expanded?: boolean } = {}) {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try { setHealth(await platformAdmin.health()); setError(false); }
    catch { setError(true); }
    finally { setRefreshing(false); }
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => { try { const h = await platformAdmin.health(); if (active) setHealth(h); } catch { if (active) setError(true); } })();
    const t = setInterval(() => { void load(); }, 30000); // auto-refresh every 30s
    return () => { active = false; clearInterval(t); };
  }, [load]);

  const items: Array<{ icon: React.ElementType; label: string; state: string; detail?: string }> = [
    { icon: Wifi, label: 'API connectivity', state: error ? 'down' : (health?.api ?? 'checking'), detail: health ? `${health.responseMs}ms` : undefined },
    { icon: Database, label: 'Database', state: error ? 'down' : (health?.database ?? 'checking'), detail: health?.dbLatencyMs != null ? `${health.dbLatencyMs}ms` : undefined },
    { icon: Server, label: 'Redis / queue', state: error ? 'down' : (health?.redis ?? 'checking'), detail: undefined },
  ];
  const dot = (s: string) => s === 'ok' ? 'bg-emerald-v' : s === 'checking' ? 'bg-amber-v' : 'bg-red-v';
  const txt = (s: string) => s === 'ok' ? 'text-emerald-v' : s === 'checking' ? 'text-amber-v' : 'text-red-v';

  return (
    <div className="cc-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-indigo" />
          <p className="text-sm font-bold text-t1">System status</p>
          {health && <span className="text-[10px] text-t3">checked {new Date(health.checkedAt).toLocaleTimeString()}</span>}
        </div>
        <button type="button" onClick={() => void load()} className="topbar-icon-btn" title="Refresh" aria-label="Refresh status">
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {items.map(it => (
          <div key={it.label} className="flex items-center gap-3 rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-3 py-2.5">
            <div className="w-8 h-8 rounded-lg bg-[var(--s1)] border border-[var(--b1)] grid place-items-center shrink-0"><it.icon className="w-4 h-4 text-t2" /></div>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-semibold text-t1 truncate">{it.label}</p>
              <p className={`text-[11px] font-semibold flex items-center gap-1.5 ${txt(it.state)}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${dot(it.state)} ${it.state === 'ok' ? 'live-dot' : ''}`} />
                {it.state === 'ok' ? 'Operational' : it.state === 'checking' ? 'Checking…' : 'Unavailable'}
                {it.detail && <span className="text-t3 font-normal">· {it.detail}</span>}
              </p>
            </div>
          </div>
        ))}
      </div>
      {expanded && (
        <div className="mt-3 rounded-xl border border-dashed border-[var(--b2)] bg-[var(--s2)] px-3 py-2.5 text-[11px] text-t3">
          Downstream provider health (email/SMS, payment webhooks, insurance API) and failed-job retry are available in the <span className="font-semibold text-t2">Integrations</span> section.
        </div>
      )}
    </div>
  );
}

function Panel({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="cc-card overflow-hidden">
      <div className="bento-header">
        <div>
          <p className="bento-title">{title}</p>
          {subtitle && <p className="text-[11px] text-t3 mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="bento-body pt-0">{children}</div>
    </div>
  );
}

/**
 * A load that failed is not an empty list. Rendering "you're all caught up"
 * over a 500 is a correctness lie, so every list below distinguishes the two.
 */
function LoadFailure({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center gap-2" role="alert">
      <div className="w-11 h-11 rounded-xl bg-red-soft grid place-items-center"><Ban className="w-5 h-5 text-red-v" /></div>
      <p className="text-[13px] font-semibold text-red-v">Could not load this list</p>
      <p className="text-[11px] text-t3 max-w-md">{message}</p>
      {onRetry && <button type="button" onClick={onRetry} className="mt-1 rounded-lg border border-[var(--b1)] px-3 py-1.5 text-[11px] font-semibold text-t2 hover:bg-[var(--s1)]">Try again</button>}
    </div>
  );
}

function EmptyState({ icon: Icon, text }: { icon: React.ElementType; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="w-11 h-11 rounded-xl bg-[var(--s3)] grid place-items-center mb-3"><Icon className="w-5 h-5 text-t3" /></div>
      <p className="text-[13px] text-t3">{text}</p>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────── */
// canManage was computed at the top of the console and never reached here, so
// a PLATFORM_SUPPORT / BILLING / AUDITOR operator was handed fully enabled
// provisioning, plan, suspend and entitlement controls that 403 on click.
function TenantsTab({ canManage, onOpenTenant }: { canManage: boolean; onOpenTenant?: (t: TenantSummary) => void }) {
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [plans, setPlans] = useState<Array<{ key: string; name: string }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // A failed plan catalog used to be indistinguishable from an empty one, so a
  // broken/unmigrated catalog rendered as a healthy single "Starter" option and
  // provisioning then 400'd with "Subscription catalog is not seeded".
  const [plansError, setPlansError] = useState<string | null>(null);
  const loadPlans = useCallback(async () => {
    try { const p = await platformAdmin.plans(); setPlansError(p.length ? null : 'The plan catalog is empty. Run the subscription catalog migration before provisioning.'); return p; }
    catch (e) { setPlansError(e instanceof Error ? e.message : 'Plan catalog could not be loaded'); return []; }
  }, []);
  const reload = useCallback(async () => {
    const [t, p] = await Promise.all([platformAdmin.tenants(), loadPlans()]);
    setTenants(t); setPlans(p);
  }, [loadPlans]);
  useEffect(() => { let a = true; void (async () => { const [t, p] = await Promise.all([platformAdmin.tenants(), loadPlans()]); if (a) { setTenants(t); setPlans(p); } })(); return () => { a = false; }; }, [loadPlans]);

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(id); setError(null);
    try { await fn(); await reload(); } catch (e) { setError(e instanceof Error ? e.message : 'Action failed'); } finally { setBusy(null); }
  }

  const rows = useMemo(() => tenants.filter(t => t.tenant &&
    (`${t.tenant.name} ${t.tenant.slug}`.toLowerCase().includes(q.toLowerCase()))), [tenants, q]);

  return (
    <Panel title="Tenant directory" subtitle={`${tenants.length} clinic ${tenants.length === 1 ? 'organization' : 'organizations'} provisioned`}
      action={
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-2.5 py-1.5 w-44">
            <Search className="w-3.5 h-3.5 text-t3 shrink-0" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search…" className="w-full bg-transparent text-xs text-t1 outline-none placeholder:text-t3" />
          </div>
          {canManage
            ? (
              <button type="button" onClick={() => setCreating(v => !v)} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">
                <Building2 className="w-3.5 h-3.5" /> New company
              </button>
            )
            : <span className="text-[11px] text-t3">Your platform role cannot provision companies.</span>}
        </div>
      }>
      {creating && <CreateCompanyForm plans={plans} plansError={plansError} onCancel={() => setCreating(false)} onCreated={async () => { setCreating(false); await reload(); }} />}
      {error && <div className="mb-3 rounded-lg bg-red-soft border border-[rgba(220,38,38,0.18)] px-3 py-2 text-xs text-red-v">{error}</div>}
      {rows.length === 0 ? <EmptyState icon={Building2} text={q ? 'No tenants match your search.' : 'No tenants provisioned yet.'} /> : (
        <div className="overflow-hidden rounded-xl border border-[var(--b1)] divide-y divide-[var(--b1)]">
          {rows.map(t => t.tenant && (
            <div key={t.tenant.id} className="group px-4 py-3 hover:bg-[var(--s2)] transition-colors">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-indigo-soft grid place-items-center shrink-0 text-[12px] font-bold text-indigo">
                    {t.tenant.name.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-t1 truncate">{t.tenant.name}</p>
                    <p className="text-[11px] text-t3 truncate">
                      /{t.tenant.slug} · {t.activeUsers} users · {t.branches} {t.branches === 1 ? 'branch' : 'branches'} · {t.enabledFeatures} features
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className={`badge ${t.setupStatus === 'configured' ? 'badge-emerald' : 'badge-amber'}`} title="Stored setup status">setup: {t.setupStatus}</span>
                  <span className={`badge ${TENANT_STATUS_BADGE[t.tenant.status] ?? 'badge-blue'}`}>{t.tenant.status}</span>
                  {t.subscription && <span className={`badge ${SUB_STATUS_BADGE[t.subscription.status] ?? 'badge-blue'}`}>{t.subscription.planKey} · {t.subscription.status.toLowerCase()}</span>}
                </div>
              </div>
              <p className="text-[10px] text-t3 pl-12 mt-1">Last activity {new Date(t.tenant.lastActivityAt).toLocaleDateString()}</p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-12">
                <select aria-label="Change plan" disabled={busy === t.tenant.id} defaultValue=""
                  onChange={e => e.target.value && act(t.tenant!.id, () => platformAdmin.changePlan(t.tenant!.id, e.target.value))}
                  className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-2.5 py-1 text-[11px] font-medium text-t2 hover:border-[var(--b2)] cursor-pointer">
                  <option value="">Change plan…</option>
                  {plans.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
                </select>
                {t.tenant.status === 'active' ? (
                  <button type="button" disabled={busy === t.tenant.id} onClick={() => act(t.tenant!.id, () => platformAdmin.suspend(t.tenant!.id))}
                    className="inline-flex items-center gap-1 rounded-lg border border-[rgba(220,38,38,0.2)] bg-red-soft px-2.5 py-1 text-[11px] font-semibold text-red-v hover:opacity-80 disabled:opacity-50">
                    {busy === t.tenant.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Ban className="w-3 h-3" />} Suspend
                  </button>
                ) : (
                  <button type="button" disabled={busy === t.tenant.id} onClick={() => act(t.tenant!.id, () => platformAdmin.reactivate(t.tenant!.id))}
                    className="inline-flex items-center gap-1 rounded-lg border border-[rgba(5,150,105,0.2)] bg-emerald-soft px-2.5 py-1 text-[11px] font-semibold text-emerald-v hover:opacity-80 disabled:opacity-50">
                    {busy === t.tenant.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} Reactivate
                  </button>
                )}
                <button type="button" onClick={() => setExpanded(prev => prev === t.tenant!.id ? null : t.tenant!.id)}
                  className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-t2 hover:bg-[var(--s3)]">
                  <SlidersHorizontal className="w-3 h-3" /> Manage features
                  {expanded === t.tenant.id ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                </button>
                {onOpenTenant && (
                  <button type="button" onClick={() => onOpenTenant(t)}
                    className="inline-flex items-center gap-1 rounded-lg bg-[var(--indigo)] px-2.5 py-1 text-[11px] font-semibold text-white hover:opacity-90">
                    <Gauge className="w-3 h-3" /> Open Control Center
                  </button>
                )}
              </div>
              {expanded === t.tenant.id && <TenantFeatureControls tenantId={t.tenant.id} canManage={canManage} onChanged={reload} />}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* ─────────────────────────────────────────────────────────── */
// Mirrors PLATFORM_SLUG_PATTERN in server/modules/platform/routes.ts, which in
// turn mirrors app_platform_provision_tenant. Three copies, one contract.
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

function CreateCompanyForm({ plans, plansError, onCancel, onCreated }: { plans: Array<{ key: string; name: string }>; plansError?: string | null; onCancel: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [planKey, setPlanKey] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [branch, setBranch] = useState('Main Branch');
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York');
  // Seed the form from Platform Settings so the operator can SEE the platform
  // defaults being applied. Previously the plan was hardcoded 'starter' here,
  // which meant Platform Settings' "default plan" could never take effect.
  useEffect(() => {
    let alive = true;
    void platformAdmin.getSettings().then(cfg => {
      if (!alive) return;
      setPlanKey(prev => prev || cfg.defaultPlanKey);
      setBranch(prev => (prev === 'Main Branch' ? cfg.defaultBranchName : prev));
      if (cfg.defaultTimezone) setTimezone(prev => prev || cfg.defaultTimezone);
    }).catch(() => { setPlanKey(prev => prev || 'starter'); });
    return () => { alive = false; };
  }, []);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ email: string } | null>(null);

  const autoSlug = (v: string) => v.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const inputCls = 'w-full rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm text-t1 outline-none focus:border-[var(--indigo)]';

  async function submit() {
    setBusy(true); setError(null);
    try {
      await platformAdmin.createTenant({ name: name.trim(), slug: slug.trim(), planKey, ownerName: ownerName.trim(), ownerEmail: ownerEmail.trim(), ownerPassword, defaultBranchName: branch.trim() || 'Main Branch', timezone });
      setOwnerPassword('');
      setDone({ email: ownerEmail.trim() });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create company');
    } finally { setBusy(false); }
  }

  if (done) {
    return (
      <div className="mb-4 rounded-xl border border-[rgba(5,150,105,0.25)] bg-emerald-soft p-4">
        <p className="text-sm font-bold text-emerald-v flex items-center gap-2"><CircleCheck className="w-4 h-4" /> Company created</p>
        <p className="text-[12px] text-t2 mt-1.5">The client can now sign in at the clinic login with <span className="font-semibold">{done.email}</span>. Deliver the initial password through your approved secure channel; it is not displayed or retained here.</p>
        <div className="mt-3 rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-[12px] text-t2">
          <p><span className="font-semibold text-t1">Email:</span> {done.email}</p>
        </div>
        <button type="button" onClick={onCreated} className="mt-3 rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">Done</button>
      </div>
    );
  }

  // Every unmet requirement is named. A greyed-out button that will not say
  // what it wants is indistinguishable from a broken button.
  const issues: Array<{ field: string; message: string }> = [];
  if (name.trim().length < 2) issues.push({ field: 'name', message: 'Company name needs at least 2 characters.' });
  if (!SLUG_PATTERN.test(slug.trim())) issues.push({ field: 'slug', message: 'Slug must be 3-40 characters: lowercase letters, numbers, and inner hyphens.' });
  if (ownerName.trim().length < 2) issues.push({ field: 'ownerName', message: 'Owner name needs at least 2 characters.' });
  if (!/.+@.+\..+/.test(ownerEmail)) issues.push({ field: 'ownerEmail', message: 'Owner email must be a valid address.' });
  if (ownerPassword.length < 8) issues.push({ field: 'ownerPassword', message: 'Initial password needs at least 8 characters.' });
  if (!planKey) issues.push({ field: 'planKey', message: 'Choose a plan.' });
  if (plansError) issues.push({ field: 'planKey', message: plansError });
  const issueFor = (field: string) => issues.find(i => i.field === field)?.message;
  const canSubmit = issues.length === 0;
  return (
    <div className="mb-4 rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-4 space-y-3">
      <p className="text-[12px] font-bold uppercase tracking-wide text-t3">Create a client company</p>
      {error && <p className="text-xs text-red-v" role="alert">{error}</p>}
      {plansError && <p className="text-xs text-amber-v" role="alert">{plansError}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block space-y-1"><span className="text-[10px] font-semibold text-t3">Company name</span>
          <input className={inputCls} value={name} onChange={e => { setName(e.target.value); if (!slugEdited) setSlug(autoSlug(e.target.value)); }} placeholder="Sunrise Dental Group" />
          {touched && issueFor('name') && <span className="text-[10px] text-red-v">{issueFor('name')}</span>}</label>
        <label className="block space-y-1"><span className="text-[10px] font-semibold text-t3">Slug (URL id)</span>
          <input className={inputCls} value={slug} onChange={e => { setSlug(autoSlug(e.target.value)); setSlugEdited(true); }} placeholder="sunrise-dental" />
          {touched && issueFor('slug') ? <span className="text-[10px] text-red-v">{issueFor('slug')}</span> : <span className="text-[10px] text-t3">3-40 characters, lowercase.</span>}</label>
        <label className="block space-y-1"><span className="text-[10px] font-semibold text-t3">Plan</span>
          <select aria-label="Plan" className={inputCls} value={planKey} onChange={e => setPlanKey(e.target.value)} disabled={!plans.length}>
            {plans.length ? plans.map(p => <option key={p.key} value={p.key}>{p.name}</option>) : <option value="">No plans available</option>}
          </select></label>
        <label className="block space-y-1"><span className="text-[10px] font-semibold text-t3">Default branch</span>
          <input className={inputCls} value={branch} onChange={e => setBranch(e.target.value)} placeholder="Main Branch" /></label>
        <label className="block space-y-1"><span className="text-[10px] font-semibold text-t3">Clinic timezone</span>
          <input className={inputCls} value={timezone} onChange={e => setTimezone(e.target.value)} placeholder="America/New_York" /></label>
      </div>
      <div className="border-t border-[var(--b1)] pt-3">
        <p className="text-[10px] font-semibold text-t3 mb-2">OWNER LOGIN (the client signs in with these)</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="block space-y-1"><span className="text-[10px] font-semibold text-t3">Owner name</span>
            <input className={inputCls} value={ownerName} onChange={e => setOwnerName(e.target.value)} placeholder="Dr. Jane Doe" />
            {touched && issueFor('ownerName') && <span className="text-[10px] text-red-v">{issueFor('ownerName')}</span>}</label>
          <label className="block space-y-1"><span className="text-[10px] font-semibold text-t3">Owner email</span>
            <input className={inputCls} type="email" value={ownerEmail} onChange={e => setOwnerEmail(e.target.value)} placeholder="owner@clinic.com" />
            {touched && issueFor('ownerEmail') && <span className="text-[10px] text-red-v">{issueFor('ownerEmail')}</span>}</label>
          <label className="block space-y-1"><span className="text-[10px] font-semibold text-t3">Initial password (min 8)</span>
            <input className={inputCls} type="password" autoComplete="new-password" value={ownerPassword} onChange={e => setOwnerPassword(e.target.value)} placeholder="Set an initial password" />
            {touched && issueFor('ownerPassword') ? <span className="text-[10px] text-red-v">{issueFor('ownerPassword')}</span> : <span className="text-[10px] text-t3">The server password policy is the authority and may require more.</span>}</label>
        </div>
      </div>
      <div className="space-y-2">
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={() => { setTouched(true); if (canSubmit) void submit(); }} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Building2 className="w-4 h-4" />} Create company</button>
          <button type="button" onClick={onCancel} className="rounded-lg border border-[var(--b1)] px-4 py-2 text-sm font-semibold text-t2 hover:bg-[var(--s3)]">Cancel</button>
        </div>
        {!canSubmit && (
          <p className="text-[11px] text-t3">
            Still needed: {issues.map(i => i.message.replace(/\.$/, '')).join('; ')}.
          </p>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────── */
function TenantFeatureControls({ tenantId, canManage, onChanged }: { tenantId: string; canManage: boolean; onChanged: () => void }) {
  const [ents, setEnts] = useState<Array<{ featureKey: string; enabled: boolean; source: string; limitValue: number | null }> | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const detail = await platformAdmin.tenant(tenantId);
    setEnts(detail.entitlements ?? []);
  }, [tenantId]);
  useEffect(() => { let a = true; void (async () => { try { const d = await platformAdmin.tenant(tenantId); if (a) setEnts(d.entitlements ?? []); } catch { if (a) setError('Failed to load features'); } })(); return () => { a = false; }; }, [tenantId]);

  async function toggle(featureKey: string, enabled: boolean) {
    setBusyKey(featureKey); setError(null);
    try { await platformAdmin.overrideEntitlement(tenantId, featureKey, enabled); await load(); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Update failed'); }
    finally { setBusyKey(null); }
  }

  // Order features by the catalog labels; include any extra keys returned.
  const keys = Object.keys(FEATURE_LABELS);
  const byKey = new Map((ents ?? []).map(e => [e.featureKey, e]));
  for (const e of ents ?? []) if (!keys.includes(e.featureKey)) keys.push(e.featureKey);

  return (
    <div className="mt-3 ml-12 rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] font-bold uppercase tracking-wide text-t3">Premium feature entitlements</p>
        {ents && <p className="text-[10px] text-t3">{ents.filter(e => e.enabled).length}/{ents.length} enabled</p>}
      </div>
      {error && <p className="text-[11px] text-red-v mb-2">{error}</p>}
      {!ents ? <div className="py-4 text-center"><Loader2 className="inline w-4 h-4 animate-spin text-indigo" /></div> : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {keys.map(key => {
            const e = byKey.get(key);
            const enabled = e?.enabled ?? false;
            const overridden = e?.source === 'platform_override';
            return (
              <div key={key} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-2">
                <div className="min-w-0">
                  <p className="text-[12px] font-semibold text-t1 truncate">{FEATURE_LABELS[key] ?? key}</p>
                  <p className="text-[10px] text-t3">{overridden ? 'platform override' : `via ${e?.source ?? 'plan'}`}{e?.limitValue != null ? ` · limit ${e.limitValue}` : ''}</p>
                </div>
                <button type="button" role="switch" aria-checked={enabled ? 'true' : 'false'} aria-label={`Toggle ${FEATURE_LABELS[key] ?? key}`}
                  disabled={busyKey === key || !canManage} title={canManage ? undefined : 'Your platform role cannot change entitlements'} onClick={() => toggle(key, !enabled)}
                  className={`relative w-9 h-5 rounded-full shrink-0 transition-colors disabled:opacity-50 ${enabled ? 'bg-[var(--indigo)]' : 'bg-[var(--b2)]'}`}>
                  {busyKey === key
                    ? <Loader2 className="w-3 h-3 animate-spin text-white absolute top-1 left-3" />
                    : <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${enabled ? 'left-[18px]' : 'left-0.5'}`} />}
                </button>
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-2 text-[10px] text-t3">Toggling sets a platform override for this tenant. Changing the plan re-derives any non-overridden features.</p>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────── */
function RequestsTab() {
  const [rows, setRows] = useState<Array<{ id: string; tenantName: string; requestType: string; status: string; requestedPlanKey: string | null; createdAt: string }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try { setRows(await platformAdmin.requests('PENDING')); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Subscription requests could not be loaded'); }
  }, []);
  useEffect(() => { void (async () => { await reload(); })(); }, [reload]);
  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(id); setError(null);
    try { await fn(); await reload(); }
    catch (e) { setError(e instanceof Error ? e.message : 'That action failed'); }
    finally { setBusy(null); }
  }
  return (
    <Panel title="Subscription requests" subtitle="Plan changes awaiting operator approval">
      {error && rows.length > 0 && <p className="mb-3 text-xs text-red-v" role="alert">{error}</p>}
      {error && rows.length === 0 ? <LoadFailure message={error} onRetry={() => void reload()} />
        : rows.length === 0 ? <EmptyState icon={FileCheck2} text="No pending subscription requests. You're all caught up." /> : (
        <div className="overflow-hidden rounded-xl border border-[var(--b1)] divide-y divide-[var(--b1)]">
          {rows.map(r => (
            <div key={r.id} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-[var(--s2)] transition-colors">
              <div className="flex items-center gap-3 min-w-0">
                <div className="stat-icon stat-icon-amber"><Clock3 className="w-4 h-4" /></div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-t1 truncate">{r.tenantName}</p>
                  <p className="text-[11px] text-t3">
                    {r.requestType.toLowerCase()}{r.requestedPlanKey ? <> → <span className="font-semibold text-t2">{r.requestedPlanKey}</span></> : ''} · {new Date(r.createdAt).toLocaleDateString()}
                  </p>
                </div>
              </div>
              <div className="flex gap-1.5 shrink-0">
                <button type="button" disabled={busy === r.id} onClick={() => act(r.id, () => platformAdmin.approveRequest(r.id))}
                  className="inline-flex items-center gap-1 rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50">
                  {busy === r.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <CircleCheck className="w-3.5 h-3.5" />} Approve
                </button>
                <button type="button" disabled={busy === r.id} onClick={() => act(r.id, () => platformAdmin.rejectRequest(r.id))}
                  className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-[var(--s3)] disabled:opacity-50">Reject</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* ─────────────────────────────────────────────────────────── */
const PLATFORM_ROLE_OPTIONS = ['PLATFORM_OWNER', 'PLATFORM_ADMIN', 'PLATFORM_BILLING', 'PLATFORM_SUPPORT', 'PLATFORM_AUDITOR'];
function UsersTab({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<Array<{ id: string; email: string; name: string; role: string; status: string; mfaEnabled: boolean; lastLoginAt?: string | null }>>([]);
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ email: '', name: '', password: '', role: 'PLATFORM_SUPPORT' });

  const [loadError, setLoadError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try { setRows(await platformAdmin.users()); setLoadError(null); }
    catch (e) { setLoadError(e instanceof Error ? e.message : 'Operators could not be loaded'); }
  }, []);
  useEffect(() => { void (async () => { await reload(); })(); }, [reload]);
  async function run(id: string, fn: () => Promise<unknown>) { setBusy(id); setError(null); try { await fn(); await reload(); } catch (e) { setError(e instanceof Error ? e.message : 'Action failed'); } finally { setBusy(null); } }
  async function invite() {
    setBusy('invite'); setError(null);
    try { await platformAdmin.createUser({ ...form, email: form.email.trim().toLowerCase(), name: form.name.trim() }); setForm({ email: '', name: '', password: '', role: 'PLATFORM_SUPPORT' }); setInviting(false); await reload(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Invite failed'); } finally { setBusy(null); }
  }
  const field = 'rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm text-t1 outline-none focus:border-[var(--indigo)]';
  const inviteValid = /.+@.+\..+/.test(form.email) && form.name.trim().length >= 2 && form.password.length >= 8;

  return (
    <Panel title="Platform operators" subtitle={canManage ? 'Invite operators and manage roles, status, and access' : 'Read-only — only owners/admins can manage operators'}
      action={canManage ? <button type="button" onClick={() => setInviting(v => !v)} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"><Plus className="w-3.5 h-3.5" /> Invite operator</button> : undefined}>
      {error && <div className="mb-3 rounded-lg bg-red-soft border border-[rgba(220,38,38,0.18)] px-3 py-2 text-xs text-red-v">{error}</div>}
      {inviting && canManage && (
        <div className="mb-4 rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3 space-y-2">
          <div className="grid sm:grid-cols-2 gap-2">
            <input className={field} placeholder="Name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            <input className={field} type="email" placeholder="operator@email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
            <input className={field} type="text" placeholder="Temp password (min 8)" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
            <select aria-label="Role" className={field} value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>{PLATFORM_ROLE_OPTIONS.map(r => <option key={r} value={r}>{r.replace('PLATFORM_', '')}</option>)}</select>
          </div>
          <div className="flex gap-2">
            <button type="button" disabled={busy === 'invite' || !inviteValid} onClick={invite} className="rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50">{busy === 'invite' ? 'Inviting…' : 'Create operator'}</button>
            <button type="button" onClick={() => setInviting(false)} className="rounded-lg border border-[var(--b1)] px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-[var(--s1)]">Cancel</button>
          </div>
        </div>
      )}
      {loadError ? <LoadFailure message={loadError} onRetry={() => void reload()} />
        : rows.length === 0 ? <EmptyState icon={Users2} text="No operators found." /> : (
        <div className="overflow-hidden rounded-xl border border-[var(--b1)] divide-y divide-[var(--b1)]">
          {rows.map(u => (
            <div key={u.id} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-[var(--s2)] transition-colors">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-full logo-user grid place-items-center text-[11px] font-bold text-white shrink-0">
                  {u.name.split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-t1 truncate">{u.name}</p>
                  <p className="text-[11px] text-t3 truncate">{u.email}{u.lastLoginAt ? ` · last seen ${new Date(u.lastLoginAt).toLocaleDateString()}` : ''}</p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {u.mfaEnabled && <span className="badge badge-violet">MFA</span>}
                {canManage ? (
                  <>
                    <select aria-label={`Role for ${u.name}`} disabled={busy === u.id} value={u.role} onChange={e => run(u.id, () => platformAdmin.updateUser(u.id, { role: e.target.value }))}
                      className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-2 py-1 text-[11px] font-semibold text-t2 cursor-pointer">
                      {PLATFORM_ROLE_OPTIONS.map(r => <option key={r} value={r}>{r.replace('PLATFORM_', '')}</option>)}
                    </select>
                    <button type="button" disabled={busy === u.id} onClick={() => run(u.id, () => platformAdmin.updateUser(u.id, { status: u.status === 'active' ? 'disabled' : 'active' }))}
                      className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-semibold disabled:opacity-50 ${u.status === 'active' ? 'border-[rgba(220,38,38,0.2)] text-red-v hover:bg-red-soft' : 'border-[rgba(5,150,105,0.2)] text-emerald-v hover:bg-emerald-soft'}`}>
                      {busy === u.id ? <Loader2 className="w-3 h-3 animate-spin" /> : u.status === 'active' ? <><Ban className="w-3 h-3" /> Disable</> : <><Play className="w-3 h-3" /> Enable</>}
                    </button>
                  </>
                ) : (
                  <>
                    <span className="badge badge-indigo">{u.role.replace('PLATFORM_', '')}</span>
                    <span className={`badge ${u.status === 'active' ? 'badge-emerald' : 'badge-red'}`}>{u.status}</span>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* ─────────────────────────────────────────────────────────── */
function AuditTab() {
  const [rows, setRows] = useState<Array<{ id: string; action: string; targetType: string; tenantId: string | null; createdAt: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setRows(await platformAdmin.audit(150)); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Audit events could not be loaded'); }
  }, []);
  useEffect(() => { void (async () => { await load(); })(); }, [load]);
  return (
    <Panel title="Audit log" subtitle="Recorded operator events. Review exported fields before sharing them outside the authorized team."
      action={<button type="button" onClick={() => void downloadAuditCsv()} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-[var(--s2)]"><Download className="w-3.5 h-3.5" /> Export CSV</button>}>
      {error ? <LoadFailure message={error} onRetry={() => void load()} />
        : rows.length === 0 ? <EmptyState icon={Activity} text="No audit events recorded yet." /> : (
        <div className="overflow-hidden rounded-xl border border-[var(--b1)] divide-y divide-[var(--b1)]">
          {rows.map(r => (
            <div key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-[var(--s2)] transition-colors">
              <div className="flex items-center gap-2.5 min-w-0">
                <ChevronRight className="w-3.5 h-3.5 text-t3 shrink-0" />
                <span className="font-mono text-[12px] font-semibold text-t2 truncate">{r.action}</span>
                <span className="badge badge-blue shrink-0">{r.targetType}</span>
              </div>
              <span className="text-[11px] text-t3 shrink-0 tabular-nums">
                {r.tenantId ? `${r.tenantId.slice(0, 8)} · ` : ''}{new Date(r.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
