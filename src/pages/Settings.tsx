import { useMemo, useState, type ReactNode, useEffect, useRef, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useSession } from '../hooks/useSession';
import {
  Building2, Users, Lock, Bell, Cable, ShieldCheck, CheckCircle2, Circle, RefreshCw,
  Trash2, Plus, MapPin, Activity, AlertTriangle, KeyRound, Clock, Coins, Globe, Check,
} from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import BentoCard from '../components/ui/BentoCard';
import StatCard from '../components/ui/StatCard';
import EmptyStatePremium from '../components/ui/EmptyStatePremium';
import ResourceSection, { ResourceErrorNotice, ResourceSkeleton } from '../components/ui/ResourceSection';
import { apiRequest } from '../lib/api';
import { describeFailure, hasResponse, type ResourceFailure } from '../lib/resourceState';
import { useResource } from '../hooks/useResource';
import { useCrudResource } from '../hooks/useCrudResource';
import { usePreferences, CURRENCIES, LANGUAGES } from '../lib/preferences';
import { formatCurrency } from '../utils/formatters';

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
  missingConfigCount: number; riskLevel: string;
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
  { id: 'preferences', label: 'Display & Currency', icon: Coins },
  { id: 'team', label: 'Team & Users', icon: Users },
  { id: 'roles', label: 'Roles & Access', icon: Lock },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'integrations', label: 'Integrations', icon: Cable },
  { id: 'security', label: 'Security', icon: ShieldCheck },
] as const;
type SectionId = typeof NAV[number]['id'];

const inputClass = 'w-full px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s2)] text-xs text-t1 outline-none focus:border-[var(--b3)]';

// The recorded checks the summary tile counts. Kept next to the posture type so
// the tile can never report a score for a posture that was not received.
function postureChecks(posture: SecurityPosture): boolean[] {
  return [
    posture.rbacEnabled,
    posture.auditLoggingEnabled,
    posture.rateLimitingEnabled,
    posture.csrf.enabled,
    posture.secrets.jwtSecretConfigured,
    posture.secrets.jwtRefreshSecretConfigured,
  ];
}

