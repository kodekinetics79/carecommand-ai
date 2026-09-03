import { useState } from 'react';
import { useLocation, Link, useNavigate } from 'react-router';
import {
  LayoutDashboard, Radar, Users2, Megaphone, TrendingUp,
  CalendarDays, ClipboardList, Settings,
  Star, Orbit, Target, UserCircle2, ShieldCheck, Sparkles, BadgeCheck, Bot, FileText, CreditCard, Lock, Cpu, Activity, SlidersHorizontal,
  ChevronsLeft, ChevronsRight, ChevronDown, Search, X, PhoneCall,
} from 'lucide-react';
import { useSession } from '../../hooks/useSession';
import { useEntitlements } from '../../hooks/useEntitlements';
import { useFrontDeskPoll } from '../../hooks/useFrontDeskPoll';
import { summarizeNeedsAction } from '../../lib/frontDesk';
import { canOpenPath, type RoutePath } from '../../lib/access';
import { useUiPrefs } from '../../lib/uiPrefs';
import Logo from '../ui/Logo';

type WorkforcePath = '/receptionist-studio/workforce';

// Nav paths gated by a subscription feature. Locked items show a lock and route
// to /subscription (backend still enforces access regardless of the UI).
const NAV_FEATURE: Record<string, string> = {
  '/receptionist-studio': 'ai_receptionist',
  '/receptionist-studio/workforce': 'ai_receptionist',
  '/front-desk': 'ai_receptionist',
  '/ai-receptionist': 'ai_receptionist',
  '/campaigns': 'campaign_automation',
  // Retired paths, still routable (they redirect to /campaigns). Kept here so a
  // deep link into one is padlocked on the same entitlement as the destination.
  '/campaigner': 'campaign_automation',
  '/reactivation': 'campaign_automation',
  '/patient-intake': 'patient_crm',
  '/compliance': 'compliance_readiness',
  '/insurance': 'insurance_eligibility',
  '/revenue-protection': 'revenue_protection',
  '/devices': 'device_integration',
  '/monitoring': 'device_integration',
  '/insurance-eligibility': 'insurance_eligibility',
  '/enrollments': 'device_integration',
  '/sync-logs': 'device_integration',
  '/rpm-readiness': 'device_integration',
  '/alert-thresholds': 'device_integration',
};

interface NavItem {
  label: string;
  // AI Workforce deliberately lives beneath Receptionist Studio so the shared
  // access registry gives it the same receptionist:manage boundary without a
  // second permission definition drifting away from the APIs it orchestrates.
  path: RoutePath | WorkforcePath;
  icon: React.ElementType;
  badge?: string | number;
  badgeColor?: 'red' | 'amber' | 'indigo';
}

interface NavSection {
  label: string;
  items: NavItem[];
}

