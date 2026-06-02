import { useLocation, Link } from 'react-router-dom';
import {
  LayoutDashboard, Radar, Users2, Megaphone, TrendingUp,
  Bot, CalendarDays, UserCircle2, Stethoscope, ClipboardList,
  Package, FileText, Video, ShieldCheck, Puzzle, Settings,
  Star, ChevronDown, Hexagon, Orbit, Target,
} from 'lucide-react';

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
    label: 'Intelligence',
    items: [
      { label: 'Dashboard',    path: '/',             icon: LayoutDashboard },
      { label: 'Clinic Radar', path: '/clinic-radar', icon: Radar, badge: 3, badgeColor: 'red' },
      { label: 'CareFlow Autopilot', path: '/autopilot', icon: Orbit, live: true },
    ],
  },
  {
    label: 'Growth & Revenue',
    items: [
      { label: 'CRM Pipeline', path: '/crm',        icon: Users2 },
      { label: 'Campaigner',   path: '/campaigner',  icon: Megaphone },
      { label: 'Reviews',      path: '/reviews',     icon: Star },
      { label: 'RevenuePulse', path: '/revenue',     icon: TrendingUp },
      { label: 'Opportunity Center', path: '/opportunities', icon: Target, badge: 'New', badgeColor: 'indigo' },
    ],
  },
  {
    label: 'Front Desk',
    items: [
      { label: 'AI Receptionist', path: '/ai-receptionist', icon: Bot, live: true },
      { label: 'Scheduling',      path: '/scheduling',       icon: CalendarDays, badge: 4, badgeColor: 'amber' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Providers',      path: '/doctor-workspace', icon: Stethoscope },
      { label: 'Staff',          path: '/staff',            icon: ClipboardList },
      { label: 'Inventory',      path: '/inventory',        icon: Package },
      { label: 'Documents',      path: '/labs',             icon: FileText },
      { label: 'Virtual Visits', path: '/telehealth',       icon: Video },
    ],
  },
  {
    label: 'Admin',
    items: [
      { label: 'Customer360',  path: '/patients',     icon: UserCircle2 },
      { label: 'Privacy',      path: '/compliance',   icon: ShieldCheck },
      { label: 'Integrations', path: '/integrations', icon: Puzzle },
      { label: 'Settings',     path: '/settings',     icon: Settings },
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
          <button type="button" aria-label="Switch workspace" title="Switch workspace" className="workspace-btn">
            All <ChevronDown className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-2">
        {nav.map((section) => (
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
