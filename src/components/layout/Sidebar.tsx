import { useState } from 'react';
import { useLocation, Link, useNavigate } from 'react-router';
import {
  LayoutDashboard, Radar, Users2, Megaphone, TrendingUp,
  CalendarDays, ClipboardList, Puzzle, Settings,
  Star, Orbit, Target, UserCircle2, ShieldCheck, Sparkles, BadgeCheck, Bot, FileText, CreditCard, Lock, Cpu, Activity, Plug,
  ChevronsLeft, ChevronsRight, ChevronDown, Search, X,
} from 'lucide-react';
import { useSession } from '../../hooks/useSession';
import { useEntitlements } from '../../hooks/useEntitlements';
import { useUiPrefs } from '../../lib/uiPrefs';
import Logo from '../ui/Logo';

// Nav paths gated by a subscription feature. Locked items show a lock and route
// to /subscription (backend still enforces access regardless of the UI).
const NAV_FEATURE: Record<string, string> = {
  '/receptionist-studio': 'ai_receptionist',
  '/ai-receptionist': 'ai_receptionist',
  '/campaigner': 'campaign_automation',
  '/reactivation': 'campaign_automation',
  '/patient-intake': 'patient_crm',
  '/compliance': 'compliance_readiness',
  '/insurance': 'insurance_eligibility',
  '/revenue-protection': 'revenue_protection',
  '/devices': 'device_integration',
  '/monitoring': 'device_integration',
  '/integration-setup': 'device_integration',
  '/insurance-eligibility': 'insurance_eligibility',
  '/enrollments': 'device_integration',
  '/sync-logs': 'device_integration',
  '/rpm-readiness': 'device_integration',
};

interface NavItem {
  label: string;
  path: string;
  icon: React.ElementType;
  badge?: string | number;
  badgeColor?: 'red' | 'amber' | 'indigo';
  live?: boolean;
}

interface NavSection {
  label: string;
  items: NavItem[];
}

// Domain-grouped IA. Badges are intentionally NOT pre-populated with "New"/fake
// counts — the product's ethos is no fabricated data; real counts get wired per
// item when the data exists. `live` marks a genuinely running surface (Autopilot).
const nav: NavSection[] = [
  {
    label: 'Command Center',
    items: [
      { label: 'Dashboard', path: '/', icon: LayoutDashboard },
      { label: 'Advisory Room', path: '/advisory', icon: Sparkles },
      { label: 'Opportunity Center', path: '/opportunities', icon: Target },
    ],
  },
  {
    label: 'Front Office',
    items: [
      { label: 'Patients', path: '/patients', icon: UserCircle2 },
      { label: 'Scheduling', path: '/scheduling', icon: CalendarDays },
      { label: 'Patient Intake', path: '/patient-intake', icon: ClipboardList },
      { label: 'AI Receptionist', path: '/ai-receptionist', icon: Bot },
      { label: 'Receptionist Studio', path: '/receptionist-studio', icon: Bot },
      { label: 'Staff', path: '/staff', icon: ClipboardList },
    ],
  },
  {
    label: 'Growth',
    items: [
      { label: 'CRM', path: '/crm', icon: Users2 },
      { label: 'Campaigner', path: '/campaigner', icon: Megaphone },
      { label: 'Reactivation', path: '/reactivation', icon: Megaphone },
      { label: 'Autopilot', path: '/autopilot', icon: Orbit, live: true },
      { label: 'Reviews', path: '/reviews', icon: Star },
      { label: 'Clinic Radar', path: '/clinic-radar', icon: Radar },
    ],
  },
  {
    label: 'Revenue',
    items: [
      { label: 'Revenue Leaks', path: '/revenue', icon: TrendingUp },
      { label: 'Revenue Protection', path: '/revenue-protection', icon: ShieldCheck },
      { label: 'Insurance', path: '/insurance', icon: BadgeCheck },
      { label: 'Insurance Eligibility', path: '/insurance-eligibility', icon: BadgeCheck },
      { label: 'Provider Performance', path: '/doctor-workspace', icon: ClipboardList },
      { label: 'Benchmarking', path: '/benchmarking', icon: Radar },
    ],
  },
  {
    label: 'Connected Care',
    items: [
      { label: 'Remote Monitoring', path: '/monitoring', icon: Activity },
      { label: 'Device Integration', path: '/devices', icon: Cpu },
      { label: 'Device Enrollments', path: '/enrollments', icon: UserCircle2 },
      { label: 'RPM Billing Readiness', path: '/rpm-readiness', icon: CreditCard },
      { label: 'Provider Sync Logs', path: '/sync-logs', icon: FileText },
      { label: 'Integration Setup', path: '/integration-setup', icon: Plug },
    ],
  },
  {
    label: 'Governance',
    items: [
      { label: 'Compliance Readiness', path: '/compliance', icon: FileText },
      { label: 'Control Plane', path: '/control-plane', icon: ShieldCheck },
      { label: 'Integrations', path: '/integrations', icon: Puzzle },
      { label: 'Subscription', path: '/subscription', icon: CreditCard },
      { label: 'Settings', path: '/settings', icon: Settings },
    ],
  },
];

