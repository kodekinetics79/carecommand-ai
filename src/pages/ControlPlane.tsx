import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  AlertTriangle,
  Activity,
  ArrowRight,
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
  Sparkles,
  Users2,
  DollarSign,
  Building2,
  FileClock,
  Network,
  Stethoscope,
  BadgeCheck,
} from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import BentoCard from '../components/ui/BentoCard';
import StatCard from '../components/ui/StatCard';
import { apiRequest, downloadCsv } from '../lib/api';
import { getLocale } from '../lib/preferences';
import { useSession } from '../hooks/useSession';
import type { AdminAuditEvent, AdminRole, AdminUser, IntegrationStatus, SecurityPosture, SecuritySession } from '../types';

type TabKey =
  | 'overview'
  | 'users'
  | 'roles'
  | 'clinics'
  | 'audit'
  | 'security'
  | 'integrations'
  | 'insurance'
  | 'finance'
  | 'system';

interface ControlPlaneOverview {
  tenant: { id: string; name: string; slug: string } | null;
  summary: {
    totalUsers: number;
    activeUsers: number;
    adminUsers: number;
    inactiveUsers: number;
    clinics: number;
    activeIntegrations: number;
    sandboxIntegrations: number;
    mockIntegrations: number;
    failedIntegrations: number;
    auditEventsToday: number;
    securityAlerts: number;
    paymentRailsStatus: string;
    insuranceRailsStatus: string;
    productionReadinessScore: number;
  };
  branches: Array<{ id: string; name: string; location: string; active: boolean }>;
  securityPosture: SecurityPosture;
  integrations: IntegrationStatus[];
  insuranceRails: InsuranceRail[];
  financeRails: FinanceRail[];
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
  integrationCount: number;
  securityAlerts: number;
}

interface ControlPlaneAuditLog extends AdminAuditEvent {
  module: string;
  tenantId: string;
  clinicId: string | null;
  result: 'success' | 'failed';
  details: unknown;
}

interface InsuranceRail {
  provider: string;
  name: string;
  configured: boolean;
  mode: 'mock' | 'sandbox' | 'live';
  modeLabel: string;
  eligibilitySupported: boolean;
  benefitsSupported: boolean;
  priorAuthSupported: boolean;
  priorAuthTrackingSupported: boolean;
  claimStatusSupportedFuture: boolean;
  payerListStatus: string;
  lastEligibilityCheck: string | null;
  lastFailedCheck: string | null;
  errorRate: number;
  workflows: string[];
  actions: string[];
  logs: Array<{ id: string; operation: string; status: string; createdAt: string; providerMode: string }>;
  payerCount: number;
  authCount: number;
}

interface FinanceRail {
  provider: string;
  name: string;
  configured: boolean;
  mode: 'mock' | 'sandbox' | 'live';
  modeLabel: string;
  paymentLinksSupported: boolean;
  depositsSupported: boolean;
  copayCollectionSupported: boolean;
  refundsFuture: boolean;
  webhooksConfigured: boolean;
  lastPaymentRequest: string | null;
  failedPaymentCount: number;
  health: 'healthy' | 'not_configured' | 'degraded';
  logs: Array<{ id: string; operation: string; status: string; createdAt: string; providerMode: string }>;
  providerConnectionId: string | null;
  actions: string[];
}