// Domain-grouped IA. Badges are intentionally NOT pre-populated with "New"/fake
// counts — the product's ethos is no fabricated data; real counts get wired per
// item when the data exists.
const nav: NavSection[] = [
  {
    label: 'Command Center',
    items: [
      { label: 'Command Center', path: '/', icon: LayoutDashboard },
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
      { label: 'Front Desk', path: '/front-desk', icon: PhoneCall },
      { label: 'AI Workforce', path: '/receptionist-studio/workforce', icon: Sparkles },
      { label: 'AI Receptionist', path: '/ai-receptionist', icon: Bot },
      { label: 'Receptionist Studio', path: '/receptionist-studio', icon: Bot },
      { label: 'Staff Tasks', path: '/staff', icon: ClipboardList },
    ],
  },
  {
    label: 'Growth',
    items: [
      { label: 'CRM', path: '/crm', icon: Users2 },
      // One entry, not two. "Campaigner" and "Reactivation" were the same
      // Campaign rows read through two field families on two backends; they are
      // one destination now and the old paths redirect into it.
      { label: 'Campaigns', path: '/campaigns', icon: Megaphone },
      { label: 'Autopilot', path: '/autopilot', icon: Orbit },
      { label: 'Reviews', path: '/reviews', icon: Star },
      { label: 'ClinicRadar', path: '/clinic-radar', icon: Radar },
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
      { label: 'Alert Thresholds', path: '/alert-thresholds', icon: SlidersHorizontal },
      { label: 'Device Integration', path: '/devices', icon: Cpu },
      { label: 'Device Enrollments', path: '/enrollments', icon: UserCircle2 },
      { label: 'RPM Billing Readiness', path: '/rpm-readiness', icon: CreditCard },
      { label: 'Provider Sync Logs', path: '/sync-logs', icon: FileText },
    ],
  },
  // "Integrations" and "Integration Setup" used to sit here and under Connected
  // Care. Both were directories of the services CareCommand buys — 17 provider
  // cards with Mock Mode badges, Test-connection buttons and API-key fields —
  // on the screen of a clinic that holds none of those accounts. They moved to
  // the Platform Console whole. What a clinic sees instead is the capability,
  // stated where it bites: the eligibility screen says eligibility is not set
  // up, the payment card says card payments are not set up, and both name
  // CareCommand support as the next step.
  {
    label: 'Governance',
    items: [
      { label: 'Compliance Readiness', path: '/compliance', icon: FileText },
      { label: 'Control Plane', path: '/control-plane', icon: ShieldCheck },
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
  // AI Workforce is a first-class child destination. Keep the parent Studio
  // from also lighting up when the workforce command center is open.
  if (path === '/receptionist-studio') return pathname === path;
  return pathname === path || pathname.startsWith(path + '/');
}

export default function Sidebar({ mobileOpen = false, onNavigate }: { mobileOpen?: boolean; onNavigate?: () => void }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { user, loading } = useSession();
  const entitlements = useEntitlements();
  const { collapsed, collapsedSections, setCollapsed, toggleSection } = useUiPrefs();
  const [filter, setFilter] = useState('');

  // The Front Desk badge is the shared 20s task summary (one poller for the
  // whole app). It is fetched only for a session that can open the board it
  // badges — GET /v1/tasks/summary is guarded by staff:read, not by the call
  // grant, so asking on behalf of an auditor was a 403 every 20 seconds for a
  // number that could never arrive. One question, asked once: canOpenPath.
  // NOTHING is shown when the summary failed to load: a missing badge means
  // "not known", and a zero would be a claim nobody verified.
  //
  // The critical number is the server's real count, not the length of the
  // capped preview (D7): a badge reading 5 beside nine open emergencies is
  // worse than no badge at all. Where only the capped preview is available the
  // badge reads "5+".
  const frontDeskSummary = useFrontDeskPoll({ enabled: !loading && canOpenPath(user, '/front-desk') });
  const frontDeskCounts = summarizeNeedsAction(frontDeskSummary.state === 'ready' ? frontDeskSummary.data : null);
  const criticalBadge = frontDeskCounts.criticalExact ? frontDeskCounts.critical : `${frontDeskCounts.critical}+`;
  const frontDeskBadge: Pick<NavItem, 'badge' | 'badgeColor'> = frontDeskSummary.state !== 'ready'
    ? {}
    : frontDeskCounts.critical > 0
      ? { badge: criticalBadge, badgeColor: 'red' }
      : frontDeskCounts.count > 0
        ? { badge: frontDeskCounts.count, badgeColor: 'amber' }
        : {};

  const q = filter.trim().toLowerCase();
  const collapsedSet = new Set(collapsedSections);

  // Permission-aware navigation. An entry whose destination the user's grants do
  // not cover is HIDDEN — never padlocked, because a padlock promises an upgrade
  // path and no plan change can grant a permission. The lock below stays for
  // subscription entitlements only. Until /v1/auth/me resolves the grant set we
  // know nothing, so nothing is offered.
  const visibleNav = loading ? [] : nav
    .map(section => ({
      ...section,
      items: section.items
        .filter(item => canOpenPath(user, item.path) && (!q || item.label.toLowerCase().includes(q)))
        .map(item => item.path === '/front-desk' ? { ...item, ...frontDeskBadge } : item),
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
        {loading && (
          <div className="px-2 py-2 space-y-2" aria-hidden="true">
            {Array.from({ length: 8 }, (_, index) => <div key={index} className="skeleton h-7 rounded-lg" />)}
          </div>
        )}
        {!loading && visibleNav.length === 0 && (
          <p className="px-2 py-6 text-center text-[12px] text-t3">
            {q ? <>No modules match “{filter}”.</> : 'No modules are available for your role yet. Ask an owner or administrator to update your access.'}
          </p>
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
                    {item.badge !== undefined && (
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
