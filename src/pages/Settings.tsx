import { useMemo, useState } from 'react';
import {
  Building2, Users, Lock, Bell, Cable, ShieldCheck, CheckCircle2, Circle, RefreshCw,
  Trash2, Plus, MapPin, Activity, AlertTriangle, KeyRound, Clock,
} from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import BentoCard from '../components/ui/BentoCard';
import StatCard from '../components/ui/StatCard';
import { apiRequest } from '../lib/api';
import { useApiData } from '../hooks/useApiData';
import { useCrudResource } from '../hooks/useCrudResource';

/* ------------------------------------------------------------------ types */
interface Branch { id: string; name: string; location: string; active?: boolean }
interface AdminOverview {
  summary: { totalUsers: number; activeUsers: number; totalRoles: number; activeBranches: number; recentAuditEvents: number };
  tenant: { name: string; slug: string; createdAt: string };
  branches: Branch[];
}
interface AdminUser {
  id: string; displayName: string; email: string; role: string; active: boolean;
  branch?: { name: string } | null; accessBranches?: { id: string; name: string }[];
}
interface AdminUsersResponse { users: AdminUser[]; branches: Branch[]; summary?: unknown }
interface RoleDef { id: string; name: string; description: string; accent: string; userCount: number }
interface Template { id: string; name: string; channel: string; status: 'ACTIVE' | 'PAUSED' }
interface IntegrationStatus {
  key: string; name: string; category: string; description: string; supportedWorkflows: string[];
  mode: string; modeLabel: string; configured: boolean; health: string; lastSyncAt: string | null;
  missingEnvVars: string[]; riskLevel: string;
}
interface SecurityPosture {
  authMode: string; rbacEnabled: boolean; auditLoggingEnabled: boolean; rateLimitingEnabled: boolean;
  devTokenDisabledInProduction: boolean; httpsRequired: boolean; csrf: { enabled: boolean };
  secrets: { jwtSecretConfigured: boolean; jwtRefreshSecretConfigured: boolean };
  accessTokenTtlMinutes: number; auditEventCount: number; loginEventCount: number;
}
interface SessionRow {
  id: string; revoked: boolean; issuedAt: string; expiresAt: string; lastActivityAt: string;
  user: { id: string; displayName: string; email: string; role: string };
  lastLoginAudit?: { occurredAt: string; ipAddress: string; userAgent: string } | null;
}

const ROLE_OPTIONS = ['OWNER', 'ADMIN', 'MANAGER', 'PROVIDER', 'FRONT_DESK', 'ANALYST'];
// Compliance roles are enforced by the Compliance module and assignable here
// (the backend role-change API accepts them). Assignment itself remains gated
// to OWNER/ADMIN by the backend.
const COMPLIANCE_ROLE_OPTIONS = ['COMPLIANCE_OFFICER', 'AUDITOR'];
const COMPLIANCE_ROLE_LABEL: Record<string, string> = { COMPLIANCE_OFFICER: 'Compliance Officer', AUDITOR: 'Auditor' };
const accentBadge: Record<string, string> = {
  violet: 'badge badge-violet', blue: 'badge badge-blue', emerald: 'badge badge-emerald',
  amber: 'badge badge-amber', red: 'badge badge-red',
};
const healthDot: Record<string, string> = {
  healthy: 'bg-emerald-500', degraded: 'bg-amber-500', disconnected: 'bg-red-500', not_configured: 'bg-slate-400',
};
const modeBadge: Record<string, string> = {
  live: 'badge badge-emerald', sandbox: 'badge badge-blue', mock: 'badge badge-amber',
};

const NAV = [
  { id: 'overview', label: 'Overview', icon: Building2 },
  { id: 'team', label: 'Team & Users', icon: Users },
  { id: 'roles', label: 'Roles & Access', icon: Lock },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'integrations', label: 'Integrations', icon: Cable },
  { id: 'security', label: 'Security', icon: ShieldCheck },
] as const;
type SectionId = typeof NAV[number]['id'];

