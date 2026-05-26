import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Radar, Users2, Bot, CalendarDays, UserCircle2,
  Megaphone, TrendingUp, Stethoscope, ClipboardList, Star, Package,
  FlaskConical, Video, ShieldCheck, Plug, Settings, ChevronDown,
  Activity, Building2, ChevronRight, Users, Crown, Monitor, UserCog
} from 'lucide-react';

const navGroups = [
  {
    label: 'Intelligence',
    items: [
      { label: 'Command Center', icon: LayoutDashboard, path: '/' },
      { label: 'ClinicRadar AI', icon: Radar, path: '/clinic-radar', badge: '15', badgeColor: 'red' as const },
    ],
  },
  {
    label: 'Growth & Revenue',
    items: [
      { label: 'GrowthPulse CRM', icon: Users2, path: '/crm' },
      { label: 'Campaigner', icon: Megaphone, path: '/campaigner' },
      { label: 'RevenuePulse', icon: TrendingUp, path: '/revenue' },
    ],
  },
  {
    label: 'Front Desk & Scheduling',
    items: [
      { label: 'AI Front Desk', icon: Bot, path: '/ai-receptionist', badge: '7', badgeColor: 'blue' as const },
      { label: 'Smart Scheduling', icon: CalendarDays, path: '/scheduling' },
      { label: 'Customer360', icon: UserCircle2, path: '/patients' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Provider Productivity', icon: Stethoscope, path: '/doctor-workspace' },
      { label: 'Staff Workflow', icon: ClipboardList, path: '/staff' },
      { label: 'Reviews & Referrals', icon: Star, path: '/reviews' },
      { label: 'Inventory Intelligence', icon: Package, path: '/inventory', badge: '3', badgeColor: 'amber' as const },
    ],
  },
  {
    label: 'Admin & Compliance',
    items: [
      { label: 'Documents & Reports', icon: FlaskConical, path: '/labs' },
      { label: 'Virtual Visit Booking', icon: Video, path: '/telehealth' },
      { label: 'Privacy & Comms Controls', icon: ShieldCheck, path: '/compliance' },
      { label: 'Integrations Hub', icon: Plug, path: '/integrations' },
      { label: 'Settings', icon: Settings, path: '/settings' },
    ],
  },
];

const workspaces = [
  { id: 'all', label: 'All Clinics', sub: '4 locations' },
  { id: 'b1', label: 'Downtown Medical', sub: 'Harley Street' },
  { id: 'b2', label: 'Westside Family', sub: 'Kensington' },
  { id: 'b3', label: 'Northgate Derma', sub: 'Camden Road' },
  { id: 'b4', label: 'Southbank Wellness', sub: 'Waterloo Rd' },
];

const roles = [
  { id: 'owner', label: 'Owner View', icon: Crown },
  { id: 'manager', label: 'Manager View', icon: Monitor },
  { id: 'frontdesk', label: 'Front Desk View', icon: Users },
  { id: 'provider', label: 'Provider View', icon: UserCog },
];

const badgeStyles = {
  red: 'bg-red-500 text-white',
  blue: 'bg-blue-500 text-white',
  amber: 'bg-amber-500 text-white',
};

export default function Sidebar() {
  const [workspace, setWorkspace] = useState(workspaces[0]);
  const [role, setRole] = useState(roles[0]);
  const [showWorkspaceMenu, setShowWorkspaceMenu] = useState(false);
  const [showRoleMenu, setShowRoleMenu] = useState(false);

  return (
    <aside className="fixed top-0 left-0 h-screen w-[280px] bg-slate-950 flex flex-col z-50 border-r border-slate-800/60">
      {/* Logo */}
      <div className="px-5 py-4 border-b border-slate-800/60">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
            <Activity className="w-4.5 h-4.5 text-white" style={{ width: 18, height: 18 }} />
          </div>
          <div>
            <div className="text-white font-bold text-[13px] leading-tight tracking-tight">CareCommand AI</div>
            <div className="text-blue-400/80 text-[9px] font-semibold tracking-[0.15em] uppercase mt-0.5">Business Growth & Ops OS</div>
          </div>
        </div>
      </div>

      {/* Workspace Switcher */}
      <div className="px-3 py-3 border-b border-slate-800/60 space-y-1.5">
        <div className="relative">
          <button
            onClick={() => { setShowWorkspaceMenu(!showWorkspaceMenu); setShowRoleMenu(false); }}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 transition-colors text-left"
          >
            <Building2 className="w-3.5 h-3.5 text-blue-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-white text-[12px] font-semibold truncate leading-tight">{workspace.label}</div>
              <div className="text-slate-500 text-[10px] truncate">{workspace.sub}</div>
            </div>
            <ChevronDown className={`w-3.5 h-3.5 text-slate-500 shrink-0 transition-transform ${showWorkspaceMenu ? 'rotate-180' : ''}`} />
          </button>
          {showWorkspaceMenu && (
            <div className="absolute top-full mt-1 left-0 right-0 bg-slate-900 border border-slate-800 rounded-xl shadow-2xl shadow-black/40 py-1 z-50 overflow-hidden">
              {workspaces.map(w => (
                <button
                  key={w.id}
                  onClick={() => { setWorkspace(w); setShowWorkspaceMenu(false); }}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-800 transition-colors ${workspace.id === w.id ? 'bg-slate-800' : ''}`}
                >
                  <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${workspace.id === w.id ? 'bg-blue-400' : 'bg-slate-700'}`} />
                  <div>
                    <div className={`text-[12px] font-semibold ${workspace.id === w.id ? 'text-blue-400' : 'text-white'}`}>{w.label}</div>
                    <div className="text-slate-500 text-[10px]">{w.sub}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Role Switcher */}
        <div className="relative">
          <button
            onClick={() => { setShowRoleMenu(!showRoleMenu); setShowWorkspaceMenu(false); }}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 transition-colors text-left"
          >
            <role.icon className="w-3.5 h-3.5 text-violet-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-slate-300 text-[12px] font-semibold truncate">{role.label}</div>
            </div>
            <ChevronDown className={`w-3.5 h-3.5 text-slate-500 shrink-0 transition-transform ${showRoleMenu ? 'rotate-180' : ''}`} />
          </button>
          {showRoleMenu && (
            <div className="absolute top-full mt-1 left-0 right-0 bg-slate-900 border border-slate-800 rounded-xl shadow-2xl shadow-black/40 py-1 z-50 overflow-hidden">
              {roles.map(r => (
                <button
                  key={r.id}
                  onClick={() => { setRole(r); setShowRoleMenu(false); }}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-slate-800 transition-colors ${role.id === r.id ? 'bg-slate-800' : ''}`}
                >
                  <r.icon className={`w-3.5 h-3.5 shrink-0 ${role.id === r.id ? 'text-violet-400' : 'text-slate-500'}`} />
                  <span className={`text-[12px] font-semibold ${role.id === r.id ? 'text-violet-400' : 'text-slate-400'}`}>{r.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2 px-2">
        {navGroups.map((group) => (
          <div key={group.label} className="mb-1">
            <p className="px-3 pt-3 pb-1.5 text-[9px] font-bold uppercase tracking-[0.15em] text-slate-600">{group.label}</p>
            {group.items.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === '/'}
                onClick={() => { setShowWorkspaceMenu(false); setShowRoleMenu(false); }}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 px-3 py-2 rounded-xl mb-0.5 text-[12.5px] transition-all group relative ${
                    isActive
                      ? 'bg-blue-600 text-white font-semibold shadow-lg shadow-blue-600/20'
                      : 'text-slate-400 hover:bg-slate-800/80 hover:text-slate-200'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <item.icon className={`w-3.5 h-3.5 shrink-0 ${isActive ? 'text-white' : 'text-slate-500 group-hover:text-slate-300'}`} />
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.badge && (
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none ${badgeStyles[item.badgeColor]}`}>
                        {item.badge}
                      </span>
                    )}
                    {isActive && <ChevronRight className="w-3 h-3 text-blue-300 shrink-0" />}
                  </>
                )}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      {/* User Profile Footer */}
      <div className="px-3 py-3 border-t border-slate-800/60">
        <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-slate-800/60 cursor-pointer transition-colors group">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-violet-500 flex items-center justify-center text-white text-xs font-bold shrink-0 shadow-md">
            KK
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-white text-[12px] font-semibold leading-tight truncate">Dr. Kiran Kapoor</div>
            <div className="text-slate-500 text-[10px]">Clinic Owner · All Branches</div>
          </div>
          <Settings className="w-3.5 h-3.5 text-slate-600 group-hover:text-slate-400 transition-colors" />
        </div>
      </div>
    </aside>
  );
}