interface SystemHealth {
  apiStatus: string;
  databaseStatus: string;
  dbLatencyMs: number | null;
  migrationStatus: string;
  latestMigration: string | null;
  authStatus: string;
  revenueProtectionStatus: string;
  integrationStatus: string;
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
  { key: 'integrations', label: 'Integration Hub', icon: Network },
  { key: 'insurance', label: 'Insurance Rails', icon: Stethoscope },
  { key: 'finance', label: 'Finance Rails', icon: DollarSign },
  { key: 'system', label: 'System Health', icon: Activity },
];

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
  const navigate = useNavigate();
  const { user } = useSession();
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [overview, setOverview] = useState<ControlPlaneOverview | null>(null);
  const [usersPayload, setUsersPayload] = useState<ControlPlaneUsersResponse | null>(null);
  const [rolesPayload, setRolesPayload] = useState<ControlPlaneRolesResponse | null>(null);
  const [clinics, setClinics] = useState<ControlPlaneClinicsResponse[]>([]);
  const [auditLogs, setAuditLogs] = useState<ControlPlaneAuditLog[]>([]);
  const [posture, setPosture] = useState<SecurityPosture | null>(null);
  const [securityEvents, setSecurityEvents] = useState<Array<{ id: string; action: string; actor: string; role: string | null; status: string; occurredAt: string; details: unknown }>>([]);
  const [sessions, setSessions] = useState<SecuritySession[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  const [insuranceRails, setInsuranceRails] = useState<InsuranceRail[]>([]);
  const [financeRails, setFinanceRails] = useState<FinanceRail[]>([]);
  const [systemHealth, setSystemHealth] = useState<SystemHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState('OWNER');
  const [userSearch, setUserSearch] = useState('');
  const [savingAction, setSavingAction] = useState<string | null>(null);
  const [editingAccessUserId, setEditingAccessUserId] = useState<string | null>(null);
  const [accessDraft, setAccessDraft] = useState<{ branchIds: string[]; primaryBranchId?: string }>({ branchIds: [] });
  const [auditFilters, setAuditFilters] = useState({ userId: '', module: '', action: '', from: '', to: '' });
  const [selectedUserAudit, setSelectedUserAudit] = useState<Array<{ id: string; action: string; resource: string; actor: string; occurredAt: string; metadata: unknown }> | null>(null);
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

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const [overviewData, usersData, rolesData, clinicsData, auditData, postureData, securityEventsData, sessionsData, integrationsData, insuranceData, financeData, systemData] = await Promise.all([
        apiRequest<ControlPlaneOverview>('/v1/control-plane/overview'),
        apiRequest<ControlPlaneUsersResponse>('/v1/control-plane/users?limit=100'),
        apiRequest<ControlPlaneRolesResponse>('/v1/control-plane/roles'),
        apiRequest<ControlPlaneClinicsResponse[]>('/v1/control-plane/clinics'),
        apiRequest<ControlPlaneAuditLog[]>('/v1/control-plane/audit-logs?limit=50'),
        apiRequest<SecurityPosture>('/v1/control-plane/security-posture'),
        apiRequest<Array<{ id: string; action: string; actor: string; role: string | null; status: string; occurredAt: string; details: unknown }>>('/v1/control-plane/security-events'),
        apiRequest<SecuritySession[]>('/v1/control-plane/sessions?limit=100'),
        apiRequest<IntegrationStatus[]>('/v1/control-plane/integrations'),
        apiRequest<InsuranceRail[]>('/v1/control-plane/insurance-rails'),
        apiRequest<FinanceRail[]>('/v1/control-plane/finance-rails'),
        apiRequest<SystemHealth>('/v1/control-plane/system-health'),
      ]);

      setOverview(overviewData);
      setUsersPayload(usersData);
      setRolesPayload(rolesData);
      setClinics(clinicsData);
      setAuditLogs(auditData);
      setPosture(postureData);
      setSecurityEvents(securityEventsData);
      setSessions(sessionsData);
      setIntegrations(integrationsData);
      setInsuranceRails(insuranceData);
      setFinanceRails(financeData);
      setSystemHealth(systemData);
      setSelectedRole(current => rolesData.roles.some(role => role.enumValue === current) ? current : (rolesData.roles[0]?.enumValue ?? 'OWNER'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load Control Plane');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial control-plane bootstrap only
    void loadData();
  }, []);

  const visibleUsers = useMemo(() => {
    const term = userSearch.trim().toLowerCase();
    return (usersPayload?.users ?? []).filter(userRecord => !term || userRecord.displayName.toLowerCase().includes(term) || userRecord.email.toLowerCase().includes(term));
  }, [userSearch, usersPayload]);

  const selectedRoleDetails = useMemo(() => rolesPayload?.roles.find(role => role.enumValue === selectedRole) ?? rolesPayload?.roles[0], [rolesPayload, selectedRole]);

  const postureAlerts = posture?.alerts ?? [];
  const activeBranches = useMemo(() => (usersPayload?.branches ?? []).filter(branch => branch.active), [usersPayload]);
  const inviteValid = inviteForm.name.trim().length >= 2 && /.+@.+\..+/.test(inviteForm.email) && inviteForm.password.length >= 8;

  async function updateUserRole(userId: string, role: string) {
    if (!canManage) return;
    setSavingAction(`role:${userId}`);
    try {
      await apiRequest(`/v1/control-plane/users/${userId}/role`, { method: 'PATCH', body: JSON.stringify({ role }) });
      await loadData();
    } finally {
      setSavingAction(null);
    }
  }

  async function toggleUserActive(userId: string, active: boolean) {
    if (!canManage) return;
    setSavingAction(`status:${userId}`);
    try {
      await apiRequest(`/v1/control-plane/users/${userId}/status`, { method: 'PATCH', body: JSON.stringify({ active }) });
      await loadData();
    } finally {
      setSavingAction(null);
    }
  }

  async function saveUserAccess(userId: string) {
    if (!canManage) return;
    setSavingAction(`access:${userId}`);
    try {
      await apiRequest(`/v1/control-plane/users/${userId}/clinic-access`, { method: 'PATCH', body: JSON.stringify(accessDraft) });
      setEditingAccessUserId(null);
      await loadData();
    } finally {
      setSavingAction(null);
    }
  }

  async function revokeSession(userId: string) {
    if (!canManage) return;
    setSavingAction(`session:${userId}`);
    try {
      await apiRequest(`/v1/control-plane/sessions/${userId}/revoke`, { method: 'PATCH' });
      await loadData();
    } finally {
      setSavingAction(null);
    }
  }

  async function openAuditTrail(userId: string) {
    const logs = await apiRequest<Array<{ id: string; action: string; resource: string; actor: string; occurredAt: string; metadata: unknown }>>(`/v1/control-plane/users/${userId}/audit-trail`);
    setSelectedUserAudit(logs);
    setActiveTab('audit');
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
      await loadData();
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'Invite failed');
    } finally {
      setInviteBusy(false);
    }
  }

  async function applyAuditFilters() {
    setSavingAction('audit');
    try {
      const params = new URLSearchParams();
      params.set('limit', '50');
      if (auditFilters.userId) params.set('userId', auditFilters.userId);
      if (auditFilters.module) params.set('module', auditFilters.module);
      if (auditFilters.action) params.set('action', auditFilters.action);
      if (auditFilters.from) params.set('from', auditFilters.from);
      if (auditFilters.to) params.set('to', auditFilters.to);
      const logs = await apiRequest<ControlPlaneAuditLog[]>(`/v1/control-plane/audit-logs?${params.toString()}`);
      setAuditLogs(logs);
    } finally {
      setSavingAction(null);
    }
  }

  async function toggleClinicStatus(clinicId: string, active: boolean) {
    if (!canManage) return;
    setSavingAction(`clinic:${clinicId}`);
    try {
      await apiRequest(`/v1/control-plane/clinics/${clinicId}/status`, { method: 'PATCH', body: JSON.stringify({ active }) });
      await loadData();
    } finally {
      setSavingAction(null);
    }
  }

  async function testIntegration(provider: string) {
    if (!canManage) return;
    setSavingAction(`integration:${provider}`);
    try {
      await apiRequest(`/v1/control-plane/integrations/${provider}/test`, { method: 'POST' });
      await loadData();
    } finally {
      setSavingAction(null);
    }
  }

  async function testInsurance(provider: string) {
    if (!canManage) return;
    setSavingAction(`insurance:${provider}`);
    try {
      await apiRequest(`/v1/control-plane/insurance-rails/${provider}/test-eligibility`, { method: 'POST' });
      await loadData();
    } finally {
      setSavingAction(null);
    }
  }

  async function testFinance(provider: string) {
    if (!canManage) return;
    setSavingAction(`finance:${provider}`);
    try {
      await apiRequest(`/v1/control-plane/finance-rails/${provider}/test-payment-link`, { method: 'POST' });
      await loadData();
    } finally {
      setSavingAction(null);
    }
  }

  const overviewCards = [
    { title: 'Users', value: overview?.summary.totalUsers ?? 0, subtitle: 'Tenant accounts', icon: <Users2 className="w-4 h-4" />, accent: 'blue' as const },
    { title: 'Active users', value: overview?.summary.activeUsers ?? 0, subtitle: 'Enabled accounts', icon: <CheckCircle2 className="w-4 h-4" />, accent: 'emerald' as const },
    { title: 'Admin users', value: overview?.summary.adminUsers ?? 0, subtitle: 'OWNER / ADMIN', icon: <ShieldCheck className="w-4 h-4" />, accent: 'violet' as const },
    { title: 'Clinics', value: overview?.summary.clinics ?? 0, subtitle: 'Branches in tenant', icon: <Building2 className="w-4 h-4" />, accent: 'amber' as const },
    { title: 'Integration health', value: `${overview?.summary.activeIntegrations ?? 0}/${overview?.integrations.length ?? 0}`, subtitle: 'Active integrations', icon: <Network className="w-4 h-4" />, accent: 'indigo' as const },
    { title: 'Control checks', value: `${overview?.summary.productionReadinessScore ?? 0}%`, subtitle: 'Configured-check score', icon: <BadgeCheck className="w-4 h-4" />, accent: 'emerald' as const },
  ];

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Control Plane"
        subtitle="Review access, recorded controls, audit events, provider connectivity, and system health for this workspace."
        badge={loading ? 'Loading…' : `Checks ${overview?.summary.productionReadinessScore ?? 0}%`}
        badgeColor="violet"
        actions={
          <button
            type="button"
            onClick={() => void loadData()}
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--indigo-mid)] transition"
          >
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        }
      />

      <div role="note" className="rounded-2xl border border-[var(--amber-soft)] bg-[var(--amber-soft)] px-4 py-3 text-xs text-amber-v">
        The displayed score summarizes selected configuration checks. It is not a security assessment, compliance certification, or authorization to launch.
      </div>

      {error && (
        <div role="alert" className="rounded-2xl border border-[var(--red-soft)] bg-[var(--red-soft)] p-4 text-sm text-red-v">
          {error}
        </div>
      )}

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
          <div className="grid gap-3 grid-cols-2 xl:grid-cols-6">
            {overviewCards.map(card => (
              <StatCard key={card.title} title={card.title} value={card.value} subtitle={card.subtitle} icon={card.icon} accent={card.accent} />
            ))}
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
            <BentoCard title="Configuration checks" subtitle="Calculated from the runtime signals listed below" headerRight={<BadgeCheck className="w-4 h-4 text-t3" />}>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-[var(--b1)] p-4">
                  <p className="text-xs text-t3">Configured-check score</p>
                  <p className="mt-2 text-3xl font-black text-t1">{overview?.summary.productionReadinessScore ?? 0}%</p>
                  <p className="mt-1 text-xs text-t3">Calculated from authentication, secret configuration, integration status, access controls, audit logging, and tenant-isolation checks.</p>
                </div>
                <div className="rounded-2xl border border-[var(--b1)] p-4">
                  <p className="text-xs text-t3">Payment rails</p>
                  <p className="mt-2 text-base font-semibold text-t1">{overview?.summary.paymentRailsStatus ?? 'Mock'}</p>
                  <p className="mt-1 text-xs text-t3">Insurance rails: {overview?.summary.insuranceRailsStatus ?? 'Mock'}</p>
                </div>
              </div>
            </BentoCard>

            <BentoCard title="Security Alerts" subtitle="Issues that need owner attention" headerRight={<AlertTriangle className="w-4 h-4 text-t3" />}>
              <div className="space-y-2">
                {(postureAlerts.length > 0 ? postureAlerts : [{ severity: 'low', title: 'No alerts returned', message: 'The checks shown did not return an alert. This is not a complete security assessment.' }]).map((alert, index) => (
                  <div key={`${alert.title}-${index}`} className="rounded-xl border border-[var(--b1)] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-t1">{alert.title}</p>
                      <span className={`badge ${formatRisk(alert.severity as 'low' | 'medium' | 'high')}`}>{alert.severity}</span>
                    </div>
                    <p className="mt-1 text-[11px] text-t3 leading-relaxed">{alert.message}</p>
                  </div>
                ))}
              </div>
            </BentoCard>
          </div>

          <BentoCard title="Operational Snapshot" subtitle="Audit events, integration modes, and system health">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-2xl border border-[var(--b1)] p-4">
                <p className="text-xs text-t3">Audit events today</p>
                <p className="mt-1 text-2xl font-bold text-t1">{overview?.summary.auditEventsToday ?? 0}</p>
              </div>
              <div className="rounded-2xl border border-[var(--b1)] p-4">
                <p className="text-xs text-t3">Mock integrations</p>
                <p className="mt-1 text-2xl font-bold text-t1">{overview?.summary.mockIntegrations ?? 0}</p>
              </div>
              <div className="rounded-2xl border border-[var(--b1)] p-4">
                <p className="text-xs text-t3">Sandbox integrations</p>
                <p className="mt-1 text-2xl font-bold text-t1">{overview?.summary.sandboxIntegrations ?? 0}</p>
              </div>
              <div className="rounded-2xl border border-[var(--b1)] p-4">
                <p className="text-xs text-t3">Failed integrations</p>
                <p className="mt-1 text-2xl font-bold text-t1">{overview?.summary.failedIntegrations ?? 0}</p>
              </div>
            </div>
          </BentoCard>
        </div>
      )}

      {activeTab === 'users' && (
        <BentoCard title="Users & Access" subtitle="Activate users, change roles, update clinic access, revoke sessions, and review audit trails." headerRight={<Users2 className="w-4 h-4 text-t3" />}>
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
              {inviteError && <div className="mt-3 rounded-xl border border-[rgba(220,38,38,0.18)] bg-red-soft px-3 py-2 text-xs text-red-v">{inviteError}</div>}
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

          <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--b1)]">
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
                      <select
                        value={userRecord.role}
                        onChange={event => void updateUserRole(userRecord.id, event.target.value)}
                        disabled={!canManage || savingAction === `role:${userRecord.id}`}
                        className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-xs font-semibold text-t1 disabled:opacity-60"
                      >
                        {rolesPayload?.roles.map(role => (
                          <option key={role.enumValue} value={role.enumValue}>{role.name}</option>
                        ))}
                      </select>
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
                        <button type="button" onClick={() => void openAuditTrail(userRecord.id)} className="rounded-xl border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-t2 hover:bg-[var(--s3)] transition">
                          View audit trail
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
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
                {(usersPayload?.branches ?? []).filter(branch => branch.active).map(branch => (
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
                <button type="button" onClick={() => void saveUserAccess(editingAccessUserId)} className="rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--indigo-mid)] transition">Save clinic access</button>
                <button type="button" onClick={() => setEditingAccessUserId(null)} className="rounded-xl border border-[var(--b1)] px-4 py-2 text-sm font-semibold text-t2 hover:bg-[var(--s3)] transition">Cancel</button>
              </div>
            </div>
          )}

          {selectedUserAudit && (
            <BentoCard title="Selected user audit trail" subtitle="Most recent events for the chosen user" className="mt-4">
              <div className="space-y-2">
                {selectedUserAudit.map(log => (
                  <div key={log.id} className="rounded-xl border border-[var(--b1)] p-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-t1">{log.action}</p>
                      <span className="badge badge-indigo">{formatDateTime(log.occurredAt)}</span>
                    </div>
                    <p className="mt-1 text-[11px] text-t3">{log.resource}</p>
                  </div>
                ))}
              </div>
            </BentoCard>
          )}
        </BentoCard>
      )}

      {activeTab === 'roles' && (
        <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
          <BentoCard title="Roles & Permissions" subtitle="Read-only matrix until permission editing endpoints are added" headerRight={<ShieldCheck className="w-4 h-4 text-t3" />}>
            <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="relative flex-1 max-w-md">
                <select
                  value={selectedRole}
                  onChange={event => setSelectedRole(event.target.value)}
                  className="w-full rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-sm font-semibold text-t1 outline-none"
                >
                  {rolesPayload?.roles.map(role => (
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
            <div className="overflow-hidden rounded-2xl border border-[var(--b1)]">
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
                  {rolesPayload?.roles.map(role => (
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
              {rolesPayload?.permissionMatrix.map(row => (
                <div key={row.role} className="rounded-2xl border border-[var(--b1)] p-4">
                  <p className="text-sm font-semibold text-t1">{row.role}</p>
                  <p className="mt-1 text-xs text-t3">{row.scope}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {row.modules.map(module => <span key={module} className="badge badge-indigo">{module}</span>)}
                  </div>
                </div>
              ))}
            </div>
          </BentoCard>

          <BentoCard title="Module Access Summary" subtitle="High-privilege roles are highlighted">
            <div className="space-y-2">
              {rolesPayload?.moduleSummary.map(section => (
                <div key={section.module} className="rounded-xl border border-[var(--b1)] p-3">
                  <p className="text-sm font-semibold text-t1">{section.module}</p>
                  <p className="mt-1 text-[11px] text-t3">{section.permissions.join(' · ')}</p>
                </div>
              ))}
            </div>
          </BentoCard>
        </div>
      )}

      {activeTab === 'clinics' && (
        <div className="space-y-4">
          <BentoCard title="Tenant Governance" subtitle="Clinics, tenant status, user access, integrations, and security alerts">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-2xl border border-[var(--b1)] p-4"><p className="text-xs text-t3">Tenant</p><p className="mt-1 font-semibold text-t1">{overview?.tenant?.name ?? usersPayload?.tenant?.name ?? '—'}</p></div>
              <div className="rounded-2xl border border-[var(--b1)] p-4"><p className="text-xs text-t3">Clinics</p><p className="mt-1 font-semibold text-t1">{clinics.length}</p></div>
              <div className="rounded-2xl border border-[var(--b1)] p-4"><p className="text-xs text-t3">Integration rail status</p><p className="mt-1 font-semibold text-t1">{overview?.summary.paymentRailsStatus ?? '—'} / {overview?.summary.insuranceRailsStatus ?? '—'}</p></div>
              <div className="rounded-2xl border border-[var(--b1)] p-4"><p className="text-xs text-t3">Security alerts</p><p className="mt-1 font-semibold text-t1">{overview?.summary.securityAlerts ?? 0}</p></div>
            </div>
          </BentoCard>

          <BentoCard title="Clinics" subtitle="Activate / deactivate clinics and view operational load">
            <div className="overflow-hidden rounded-2xl border border-[var(--b1)]">
              <table className="min-w-full text-sm">
                <thead className="bg-[var(--s2)] text-left text-xs text-t3">
                  <tr>
                    <th className="px-4 py-3">Clinic</th>
                    <th className="px-4 py-3">Users</th>
                    <th className="px-4 py-3">Integrations</th>
                    <th className="px-4 py-3">Security alerts</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {clinics.map(clinic => (
                    <tr key={clinic.id} className="border-t border-[var(--b1)]">
                      <td className="px-4 py-3"><p className="font-semibold text-t1">{clinic.name}</p><p className="text-xs text-t3">{clinic.location}</p></td>
                      <td className="px-4 py-3 text-xs text-t2">{clinic.userCount}</td>
                      <td className="px-4 py-3 text-xs text-t2">{clinic.integrationCount}</td>
                      <td className="px-4 py-3 text-xs text-t2">{clinic.securityAlerts}</td>
                      <td className="px-4 py-3"><span className={`badge ${clinic.active ? 'badge-emerald' : 'badge-red'}`}>{clinic.active ? 'Active' : 'Inactive'}</span></td>
                      <td className="px-4 py-3">
                        <button type="button" onClick={() => void toggleClinicStatus(clinic.id, !clinic.active)} className="rounded-xl border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-t2 hover:bg-[var(--s3)] transition">{clinic.active ? 'Deactivate' : 'Activate'}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
            <button type="button" onClick={() => void applyAuditFilters()} className="rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white">Apply filters</button>
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

          {selectedUserAudit && (
            <div className="mt-4 rounded-2xl border border-[var(--b1)] p-4">
              <p className="text-sm font-semibold text-t1">User audit trail</p>
              <div className="mt-2 space-y-2">
                {selectedUserAudit.map(log => (
                  <div key={log.id} className="rounded-xl border border-[var(--b1)] p-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-t1">{log.action}</p>
                      <span className="badge badge-indigo">{formatDateTime(log.occurredAt)}</span>
                    </div>
                    <p className="mt-1 text-[11px] text-t3">{log.resource}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--b1)]">
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
                {auditLogs.map(log => (
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
        </BentoCard>
      )}

      {activeTab === 'security' && posture && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard title="Auth mode" value={posture.authMode} subtitle="Current session strategy" icon={<KeyRound className="w-4 h-4" />} accent="blue" />
            <StatCard title="Control checks" value={`${overview?.summary.productionReadinessScore ?? 0}%`} subtitle={posture.riskLabel} icon={<ShieldCheck className="w-4 h-4" />} accent="emerald" />
            <StatCard title="Alerts" value={posture.alerts.length} subtitle="Security warnings" icon={<AlertTriangle className="w-4 h-4" />} accent="amber" />
            <StatCard title="Access TTL" value={`${posture.accessTokenTtlMinutes}m`} subtitle="Short-lived access tokens" icon={<Lock className="w-4 h-4" />} accent="violet" />
          </div>
          <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
            <BentoCard title="Recorded security controls" subtitle="Reported authentication, access, isolation, and infrastructure checks">
              <div className="grid gap-2 sm:grid-cols-2">
                {[
                  ['Password login', posture.passwordLoginEnabled],
                  ['Dev token', posture.devTokenEnabled],
                  ['HttpOnly refresh cookie', posture.refreshCookieHttpOnly],
                  ['CSRF enabled', posture.csrfEnabled],
                  ['Refresh rotation', posture.refreshRotationEnabled],
                  ['RBAC enabled', posture.rbacEnabled],
                  ['Tenant isolation', posture.tenantIsolationEnabled],
                  ['Clinic scoping', posture.clinicScopingEnabled],
                  ['Secrets configured', posture.jwtSecretsConfigured && posture.refreshSecretConfigured],
                  ['HTTPS required', posture.httpsRequired],
                ].map(([label, enabled]) => (
                  <div key={label as string} className="flex items-center justify-between gap-2 rounded-xl border border-[var(--b1)] p-3">
                    <span className="text-sm text-t2">{label as string}</span>
                    <span className={`badge ${enabled ? 'badge-emerald' : 'badge-red'}`}>{enabled ? 'Yes' : 'No'}</span>
                  </div>
                ))}
              </div>
            </BentoCard>
            <BentoCard title="Security Events" subtitle="Login and session actions">
              <div className="space-y-2">
                {securityEvents.map(event => (
                  <div key={event.id} className="rounded-xl border border-[var(--b1)] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-t1">{event.action}</p>
                      <span className={`badge ${event.status === 'failed' ? 'badge-red' : 'badge-emerald'}`}>{event.status}</span>
                    </div>
                    <p className="mt-1 text-[11px] text-t3">{event.actor} · {event.role ?? '—'} · {formatDateTime(event.occurredAt)}</p>
                  </div>
                ))}
              </div>
            </BentoCard>
          </div>
          <BentoCard title="Active Sessions" subtitle="Session revocation supported for owner/admin">
            <div className="overflow-hidden rounded-2xl border border-[var(--b1)]">
              <table className="min-w-full text-sm">
                <thead className="bg-[var(--s2)] text-left text-xs text-t3">
                  <tr><th className="px-4 py-3">User</th><th className="px-4 py-3">Expires</th><th className="px-4 py-3">Access branches</th><th className="px-4 py-3">Actions</th></tr>
                </thead>
                <tbody>
                  {sessions.map(session => (
                    <tr key={session.id} className="border-t border-[var(--b1)]">
                      <td className="px-4 py-3">
                        <p className="font-semibold text-t1">{session.user.displayName}</p>
                        <p className="text-xs text-t3">{session.user.email} · {session.user.role}</p>
                      </td>
                      <td className="px-4 py-3 text-xs text-t2">{formatDateTime(session.expiresAt)}</td>
                      <td className="px-4 py-3 text-xs text-t2">{session.accessBranches.map(branch => branch.name).join(', ') || '—'}</td>
                      <td className="px-4 py-3">
                        <button type="button" onClick={() => void revokeSession(session.user.id)} className="rounded-xl border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-t2 hover:bg-[var(--s3)] transition">Revoke</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </BentoCard>
        </div>
      )}

      {activeTab === 'integrations' && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard title="Active" value={overview?.summary.activeIntegrations ?? 0} subtitle="Configured and healthy" icon={<CheckCircle2 className="w-4 h-4" />} accent="emerald" />
            <StatCard title="Sandbox" value={overview?.summary.sandboxIntegrations ?? 0} subtitle="Sandbox ready/active" icon={<Sparkles className="w-4 h-4" />} accent="violet" />
            <StatCard title="Mock" value={overview?.summary.mockIntegrations ?? 0} subtitle="Not configured" icon={<AlertTriangle className="w-4 h-4" />} accent="amber" />
            <StatCard title="Failed" value={overview?.summary.failedIntegrations ?? 0} subtitle="Needs attention" icon={<AlertTriangle className="w-4 h-4" />} accent="red" />
          </div>
          <BentoCard title="Integration Hub" subtitle="Honest provider readiness">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {integrations.map(row => (
                <div key={row.key} className="rounded-2xl border border-[var(--b1)] p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-t1">{row.name}</p>
                      <p className="text-[11px] text-t3">{row.category}</p>
                    </div>
                    <span className={`badge ${row.health === 'healthy' ? 'badge-emerald' : row.health === 'degraded' ? 'badge-amber' : row.health === 'not_configured' ? 'badge-blue' : 'badge-red'}`}>{row.modeLabel}</span>
                  </div>
                  <p className="mt-2 text-[11px] text-t3">{row.description}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">{row.supportedWorkflows.map(workflow => <span key={workflow} className="badge badge-indigo">{workflow}</span>)}</div>
                  {row.missingConfigCount > 0 && <p className="mt-2 text-[11px] text-t3">Setup incomplete — your administrator must finish connecting this provider.</p>}
                  <button type="button" onClick={() => void testIntegration(row.key)} disabled={!canManage} className="mt-3 inline-flex items-center gap-2 rounded-xl border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-t2 hover:bg-[var(--s3)] transition disabled:opacity-40">Test connection</button>
                </div>
              ))}
            </div>
          </BentoCard>
        </div>
      )}

      {activeTab === 'insurance' && (
        <div className="space-y-4">
          <BentoCard title="Insurance Rails" subtitle="Eligibility, benefits, and prior auth readiness">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {insuranceRails.map(provider => (
                <div key={provider.provider} className="rounded-2xl border border-[var(--b1)] p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-t1">{provider.name}</p>
                    <span className={`badge ${provider.configured ? 'badge-emerald' : 'badge-amber'}`}>{provider.modeLabel}</span>
                  </div>
                  <div className="mt-2 space-y-1 text-[11px] text-t2">
                    <p>Eligibility: {provider.eligibilitySupported ? 'Yes' : 'No'}</p>
                    <p>Benefits: {provider.benefitsSupported ? 'Yes' : 'No'}</p>
                    <p>Prior auth: {provider.priorAuthSupported ? 'Payer-connected' : provider.priorAuthTrackingSupported ? 'Manual tracking only' : 'No'}</p>
                    <p>Payer list: {provider.payerListStatus}</p>
                    <p>Error rate: {provider.errorRate}%</p>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">{provider.workflows.map(workflow => <span key={workflow} className="badge badge-indigo">{workflow}</span>)}</div>
                  <button type="button" onClick={() => void testInsurance(provider.provider)} disabled={!canManage} className="mt-3 rounded-xl border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-t2 hover:bg-[var(--s3)] transition disabled:opacity-40">Test eligibility</button>
                </div>
              ))}
            </div>
          </BentoCard>
          <BentoCard title="Insurance Logs" subtitle="Normalized eligibility and provider runs">
            <div className="space-y-2">
              {insuranceRails.flatMap(provider => provider.logs.map(log => (
                <div key={log.id} className="rounded-xl border border-[var(--b1)] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-t1">{provider.name} · {log.operation}</p>
                    <span className="badge badge-indigo">{log.status}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-t3">{formatDateTime(log.createdAt)} · {log.providerMode}</p>
                </div>
              )))}
            </div>
            <button type="button" onClick={() => navigate('/revenue-protection')} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white">
              Open Revenue Protection <ArrowRight className="w-4 h-4" />
            </button>
          </BentoCard>
        </div>
      )}

      {activeTab === 'finance' && (
        <div className="space-y-4">
          <BentoCard title="Finance Rails" subtitle="Payment links, deposits, copays, and webhook posture">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {financeRails.map(provider => (
                <div key={provider.provider} className="rounded-2xl border border-[var(--b1)] p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-t1">{provider.name}</p>
                    <span className={`badge ${provider.configured ? 'badge-emerald' : 'badge-amber'}`}>{provider.modeLabel}</span>
                  </div>
                  <div className="mt-2 space-y-1 text-[11px] text-t2">
                    <p>Payment links: {provider.paymentLinksSupported ? 'Yes' : 'No'}</p>
                    <p>Deposits: {provider.depositsSupported ? 'Yes' : 'No'}</p>
                    <p>Copays: {provider.copayCollectionSupported ? 'Yes' : 'No'}</p>
                    <p>Webhooks: {provider.webhooksConfigured ? 'Configured' : 'Missing'}</p>
                    <p>Failed payments: {provider.failedPaymentCount}</p>
                  </div>
                  <button type="button" onClick={() => void testFinance(provider.provider)} disabled={!canManage} className="mt-3 rounded-xl border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-t2 hover:bg-[var(--s3)] transition disabled:opacity-40">Test payment link</button>
                </div>
              ))}
            </div>
          </BentoCard>
          <BentoCard title="Payment Logs" subtitle="Recorded payment provider actions">
            <div className="space-y-2">
              {financeRails.flatMap(provider => provider.logs.map(log => (
                <div key={log.id} className="rounded-xl border border-[var(--b1)] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-t1">{provider.name} · {log.operation}</p>
                    <span className="badge badge-indigo">{log.status}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-t3">{formatDateTime(log.createdAt)} · {log.providerMode}</p>
                </div>
              )))}
            </div>
            <button type="button" onClick={() => navigate('/revenue-protection')} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white">
              Open Payment Queue <ArrowRight className="w-4 h-4" />
            </button>
          </BentoCard>
        </div>
      )}

      {activeTab === 'system' && systemHealth && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard title="API" value={systemHealth.apiStatus} subtitle="Service status" icon={<ServerCog className="w-4 h-4" />} accent="blue" />
            <StatCard title="Database" value={systemHealth.databaseStatus} subtitle={systemHealth.dbLatencyMs != null ? `${systemHealth.dbLatencyMs}ms latency` : 'Connectivity'} icon={<Database className="w-4 h-4" />} accent={systemHealth.databaseStatus === 'healthy' ? 'emerald' : 'red'} />
            <StatCard title="Auth" value={systemHealth.authStatus} subtitle="Secrets and sessions" icon={<Lock className="w-4 h-4" />} accent="violet" />
            <StatCard title="Environment" value={systemHealth.environmentMode} subtitle="Running mode" icon={<Globe2 className="w-4 h-4" />} accent="amber" />
          </div>
          <BentoCard title="System Health" subtitle="Deployment and runtime signals">
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {[
                ['Migration status', systemHealth.migrationStatus],
                ['Latest migration', systemHealth.latestMigration ?? '—'],
                ['Revenue protection', systemHealth.revenueProtectionStatus],
                ['Integration status', systemHealth.integrationStatus],
                ['Background jobs', systemHealth.backgroundJobs],
                ['Build version', systemHealth.buildVersion ?? '—'],
                ['Audit event count', String(systemHealth.auditEventCount)],
              ].map(([label, value]) => (
                <div key={label as string} className="rounded-2xl border border-[var(--b1)] p-4">
                  <p className="text-xs text-t3">{label as string}</p>
                  <p className="mt-1 text-sm font-semibold text-t1">{value as string}</p>
                </div>
              ))}
            </div>
          </BentoCard>
        </div>
      )}
    </div>
  );
}