const inputClass = 'w-full px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)]';

export default function Settings() {
  const [section, setSection] = useState<SectionId>('overview');

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Settings"
        subtitle="Practice configuration, team access, automation, integrations, and security — all live."
        badge="Control Panel"
        badgeColor="violet"
      />

      <SettingsSummary />

      <div className="grid gap-4 lg:grid-cols-[220px_1fr] items-start">
        {/* Section nav */}
        <nav className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-2 lg:sticky lg:top-4">
          <div className="flex lg:flex-col gap-1 overflow-x-auto">
            {NAV.map(item => {
              const Icon = item.icon;
              const active = section === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSection(item.id)}
                  className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${active ? 'bg-[var(--indigo)] text-white shadow-sm' : 'text-t2 hover:bg-[var(--s3)]'}`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  {item.label}
                </button>
              );
            })}
          </div>
        </nav>

        {/* Section content */}
        <div className="min-w-0 space-y-4">
          {section === 'overview' && <OverviewSection />}
          {section === 'team' && <TeamSection />}
          {section === 'roles' && <RolesSection />}
          {section === 'notifications' && <NotificationsSection />}
          {section === 'integrations' && <IntegrationsSection />}
          {section === 'security' && <SecuritySection />}
        </div>
      </div>
    </div>
  );
}

function SettingsSummary() {
  const { data: overview } = useApiData<AdminOverview | null>('/v1/admin/overview', null);
  const { data: integrations } = useApiData<IntegrationStatus[]>('/v1/integrations/status', []);
  const { data: posture } = useApiData<SecurityPosture | null>('/v1/security/posture', null);

  const connected = integrations.filter(item => item.configured).length;
  const risky = integrations.filter(item => item.health !== 'healthy').length;
  const activeBranches = overview?.summary.activeBranches ?? 0;
  const securityChecks = posture
    ? [posture.rbacEnabled, posture.auditLoggingEnabled, posture.rateLimitingEnabled, posture.csrf.enabled, posture.secrets.jwtSecretConfigured, posture.secrets.jwtRefreshSecretConfigured]
    : [];
  const passingSecurityChecks = securityChecks.filter(Boolean).length;

  return (
    <BentoCard title="Workspace Control Summary" subtitle="Live configuration, integration health, and security posture">
      <div className="grid gap-3 xl:grid-cols-[1.3fr_0.9fr]">
        <div className="grid gap-3 grid-cols-2 xl:grid-cols-4">
          <StatCard title="Team Members" value={overview?.summary.totalUsers ?? '—'} subtitle={`${overview?.summary.activeUsers ?? 0} active`} icon={<Users className="w-4 h-4" />} accent="blue" />
          <StatCard title="Connected" value={connected} subtitle={`${integrations.length} integrations`} icon={<Cable className="w-4 h-4" />} accent="emerald" />
          <StatCard title="Security Checks" value={posture ? `${passingSecurityChecks}/${securityChecks.length}` : '—'} subtitle="Passing controls" icon={<ShieldCheck className="w-4 h-4" />} accent="violet" />
          <StatCard title="Active Branches" value={activeBranches} subtitle={`${risky} integrations need attention`} icon={<Building2 className="w-4 h-4" />} accent="amber" />
        </div>

        <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4">
          <div className="flex items-center justify-between gap-2 mb-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-t3">Operational status</p>
              <p className="text-sm font-semibold text-t1 mt-1">{overview?.tenant.name ?? 'Workspace'} · {overview?.tenant.slug ?? '—'}</p>
            </div>
            <span className="badge badge-emerald">{connected}/{integrations.length} live</span>
          </div>
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-t3">Integration health</span>
              <span className="font-semibold text-t1">{risky === 0 ? 'All healthy' : `${risky} need attention`}</span>
            </div>
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-t3">Security posture</span>
              <span className="font-semibold text-t1">{posture?.authMode ?? 'Loading…'}</span>
            </div>
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-t3">Tenant created</span>
              <span className="font-semibold text-t1">{overview?.tenant.createdAt ? new Date(overview.tenant.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</span>
            </div>
          </div>
        </div>
      </div>
    </BentoCard>
  );
}

/* ------------------------------------------------------------------ Overview */
function OverviewSection() {
  const { data, loading } = useApiData<AdminOverview | null>('/v1/admin/overview', null);
  if (loading && !data) return <Skeleton />;
  const s = data?.summary;
  return (
    <>
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Team Members" value={s?.totalUsers ?? '—'} subtitle={`${s?.activeUsers ?? 0} active`} icon={<Users className="w-4 h-4" />} accent="blue" />
        <StatCard title="Roles" value={s?.totalRoles ?? '—'} subtitle="Defined" icon={<Lock className="w-4 h-4" />} accent="violet" />
        <StatCard title="Branches" value={s?.activeBranches ?? '—'} subtitle="Active locations" icon={<MapPin className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Audit Events" value={s?.recentAuditEvents ?? '—'} subtitle="Recent activity" icon={<Activity className="w-4 h-4" />} accent="amber" />
      </div>

      <BentoCard title="Practice Profile" subtitle="Organisation details" headerRight={<Building2 className="w-4 h-4 text-t3" />}>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Practice name" value={data?.tenant.name ?? '—'} />
          <Field label="Workspace slug" value={data?.tenant.slug ?? '—'} />
          <Field label="Created" value={data?.tenant.createdAt ? new Date(data.tenant.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '—'} />
          <Field label="Active branches" value={String(data?.branches.filter(b => b.active).length ?? 0)} />
        </div>
      </BentoCard>

      <BentoCard title="Practice Locations" subtitle="Branch configuration" headerRight={<MapPin className="w-4 h-4 text-t3" />}>
        <div className="space-y-2.5">
          {(data?.branches ?? []).map(branch => (
            <div key={branch.id} className="flex items-center justify-between gap-3 p-3.5 rounded-xl border border-[var(--b1)] hover:bg-[var(--s3)] transition-all">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-blue-500 to-violet-500 flex items-center justify-center text-white text-[10px] font-bold shrink-0">{branch.name.charAt(0)}</div>
                <div>
                  <p className="text-xs font-bold text-t1">{branch.name}</p>
                  <p className="text-[11px] text-t3">{branch.location}</p>
                </div>
              </div>
              <span className={branch.active ? 'badge badge-emerald' : 'badge badge-red'}>{branch.active ? 'Active' : 'Inactive'}</span>
            </div>
          ))}
        </div>
      </BentoCard>
    </>
  );
}

/* ------------------------------------------------------------------ Team */
function TeamSection() {
  const { data, loading, reload } = useApiData<AdminUsersResponse | null>('/v1/admin/users', null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  async function changeRole(id: string, role: string) {
    setPendingId(id);
    try { await apiRequest(`/v1/admin/users/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) }); await reload(); }
    finally { setPendingId(null); }
  }
  async function toggleActive(id: string, active: boolean) {
    setPendingId(id);
    try { await apiRequest(`/v1/admin/users/${id}/status`, { method: 'PATCH', body: JSON.stringify({ active }) }); await reload(); }
    finally { setPendingId(null); }
  }

  if (loading && !data) return <Skeleton />;
  const users = (data?.users ?? []).filter(u => !search || u.displayName.toLowerCase().includes(search.toLowerCase()) || u.email.toLowerCase().includes(search.toLowerCase()));

  return (
    <BentoCard title="Team & Users" subtitle={`${data?.users.length ?? 0} members · live role & access management`} headerRight={
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…" className="text-xs px-3 py-1.5 border border-[var(--b1)] rounded-xl bg-[var(--s3)] text-t1 placeholder:text-t3 outline-none w-40" />
    }>
      <div className="space-y-2">
        {users.map(user => (
          <div key={user.id} className="flex flex-wrap items-center gap-3 p-3 rounded-xl border border-[var(--b1)] hover:bg-[var(--s3)] transition-all">
            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-400 to-violet-500 flex items-center justify-center text-white text-[11px] font-bold shrink-0">
              {user.displayName.split(' ').map(n => n[0]).join('').slice(0, 2)}
            </div>
            <div className="flex-1 min-w-[140px]">
              <p className="text-sm font-semibold text-t1">{user.displayName}</p>
              <p className="text-[11px] text-t3">{user.email}{user.branch ? ` · ${user.branch.name.split(' ')[0]}` : ''}</p>
            </div>
            <select
              aria-label={`Role for ${user.displayName}`}
              value={user.role}
              disabled={pendingId === user.id}
              onChange={e => changeRole(user.id, e.target.value)}
              className="px-2.5 py-1.5 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-[11px] font-semibold text-t1 outline-none focus:border-[var(--b3)] disabled:opacity-40"
            >
              {ROLE_OPTIONS.map(r => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
              {COMPLIANCE_ROLE_OPTIONS.map(r => <option key={r} value={r}>{COMPLIANCE_ROLE_LABEL[r]}</option>)}
            </select>
            <button
              type="button"
              disabled={pendingId === user.id}
              onClick={() => toggleActive(user.id, !user.active)}
              className={`text-[10px] font-bold px-2.5 py-1 rounded-full transition disabled:opacity-40 ${user.active ? 'badge badge-emerald' : 'badge badge-red'}`}
            >
              {user.active ? 'Active' : 'Disabled'}
            </button>
          </div>
        ))}
        {users.length === 0 && <p className="text-xs text-t3 py-6 text-center">No users match your search.</p>}
      </div>
    </BentoCard>
  );
}

/* ------------------------------------------------------------------ Roles */
function RolesSection() {
  const roles = useCrudResource<RoleDef>('/v1/settings/roles', []);
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ name: '', description: '' });

  async function add() {
    if (!form.name.trim() || !form.description.trim()) return;
    await roles.create({ name: form.name.trim(), description: form.description.trim(), accent: 'blue' });
    setForm({ name: '', description: '' });
    setShow(false);
  }

  return (
    <BentoCard title="Roles & Access" subtitle="Permission groups · live" headerRight={<Lock className="w-4 h-4 text-t3" />}>
      {roles.error && <p className="text-[11px] text-red-v mb-2">{roles.error}</p>}
      <div className="space-y-2.5">
        {roles.data.map(r => (
          <div key={r.id} className="flex items-start gap-3 p-3 rounded-xl border border-[var(--b1)] hover:bg-[var(--s3)] transition-colors group">
            <span className={`text-[10px] font-bold px-2 py-1 rounded-lg shrink-0 ${accentBadge[r.accent] ?? 'badge badge-blue'}`}>{r.name}</span>
            <p className="flex-1 min-w-0 text-[11px] text-t2">{r.description}</p>
            <span className="text-[10px] text-t3 shrink-0">{r.userCount} users</span>
            <button type="button" disabled={roles.busy} onClick={() => roles.remove(r.id)} className="text-t3 hover:text-red-v opacity-0 group-hover:opacity-100 disabled:opacity-40 shrink-0" aria-label="Delete role"><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
        ))}
      </div>
      {show ? (
        <div className="mt-3 p-3 rounded-xl border border-[var(--b2)] bg-[var(--s2)] space-y-2">
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Role name" className={inputClass} />
          <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Description" className={inputClass} />
          <div className="flex gap-2">
            <button type="button" disabled={roles.busy} onClick={add} className="flex-1 py-2 rounded-lg bg-[var(--indigo)] text-white text-xs font-semibold hover:opacity-90 disabled:opacity-40">Add role</button>
            <button type="button" onClick={() => setShow(false)} className="px-3 py-2 rounded-lg border border-[var(--b1)] text-t2 text-xs font-semibold hover:bg-[var(--s3)]">Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setShow(true)} className="mt-3 w-full py-2 border border-dashed border-[var(--b2)] rounded-xl text-xs font-semibold text-t3 hover:text-indigo hover:bg-[var(--s3)] inline-flex items-center justify-center gap-1"><Plus className="w-3.5 h-3.5" /> Add role</button>
      )}
    </BentoCard>
  );
}