const badgeCls: Record<string, string> = {
  red: 'badge badge-red',
  amber: 'badge badge-amber',
  indigo: 'badge badge-indigo',
};

function initials(name?: string): string {
  if (!name) return '·';
  return name.trim().split(/\s+/).slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('') || '·';
}

// Segment-aware active match: '/' is exact; others match the path or a deeper
// child (/patients/:id) but NOT a sibling prefix (/revenue vs /revenue-protection).
function isPathActive(pathname: string, path: string): boolean {
  if (path === '/') return pathname === '/';
  return pathname === path || pathname.startsWith(path + '/');
}

export default function Sidebar({ mobileOpen = false, onNavigate }: { mobileOpen?: boolean; onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { user } = useSession();
  const entitlements = useEntitlements();
  const { collapsed, collapsedSections, setCollapsed, toggleSection } = useUiPrefs();
  const [filter, setFilter] = useState('');

  const isAdmin = user ? ['OWNER', 'ADMIN'].includes(user.role) : false;
  const canCompliance = user ? ['OWNER', 'ADMIN', 'COMPLIANCE_OFFICER', 'AUDITOR'].includes(user.role) : false;
  const q = filter.trim().toLowerCase();
  const collapsedSet = new Set(collapsedSections);

  const visibleNav = nav
    .map(section => ({
      ...section,
      items: section.items.filter(item =>
        (item.path !== '/control-plane' || isAdmin) &&
        (item.path !== '/compliance' || canCompliance) &&
        (!q || item.label.toLowerCase().includes(q))),
    }))
    .filter(section => section.items.length > 0);

  const roleLabel = user?.role ? user.role.toLowerCase().replace(/_/g, ' ') : '';

  return (
    <aside id="staff-navigation" className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''} ${mobileOpen ? 'sidebar--mobile-open' : ''}`}>
      {/* Brand */}
      <div className="px-4 pt-4 pb-3 border-b-b1">
        <div className="brand-row flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <Logo size={30} className="shrink-0" />
            <div className="collapse-hide min-w-0">
              <p className="text-[13px] font-bold leading-none text-t1 tracking-tight truncate">CareCommand AI</p>
              <p className="text-[10px] leading-none mt-1 text-t3 truncate">Clinic Operating System</p>
            </div>
          </div>
          <button type="button" onClick={() => setCollapsed(!collapsed)} aria-label="Collapse sidebar" title="Collapse"
            className="collapse-hide workspace-btn shrink-0"><ChevronsLeft className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      {/* Quick filter */}
      {!collapsed && (
        <div className="px-3 pt-2.5 collapse-hide">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-t3 pointer-events-none" aria-hidden="true" />
            <input
              type="text" value={filter} onChange={e => setFilter(e.target.value)}
              placeholder="Filter modules…" aria-label="Filter navigation"
              className="w-full rounded-lg border border-[var(--b1)] bg-[var(--s2)] pl-8 pr-7 py-1.5 text-[12px] text-t1 placeholder:text-t3 outline-none focus:border-[var(--indigo)] transition"
            />
            {filter && (
              <button type="button" onClick={() => setFilter('')} aria-label="Clear filter"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-t3 hover:text-t1"><X className="w-3.5 h-3.5" /></button>
            )}
          </div>
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-2" onClick={event => {
        if ((event.target as Element).closest('a')) onNavigate?.();
      }}>
        {visibleNav.length === 0 && (
          <p className="px-2 py-6 text-center text-[12px] text-t3">No modules match “{filter}”.</p>
        )}
        {visibleNav.map((section) => {
          // Sections collapse only in the expanded sidebar and when not filtering.
          const sectionCollapsed = !collapsed && !q && collapsedSet.has(section.label);
          return (
            <div key={section.label}>
              {collapsed ? (
                <p className="sidebar-section-label">{section.label}</p>
              ) : (
                <button type="button" onClick={() => !q && toggleSection(section.label)}
                  className="sidebar-section-label flex items-center justify-between w-full group cursor-pointer"
                  aria-expanded={sectionCollapsed ? 'false' : 'true'}>
                  <span>{section.label}</span>
                  {!q && (
                    <ChevronDown className={`w-3 h-3 text-t3 transition-transform duration-150 ${sectionCollapsed ? '-rotate-90' : ''}`} aria-hidden="true" />
                  )}
                </button>
              )}
              {!sectionCollapsed && section.items.map((item) => {
                const active = isPathActive(pathname, item.path);
                const Icon = item.icon;
                const feature = NAV_FEATURE[item.path];
                const locked = !!feature && entitlements !== null && !entitlements.has(feature);
                if (locked) {
                  return (
                    <Link key={item.path} to="/subscription" title={`${item.label} requires a plan upgrade or add-on`} className="nav-item opacity-60">
                      <Icon className="w-[15px] h-[15px] shrink-0 text-t3" />
                      <span className="flex-1 truncate">{item.label}</span>
                      <Lock className="w-3 h-3 shrink-0 text-t3" />
                    </Link>
                  );
                }
                return (
                  <Link key={item.path} to={item.path} title={item.label} className={`nav-item ${active ? 'active' : ''}`}>
                    <Icon className={`w-[15px] h-[15px] shrink-0 ${active ? 'text-indigo' : 'text-t3'}`} />
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.live && <span className="w-1.5 h-1.5 rounded-full shrink-0 live-dot pf-emerald" />}
                    {item.badge !== undefined && !item.live && (
                      <span className={`${badgeCls[item.badgeColor ?? 'indigo']} shrink-0`}>{item.badge}</span>
                    )}
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>

      {/* Collapse control */}
      <div className="px-3 py-2 border-t-b1">
        <button type="button" onClick={() => setCollapsed(!collapsed)} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="nav-item w-full text-t3">
          {collapsed ? <ChevronsRight className="w-[15px] h-[15px] shrink-0" /> : <ChevronsLeft className="w-[15px] h-[15px] shrink-0" />}
          <span className="flex-1 truncate collapse-hide">Collapse</span>
        </button>
      </div>

      {/* User profile — the real signed-in user */}
      <div className="px-3 py-3 border-t-b1">
        <button type="button" onClick={() => { onNavigate?.(); navigate('/settings'); }} title="Account & settings"
          className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg transition-colors hover:bg-[rgba(255,255,255,0.04)]">
          <div className="logo-user w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold text-white shrink-0">{initials(user?.displayName)}</div>
          <div className="flex-1 text-left min-w-0 collapse-hide">
            <p className="text-[11px] font-semibold leading-none text-t1 truncate">{user?.displayName ?? 'Account'}</p>
            <p className="text-[10px] leading-none mt-0.5 text-t3 capitalize truncate">{roleLabel || '—'}</p>
          </div>
        </button>
      </div>
    </aside>
  );
}
