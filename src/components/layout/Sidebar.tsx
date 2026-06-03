import { useLocation, Link, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Radar, Users2, Megaphone, TrendingUp,
  CalendarDays, ClipboardList, Puzzle, Settings,
  Star, ChevronDown, Hexagon, Orbit, Target, UserCircle2, ShieldCheck, Sparkles, BadgeCheck,
} from 'lucide-react';
import { useSession } from '../../hooks/useSession';

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
      { label: 'Campaigner',   path: '/campaigner',      icon: Megaphone },
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
      { label: 'Provider Performance', path: '/doctor-workspace', icon: ClipboardList },
      { label: 'Multi-Clinic Benchmarking', path: '/benchmarking', icon: Radar },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Patients',    path: '/patients',   icon: UserCircle2 },
      { label: 'Scheduling',  path: '/scheduling', icon: CalendarDays, badge: 4, badgeColor: 'amber' },
      { label: 'Staff',       path: '/staff',      icon: ClipboardList },
    ],
  },
  {
    label: 'Platform',
    items: [
      { label: 'Control Plane', path: '/control-plane', icon: ShieldCheck },
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
  const isAdmin = user ? ['OWNER', 'ADMIN'].includes(user.role) : false;

  const visibleNav = nav
    .map(section => ({
      ...section,
      items: section.items.filter(item => item.path !== '/control-plane' || isAdmin),
    }))
    .filter(section => section.items.length > 0);

  return (
    <aside className="sidebar">
      {/* Brand */}
      <div className="px-4 pt-4 pb-3 border-b-b1">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="logo-icon w-7 h-7 rounded-lg flex items-center justify-center shrink-0">
              <Hexagon className="w-3.5 h-3.5 fill-white text-white" />
            </div>
            <div>
              <p className="text-xs font-bold leading-none text-t1">CareCommand</p>
              <p className="text-[10px] leading-none mt-0.5 text-t3">AI Platform</p>
            </div>
          </div>
          <div aria-label="Switch workspace" title="Switch workspace" className="workspace-btn">
            All <ChevronDown className="w-3 h-3" />
          </div>
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
              return (
                <Link key={item.path} to={item.path} className={`nav-item ${isActive ? 'active' : ''}`}>
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

      {/* User profile */}
      <div className="px-3 py-3 border-t-b1">
        <button
          type="button"
          onClick={() => navigate('/settings')}
          className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg transition-colors hover:bg-[rgba(255,255,255,0.04)]"
        >
          <div className="logo-user w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold text-white shrink-0">
            ZK
          </div>
          <div className="flex-1 text-left min-w-0">
            <p className="text-[11px] font-semibold leading-none text-t1 truncate">Zack Khan</p>
            <p className="text-[10px] leading-none mt-0.5 text-t3">Owner</p>
          </div>
        </button>
      </div>
    </aside>
  );
}