/* ------------------------------------------------------------------ Notifications */
function NotificationsSection() {
  const templates = useCrudResource<Template>('/v1/settings/notification-templates', []);
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ name: '', channel: '' });

  async function add() {
    if (!form.name.trim() || !form.channel.trim()) return;
    await templates.create({ name: form.name.trim(), channel: form.channel.trim(), status: 'ACTIVE' });
    setForm({ name: '', channel: '' });
    setShow(false);
  }

  return (
    <BentoCard title="Notification Templates" subtitle="Automated patient messaging · live" headerRight={<Bell className="w-4 h-4 text-t3" />}>
      {templates.error && <p className="text-[11px] text-red-v mb-2">{templates.error}</p>}
      <div className="space-y-2.5">
        {templates.data.map(t => (
          <div key={t.id} className={`flex items-center justify-between gap-3 p-3.5 rounded-xl border transition-all ${t.status === 'PAUSED' ? 'border-[var(--b1)] bg-[var(--s2)]' : 'border-[var(--b1)] hover:border-[var(--b2)]'}`}>
            <div className="min-w-0">
              <p className="text-xs font-bold text-t1">{t.name}</p>
              <p className="text-[10px] text-t3 mt-0.5">Channel: {t.channel}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className={t.status === 'ACTIVE' ? 'badge badge-emerald' : 'badge badge-blue'}>{t.status.toLowerCase()}</span>
              <button type="button" disabled={templates.busy} onClick={() => templates.update(t.id, { status: t.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' })} className="text-[10px] font-semibold text-indigo hover:text-blue-v disabled:opacity-40">{t.status === 'ACTIVE' ? 'Pause' : 'Activate'}</button>
              <button type="button" disabled={templates.busy} onClick={() => templates.remove(t.id)} className="text-t3 hover:text-red-v disabled:opacity-40" aria-label="Delete template"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          </div>
        ))}
      </div>
      {show ? (
        <div className="mt-3 p-3 rounded-xl border border-[var(--b2)] bg-[var(--s2)] space-y-2">
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Template name" className={inputClass} />
          <input value={form.channel} onChange={e => setForm(f => ({ ...f, channel: e.target.value }))} placeholder="Channel (e.g. WhatsApp + SMS)" className={inputClass} />
          <div className="flex gap-2">
            <button type="button" disabled={templates.busy} onClick={add} className="flex-1 py-2 rounded-lg bg-[var(--indigo)] text-white text-xs font-semibold hover:opacity-90 disabled:opacity-40">Add template</button>
            <button type="button" onClick={() => setShow(false)} className="px-3 py-2 rounded-lg border border-[var(--b1)] text-t2 text-xs font-semibold hover:bg-[var(--s3)]">Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setShow(true)} className="mt-3 w-full py-2 border border-dashed border-[var(--b2)] rounded-xl text-xs font-semibold text-t3 hover:text-indigo hover:bg-[var(--s3)] inline-flex items-center justify-center gap-1"><Plus className="w-3.5 h-3.5" /> Add template</button>
      )}
    </BentoCard>
  );
}

/* ------------------------------------------------------------------ Integrations */
function IntegrationsSection() {
  const { data, loading, reload } = useApiData<IntegrationStatus[]>('/v1/integrations/status', []);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  async function test(key: string) {
    setTestingKey(key);
    setToast(null);
    try {
      const res = await apiRequest<{ message?: string; modeLabel?: string }>(`/v1/integrations/${key}/test`, { method: 'POST' });
      setToast(`${key}: ${res.modeLabel ?? 'tested'} — ${res.message ?? 'ok'}`);
      await reload();
    } catch (err) {
      setToast(`${key}: ${err instanceof Error ? err.message : 'test failed'}`);
    } finally {
      setTestingKey(null);
    }
  }

  const grouped = useMemo(() => {
    const map = new Map<string, IntegrationStatus[]>();
    for (const item of data) {
      if (!map.has(item.category)) map.set(item.category, []);
      map.get(item.category)!.push(item);
    }
    return [...map.entries()];
  }, [data]);

  const connected = data.filter(d => d.configured).length;

  if (loading && data.length === 0) return <Skeleton />;

  return (
    <>
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Integrations" value={data.length} subtitle="Available providers" icon={<Cable className="w-4 h-4" />} accent="blue" />
        <StatCard title="Connected" value={connected} subtitle="Configured & live" icon={<CheckCircle2 className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Needs Setup" value={data.length - connected} subtitle="Awaiting credentials" icon={<AlertTriangle className="w-4 h-4" />} accent="amber" />
        <StatCard title="Categories" value={grouped.length} subtitle="Provider types" icon={<Activity className="w-4 h-4" />} accent="violet" />
      </div>

      {toast && <div className="rounded-xl border border-[var(--b2)] bg-[var(--blue-soft)] px-3 py-2 text-[11px] font-semibold text-blue-v">{toast}</div>}

      {grouped.map(([category, items]) => (
        <BentoCard key={category} title={category} subtitle={`${items.filter(i => i.configured).length}/${items.length} connected`}>
          <div className="grid gap-3 sm:grid-cols-2">
            {items.map(item => (
              <div key={item.key} className="p-4 rounded-2xl border border-[var(--b1)] hover:border-[var(--b2)] transition-all flex flex-col">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-t1">{item.name}</p>
                    <p className="text-[11px] text-t3 mt-0.5 leading-relaxed">{item.description}</p>
                  </div>
                  <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${modeBadge[item.mode] ?? 'badge badge-blue'}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${healthDot[item.health] ?? 'bg-slate-400'}`} />
                    {item.modeLabel}
                  </span>
                </div>

                <div className="flex flex-wrap gap-1 mb-2">
                  {item.supportedWorkflows.slice(0, 3).map(w => (
                    <span key={w} className="text-[9px] font-semibold text-t3 bg-[var(--s3)] px-1.5 py-0.5 rounded">{w}</span>
                  ))}
                </div>

                {item.missingEnvVars.length > 0 && (
                  <p className="text-[10px] text-amber-v mb-2 flex items-center gap-1"><KeyRound className="w-3 h-3 shrink-0" /> Needs: {item.missingEnvVars.join(', ')}</p>
                )}

                <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                  <span className="text-[10px] text-t3">{item.lastSyncAt ? `Synced ${new Date(item.lastSyncAt).toLocaleDateString('en-GB')}` : 'Never synced'}</span>
                  <button type="button" disabled={testingKey === item.key} onClick={() => test(item.key)} className="inline-flex items-center gap-1 text-[10px] font-semibold text-indigo bg-[var(--indigo-soft)] px-2.5 py-1 rounded-lg hover:opacity-80 disabled:opacity-40">
                    <RefreshCw className={`w-3 h-3 ${testingKey === item.key ? 'animate-spin' : ''}`} /> {testingKey === item.key ? 'Testing…' : 'Test connection'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </BentoCard>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ Security */
function SecuritySection() {
  const posture = useApiData<SecurityPosture | null>('/v1/security/posture', null);
  const sessions = useApiData<SessionRow[]>('/v1/security/sessions', []);
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function revoke(userId: string) {
    setPendingId(userId);
    try { await apiRequest(`/v1/security/sessions/${userId}/revoke`, { method: 'POST' }); await sessions.reload(); }
    finally { setPendingId(null); }
  }

  const p = posture.data;
  const checks = p ? [
    { label: 'Role-based access control', ok: p.rbacEnabled },
    { label: 'Audit logging', ok: p.auditLoggingEnabled },
    { label: 'Rate limiting', ok: p.rateLimitingEnabled },
    { label: 'CSRF protection', ok: p.csrf.enabled },
    { label: 'JWT secret configured', ok: p.secrets.jwtSecretConfigured },
    { label: 'Refresh secret configured', ok: p.secrets.jwtRefreshSecretConfigured },
    { label: 'Dev-token disabled in production', ok: p.devTokenDisabledInProduction },
    { label: 'HTTPS required', ok: p.httpsRequired },
  ] : [];

  return (
    <>
      {p && (
        <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
          <StatCard title="Access Token TTL" value={`${p.accessTokenTtlMinutes}m`} subtitle="Session lifetime" icon={<Clock className="w-4 h-4" />} accent="blue" />
          <StatCard title="Audit Events" value={p.auditEventCount} subtitle="Total logged" icon={<Activity className="w-4 h-4" />} accent="violet" />
          <StatCard title="Login Events" value={p.loginEventCount} subtitle="Recorded" icon={<KeyRound className="w-4 h-4" />} accent="emerald" />
          <StatCard title="Active Sessions" value={sessions.data.filter(s => !s.revoked).length} subtitle="Live now" icon={<Users className="w-4 h-4" />} accent="amber" />
        </div>
      )}

      <BentoCard title="Security Posture" subtitle={p?.authMode ?? 'Authentication & controls'} headerRight={<ShieldCheck className="w-4 h-4 text-t3" />}>
        {posture.loading && !p ? <Skeleton /> : (
          <div className="grid sm:grid-cols-2 gap-2">
            {checks.map(c => (
              <div key={c.label} className={`flex items-center gap-2.5 p-2.5 rounded-xl border border-[var(--b1)] ${c.ok ? 'bg-[var(--emerald-soft)]' : 'bg-[var(--amber-soft)]'}`}>
                {c.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-v shrink-0" /> : <Circle className="w-3.5 h-3.5 text-amber-v shrink-0" />}
                <p className="text-[11px] font-medium text-t2">{c.label}</p>
              </div>
            ))}
          </div>
        )}
      </BentoCard>

      <BentoCard title="Active Sessions" subtitle={`${sessions.data.filter(s => !s.revoked).length} live · revoke to force sign-out`}>
        <div className="space-y-2">
          {sessions.data.map(s => (
            <div key={s.id} className="flex flex-wrap items-center gap-3 p-3 rounded-xl border border-[var(--b1)]">
              <div className="flex-1 min-w-[160px]">
                <p className="text-xs font-bold text-t1">{s.user.displayName} <span className="text-[10px] font-normal text-t3">· {s.user.role.replace('_', ' ')}</span></p>
                <p className="text-[10px] text-t3 mt-0.5">{s.lastLoginAudit?.ipAddress ?? '—'} · last active {new Date(s.lastActivityAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>
              </div>
              {s.revoked
                ? <span className="badge badge-red shrink-0">Revoked</span>
                : <button type="button" disabled={pendingId === s.user.id} onClick={() => revoke(s.user.id)} className="text-[10px] font-semibold text-red-v hover:opacity-80 border border-[var(--b1)] px-2.5 py-1 rounded-lg disabled:opacity-40 shrink-0">{pendingId === s.user.id ? 'Revoking…' : 'Revoke'}</button>
              }
            </div>
          ))}
          {sessions.data.length === 0 && <p className="text-xs text-t3 py-4 text-center">No active sessions.</p>}
        </div>
      </BentoCard>
    </>
  );
}

/* ------------------------------------------------------------------ helpers */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-3 rounded-xl border border-[var(--b1)] bg-[var(--s2)]">
      <p className="text-[10px] font-bold uppercase tracking-widest text-t3">{label}</p>
      <p className="text-sm font-semibold text-t1 mt-1 truncate">{value}</p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2">
      <div className="skeleton h-16 rounded-xl" />
      <div className="skeleton h-16 rounded-xl" />
      <div className="skeleton h-16 rounded-xl" />
    </div>
  );
}
