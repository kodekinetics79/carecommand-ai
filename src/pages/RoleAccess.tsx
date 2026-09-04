import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  LockKeyhole,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Users2,
} from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import { apiRequest, ApiError } from '../lib/api';

type RoleKey =
  | 'OWNER'
  | 'ADMIN'
  | 'MANAGER'
  | 'BILLING'
  | 'PROVIDER'
  | 'FRONT_DESK'
  | 'ANALYST'
  | 'COMPLIANCE_OFFICER'
  | 'AUDITOR';

type RoleDefinition = {
  id: string;
  name: string;
  description: string;
  accent: string;
  sortOrder: number;
  permissions: unknown;
  userCount: number;
};

type PermissionCatalog = {
  permissions: string[];
  defaultMatrix: Record<RoleKey, string[]>;
};

type BuiltInRole = {
  key: RoleKey;
  name: string;
  description: string;
  scope: string;
};

const BUILT_IN_ROLES: BuiltInRole[] = [
  { key: 'OWNER', name: 'Owner', description: 'Full tenant governance and business authority.', scope: 'All clinics' },
  { key: 'ADMIN', name: 'Admin', description: 'Day-to-day platform and access administration.', scope: 'All clinics' },
  { key: 'MANAGER', name: 'Branch Manager', description: 'Runs assigned clinics and front-office operations.', scope: 'Assigned clinics' },
  { key: 'BILLING', name: 'Billing', description: 'Revenue, payment, coverage, and financial follow-up work.', scope: 'Assigned financial workflows' },
  { key: 'PROVIDER', name: 'Provider', description: 'Clinical schedule, patients, and provider work.', scope: 'Assigned clinics' },
  { key: 'FRONT_DESK', name: 'Front Desk', description: 'Patients, scheduling, intake, calls, and routine follow-up.', scope: 'Assigned clinics' },
  { key: 'ANALYST', name: 'Analyst', description: 'Read-only operational and performance insight.', scope: 'Permitted clinic data' },
  { key: 'COMPLIANCE_OFFICER', name: 'Compliance Officer', description: 'Compliance evidence, audit, and privacy oversight.', scope: 'Compliance workspace' },
  { key: 'AUDITOR', name: 'Auditor', description: 'Independent read-only compliance and evidence review.', scope: 'Compliance workspace' },
];

const PROTECTED_ADMIN = new Set(['admin:manage', 'settings:write']);
const PLATFORM_ONLY = new Set(['platform:voice-line-mechanics:read']);
const HIGH_RISK = new Set([
  'admin:manage',
  'settings:write',
  'patient:export',
  'receptionist:recordings:read',
  'receptionist:manage',
  'campaign:manage',
  'integrations:manage',
]);

const PERMISSION_GROUPS: Array<{ label: string; prefixes: string[] }> = [
  { label: 'Patients & Intake', prefixes: ['patient:', 'intake:'] },
  { label: 'Scheduling', prefixes: ['appointment:', 'schedule:'] },
  { label: 'Billing & Insurance', prefixes: ['billing:', 'insurance:'] },
  { label: 'Staff & Operations', prefixes: ['staff:', 'operations:'] },
  { label: 'CRM & Campaigns', prefixes: ['crm:', 'campaign:'] },
  { label: 'Revenue & Inventory', prefixes: ['revenue:', 'inventory:'] },
  { label: 'AI Receptionist', prefixes: ['receptionist:'] },
  { label: 'Compliance & Audit', prefixes: ['compliance:', 'audit:', 'partner-report:'] },
  { label: 'Administration & Integrations', prefixes: ['settings:', 'admin:', 'integrations:'] },
];