export default function Settings() {
  const [section, setSection] = useState<SectionId>('overview');

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Settings"
        subtitle="Manage workspace preferences, team access, integrations, and recorded security controls."
        badge="Workspace settings"
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
                  aria-current={active ? 'page' : undefined}
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
          {section === 'preferences' && <PreferencesSection />}
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
  const overview = useResource<AdminOverview>('/v1/admin/overview');
  const integrations = useResource<IntegrationStatus[]>('/v1/integrations/status');
  const posture = useResource<SecurityPosture>('/v1/security/posture');

  return (
    <BentoCard title="Workspace summary" subtitle="Current configuration and the latest recorded control status">
      <div className="grid gap-3 xl:grid-cols-[1.3fr_0.9fr]">
        <div className="grid gap-3 grid-cols-2 xl:grid-cols-4">
          <ResourceSection label="Team members" state={overview.state} onRetry={overview.reload} compact loading={<TileSkeleton label="team members" />}>
            {data => <StatCard title="Team Members" value={data.summary.totalUsers} subtitle={`${data.summary.activeUsers} active`} icon={<Users className="w-4 h-4" />} accent="blue" />}
          </ResourceSection>

          {/* A response listing zero integrations is a real answer, so these
              tiles show the received 0 rather than the empty-state card. */}
          <ResourceSection label="Integration status" state={integrations.state} onRetry={integrations.reload} compact isEmpty={() => false} loading={<TileSkeleton label="integration status" />}>
            {rows => <StatCard title="Configured" value={rows.filter(item => item.configured).length} subtitle={`${rows.length} integrations`} icon={<Cable className="w-4 h-4" />} accent="emerald" />}
          </ResourceSection>

          <ResourceSection label="Security checks" state={posture.state} onRetry={posture.reload} compact loading={<TileSkeleton label="security checks" />}>
            {data => (
              <StatCard
                title="Security check results"
                value={`${postureChecks(data).filter(Boolean).length}/${postureChecks(data).length}`}
                subtitle="Latest recorded checks"
                icon={<ShieldCheck className="w-4 h-4" />}
                accent="violet"
              />
            )}
          </ResourceSection>

          <ResourceSection label="Active branches" state={overview.state} onRetry={overview.reload} compact loading={<TileSkeleton label="active branches" />}>
            {data => <StatCard title="Active Branches" value={data.summary.activeBranches} subtitle="Active locations" icon={<Building2 className="w-4 h-4" />} accent="amber" />}
          </ResourceSection>
        </div>

        <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4">
          <div className="mb-3">
            <p className="text-xs font-bold uppercase tracking-widest text-t3">Operational status</p>
            <ResourceSection label="Workspace identity" state={overview.state} onRetry={overview.reload} compact
              loading={<ResourceSkeleton label="workspace identity" lines={1} rowClassName="h-4 w-44 rounded mt-1" />}>
              {data => <p className="text-sm font-semibold text-t1 mt-1">{data.tenant.name} · {data.tenant.slug}</p>}
            </ResourceSection>
          </div>
          <div className="space-y-2.5">
            <StatusRow label="Recorded integration health">
              <ResourceSection label="Integration status" state={integrations.state} onRetry={integrations.reload} compact isEmpty={() => false}
                loading={<ResourceSkeleton label="integration status" lines={1} rowClassName="h-3.5 w-32 rounded" />}>
                {rows => {
                  const risky = rows.filter(item => item.health !== 'healthy').length;
                  return (
                    <span className="font-semibold text-t1">
                      {rows.length === 0 ? 'No integrations returned' : risky === 0 ? 'No issues reported' : `${risky} need attention`}
                    </span>
                  );
                }}
              </ResourceSection>
            </StatusRow>
            <StatusRow label="Security posture">
              <ResourceSection label="Security posture" state={posture.state} onRetry={posture.reload} compact
                loading={<ResourceSkeleton label="security posture" lines={1} rowClassName="h-3.5 w-24 rounded" />}>
                {data => <span className="font-semibold text-t1">{data.authMode}</span>}
              </ResourceSection>
            </StatusRow>
            <StatusRow label="Tenant created">
              <ResourceSection label="Workspace identity" state={overview.state} onRetry={overview.reload} compact
                loading={<ResourceSkeleton label="tenant creation date" lines={1} rowClassName="h-3.5 w-24 rounded" />}>
                {data => (
                  <span className="font-semibold text-t1">
                    {new Date(data.tenant.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </span>
                )}
              </ResourceSection>
            </StatusRow>
          </div>
        </div>
      </div>
    </BentoCard>
  );
}

/* --------------------------------------------------------- Display & Currency */
function PreferencesSection() {
  const { currency, language, setCurrency, setLanguage } = usePreferences();
  const active = CURRENCIES.find(c => c.code === currency) ?? CURRENCIES[1];
  return (
    <div className="space-y-4">
      <BentoCard title="Display currency" subtitle="Choose how monetary figures are shown across the app. Amounts are formatted (not converted) — your operating currency stays the same.">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {CURRENCIES.map(c => {
            const on = c.code === currency;
            return (
              <button key={c.code} type="button" onClick={() => setCurrency(c.code)} aria-pressed={on ? 'true' : 'false'}
                className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-sm font-semibold transition-all focus-visible:outline-2 focus-visible:outline-[var(--indigo)] ${on ? 'border-[var(--indigo)] bg-[var(--indigo-soft)] text-indigo' : 'border-[var(--b1)] bg-[var(--s1)] text-t1 hover:border-[var(--b2)]'}`}>
                <span className="inline-flex items-center gap-2"><Coins className="w-4 h-4 text-t3" aria-hidden="true" /> {c.label}</span>
                {on && <Check className="w-4 h-4" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
        <div className="mt-3 rounded-xl border border-[var(--b1)] bg-[var(--s2)] px-4 py-3">
          <p className="text-[11px] uppercase tracking-wide text-t3">Preview</p>
          <p className="text-lg font-bold text-t1 tabular-nums">{formatCurrency(27200)} <span className="text-[11px] font-normal text-t3">· {active.code} ({active.locale})</span></p>
        </div>
      </BentoCard>

      <BentoCard title="Language" subtitle="Sets the saved interface preference and page direction for supported locales.">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {LANGUAGES.map(l => {
            const on = l.code === language;
            return (
              <button key={l.code} type="button" onClick={() => setLanguage(l.code)} aria-pressed={on ? 'true' : 'false'}
                className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2.5 text-sm font-semibold transition-all focus-visible:outline-2 focus-visible:outline-[var(--indigo)] ${on ? 'border-[var(--indigo)] bg-[var(--indigo-soft)] text-indigo' : 'border-[var(--b1)] bg-[var(--s1)] text-t1 hover:border-[var(--b2)]'}`}>
                <span className="inline-flex items-center gap-2"><Globe className="w-4 h-4 text-t3" aria-hidden="true" /> {l.label}</span>
                {on && <Check className="w-4 h-4" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-[11px] text-t3">Some interface text may remain in English while translations are completed. Number and currency formatting use the preferences selected above.</p>
      </BentoCard>
    </div>
  );
}

/* ------------------------------------------------------------------ Overview */
function OverviewSection() {
  const overview = useResource<AdminOverview>('/v1/admin/overview');
  return (
    <ResourceSection
      label="Workspace overview"
      state={overview.state}
      onRetry={overview.reload}
      loading={<ResourceSkeleton label="workspace overview" lines={4} rowClassName="h-16 rounded-xl" />}
    >
      {data => (
        <div className="space-y-4">
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
            <StatCard title="Team Members" value={data.summary.totalUsers} subtitle={`${data.summary.activeUsers} active`} icon={<Users className="w-4 h-4" />} accent="blue" />
            <StatCard title="Roles" value={data.summary.totalRoles} subtitle="Defined" icon={<Lock className="w-4 h-4" />} accent="violet" />
            <StatCard title="Branches" value={data.summary.activeBranches} subtitle="Active locations" icon={<MapPin className="w-4 h-4" />} accent="emerald" />
            <StatCard title="Audit Events" value={data.summary.recentAuditEvents} subtitle="Recent activity" icon={<Activity className="w-4 h-4" />} accent="amber" />
          </div>

          <BentoCard title="Practice Profile" subtitle="Organization details" headerRight={<Building2 className="w-4 h-4 text-t3" />}>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Practice name" value={data.tenant.name} />
              <Field label="Workspace slug" value={data.tenant.slug} />
              <Field label="Created" value={new Date(data.tenant.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} />
              <Field label="Active branches" value={String(data.branches.filter(b => b.active).length)} />
            </div>
          </BentoCard>

          <BentoCard title="Practice Locations" subtitle="Branch configuration" headerRight={<MapPin className="w-4 h-4 text-t3" />}>
            {data.branches.length === 0 ? (
              <EmptyStatePremium
                icon={<MapPin className="w-5 h-5" />}
                title="No branches configured"
                description="The workspace overview loaded successfully and this workspace has no branch records."
              />
            ) : (
              <div className="space-y-2.5">
                {data.branches.map(branch => (
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
            )}
          </BentoCard>
        </div>
      )}
    </ResourceSection>
  );
}

/* ------------------------------------------------------------------ Team */
function TeamSection() {
  const team = useResource<AdminUsersResponse>('/v1/admin/users');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionFailure, setActionFailure] = useState<ResourceFailure | null>(null);
  const [search, setSearch] = useState('');

  async function changeRole(id: string, role: string) {
    setPendingId(id);
    setActionFailure(null);
    try {
      await apiRequest(`/v1/admin/users/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) });
      team.reload();
    } catch (err) {
      setActionFailure(describeFailure(err));
    } finally {
      setPendingId(null);
    }
  }
  async function toggleActive(id: string, active: boolean) {
    setPendingId(id);
    setActionFailure(null);
    try {
      await apiRequest(`/v1/admin/users/${id}/status`, { method: 'PATCH', body: JSON.stringify({ active }) });
      team.reload();
    } catch (err) {
      setActionFailure(describeFailure(err));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="space-y-3">
      {actionFailure && <ResourceErrorNotice title="That change was not saved" failure={actionFailure} />}

      <BentoCard
        title="Team & users"
        subtitle="Roles, activation state, and recorded branch access"
        headerRight={hasResponse(team.state)
          ? <input value={search} onChange={e => setSearch(e.target.value)} aria-label="Search team members" placeholder="Search team…" className="text-xs px-3 py-1.5 border border-[var(--b1)] rounded-xl bg-[var(--s3)] text-t1 placeholder:text-t3 outline-none w-40" />
          : undefined}
      >
        <ResourceSection
          label="Team members"
          state={team.state}
          onRetry={team.reload}
          isEmpty={data => data.users.length === 0}
          empty={{
            icon: <Users className="w-5 h-5" />,
            title: 'No team members recorded',
            description: 'The team list loaded successfully and this workspace has no user records.',
          }}
        >
          {data => {
            const users = data.users.filter(u => !search || u.displayName.toLowerCase().includes(search.toLowerCase()) || u.email.toLowerCase().includes(search.toLowerCase()));
            return (
              <>
                <p className="text-[11px] text-t3 mb-2">{data.users.length} member records</p>
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
                        aria-label={`${user.active ? 'Disable' : 'Activate'} ${user.displayName}`}
                        title={`${user.active ? 'Disable' : 'Activate'} ${user.displayName}`}
                        className={`text-[10px] font-bold px-2.5 py-1 rounded-full transition disabled:opacity-40 ${user.active ? 'badge badge-emerald' : 'badge badge-red'}`}
                      >
                        {user.active ? 'Active' : 'Disabled'}
                      </button>
                    </div>
                  ))}
                  {users.length === 0 && <p className="text-xs text-t3 py-6 text-center">No users match your search.</p>}
                </div>
              </>
            );
          }}
        </ResourceSection>
      </BentoCard>
    </div>
  );
}

/* ------------------------------------------------------------------ Roles */
function RolesSection() {
  const roles = useCrudResource<RoleDef>('/v1/settings/roles');
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ name: '', description: '' });

  async function add() {
    if (!form.name.trim() || !form.description.trim()) return;
    await roles.create({ name: form.name.trim(), description: form.description.trim(), accent: 'blue' });
    setForm({ name: '', description: '' });
    setShow(false);
  }

  return (
    <BentoCard title="Roles & access" subtitle="Configured permission groups" headerRight={<Lock className="w-4 h-4 text-t3" />}>
      {roles.actionFailure && <ResourceErrorNotice title="That role change was not saved" failure={roles.actionFailure} className="mb-3" />}
      <ResourceSection
        label="Roles"
        state={roles.state}
        onRetry={roles.reload}
        empty={{
          icon: <Lock className="w-5 h-5" />,
          title: 'No roles configured',
          description: 'The role list loaded successfully and this workspace has no role definitions.',
        }}
      >
        {rows => (
          <div className="space-y-2.5">
            {rows.map(r => (
              <div key={r.id} className="flex items-start gap-3 p-3 rounded-xl border border-[var(--b1)] hover:bg-[var(--s3)] transition-colors group">
                <span className={`text-[10px] font-bold px-2 py-1 rounded-lg shrink-0 ${accentBadge[r.accent] ?? 'badge badge-blue'}`}>{r.name}</span>
                <p className="flex-1 min-w-0 text-[11px] text-t2">{r.description}</p>
                <span className="text-[10px] text-t3 shrink-0">{r.userCount} users</span>
                <button type="button" disabled={roles.busy} onClick={() => roles.remove(r.id)} className="text-t3 hover:text-red-v opacity-0 group-hover:opacity-100 disabled:opacity-40 shrink-0" aria-label="Delete role"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            ))}
          </div>
        )}
      </ResourceSection>

      {/* Adding is only offered once the list itself loaded: a role cannot be
          added to a list the workspace would not return. */}
      {hasResponse(roles.state) && (show ? (
        <div className="mt-3 p-3 rounded-xl border border-[var(--b2)] bg-[var(--s2)] space-y-2">
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} aria-label="Role name" placeholder="Role name" className={inputClass} />
          <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} aria-label="Role description" placeholder="Role description" className={inputClass} />
          <div className="flex gap-2">
            <button type="button" disabled={roles.busy} onClick={add} className="flex-1 py-2 rounded-lg bg-[var(--indigo)] text-white text-xs font-semibold hover:opacity-90 disabled:opacity-40">Add role</button>
            <button type="button" onClick={() => setShow(false)} className="px-3 py-2 rounded-lg border border-[var(--b1)] text-t2 text-xs font-semibold hover:bg-[var(--s3)]">Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setShow(true)} className="mt-3 w-full py-2 border border-dashed border-[var(--b2)] rounded-xl text-xs font-semibold text-t3 hover:text-indigo hover:bg-[var(--s3)] inline-flex items-center justify-center gap-1"><Plus className="w-3.5 h-3.5" /> Add role</button>
      ))}
    </BentoCard>
  );
}

/* ------------------------------------------------------------------ Notifications */
function NotificationsSection() {
  const templates = useCrudResource<Template>('/v1/settings/notification-templates');
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ name: '', channel: '' });

  async function add() {
    if (!form.name.trim() || !form.channel.trim()) return;
    await templates.create({ name: form.name.trim(), channel: form.channel.trim(), status: 'ACTIVE' });
    setForm({ name: '', channel: '' });
    setShow(false);
  }

  return (
    <BentoCard title="Notification templates" subtitle="Configured patient-message templates; delivery depends on provider setup and consent checks" headerRight={<Bell className="w-4 h-4 text-t3" />}>
      {templates.actionFailure && <ResourceErrorNotice title="That template change was not saved" failure={templates.actionFailure} className="mb-3" />}
      <ResourceSection
        label="Notification templates"
        state={templates.state}
        onRetry={templates.reload}
        empty={{
          icon: <Bell className="w-5 h-5" />,
          title: 'No templates configured',
          description: 'The template list loaded successfully and this workspace has no message templates.',
        }}
      >
        {rows => (
          <div className="space-y-2.5">
            {rows.map(t => (
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
        )}
      </ResourceSection>

      {hasResponse(templates.state) && (show ? (
        <div className="mt-3 p-3 rounded-xl border border-[var(--b2)] bg-[var(--s2)] space-y-2">
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} aria-label="Template name" placeholder="Template name" className={inputClass} />
          <input value={form.channel} onChange={e => setForm(f => ({ ...f, channel: e.target.value }))} aria-label="Message channel" placeholder="Channel (for example, SMS)" className={inputClass} />
          <div className="flex gap-2">
            <button type="button" disabled={templates.busy} onClick={add} className="flex-1 py-2 rounded-lg bg-[var(--indigo)] text-white text-xs font-semibold hover:opacity-90 disabled:opacity-40">Add template</button>
            <button type="button" onClick={() => setShow(false)} className="px-3 py-2 rounded-lg border border-[var(--b1)] text-t2 text-xs font-semibold hover:bg-[var(--s3)]">Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setShow(true)} className="mt-3 w-full py-2 border border-dashed border-[var(--b2)] rounded-xl text-xs font-semibold text-t3 hover:text-indigo hover:bg-[var(--s3)] inline-flex items-center justify-center gap-1"><Plus className="w-3.5 h-3.5" /> Add template</button>
      ))}
    </BentoCard>
  );
}

/* ------------------------------------------------------------------ Integrations */
function IntegrationsSection() {
  const integrations = useResource<IntegrationStatus[]>('/v1/integrations/status');
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Held here rather than in the rendered list so a reload cannot discard the
  // result of a connection test the user just ran.
  async function test(key: string) {
    setTestingKey(key);
    setToast(null);
    try {
      const res = await apiRequest<{ message?: string; modeLabel?: string }>(`/v1/integrations/${key}/test`, { method: 'POST' });
      setToast(`${key}: ${res.modeLabel ?? 'tested'} — ${res.message ?? 'ok'}`);
      integrations.reload();
    } catch (err) {
      setToast(`${key}: ${describeFailure(err).message}`);
    } finally {
      setTestingKey(null);
    }
  }

  return (
    <div className="space-y-4">
      {toast && <div role="status" aria-live="polite" className="rounded-xl border border-[var(--b2)] bg-[var(--blue-soft)] px-3 py-2 text-[11px] font-semibold text-blue-v">{toast}</div>}

      <ResourceSection
        label="Integrations"
        state={integrations.state}
        onRetry={integrations.reload}
        loading={<ResourceSkeleton label="integrations" lines={4} rowClassName="h-16 rounded-xl" />}
        empty={{
          icon: <Cable className="w-5 h-5" />,
          title: 'No integrations available',
          description: 'The integration catalogue loaded successfully and returned no providers.',
        }}
      >
        {rows => <IntegrationsView rows={rows} testingKey={testingKey} onTest={test} />}
      </ResourceSection>
    </div>
  );
}

function IntegrationsView({ rows, testingKey, onTest }: { rows: IntegrationStatus[]; testingKey: string | null; onTest: (key: string) => void }) {
  const grouped = useMemo(() => {
    const map = new Map<string, IntegrationStatus[]>();
    for (const item of rows) {
      if (!map.has(item.category)) map.set(item.category, []);
      map.get(item.category)!.push(item);
    }
    return [...map.entries()];
  }, [rows]);

  const connected = rows.filter(d => d.configured).length;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Integrations" value={rows.length} subtitle="Available providers" icon={<Cable className="w-4 h-4" />} accent="blue" />
        <StatCard title="Configured" value={connected} subtitle="Configuration detected" icon={<CheckCircle2 className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Needs Setup" value={rows.length - connected} subtitle="Awaiting credentials" icon={<AlertTriangle className="w-4 h-4" />} accent="amber" />
        <StatCard title="Categories" value={grouped.length} subtitle="Provider types" icon={<Activity className="w-4 h-4" />} accent="violet" />
      </div>

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

                {item.missingConfigCount > 0 && (
                  <p className="text-[10px] text-amber-v mb-2 flex items-center gap-1"><KeyRound className="w-3 h-3 shrink-0" /> Setup required — your administrator must finish connecting this provider.</p>
                )}

                <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                  <span className="text-[10px] text-t3">{item.lastSyncAt ? `Synced ${new Date(item.lastSyncAt).toLocaleDateString('en-GB')}` : 'Never synced'}</span>
                  <button type="button" disabled={testingKey === item.key} onClick={() => onTest(item.key)} className="inline-flex items-center gap-1 text-[10px] font-semibold text-indigo bg-[var(--indigo-soft)] px-2.5 py-1 rounded-lg hover:opacity-80 disabled:opacity-40">
                    <RefreshCw className={`w-3 h-3 ${testingKey === item.key ? 'animate-spin' : ''}`} /> {testingKey === item.key ? 'Testing…' : 'Test connection'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </BentoCard>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ Security */
function ChangePasswordCard() {
  const navigate = useNavigate();
  const { signOut } = useSession();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (form.newPassword !== form.confirmPassword) {
      setError('The new password and its confirmation do not match.');
      return;
    }
    setBusy(true);
    try {
      await apiRequest('/v1/auth/password-change', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: form.currentPassword, newPassword: form.newPassword }),
      });
      setForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setChanged(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password change failed.');
    } finally {
      setBusy(false);
    }
  }

  // The change revoked this session server-side. Clicking "sign in again" is
  // not enough: switching Settings tabs unmounts this card and leaves a
  // signed-in-looking shell whose every request now 401s. Guarantee the local
  // session ends however the user leaves, while still showing the confirmation.
  const changedRef = useRef(false);
  useEffect(() => { changedRef.current = changed; }, [changed]);
  useEffect(() => () => { if (changedRef.current) void signOut(); }, [signOut]);

  // Explicit path for the user who clicks the button.
  async function signInAgain() {
    await signOut();
    navigate('/login', { replace: true });
  }

  return (
    <BentoCard title="Your password" subtitle="Change the password for your own account. No reset email is sent — your current password is the confirmation." headerRight={<KeyRound className="w-4 h-4 text-t3" />}>
      {changed ? (
        <div className="space-y-3 max-w-sm">
          <p role="status" className="rounded-xl border border-[var(--b1)] bg-[var(--emerald-soft)] px-3 py-2.5 text-[11px] font-semibold text-emerald-v">
            Password updated. Every session for your account was ended, so sign in again with the new password.
          </p>
          <button type="button" onClick={() => void signInAgain()} className="w-full py-2 rounded-lg bg-[var(--indigo)] text-white text-xs font-semibold hover:opacity-90">Sign in again</button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-2 max-w-sm">
          {error && <p role="alert" className="text-[11px] text-red-v">{error}</p>}
          <input type="password" value={form.currentPassword} onChange={e => setForm(f => ({ ...f, currentPassword: e.target.value }))} aria-label="Current password" placeholder="Current password" autoComplete="current-password" className={inputClass} required />
          <input type="password" value={form.newPassword} onChange={e => setForm(f => ({ ...f, newPassword: e.target.value }))} aria-label="New password" placeholder="New password" autoComplete="new-password" minLength={8} className={inputClass} required />
          <input type="password" value={form.confirmPassword} onChange={e => setForm(f => ({ ...f, confirmPassword: e.target.value }))} aria-label="Confirm new password" placeholder="Confirm new password" autoComplete="new-password" minLength={8} className={inputClass} required />
          <button type="submit" disabled={busy} className="w-full py-2 rounded-lg bg-[var(--indigo)] text-white text-xs font-semibold hover:opacity-90 disabled:opacity-40">{busy ? 'Updating…' : 'Update password'}</button>
          <p className="text-[10px] text-t3">Changing your password ends every signed-in session for your account, including this one.</p>
        </form>
      )}
    </BentoCard>
  );
}

/* ------------------------------------------------------------------ Security */

function SecuritySection() {
  const posture = useResource<SecurityPosture>('/v1/security/posture');
  const sessions = useResource<SessionRow[]>('/v1/security/sessions');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionFailure, setActionFailure] = useState<ResourceFailure | null>(null);

  async function revoke(userId: string) {
    setPendingId(userId);
    setActionFailure(null);
    try {
      await apiRequest(`/v1/security/sessions/${userId}/revoke`, { method: 'POST' });
      sessions.reload();
    } catch (err) {
      setActionFailure(describeFailure(err));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Self-service password change: available to EVERY authenticated user.
          This is the only self-service password path in the product, so it must
          not sit behind an admin-only gate. */}
      <ChangePasswordCard />
      {actionFailure && <ResourceErrorNotice title="Those sessions were not revoked" failure={actionFailure} />}

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <ResourceSection label="Access token lifetime" state={posture.state} onRetry={posture.reload} compact loading={<TileSkeleton label="access token lifetime" />}>
          {p => <StatCard title="Access Token TTL" value={`${p.accessTokenTtlMinutes}m`} subtitle="Session lifetime" icon={<Clock className="w-4 h-4" />} accent="blue" />}
        </ResourceSection>
        <ResourceSection label="Audit event count" state={posture.state} onRetry={posture.reload} compact loading={<TileSkeleton label="audit event count" />}>
          {p => <StatCard title="Audit Events" value={p.auditEventCount} subtitle="Total logged" icon={<Activity className="w-4 h-4" />} accent="violet" />}
        </ResourceSection>
        <ResourceSection label="Login event count" state={posture.state} onRetry={posture.reload} compact loading={<TileSkeleton label="login event count" />}>
          {p => <StatCard title="Login Events" value={p.loginEventCount} subtitle="Recorded" icon={<KeyRound className="w-4 h-4" />} accent="emerald" />}
        </ResourceSection>
        <ResourceSection label="Session records" state={sessions.state} onRetry={sessions.reload} compact isEmpty={() => false} loading={<TileSkeleton label="session records" />}>
          {rows => <StatCard title="Unrevoked Sessions" value={rows.filter(s => !s.revoked).length} subtitle="Session records" icon={<Users className="w-4 h-4" />} accent="amber" />}
        </ResourceSection>
      </div>

      <BentoCard title="Security Posture" subtitle="Authentication & controls" headerRight={<ShieldCheck className="w-4 h-4 text-t3" />}>
        <ResourceSection label="Security posture" state={posture.state} onRetry={posture.reload} lines={4} rowClassName="h-11 rounded-xl">
          {p => (
            <>
              <p className="text-[11px] text-t3 mb-2">Auth mode: {p.authMode}</p>
              <div className="grid sm:grid-cols-2 gap-2">
                {[
                  { label: 'Role-based access control', ok: p.rbacEnabled },
                  { label: 'Audit logging', ok: p.auditLoggingEnabled },
                  { label: 'Rate limiting', ok: p.rateLimitingEnabled },
                  { label: 'CSRF protection', ok: p.csrf.enabled },
                  { label: 'JWT secret configured', ok: p.secrets.jwtSecretConfigured },
                  { label: 'Refresh secret configured', ok: p.secrets.jwtRefreshSecretConfigured },
                  { label: 'Dev-token disabled in production', ok: p.devTokenDisabledInProduction },
                  { label: 'HTTPS required', ok: p.httpsRequired },
                ].map(c => (
                  <div key={c.label} className={`flex items-center gap-2.5 p-2.5 rounded-xl border border-[var(--b1)] ${c.ok ? 'bg-[var(--emerald-soft)]' : 'bg-[var(--amber-soft)]'}`}>
                    {c.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-v shrink-0" /> : <Circle className="w-3.5 h-3.5 text-amber-v shrink-0" />}
                    <p className="text-[11px] font-medium text-t2">{c.label}</p>
                  </div>
                ))}
              </div>
            </>
          )}
        </ResourceSection>
      </BentoCard>

      <BentoCard title="Session records" subtitle="Revoke a user's sessions to require sign-in again">
        <ResourceSection
          label="Session records"
          state={sessions.state}
          onRetry={sessions.reload}
          empty={{
            icon: <Users className="w-5 h-5" />,
            title: 'No session records',
            description: 'The session list loaded successfully and this workspace has no recorded sessions.',
          }}
        >
          {rows => (
            <>
              <p className="text-[11px] text-t3 mb-2">{rows.filter(s => !s.revoked).length} unrevoked</p>
              <div className="space-y-2">
                {rows.map(s => (
                  <div key={s.id} className="flex flex-wrap items-center gap-3 p-3 rounded-xl border border-[var(--b1)]">
                    <div className="flex-1 min-w-[160px]">
                      <p className="text-xs font-bold text-t1">{s.user.displayName} <span className="text-[10px] font-normal text-t3">· {s.user.role.replace('_', ' ')}</span></p>
                      <p className="text-[10px] text-t3 mt-0.5">
                        {s.lastLoginAudit ? `${s.lastLoginAudit.ipAddress} · ` : ''}
                        last active {new Date(s.lastActivityAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                    {s.revoked
                      ? <span className="badge badge-red shrink-0">Revoked</span>
                      : <button type="button" disabled={pendingId === s.user.id} onClick={() => revoke(s.user.id)} aria-label={`Revoke sessions for ${s.user.displayName}`} className="text-[10px] font-semibold text-red-v hover:opacity-80 border border-[var(--b1)] px-2.5 py-1 rounded-lg disabled:opacity-40 shrink-0">{pendingId === s.user.id ? 'Revoking…' : 'Revoke sessions'}</button>
                    }
                  </div>
                ))}
              </div>
            </>
          )}
        </ResourceSection>
      </BentoCard>
    </div>
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

/** KPI-tile shaped loading placeholder, announced like every other one. */
function TileSkeleton({ label }: { label: string }) {
  return <ResourceSkeleton label={label} lines={1} rowClassName="h-[92px] rounded-xl" />;
}

function StatusRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-t3 shrink-0">{label}</span>
      <div className="min-w-0 text-right">{children}</div>
    </div>
  );
}
