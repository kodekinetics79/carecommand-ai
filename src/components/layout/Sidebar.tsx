import { useLocation, Link, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Radar, Users2, Megaphone, TrendingUp,
  CalendarDays, ClipboardList, Puzzle, Settings,
  Star, Orbit, Target, UserCircle2, ShieldCheck, Sparkles, BadgeCheck, Bot, FileText, CreditCard, Lock, Cpu, Activity, Plug,
  ChevronsLeft, ChevronsRight,
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

const nav: NavSection[] = [
  {
    label: 'Command Center',
    items: [
      { label: 'Dashboard',    path: '/',             icon: LayoutDashboard },
      { label: 'Advisory Room', path: '/advisory',    icon: Sparkles, badge: 'New', badgeColor: 'indigo' },
      { label: 'Opportunity Center', path: '/opportunities', icon: Target, badge: 'New', badgeColor: 'indigo' },
    ],
  },
  {
    label: 'Growth',
    items: [
      { label: 'CRM',          path: '/crm',             icon: Users2 },
      { label: 'Receptionist Studio', path: '/receptionist-studio', icon: Bot, badge: 'New', badgeColor: 'indigo' },
      { label: 'Campaigner',   path: '/campaigner',      icon: Megaphone },
      { label: 'Reactivation', path: '/reactivation',    icon: Megaphone, badge: 'New', badgeColor: 'indigo' },
      { label: 'Autopilot',    path: '/autopilot',       icon: Orbit, live: true },
      { label: 'Reviews',      path: '/reviews',         icon: Star },
      { label: 'Clinic Radar', path: '/clinic-radar',    icon: Radar, badge: 3, badgeColor: 'red' },
    ],
  },
  {
    label: 'Revenue',
    items: [
      { label: 'Revenue Leaks', path: '/revenue',         icon: TrendingUp },
      { label: 'Revenue Protection', path: '/revenue-protection', icon: ShieldCheck, badge: 'New', badgeColor: 'indigo' },
      { label: 'Insurance', path: '/insurance', icon: BadgeCheck, badge: 'New', badgeColor: 'indigo' },
      { label: 'Insurance Eligibility', path: '/insurance-eligibility', icon: BadgeCheck, badge: 'New', badgeColor: 'indigo' },
      { label: 'Provider Performance', path: '/doctor-workspace', icon: ClipboardList },
      { label: 'Multi-Clinic Benchmarking', path: '/benchmarking', icon: Radar },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Patients',    path: '/patients',   icon: UserCircle2 },
      { label: 'Patient Intake', path: '/patient-intake', icon: ClipboardList, badge: 'New', badgeColor: 'indigo' },
      { label: 'Remote Monitoring', path: '/monitoring', icon: Activity, badge: 'New', badgeColor: 'indigo' },
      { label: 'Device Enrollments', path: '/enrollments', icon: UserCircle2, badge: 'New', badgeColor: 'indigo' },
      { label: 'RPM Billing Readiness', path: '/rpm-readiness', icon: CreditCard, badge: 'New', badgeColor: 'indigo' },
      { label: 'Scheduling',  path: '/scheduling', icon: CalendarDays, badge: 4, badgeColor: 'amber' },
      { label: 'Staff',       path: '/staff',      icon: ClipboardList },
    ],
  },
  {
    label: 'Platform',
    items: [
      { label: 'Control Plane', path: '/control-plane', icon: ShieldCheck },
      { label: 'Compliance Readiness', path: '/compliance', icon: FileText, badge: 'New', badgeColor: 'indigo' },
      { label: 'Device Integration', path: '/devices', icon: Cpu, badge: 'New', badgeColor: 'indigo' },
      { label: 'Integration Setup', path: '/integration-setup', icon: Plug, badge: 'New', badgeColor: 'indigo' },
      { label: 'Provider Sync Logs', path: '/sync-logs', icon: FileText, badge: 'New', badgeColor: 'indigo' },
      { label: 'Subscription',  path: '/subscription', icon: CreditCard },
      { label: 'Integrations',  path: '/integrations', icon: Puzzle },
      { label: 'Settings',      path: '/settings',     icon: Settings },
    ],
  },
];

const badgeCls: Record<string, string> = {
  red:    'badge badge-red',
  amber:  'badge badge-amber',
  indigo: 'badge badge-indigo',
};

export default function Sidebar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { user } = useSession();
  const entitlements = useEntitlements();
  const { collapsed, setCollapsed } = useUiPrefs();
  const isAdmin = user ? ['OWNER', 'ADMIN'].includes(user.role) : false;
  // Compliance Readiness Center is visible only to compliance roles; normal
  // users (manager/provider/front-desk/billing/analyst) never see it.
  const canCompliance = user ? ['OWNER', 'ADMIN', 'COMPLIANCE_OFFICER', 'AUDITOR'].includes(user.role) : false;

  const visibleNav = nav
    .map(section => ({
      ...section,
      items: section.items.filter(item =>
        (item.path !== '/control-plane' || isAdmin) &&
        (item.path !== '/compliance' || canCompliance)),
    }))
    .filter(section => section.items.length > 0);

  return (
    <aside className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''}`}>
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
          <button type="button" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand' : 'Collapse'}
            className="collapse-hide workspace-btn shrink-0"><ChevronsLeft className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-2">
        {visibleNav.map((section) => (
          <div key={section.label}>
            <p className="sidebar-section-label">{section.label}</p>
            {section.items.map((item) => {
              const isActive = item.path === '/' ? pathname === '/' : pathname.startsWith(item.path);
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
                <Link key={item.path} to={item.path} title={item.label} className={`nav-item ${isActive ? 'active' : ''}`}>
                  <Icon className={`w-[15px] h-[15px] shrink-0 ${isActive ? 'text-indigo' : 'text-t3'}`} />
                  <span className="flex-1 truncate">{item.label}</span>
                  {item.live && (
                    <span className="w-1.5 h-1.5 rounded-full shrink-0 live-dot pf-emerald" />
                  )}
                  {item.badge !== undefined && !item.live && (
                    <span className={`${badgeCls[item.badgeColor ?? 'indigo']} shrink-0`}>{item.badge}</span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Collapse control */}
      <div className="px-3 py-2 border-t-b1">
        <button type="button" onClick={() => setCollapsed(!collapsed)} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="nav-item w-full text-t3">
          {collapsed ? <ChevronsRight className="w-[15px] h-[15px] shrink-0" /> : <ChevronsLeft className="w-[15px] h-[15px] shrink-0" />}
          <span className="flex-1 truncate collapse-hide">Collapse</span>
        </button>
      </div>

      {/* User profile */}
      <div className="px-3 py-3 border-t-b1">
        <button type="button" onClick={() => navigate('/settings')} title="Account & settings"
          className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg transition-colors hover:bg-[rgba(255,255,255,0.04)]">
          <div className="logo-user w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold text-white shrink-0">ZK</div>
          <div className="flex-1 text-left min-w-0 collapse-hide">
            <p className="text-[11px] font-semibold leading-none text-t1 truncate">Zack Khan</p>
            <p className="text-[10px] leading-none mt-0.5 text-t3">Owner</p>
          </div>
        </button>
      </div>
    </aside>
  );
}
