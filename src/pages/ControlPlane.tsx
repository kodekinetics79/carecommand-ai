import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Activity,
  CheckCircle2,
  Database,
  Globe2,
  KeyRound,
  Lock,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  ServerCog,
  ShieldCheck,
  Users2,
  Building2,
  FileClock,
  BadgeCheck,
} from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import BentoCard from '../components/ui/BentoCard';
import StatCard from '../components/ui/StatCard';
import ResourceSection, { ResourceErrorNotice, ResourceSkeleton } from '../components/ui/ResourceSection';
import { apiRequest, downloadCsv } from '../lib/api';
import { describeFailure, receivedData, type ResourceFailure } from '../lib/resourceState';
import { useResource } from '../hooks/useResource';
import { getLocale } from '../lib/preferences';
import { useSession } from '../hooks/useSession';
import type { AdminAuditEvent, AdminRole, AdminUser, SecurityPosture, SecuritySession } from '../types';

// Three tabs left with the supplier catalogue: Integration Hub (17 vendor
// cards with Mock Mode badges and Test connection), Insurance Rails and
// Finance Rails (per-vendor readiness, error rates and provider run logs).
// A clinic owner cannot act on any of it — they hold no account with the
// companies named — and every one of those screens is now in the Platform
// Console at /v1/platform/tenants/:tenantId/providers, whole.
type TabKey =
  | 'overview'
  | 'users'
  | 'roles'
  | 'clinics'
  | 'audit'
  | 'security'
  | 'system';

interface ControlPlaneOverview {
  tenant: { id: string; name: string; slug: string } | null;
  summary: {
    totalUsers: number;
    activeUsers: number;
    adminUsers: number;
    inactiveUsers: number;
    clinics: number;
    auditEventsToday: number;
    securityAlerts: number;
    productionReadinessScore: number;
  };
  branches: Array<{ id: string; name: string; location: string; active: boolean }>;
  securityPosture: SecurityPosture;
  systemHealth: SystemHealth;
  auditEventsToday: Array<{ id: string; action: string; occurredAt: string }>;
}

interface ControlPlaneUsersResponse {
  tenant: { id: string; name: string; slug: string } | null;
  branches: Array<{ id: string; name: string; location: string; active: boolean }>;
  summary: { totalUsers: number; activeUsers: number; inactiveUsers: number; activeBranches: number };
  users: AdminUser[];
}

interface ControlPlaneRolesResponse {
  roles: (AdminRole & { risk?: 'low' | 'medium' | 'high' })[];
  permissionMatrix: Array<{ role: string; scope: string; modules: string[]; risk: 'low' | 'medium' | 'high' }>;
  moduleSummary: Array<{ module: string; permissions: string[] }>;
}

interface ControlPlaneClinicsResponse {
  id: string;
  name: string;
  location: string;
  active: boolean;
  userCount: number;
  securityAlerts: number;
}

interface ControlPlaneAuditLog extends AdminAuditEvent {
  module: string;
  tenantId: string;
  clinicId: string | null;
  result: 'success' | 'failed';
  details: unknown;
}

interface ControlPlaneSecurityEvent {
  id: string;
  action: string;
  actor: string;
  role: string | null;
  status: string;
  occurredAt: string;
  details: unknown;
}

interface ControlPlaneUserAuditEntry {
  id: string;
  action: string;
  resource: string;
  actor: string;
  occurredAt: string;
  metadata: unknown;
}

interface SystemHealth {
  apiStatus: string;
  databaseStatus: string;
  dbLatencyMs: number | null;
  migrationStatus: string;
  latestMigration: string | null;
  authStatus: string;
  revenueProtectionStatus: string;
  backgroundJobs: string;
  environmentMode: string;
  buildVersion: string | null;
  auditEventCount: number;
}

const tabs: Array<{ key: TabKey; label: string; icon: React.ElementType }> = [
  { key: 'overview', label: 'Overview', icon: ServerCog },
  { key: 'users', label: 'Users & Access', icon: Users2 },
  { key: 'roles', label: 'Roles & Permissions', icon: ShieldCheck },
  { key: 'clinics', label: 'Clinics & Tenants', icon: Building2 },
  { key: 'audit', label: 'Audit Logs', icon: FileClock },
  { key: 'security', label: 'Security Posture', icon: Lock },
  { key: 'system', label: 'System Health', icon: Activity },
];

const AUDIT_FILTER_DEFAULTS = { userId: '', module: '', action: '', from: '', to: '' };