function sorted(values: Iterable<string>) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function sameSet(left: Iterable<string>, right: Iterable<string>) {
  const a = sorted(left);
  const b = sorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function humanPermission(permission: string) {
  const [resource, ...rest] = permission.split(':');
  const action = rest.join(' ');
  const resourceLabel = resource.replace(/-/g, ' ');
  const actionLabel = action.replace(/-/g, ' ');
  return `${resourceLabel} — ${actionLabel}`.replace(/\b\w/g, letter => letter.toUpperCase());
}

function permissionDescription(permission: string) {
  if (permission === 'admin:manage') return 'Manage users, roles, sessions, and access policy.';
  if (permission === 'settings:write') return 'Change clinic-wide settings and access configuration.';
  if (permission === 'patient:export') return 'Export a patient’s full protected-health-information record.';
  if (permission === 'receptionist:recordings:read') return 'Listen to provider-hosted call recordings that may contain PHI.';
  if (permission === 'receptionist:manage') return 'Configure and operate AI receptionist workflows and outbound work.';
  if (permission === 'campaign:manage') return 'Create, approve, and operate outreach campaigns.';
  if (permission === 'integrations:manage') return 'Change tenant integration configuration.';
  if (permission.endsWith(':read')) return 'View this area.';
  if (permission.endsWith(':write')) return 'Create or change records in this area.';
  if (permission.endsWith(':manage')) return 'Configure and operate this area.';
  return 'Use this capability.';
}

function statusText(isRecommended: boolean) {
  return isRecommended ? 'Recommended access' : 'Customized access';
}

export default function RoleAccess() {
  const [roles, setRoles] = useState<RoleDefinition[]>([]);
  const [catalog, setCatalog] = useState<PermissionCatalog | null>(null);
  const [selectedKey, setSelectedKey] = useState<RoleKey>('OWNER');
  const [selectedPermissions, setSelectedPermissions] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextRoles, nextCatalog] = await Promise.all([
        apiRequest<RoleDefinition[]>('/v1/settings/roles'),
        apiRequest<PermissionCatalog>('/v1/settings/permissions/catalog'),
      ]);
      setRoles(nextRoles);
      setCatalog(nextCatalog);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Roles and access could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const selectedRole = BUILT_IN_ROLES.find(role => role.key === selectedKey) ?? BUILT_IN_ROLES[0];
  const selectedRow = roles.find(role => role.name === selectedRole.name) ?? null;
  const defaults = catalog?.defaultMatrix[selectedKey] ?? [];

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const override = selectedRow && Array.isArray(selectedRow.permissions)
        ? selectedRow.permissions.filter((value): value is string => typeof value === 'string')
        : defaults;
      setSelectedPermissions(new Set(override.filter(permission => !PLATFORM_ONLY.has(permission))));
      setSuccess(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedKey, selectedRow, defaults]);

  const visiblePermissions = useMemo(
    () => (catalog?.permissions ?? []).filter(permission => !PLATFORM_ONLY.has(permission)),
    [catalog],
  );

  const groupedPermissions = useMemo(() => PERMISSION_GROUPS.map(group => ({
    ...group,
    permissions: visiblePermissions.filter(permission => group.prefixes.some(prefix => permission.startsWith(prefix))),
  })).filter(group => group.permissions.length > 0), [visiblePermissions]);

  const recommended = sameSet(selectedPermissions, defaults.filter(permission => !PLATFORM_ONLY.has(permission)));
  const dirty = selectedRow
    ? !sameSet(
        selectedPermissions,
        (Array.isArray(selectedRow.permissions)
          ? selectedRow.permissions.filter((value): value is string => typeof value === 'string')
          : defaults).filter(permission => !PLATFORM_ONLY.has(permission)),
      )
    : true;

  function togglePermission(permission: string) {
    const locked = (selectedKey === 'OWNER' || selectedKey === 'ADMIN') && PROTECTED_ADMIN.has(permission);
    if (locked) return;
    setSelectedPermissions(current => {
      const next = new Set(current);
      if (next.has(permission)) next.delete(permission);
      else next.add(permission);
      return next;
    });
    setSuccess(null);
  }

  async function savePermissions(nextPermissions = selectedPermissions) {
    if (!catalog) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    const permissions = sorted(nextPermissions).filter(permission => !PLATFORM_ONLY.has(permission));
    try {
      if (selectedRow) {
        await apiRequest(`/v1/settings/roles/${selectedRow.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ permissions }),
        });
      } else {
        await apiRequest('/v1/settings/roles', {
          method: 'POST',
          body: JSON.stringify({
            name: selectedRole.name,
            description: selectedRole.description,
            accent: 'blue',
            sortOrder: BUILT_IN_ROLES.findIndex(role => role.key === selectedKey),
            permissions,
          }),
        });
      }
      setSuccess(`${selectedRole.name} access saved.`);
      await load();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'protected_admin_permission') {
        setError('Owner and Admin must keep the minimum permissions needed to recover access administration.');
      } else {
        setError(cause instanceof Error ? cause.message : 'Role access could not be saved.');
      }
    } finally {
      setSaving(false);
    }
  }

  async function restoreRecommended() {
    const next = new Set(defaults.filter(permission => !PLATFORM_ONLY.has(permission)));
    setSelectedPermissions(next);
    await savePermissions(next);
  }

  return (
    <div className="animate-fade-up space-y-5">
      <PageHeader
        title="Roles & Access"
        subtitle="Start with safe recommended roles, assign staff to the clinics they work in, and customize only when your organization needs it."
        badge="Administration"
        badgeColor="violet"
        actions={(
          <button type="button" onClick={() => void load()} disabled={loading} className="workspace-btn inline-flex items-center gap-2">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        )}
      />

      {error && (
        <div className="rounded-xl border border-red-v/30 bg-red-v/5 px-4 py-3 text-[12px] text-red-v" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-xl border border-emerald-v/30 bg-[#ECFDF5] px-4 py-3 text-[12px] text-emerald-v" role="status">
          {success}
        </div>
      )}

      <section className="command-deck p-5 md:p-6">
        <div className="command-deck-grid" aria-hidden="true" />
        <div className="relative z-[1] grid gap-4 lg:grid-cols-[1fr_auto] lg:items-center">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-indigo/40 bg-white/70 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-indigo">
              <ShieldCheck className="w-3.5 h-3.5" /> Least privilege by default
            </div>
            <h2 className="mt-4 text-[24px] md:text-[30px] font-bold tracking-[-0.035em] text-t1 leading-[1.08]">
              Nine real roles. Clear clinic scope. No fake access.
            </h2>
            <p className="mt-3 max-w-3xl text-[13px] leading-relaxed text-t2">
              The same permission set shown here is resolved by the server for each session and enforced again by the API. Hiding a menu item is never the security boundary.
            </p>
          </div>
          <div className="deck-chip min-w-[220px]">
            <Users2 className="w-4 h-4 text-indigo" />
            <div><p className="text-[10px] text-t3">Assignable roles</p><p className="text-lg font-bold text-t1">9</p></div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[0.72fr_1.28fr]">
        <div className="cc-card p-3">
          <div className="px-2 py-2">
            <h2 className="text-[14px] font-bold text-t1">Role templates</h2>
            <p className="mt-0.5 text-[11px] text-t3">Choose a role to review or adjust its access.</p>
          </div>
          <div className="space-y-1">
            {BUILT_IN_ROLES.map(role => {
              const row = roles.find(item => item.name === role.name);
              const rolePermissions = row && Array.isArray(row.permissions)
                ? row.permissions.filter((value): value is string => typeof value === 'string')
                : catalog?.defaultMatrix[role.key] ?? [];
              const roleRecommended = sameSet(rolePermissions, catalog?.defaultMatrix[role.key] ?? []);
              const active = selectedKey === role.key;
              return (
                <button key={role.key} type="button" onClick={() => setSelectedKey(role.key)}
                  className={`w-full rounded-xl px-3 py-3 text-left transition border ${active ? 'border-indigo/35 bg-indigo/5' : 'border-transparent hover:bg-[var(--s2)]'}`}>
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${active ? 'bg-indigo text-white' : 'bg-[var(--s2)] text-t2'}`}>
                      <ShieldCheck className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-[12px] font-semibold text-t1 truncate">{role.name}</p>
                        {row?.userCount ? <span className="badge">{row.userCount}</span> : null}
                      </div>
                      <p className="mt-0.5 text-[10px] text-t3 truncate">{role.scope}</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {roleRecommended ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-v" /> : <span className="w-2 h-2 rounded-full bg-amber-v" />}
                      <ChevronRight className="w-3.5 h-3.5 text-t3" />
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="cc-card p-5">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-[18px] font-bold text-t1">{selectedRole.name}</h2>
                <span className={`badge ${recommended ? 'badge-emerald' : 'badge-amber'}`}>{statusText(recommended)}</span>
              </div>
              <p className="mt-1 text-[12px] text-t3">{selectedRole.description}</p>
              <p className="mt-2 text-[11px] font-semibold text-t2">Scope: {selectedRole.scope}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void restoreRecommended()} disabled={saving || !catalog}
                className="workspace-btn inline-flex items-center gap-2">
                <RotateCcw className="w-3.5 h-3.5" /> Restore recommended
              </button>
              <button type="button" onClick={() => void savePermissions()} disabled={saving || !catalog || (!dirty && !!selectedRow)}
                className="inline-flex min-h-9 items-center justify-center gap-2 rounded-lg bg-indigo px-3.5 py-2 text-[11px] font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed">
                {saving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {saving ? 'Saving…' : 'Save access'}
              </button>
            </div>
          </div>

          {(selectedKey === 'OWNER' || selectedKey === 'ADMIN') && (
            <div className="mt-4 rounded-xl border border-indigo/20 bg-indigo/5 px-3 py-3 flex items-start gap-2.5">
              <LockKeyhole className="w-4 h-4 text-indigo shrink-0 mt-0.5" />
              <p className="text-[11px] leading-relaxed text-t2">
                Owner and Admin must retain access administration and settings authority. CareCommand locks those recovery permissions so the clinic cannot accidentally lock itself out.
              </p>
            </div>
          )}

          <div className="mt-5 space-y-5">
            {groupedPermissions.map(group => (
              <div key={group.label}>
                <div className="flex items-center justify-between gap-3 mb-2">
                  <h3 className="text-[12px] font-bold text-t1">{group.label}</h3>
                  <span className="text-[10px] text-t3">{group.permissions.filter(permission => selectedPermissions.has(permission)).length}/{group.permissions.length} enabled</span>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {group.permissions.map(permission => {
                    const checked = selectedPermissions.has(permission);
                    const protectedGrant = (selectedKey === 'OWNER' || selectedKey === 'ADMIN') && PROTECTED_ADMIN.has(permission);
                    const risky = HIGH_RISK.has(permission);
                    return (
                      <button key={permission} type="button" onClick={() => togglePermission(permission)} disabled={protectedGrant}
                        aria-pressed={checked}
                        className={`rounded-xl border px-3 py-3 text-left transition ${checked ? 'border-indigo/30 bg-indigo/5' : 'border-[var(--b1)] bg-white hover:border-indigo/20'} ${protectedGrant ? 'cursor-not-allowed' : ''}`}>
                        <div className="flex items-start gap-2.5">
                          <span className={`mt-0.5 w-5 h-5 rounded-md border flex items-center justify-center shrink-0 ${checked ? 'bg-indigo border-indigo text-white' : 'border-[var(--b2)] bg-white'}`}>
                            {checked ? <Check className="w-3.5 h-3.5" /> : null}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <p className="text-[11px] font-semibold text-t1">{humanPermission(permission)}</p>
                              {risky && <span className="badge badge-amber">Sensitive</span>}
                              {protectedGrant && <span className="badge badge-indigo">Required</span>}
                            </div>
                            <p className="mt-1 text-[10px] leading-relaxed text-t3">{permissionDescription(permission)}</p>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {!loading && selectedPermissions.size === 0 && (
            <div className="mt-4 rounded-xl border border-amber-v/30 bg-amber-v/5 px-3 py-3 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-v mt-0.5" />
              <p className="text-[11px] text-t2">This role currently has no enabled permissions. Staff assigned to it will have a very limited workspace.</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