function formatDateTime(value: string | null | undefined) {
  if (!value) return '—';
  return new Date(value).toLocaleString(getLocale(), {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatRisk(value?: 'low' | 'medium' | 'high') {
  return value === 'high' ? 'badge-red' : value === 'medium' ? 'badge-amber' : 'badge-emerald';
}

export default function ControlPlane() {
  const { user } = useSession();
  const [activeTab, setActiveTab] = useState<TabKey>('overview');

  // Every panel loads on its own so one refused or slow endpoint cannot blank
  // the others, and so a panel that failed says so instead of reporting zero.
  const overview = useResource<ControlPlaneOverview>('/v1/control-plane/overview');
  const users = useResource<ControlPlaneUsersResponse>('/v1/control-plane/users?limit=100');
  const roles = useResource<ControlPlaneRolesResponse>('/v1/control-plane/roles');
  const clinics = useResource<ControlPlaneClinicsResponse[]>('/v1/control-plane/clinics');
  const posture = useResource<SecurityPosture>('/v1/control-plane/security-posture');
  const securityEvents = useResource<ControlPlaneSecurityEvent[]>('/v1/control-plane/security-events');
  const sessions = useResource<SecuritySession[]>('/v1/control-plane/sessions?limit=100');
  const systemHealth = useResource<SystemHealth>('/v1/control-plane/system-health');

  const [auditFilters, setAuditFilters] = useState(AUDIT_FILTER_DEFAULTS);
  const [appliedAuditFilters, setAppliedAuditFilters] = useState(AUDIT_FILTER_DEFAULTS);
  const auditPath = useMemo(() => {
    const params = new URLSearchParams();
    params.set('limit', '50');
    if (appliedAuditFilters.userId) params.set('userId', appliedAuditFilters.userId);
    if (appliedAuditFilters.module) params.set('module', appliedAuditFilters.module);
    if (appliedAuditFilters.action) params.set('action', appliedAuditFilters.action);
    if (appliedAuditFilters.from) params.set('from', appliedAuditFilters.from);
    if (appliedAuditFilters.to) params.set('to', appliedAuditFilters.to);
    return `/v1/control-plane/audit-logs?${params.toString()}`;
  }, [appliedAuditFilters]);
  // The rows are keyed to the filters that produced them: applying a filter
  // reads as loading rather than leaving the previous answer under a new query.
  const auditLogs = useResource<ControlPlaneAuditLog[]>(auditPath);

  const [roleSelection, setRoleSelection] = useState<string | null>(null);
  const [userSearch, setUserSearch] = useState('');
  const [savingAction, setSavingAction] = useState<string | null>(null);
  const [actionFailure, setActionFailure] = useState<ResourceFailure | null>(null);
  const [editingAccessUserId, setEditingAccessUserId] = useState<string | null>(null);
  const [accessDraft, setAccessDraft] = useState<{ branchIds: string[]; primaryBranchId?: string }>({ branchIds: [] });
  const [auditTrailUserId, setAuditTrailUserId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteForm, setInviteForm] = useState({
    name: '',
    email: '',
    password: '',
    role: 'FRONT_DESK',
    branchIds: [] as string[],
    primaryBranchId: '',
  });

  const canManage = !!user && ['OWNER', 'ADMIN'].includes(user.role);

  function refreshAll() {
    overview.reload();
    users.reload();
    roles.reload();
    clinics.reload();
    posture.reload();
    securityEvents.reload();
    sessions.reload();
    systemHealth.reload();
    auditLogs.reload();
  }

  // A mutation refreshes what it actually changed. Reported failures are shown;
  // they used to be swallowed, which left the screen claiming the change stuck.
  async function runAction(key: string, run: () => Promise<unknown>, afterSuccess: () => void) {
    if (!canManage) return;
    setSavingAction(key);
    setActionFailure(null);
    try {
      await run();
      afterSuccess();
    } catch (err) {
      setActionFailure(describeFailure(err));
    } finally {
      setSavingAction(null);
    }
  }

  const receivedRoles = receivedData(roles.state);
  const roleOptions = receivedRoles?.roles ?? null;
  const selectedRole = roleSelection && roleOptions?.some(role => role.enumValue === roleSelection)
    ? roleSelection
    : roleOptions?.[0]?.enumValue ?? '';
  const selectedRoleDetails = roleOptions?.find(role => role.enumValue === selectedRole);

  const receivedOverview = receivedData(overview.state);
  const headerBadge = overview.state.status === 'loading'
    ? 'Loading…'
    : receivedOverview
      ? `Checks ${receivedOverview.summary.productionReadinessScore}%`
      : 'Checks unavailable';

  async function updateUserRole(userId: string, role: string) {
    await runAction(
      `role:${userId}`,
      () => apiRequest(`/v1/control-plane/users/${userId}/role`, { method: 'PATCH', body: JSON.stringify({ role }) }),
      () => { users.reload(); roles.reload(); overview.reload(); },
    );
  }

  async function toggleUserActive(userId: string, active: boolean) {
    await runAction(
      `status:${userId}`,
      () => apiRequest(`/v1/control-plane/users/${userId}/status`, { method: 'PATCH', body: JSON.stringify({ active }) }),
      () => { users.reload(); overview.reload(); },
    );
  }

  async function saveUserAccess(userId: string) {
    await runAction(
      `access:${userId}`,
      () => apiRequest(`/v1/control-plane/users/${userId}/clinic-access`, { method: 'PATCH', body: JSON.stringify(accessDraft) }),
      () => { setEditingAccessUserId(null); users.reload(); },
    );
  }

  async function revokeSession(userId: string) {
    await runAction(
      `session:${userId}`,
      () => apiRequest(`/v1/control-plane/sessions/${userId}/revoke`, { method: 'PATCH' }),
      () => { users.reload(); sessions.reload(); },
    );
  }

  async function createUserInvite() {
    if (!canManage) return;
    setInviteBusy(true);
    setInviteError(null);
    try {
      await apiRequest('/v1/control-plane/users', {
        method: 'POST',
        body: JSON.stringify({
          name: inviteForm.name.trim(),
          email: inviteForm.email.trim().toLowerCase(),
          password: inviteForm.password,
          role: inviteForm.role,
          branchIds: inviteForm.branchIds,
          primaryBranchId: inviteForm.primaryBranchId || undefined,
        }),
      });
      setInviteOpen(false);
      setInviteForm({ name: '', email: '', password: '', role: 'FRONT_DESK', branchIds: [], primaryBranchId: '' });
      users.reload();
      roles.reload();
      overview.reload();
    } catch (err) {
      setInviteError(describeFailure(err).message);
    } finally {
      setInviteBusy(false);
    }
  }

  async function toggleClinicStatus(clinicId: string, active: boolean) {
    await runAction(
      `clinic:${clinicId}`,
      () => apiRequest(`/v1/control-plane/clinics/${clinicId}/status`, { method: 'PATCH', body: JSON.stringify({ active }) }),
      () => { clinics.reload(); overview.reload(); },
    );
  }

  const inviteValid = inviteForm.name.trim().length >= 2 && /.+@.+\..+/.test(inviteForm.email) && inviteForm.password.length >= 8;

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Control Plane"
        subtitle="Review access, recorded controls, audit events, provider connectivity, and system health for this workspace."
        badge={headerBadge}
        badgeColor={overview.state.status === 'error' ? 'red' : 'violet'}
        actions={
          <button
            type="button"
            onClick={refreshAll}
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--indigo-mid)] transition"
          >
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        }
      />

      <div role="note" className="rounded-2xl border border-[var(--amber-soft)] bg-[var(--amber-soft)] px-4 py-3 text-xs text-amber-v">
        The displayed score summarizes selected configuration checks. It is not a security assessment, compliance certification, or authorization to launch.
      </div>

      {actionFailure && <ResourceErrorNotice title="That change was not saved" failure={actionFailure} />}

      <div className="flex flex-wrap gap-2 border-b border-[var(--b1)] pb-3">
        {tabs.map(tab => {
          const Icon = tab.icon;
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`inline-flex items-center gap-2 rounded-full px-3 py-2 text-xs font-semibold transition ${active ? 'bg-[var(--indigo)] text-white' : 'border border-[var(--b1)] text-t2 hover:bg-[var(--s3)]'}`}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === 'overview' && (
        <div className="space-y-6">
          <ResourceSection
            label="Control plane overview"
            state={overview.state}
            onRetry={overview.reload}
            loading={<ResourceSkeleton label="control plane overview" lines={2} rowClassName="h-24 rounded-2xl" />}
          >
            {data => (
              <div className="space-y-6">
                <div className="grid gap-3 grid-cols-2 xl:grid-cols-5">
                  <StatCard title="Users" value={data.summary.totalUsers} subtitle="Tenant accounts" icon={<Users2 className="w-4 h-4" />} accent="blue" />
                  <StatCard title="Active users" value={data.summary.activeUsers} subtitle="Enabled accounts" icon={<CheckCircle2 className="w-4 h-4" />} accent="emerald" />
                  <StatCard title="Admin users" value={data.summary.adminUsers} subtitle="OWNER / ADMIN" icon={<ShieldCheck className="w-4 h-4" />} accent="violet" />
                  <StatCard title="Clinics" value={data.summary.clinics} subtitle="Branches in tenant" icon={<Building2 className="w-4 h-4" />} accent="amber" />
                  <StatCard title="Control checks" value={`${data.summary.productionReadinessScore}%`} subtitle="Configured-check score" icon={<BadgeCheck className="w-4 h-4" />} accent="emerald" />
                </div>

                <BentoCard title="Configuration checks" subtitle="Calculated from the runtime signals listed below" headerRight={<BadgeCheck className="w-4 h-4 text-t3" />}>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-2xl border border-[var(--b1)] p-4">
                      <p className="text-xs text-t3">Configured-check score</p>
                      <p className="mt-2 text-3xl font-black text-t1">{data.summary.productionReadinessScore}%</p>
                      <p className="mt-1 text-xs text-t3">Calculated from authentication, secret configuration, access controls, audit logging, and tenant-isolation checks.</p>
                    </div>
                    <div className="rounded-2xl border border-[var(--b1)] p-4">
                      <p className="text-xs text-t3">Audit events today</p>
                      <p className="mt-2 text-3xl font-black text-t1">{data.summary.auditEventsToday}</p>
                      <p className="mt-1 text-xs text-t3">Recorded in this workspace since midnight.</p>
                    </div>
                  </div>
                </BentoCard>
              </div>
            )}
          </ResourceSection>

          <BentoCard title="Security Alerts" subtitle="Issues that need owner attention" headerRight={<AlertTriangle className="w-4 h-4 text-t3" />}>
            <ResourceSection
              label="Security alerts"
              state={posture.state}
              onRetry={posture.reload}
              isEmpty={data => data.alerts.length === 0}
              empty={{
                icon: <ShieldCheck className="w-5 h-5" />,
                title: 'No alerts returned',
                description: 'The security-posture checks ran and returned no alerts. This is not a complete security assessment.',
              }}
            >
              {data => (
                <div className="space-y-2">
                  {data.alerts.map((alert, index) => (
                    <div key={`${alert.title}-${index}`} className="rounded-xl border border-[var(--b1)] p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-t1">{alert.title}</p>
                        <span className={`badge ${formatRisk(alert.severity as 'low' | 'medium' | 'high')}`}>{alert.severity}</span>
                      </div>
                      <p className="mt-1 text-[11px] text-t3 leading-relaxed">{alert.message}</p>
                    </div>
                  ))}
                </div>
              )}
            </ResourceSection>
          </BentoCard>
        </div>
      )}

      {activeTab === 'users' && (
        <BentoCard title="Users & Access" subtitle="Activate users, change roles, update clinic access, revoke sessions, and review audit trails." headerRight={<Users2 className="w-4 h-4 text-t3" />}>
          <ResourceSection
            label="Users and access"
            state={users.state}
            onRetry={users.reload}
            // A directory with no rows is stated inside the table so the invite
            // control stays reachable for the first user of a new tenant.
            isEmpty={() => false}
            loading={<ResourceSkeleton label="users and access" lines={5} />}
          >
            {payload => {
              const term = userSearch.trim().toLowerCase();
              const visibleUsers = payload.users.filter(userRecord => !term || userRecord.displayName.toLowerCase().includes(term) || userRecord.email.toLowerCase().includes(term));
              const activeBranches = payload.branches.filter(branch => branch.active);
              return (
                <>
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div className="relative flex-1">
                      <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-t3" />
                      <input value={userSearch} onChange={event => setUserSearch(event.target.value)} placeholder="Search users" className="w-full rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-10 py-2 text-sm text-t1 outline-none focus:border-[var(--b3)]" />
                    </div>
                    <button type="button" onClick={() => setInviteOpen(v => !v)} disabled={!canManage} className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-t2 hover:bg-[var(--s3)] transition disabled:cursor-not-allowed disabled:opacity-50">
                      <Plus className="w-3.5 h-3.5" /> Invite user
                    </button>
                  </div>

                  {inviteOpen && canManage && (
                    <div className="mt-4 rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-t1">Invite a new clinic user</p>
                          <p className="text-xs text-t3">Creates a real tenant user with a temporary password and optional clinic access.</p>
                        </div>
                        <button type="button" onClick={() => setInviteOpen(false)} className="text-xs font-semibold text-t3 hover:text-t1">Close</button>
                      </div>
                      {inviteError && <div className="mt-3 rounded-xl border border-[rgba(220,38,38,0.18)] bg-[var(--red-soft)] px-3 py-2 text-xs text-red-v" role="alert">{inviteError}</div>}
                      <div className="mt-4 grid gap-3 md:grid-cols-2">
                        <input
                          value={inviteForm.name}
                          onChange={event => setInviteForm(current => ({ ...current, name: event.target.value }))}
                          placeholder="Full name"
                          className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm text-t1 outline-none focus:border-[var(--b3)]"
                        />
                        <input
                          value={inviteForm.email}
                          onChange={event => setInviteForm(current => ({ ...current, email: event.target.value }))}
                          placeholder="name@clinic.com"
                          type="email"
                          className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm text-t1 outline-none focus:border-[var(--b3)]"
                        />
                        <input
                          value={inviteForm.password}
                          onChange={event => setInviteForm(current => ({ ...current, password: event.target.value }))}
                          placeholder="Temporary password"
                          type="text"
                          className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm text-t1 outline-none focus:border-[var(--b3)]"
                        />
                        <select
                          value={inviteForm.role}
                          onChange={event => setInviteForm(current => ({ ...current, role: event.target.value }))}
                          className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm text-t1 outline-none focus:border-[var(--b3)]"
                        >
                          <option value="FRONT_DESK">Front Desk</option>
                          <option value="PROVIDER">Provider</option>
                          <option value="MANAGER">Manager</option>
                          <option value="BILLING">Billing</option>
                          <option value="ANALYST">Analyst</option>
                          <option value="ADMIN">Admin</option>
                          <option value="OWNER">Owner</option>
                          <option value="COMPLIANCE_OFFICER">Compliance Officer</option>
                          <option value="AUDITOR">Auditor</option>
                        </select>
                      </div>
                      <div className="mt-4">
                        <p className="text-xs font-semibold text-t2">Clinic access</p>
                        <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                          {activeBranches.map(branch => (
                            <label key={branch.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--b1)] px-3 py-2 text-sm text-t2">
                              <span className="min-w-0">
                                <span className="block truncate font-semibold text-t1">{branch.name}</span>
                                <span className="block text-[11px] text-t3">{branch.location}</span>
                              </span>
                              <input
                                type="checkbox"
                                checked={inviteForm.branchIds.includes(branch.id)}
                                onChange={event => setInviteForm(current => {
                                  const branchIds = event.target.checked
                                    ? [...current.branchIds, branch.id]
                                    : current.branchIds.filter(id => id !== branch.id);
                                  const nextPrimary = current.primaryBranchId && branchIds.includes(current.primaryBranchId) ? current.primaryBranchId : branchIds[0] ?? '';
                                  return { ...current, branchIds, primaryBranchId: nextPrimary };
                                })}
                              />
                            </label>
                          ))}
                        </div>
                        <div className="mt-3 max-w-sm">
                          <label className="text-xs font-semibold text-t2">Primary branch</label>
                          <select
                            value={inviteForm.primaryBranchId}
                            onChange={event => setInviteForm(current => ({ ...current, primaryBranchId: event.target.value }))}
                            className="mt-1 w-full rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm text-t1 outline-none focus:border-[var(--b3)]"
                          >
                            <option value="">Auto-select first branch</option>
                            {inviteForm.branchIds.map(branchId => {
                              const branch = activeBranches.find(item => item.id === branchId);
                              return branch ? <option key={branch.id} value={branch.id}>{branch.name}</option> : null;
                            })}
                          </select>
                        </div>
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={!inviteValid || inviteBusy}
                          onClick={() => void createUserInvite()}
                          className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--indigo-mid)] transition disabled:opacity-50"
                        >
                          {inviteBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                          Create user
                        </button>
                        <button type="button" onClick={() => setInviteOpen(false)} className="rounded-xl border border-[var(--b1)] px-4 py-2 text-sm font-semibold text-t2 hover:bg-[var(--s3)] transition">Cancel</button>
                      </div>
                    </div>
                  )}

                  <div className="mt-4 overflow-x-auto rounded-2xl border border-[var(--b1)]">
                    <table className="min-w-full text-sm">
                      <thead className="bg-[var(--s2)] text-left text-xs text-t3">
                        <tr>
                          <th className="px-4 py-3">User</th>
                          <th className="px-4 py-3">Role</th>
                          <th className="px-4 py-3">Clinic access</th>
                          <th className="px-4 py-3">Status</th>
                          <th className="px-4 py-3">Session</th>
                          <th className="px-4 py-3">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleUsers.map(userRecord => (
                          <tr key={userRecord.id} className="border-t border-[var(--b1)]">
                            <td className="px-4 py-3">
                              <p className="font-semibold text-t1">{userRecord.displayName}</p>
                              <p className="text-xs text-t3">{userRecord.email}</p>
                              <p className="text-[11px] text-t3">Tenant account</p>
                            </td>
                            <td className="px-4 py-3">
                              {/* The role list is its own request. Without it there
                                  is no menu to offer, so the current role is stated
                                  rather than shown as an empty dropdown. */}
                              {roleOptions ? (
                                <select
                                  value={userRecord.role}
                                  onChange={event => void updateUserRole(userRecord.id, event.target.value)}
                                  disabled={!canManage || savingAction === `role:${userRecord.id}`}
                                  className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-xs font-semibold text-t1 disabled:opacity-60"
                                >
                                  {roleOptions.map(role => (
                                    <option key={role.enumValue} value={role.enumValue}>{role.name}</option>
                                  ))}
                                </select>
                              ) : (
                                <>
                                  <span className="badge badge-blue">{userRecord.role}</span>
                                  <p className="mt-1 text-[11px] text-t3">Role list unavailable — role cannot be changed here.</p>
                                </>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <div className="space-y-2">
                                <p className="text-xs text-t1">{userRecord.accessBranches.map(branch => branch.name).join(', ') || 'No access configured'}</p>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingAccessUserId(userRecord.id);
                                    setAccessDraft({
                                      branchIds: userRecord.accessBranches.map(branch => branch.id),
                                      primaryBranchId: userRecord.accessBranches.find(branch => branch.isPrimary)?.id,
                                    });
                                  }}
                                  className="text-xs font-semibold text-indigo hover:underline"
                                >
                                  Update clinic access
                                </button>
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <span className={`badge ${userRecord.active ? 'badge-emerald' : 'badge-red'}`}>{userRecord.active ? 'Active' : 'Inactive'}</span>
                              <p className="mt-1 text-[11px] text-t3">Created {formatDateTime(userRecord.createdAt)}</p>
                            </td>
                            <td className="px-4 py-3">
                              <span className={`badge ${userRecord.sessionActive ? 'badge-emerald' : 'badge-amber'}`}>{userRecord.sessionActive ? 'Session active' : 'No session'}</span>
                              <p className="mt-1 text-[11px] text-t3">Last login {formatDateTime(userRecord.lastLoginAt)}</p>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex flex-wrap gap-2">
                                <button type="button" onClick={() => void toggleUserActive(userRecord.id, !userRecord.active)} disabled={!canManage || savingAction === `status:${userRecord.id}`} className="rounded-xl border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-t2 hover:bg-[var(--s3)] transition disabled:opacity-50">
                                  {userRecord.active ? 'Deactivate' : 'Activate'}
                                </button>
                                <button type="button" onClick={() => void revokeSession(userRecord.id)} disabled={!canManage || !userRecord.sessionActive || savingAction === `session:${userRecord.id}`} className="rounded-xl border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-t2 hover:bg-[var(--s3)] transition disabled:opacity-40" title={!userRecord.sessionActive ? 'No active session to revoke' : ''}>
                                  Revoke session
                                </button>
                                <button type="button" onClick={() => { setAuditTrailUserId(userRecord.id); setActiveTab('audit'); }} className="rounded-xl border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-t2 hover:bg-[var(--s3)] transition">
                                  View audit trail
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                        {visibleUsers.length === 0 && (
                          <tr className="border-t border-[var(--b1)]">
                            <td className="px-4 py-6 text-center text-xs text-t3" colSpan={6}>
                              {payload.users.length === 0
                                ? 'The user directory loaded successfully and this tenant has no user accounts.'
                                : 'No users match your search.'}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  {editingAccessUserId && (
                    <div className="mt-4 rounded-2xl border border-[var(--b1)] p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-t1">Edit clinic access</p>
                          <p className="text-xs text-t3">Changes are saved to the backend UserClinicAccess table.</p>
                        </div>
                        <button type="button" onClick={() => setEditingAccessUserId(null)} className="text-xs font-semibold text-t3 hover:text-t1">Close</button>
                      </div>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {activeBranches.map(branch => (
                          <label key={branch.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--b1)] px-3 py-2 text-sm text-t2">
                            <span className="min-w-0">
                              <span className="block truncate font-semibold text-t1">{branch.name}</span>
                              <span className="block text-[11px] text-t3">{branch.location}</span>
                            </span>
                            <input
                              type="checkbox"
                              checked={accessDraft.branchIds.includes(branch.id)}
                              onChange={event => {
                                setAccessDraft(current => {
                                  const branchIds = event.target.checked
                                    ? [...current.branchIds, branch.id]
                                    : current.branchIds.filter(branchId => branchId !== branch.id);
                                  return {
                                    branchIds,
                                    primaryBranchId: current.primaryBranchId && branchIds.includes(current.primaryBranchId)
                                      ? current.primaryBranchId
                                      : branchIds[0],
                                  };
                                });
                              }}
                            />
                          </label>
                        ))}
                      </div>
                      <div className="mt-4 flex gap-2">
                        <button type="button" onClick={() => void saveUserAccess(editingAccessUserId)} disabled={savingAction === `access:${editingAccessUserId}`} className="rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--indigo-mid)] transition disabled:opacity-50">Save clinic access</button>
                        <button type="button" onClick={() => setEditingAccessUserId(null)} className="rounded-xl border border-[var(--b1)] px-4 py-2 text-sm font-semibold text-t2 hover:bg-[var(--s3)] transition">Cancel</button>
                      </div>
                    </div>
                  )}
                </>
              );
            }}
          </ResourceSection>
        </BentoCard>
      )}

      {activeTab === 'roles' && (
        <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
          <BentoCard title="Roles & Permissions" subtitle="Read-only matrix until permission editing endpoints are added" headerRight={<ShieldCheck className="w-4 h-4 text-t3" />}>
            <ResourceSection
              label="Roles and permissions"
              state={roles.state}
              onRetry={roles.reload}
              isEmpty={data => data.roles.length === 0}
              empty={{
                icon: <ShieldCheck className="w-5 h-5" />,
                title: 'No roles returned',
                description: 'The role matrix loaded successfully and this tenant has no role definitions.',
              }}
              loading={<ResourceSkeleton label="roles and permissions" lines={5} />}
            >
              {data => (
                <>
                  <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div className="relative flex-1 max-w-md">
                      <select
                        value={selectedRole}
                        onChange={event => setRoleSelection(event.target.value)}
                        className="w-full rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm font-semibold text-t1 outline-none"
                      >
                        {data.roles.map(role => (
                          <option key={role.enumValue} value={role.enumValue}>{role.name}</option>
                        ))}
                      </select>
                    </div>
                    {selectedRoleDetails && (
                      <div className="rounded-xl border border-[var(--b1)] px-3 py-2 text-xs text-t2">
                        <span className={`badge ${formatRisk(selectedRoleDetails.risk)}`}>{selectedRoleDetails.risk ?? 'low'}</span>
                        <span className="ml-2 font-semibold text-t1">{selectedRoleDetails.name}</span>
                        <span className="ml-2 text-t3">{selectedRoleDetails.clinicScope}</span>
                      </div>
                    )}
                  </div>
                  <div className="overflow-x-auto rounded-2xl border border-[var(--b1)]">
                    <table className="min-w-full text-sm">
                      <thead className="bg-[var(--s2)] text-left text-xs text-t3">
                        <tr>
                          <th className="px-4 py-3">Role</th>
                          <th className="px-4 py-3">Scope</th>
                          <th className="px-4 py-3">Users</th>
                          <th className="px-4 py-3">Risk</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.roles.map(role => (
                          <tr key={role.enumValue} className="border-t border-[var(--b1)]">
                            <td className="px-4 py-3">
                              <p className="font-semibold text-t1">{role.name}</p>
                              <p className="text-[11px] text-t3">{role.description}</p>
                            </td>
                            <td className="px-4 py-3 text-xs text-t2">{role.clinicScope}</td>
                            <td className="px-4 py-3 text-xs text-t2">{role.userCount}</td>
                            <td className="px-4 py-3"><span className={`badge ${formatRisk(role.risk)}`}>{role.risk ?? 'low'}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    {data.permissionMatrix.map(row => (
                      <div key={row.role} className="rounded-2xl border border-[var(--b1)] p-4">
                        <p className="text-sm font-semibold text-t1">{row.role}</p>
                        <p className="mt-1 text-xs text-t3">{row.scope}</p>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {row.modules.map(module => <span key={module} className="badge badge-indigo">{module}</span>)}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </ResourceSection>
          </BentoCard>

          <BentoCard title="Module Access Summary" subtitle="High-privilege roles are highlighted">
            <ResourceSection
              label="Module access summary"
              state={roles.state}
              onRetry={roles.reload}
              isEmpty={data => data.moduleSummary.length === 0}
              empty={{
                icon: <Lock className="w-5 h-5" />,
                title: 'No module summary returned',
                description: 'The role matrix loaded successfully and carried no module summary.',
              }}
            >
              {data => (
                <div className="space-y-2">
                  {data.moduleSummary.map(section => (
                    <div key={section.module} className="rounded-xl border border-[var(--b1)] p-3">
                      <p className="text-sm font-semibold text-t1">{section.module}</p>
                      <p className="mt-1 text-[11px] text-t3">{section.permissions.join(' · ')}</p>
                    </div>
                  ))}
                </div>
              )}
            </ResourceSection>
          </BentoCard>
        </div>
      )}

      {activeTab === 'clinics' && (
        <div className="space-y-4">
          <BentoCard title="Tenant Governance" subtitle="Clinics, tenant status, user access, and security alerts">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <ResourceSection label="Tenant" state={overview.state} onRetry={overview.reload} compact loading={<ResourceSkeleton label="tenant" lines={1} rowClassName="h-[76px] rounded-2xl" />}>
                {data => <MetricBox label="Tenant" value={data.tenant?.name ?? 'No tenant record returned'} />}
              </ResourceSection>
              <ResourceSection label="Clinic count" state={clinics.state} onRetry={clinics.reload} compact isEmpty={() => false} loading={<ResourceSkeleton label="clinic count" lines={1} rowClassName="h-[76px] rounded-2xl" />}>
                {rows => <MetricBox label="Clinics" value={String(rows.length)} />}
              </ResourceSection>
              <ResourceSection label="Active user count" state={overview.state} onRetry={overview.reload} compact loading={<ResourceSkeleton label="active user count" lines={1} rowClassName="h-[76px] rounded-2xl" />}>
                {data => <MetricBox label="Active users" value={String(data.summary.activeUsers)} />}
              </ResourceSection>
              <ResourceSection label="Security alert count" state={overview.state} onRetry={overview.reload} compact loading={<ResourceSkeleton label="security alert count" lines={1} rowClassName="h-[76px] rounded-2xl" />}>
                {data => <MetricBox label="Security alerts" value={String(data.summary.securityAlerts)} />}
              </ResourceSection>
            </div>
          </BentoCard>

          <BentoCard title="Clinics" subtitle="Activate / deactivate clinics and view operational load">
            <ResourceSection
              label="Clinics"
              state={clinics.state}
              onRetry={clinics.reload}
              empty={{
                icon: <Building2 className="w-5 h-5" />,
                title: 'No clinics returned',
                description: 'The clinic list loaded successfully and this tenant has no clinic records.',
              }}
              loading={<ResourceSkeleton label="clinics" lines={4} />}
            >
              {rows => (
                <div className="overflow-x-auto rounded-2xl border border-[var(--b1)]">
                  <table className="min-w-full text-sm">
                    <thead className="bg-[var(--s2)] text-left text-xs text-t3">
                      <tr>
                        <th className="px-4 py-3">Clinic</th>
                        <th className="px-4 py-3">Users</th>
                        <th className="px-4 py-3">Security alerts</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(clinic => (
                        <tr key={clinic.id} className="border-t border-[var(--b1)]">
                          <td className="px-4 py-3"><p className="font-semibold text-t1">{clinic.name}</p><p className="text-xs text-t3">{clinic.location}</p></td>
                          <td className="px-4 py-3 text-xs text-t2">{clinic.userCount}</td>
                          <td className="px-4 py-3 text-xs text-t2">{clinic.securityAlerts}</td>
                          <td className="px-4 py-3"><span className={`badge ${clinic.active ? 'badge-emerald' : 'badge-red'}`}>{clinic.active ? 'Active' : 'Inactive'}</span></td>
                          <td className="px-4 py-3">
                            <button type="button" onClick={() => void toggleClinicStatus(clinic.id, !clinic.active)} disabled={!canManage || savingAction === `clinic:${clinic.id}`} className="rounded-xl border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-t2 hover:bg-[var(--s3)] transition disabled:opacity-50">{clinic.active ? 'Deactivate' : 'Activate'}</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </ResourceSection>
          </BentoCard>
        </div>
      )}

      {activeTab === 'audit' && (
        <BentoCard title="Audit Logs" subtitle="Real tenant audit history with filters and export controls">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5 flex-1">
              <input value={auditFilters.userId} onChange={event => setAuditFilters(current => ({ ...current, userId: event.target.value }))} placeholder="User ID" className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm" />
              <input value={auditFilters.module} onChange={event => setAuditFilters(current => ({ ...current, module: event.target.value }))} placeholder="Module" className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm" />
              <input value={auditFilters.action} onChange={event => setAuditFilters(current => ({ ...current, action: event.target.value }))} placeholder="Action" className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm" />
              <input value={auditFilters.from} onChange={event => setAuditFilters(current => ({ ...current, from: event.target.value }))} placeholder="From" type="date" className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm" />
              <input value={auditFilters.to} onChange={event => setAuditFilters(current => ({ ...current, to: event.target.value }))} placeholder="To" type="date" className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm" />
            </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setAppliedAuditFilters(auditFilters)} className="rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white">Apply filters</button>
            <button
              type="button"
              onClick={() => void downloadCsv(`/v1/control-plane/audit-logs/export.csv?${new URLSearchParams({
                ...(auditFilters.userId ? { userId: auditFilters.userId } : {}),
                ...(auditFilters.module ? { module: auditFilters.module } : {}),
                ...(auditFilters.action ? { action: auditFilters.action } : {}),
                ...(auditFilters.from ? { from: auditFilters.from } : {}),
                ...(auditFilters.to ? { to: auditFilters.to } : {}),
              }).toString()}`, 'control-plane-audit.csv')}
              className="rounded-xl border border-[var(--b1)] px-4 py-2 text-sm font-semibold text-t2 hover:bg-[var(--s3)] transition"
            >
              Export
            </button>
          </div>
        </div>

          {auditTrailUserId && (
            <UserAuditTrail userId={auditTrailUserId} onClose={() => setAuditTrailUserId(null)} />
          )}

          <div className="mt-4">
            <ResourceSection
              label="Audit log"
              state={auditLogs.state}
              onRetry={auditLogs.reload}
              empty={{
                icon: <FileClock className="w-5 h-5" />,
                title: 'No audit events match',
                description: 'The audit log loaded successfully and no recorded events match these filters.',
              }}
              loading={<ResourceSkeleton label="audit log" lines={5} />}
            >
              {rows => (
                <div className="overflow-x-auto rounded-2xl border border-[var(--b1)]">
                  <table className="min-w-full text-sm">
                    <thead className="bg-[var(--s2)] text-left text-xs text-t3">
                      <tr>
                        <th className="px-4 py-3">Timestamp</th>
                        <th className="px-4 py-3">Actor</th>
                        <th className="px-4 py-3">Action</th>
                        <th className="px-4 py-3">Module</th>
                        <th className="px-4 py-3">Result</th>
                        <th className="px-4 py-3">Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(log => (
                        <tr key={log.id} className="border-t border-[var(--b1)]">
                          <td className="px-4 py-3 text-xs text-t2">{formatDateTime(log.occurredAt)}</td>
                          <td className="px-4 py-3"><p className="font-semibold text-t1">{log.actor}</p><p className="text-xs text-t3">{log.role ?? '—'}</p></td>
                          <td className="px-4 py-3 text-xs text-t2">{log.action}</td>
                          <td className="px-4 py-3 text-xs text-t2">{log.module}</td>
                          <td className="px-4 py-3"><span className={`badge ${log.result === 'failed' ? 'badge-red' : 'badge-emerald'}`}>{log.result}</span></td>
                          <td className="px-4 py-3 text-xs text-t3">{typeof log.details === 'object' ? JSON.stringify(log.details).slice(0, 90) : String(log.details ?? '—')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </ResourceSection>
          </div>
        </BentoCard>
      )}

      {activeTab === 'security' && (
        <div className="space-y-4">
          <ResourceSection
            label="Security posture"
            state={posture.state}
            onRetry={posture.reload}
            loading={<ResourceSkeleton label="security posture" lines={2} rowClassName="h-24 rounded-2xl" />}
          >
            {data => (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <StatCard title="Auth mode" value={data.authMode} subtitle="Current session strategy" icon={<KeyRound className="w-4 h-4" />} accent="blue" />
                  <ResourceSection label="Control check score" state={overview.state} onRetry={overview.reload} compact loading={<ResourceSkeleton label="control check score" lines={1} rowClassName="h-[104px] rounded-2xl" />}>
                    {overviewData => <StatCard title="Control checks" value={`${overviewData.summary.productionReadinessScore}%`} subtitle={data.riskLabel} icon={<ShieldCheck className="w-4 h-4" />} accent="emerald" />}
                  </ResourceSection>
                  <StatCard title="Alerts" value={data.alerts.length} subtitle="Security warnings" icon={<AlertTriangle className="w-4 h-4" />} accent="amber" />
                  <StatCard title="Access TTL" value={`${data.accessTokenTtlMinutes}m`} subtitle="Short-lived access tokens" icon={<Lock className="w-4 h-4" />} accent="violet" />
                </div>
                <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
                  <BentoCard title="Recorded security controls" subtitle="Reported authentication, access, isolation, and infrastructure checks">
                    <div className="grid gap-2 sm:grid-cols-2">
                      {[
                        ['Password login', data.passwordLoginEnabled],
                        ['Dev token', data.devTokenEnabled],
                        ['HttpOnly refresh cookie', data.refreshCookieHttpOnly],
                        ['CSRF enabled', data.csrfEnabled],
                        ['Refresh rotation', data.refreshRotationEnabled],
                        ['RBAC enabled', data.rbacEnabled],
                        ['Tenant isolation', data.tenantIsolationEnabled],
                        ['Clinic scoping', data.clinicScopingEnabled],
                        ['Secrets configured', data.jwtSecretsConfigured && data.refreshSecretConfigured],
                        ['HTTPS required', data.httpsRequired],
                      ].map(([label, enabled]) => (
                        <div key={label as string} className="flex items-center justify-between gap-2 rounded-xl border border-[var(--b1)] p-3">
                          <span className="text-sm text-t2">{label as string}</span>
                          <span className={`badge ${enabled ? 'badge-emerald' : 'badge-red'}`}>{enabled ? 'Yes' : 'No'}</span>
                        </div>
                      ))}
                    </div>
                  </BentoCard>
                  <BentoCard title="Security Events" subtitle="Login and session actions">
                    <ResourceSection
                      label="Security events"
                      state={securityEvents.state}
                      onRetry={securityEvents.reload}
                      empty={{
                        icon: <FileClock className="w-5 h-5" />,
                        title: 'No security events returned',
                        description: 'The security event feed loaded successfully and carried no login or session actions.',
                      }}
                    >
                      {events => (
                        <div className="space-y-2">
                          {events.map(event => (
                            <div key={event.id} className="rounded-xl border border-[var(--b1)] p-3">
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-sm font-semibold text-t1">{event.action}</p>
                                <span className={`badge ${event.status === 'failed' ? 'badge-red' : 'badge-emerald'}`}>{event.status}</span>
                              </div>
                              <p className="mt-1 text-[11px] text-t3">{event.actor} · {event.role ?? '—'} · {formatDateTime(event.occurredAt)}</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </ResourceSection>
                  </BentoCard>
                </div>
              </div>
            )}
          </ResourceSection>

          <BentoCard title="Active Sessions" subtitle="Session revocation supported for owner/admin">
            <ResourceSection
              label="Active sessions"
              state={sessions.state}
              onRetry={sessions.reload}
              empty={{
                icon: <Users2 className="w-5 h-5" />,
                title: 'No sessions returned',
                description: 'The session list loaded successfully and this tenant has no recorded sessions.',
              }}
              loading={<ResourceSkeleton label="active sessions" lines={4} />}
            >
              {rows => (
                <div className="overflow-x-auto rounded-2xl border border-[var(--b1)]">
                  <table className="min-w-full text-sm">
                    <thead className="bg-[var(--s2)] text-left text-xs text-t3">
                      <tr><th className="px-4 py-3">User</th><th className="px-4 py-3">Expires</th><th className="px-4 py-3">Access branches</th><th className="px-4 py-3">Actions</th></tr>
                    </thead>
                    <tbody>
                      {rows.map(session => (
                        <tr key={session.id} className="border-t border-[var(--b1)]">
                          <td className="px-4 py-3">
                            <p className="font-semibold text-t1">{session.user.displayName}</p>
                            <p className="text-xs text-t3">{session.user.email} · {session.user.role}</p>
                          </td>
                          <td className="px-4 py-3 text-xs text-t2">{formatDateTime(session.expiresAt)}</td>
                          <td className="px-4 py-3 text-xs text-t2">{session.accessBranches.map(branch => branch.name).join(', ') || '—'}</td>
                          <td className="px-4 py-3">
                            <button type="button" onClick={() => void revokeSession(session.user.id)} disabled={!canManage || savingAction === `session:${session.user.id}`} className="rounded-xl border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-t2 hover:bg-[var(--s3)] transition disabled:opacity-50">Revoke</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </ResourceSection>
          </BentoCard>
        </div>
      )}

      {activeTab === 'system' && (
        <ResourceSection
          label="System health"
          state={systemHealth.state}
          onRetry={systemHealth.reload}
          loading={<ResourceSkeleton label="system health" lines={2} rowClassName="h-24 rounded-2xl" />}
        >
          {data => (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard title="API" value={data.apiStatus} subtitle="Service status" icon={<ServerCog className="w-4 h-4" />} accent="blue" />
                <StatCard title="Database" value={data.databaseStatus} subtitle={data.dbLatencyMs != null ? `${data.dbLatencyMs}ms latency` : 'Connectivity'} icon={<Database className="w-4 h-4" />} accent={data.databaseStatus === 'healthy' ? 'emerald' : 'red'} />
                <StatCard title="Auth" value={data.authStatus} subtitle="Secrets and sessions" icon={<Lock className="w-4 h-4" />} accent="violet" />
                <StatCard title="Environment" value={data.environmentMode} subtitle="Running mode" icon={<Globe2 className="w-4 h-4" />} accent="amber" />
              </div>
              <BentoCard title="System Health" subtitle="Deployment and runtime signals">
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {[
                    ['Migration status', data.migrationStatus],
                    ['Latest migration', data.latestMigration ?? 'None reported'],
                    ['Revenue protection', data.revenueProtectionStatus],
                    ['Background jobs', data.backgroundJobs],
                    ['Build version', data.buildVersion ?? 'None reported'],
                    ['Audit event count', String(data.auditEventCount)],
                  ].map(([label, value]) => (
                    <MetricBox key={label} label={label} value={value} />
                  ))}
                </div>
              </BentoCard>
            </div>
          )}
        </ResourceSection>
      )}
    </div>
  );
}

/**
 * The audit trail for one user. Mounted only once a user is chosen, so the
 * panel has no "nothing selected" state to confuse with "nothing recorded".
 */
function UserAuditTrail({ userId, onClose }: { userId: string; onClose: () => void }) {
  const trail = useResource<ControlPlaneUserAuditEntry[]>(`/v1/control-plane/users/${userId}/audit-trail`);
  return (
    <BentoCard
      title="Selected user audit trail"
      subtitle="Most recent events for the chosen user"
      className="mt-4"
      headerRight={<button type="button" onClick={onClose} className="text-xs font-semibold text-t3 hover:text-t1">Close</button>}
    >
      <ResourceSection
        label="User audit trail"
        state={trail.state}
        onRetry={trail.reload}
        empty={{
          icon: <FileClock className="w-5 h-5" />,
          title: 'No events for this user',
          description: 'The audit trail loaded successfully and this user has no recorded events.',
        }}
      >
        {rows => (
          <div className="space-y-2">
            {rows.map(log => (
              <div key={log.id} className="rounded-xl border border-[var(--b1)] p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-t1">{log.action}</p>
                  <span className="badge badge-indigo">{formatDateTime(log.occurredAt)}</span>
                </div>
                <p className="mt-1 text-[11px] text-t3">{log.resource}</p>
              </div>
            ))}
          </div>
        )}
      </ResourceSection>
    </BentoCard>
  );
}

function MetricBox({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-2xl border border-[var(--b1)] p-4">
      <p className="text-xs text-t3">{label}</p>
      <p className={strong ? 'mt-1 text-2xl font-bold text-t1' : 'mt-1 text-sm font-semibold text-t1'}>{value}</p>
    </div>
  );
}
