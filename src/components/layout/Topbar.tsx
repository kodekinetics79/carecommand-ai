import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Search, Bell, Command, Zap, LogOut, UserCircle2 } from 'lucide-react';
import CommandPalette from '../ui/CommandPalette';
import { useBackendHealth } from '../../hooks/useBackendHealth';
import { formatCurrency } from '../../utils/formatters';
import { useSession } from '../../hooks/useSession';

const routeLabels: Record<string, string> = {
  '/':                 'Dashboard',
  '/opportunities':    'Opportunity Center',
  '/clinic-radar':     'Clinic Radar',
  '/benchmarking':     'Multi-Clinic Benchmarking',
  '/autopilot':        'Autopilot',
  '/crm':              'CRM',
  '/campaigner':       'Campaigner',
  '/reviews':          'Reviews',
  '/revenue':          'Revenue Leaks',
  '/doctor-workspace': 'Provider Performance',
  '/patients':         'Patients',
  '/scheduling':       'Scheduling',
  '/staff':            'Staff',
  '/control-plane':    'Control Plane',
  '/admin':            'Control Plane',
  '/integrations':     'Integrations',
  '/settings':         'Settings',
};

const notifs = [
  { title: '3 critical stock alerts',    desc: 'Botox critically low at Downtown',          time: '2m', dotCls: 'pf-red' },
  { title: 'SLA breach — Jake Williams', desc: 'Response time exceeds 6-min threshold',     time: '8m', dotCls: 'pf-amber' },
  { title: `AI recovered ${formatCurrency(840)} today`, desc: '6 missed-call bookings converted', time: '1h', dotCls: 'pf-emerald' },
  { title: 'New 1-star review',          desc: 'Unresponded negative review — Southbank',   time: '2h', dotCls: 'pf-red' },
];

export default function Topbar() {
  const { pathname } = useLocation();
  const [cmdOpen,   setCmdOpen]   = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const backendReady = useBackendHealth();
  const { user, signOut } = useSession();

  const pageLabel = pathname === '/'
    ? 'Dashboard'
    : (routeLabels[Object.keys(routeLabels).find(k => k !== '/' && pathname.startsWith(k)) ?? ''] ?? 'CareCommand');

  return (
    <>
      <header className="topbar">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-xs font-medium text-t3">CareCommand</span>
          <span className="text-t3 opacity-40 select-none">/</span>
          <span className="text-sm font-semibold text-t1 truncate">{pageLabel}</span>
          <div className="flex items-center gap-1.5 ml-2 px-2 py-0.5 rounded-full topbar-live">
            <span className="w-1.5 h-1.5 rounded-full live-dot pf-emerald" />
            <span className="text-[10px] font-semibold topbar-live-text">{backendReady ? 'API Live' : 'Demo Mode'}</span>
          </div>
        </div>

        {/* Search */}
        <button type="button" onClick={() => setCmdOpen(true)} className="topbar-search">
          <Search className="w-3.5 h-3.5 shrink-0" />
          <span className="topbar-search-text">Search or run a command…</span>
          <kbd className="topbar-kbd"><Command className="w-2.5 h-2.5" />K</kbd>
        </button>

        {/* Actions */}
          <div className="flex items-center gap-1.5">
          {user && (
            <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-full border border-[var(--b1)] bg-[var(--s2)]">
              <UserCircle2 className="w-4 h-4 text-t3" />
              <div className="min-w-0">
                <p className="text-[11px] font-semibold leading-none text-t1 truncate">{user.displayName}</p>
                <p className="text-[10px] leading-none mt-0.5 text-t3">{user.role}</p>
              </div>
            </div>
          )}

          {user && (
            <button type="button" onClick={() => void signOut()} className="topbar-ai-btn">
              <LogOut className="w-3.5 h-3.5" /> Logout
            </button>
          )}

          <button type="button" onClick={() => setCmdOpen(true)} className="topbar-ai-btn">
            <Zap className="w-3.5 h-3.5" /> AI Actions
          </button>

          <div className="relative">
            <button
              type="button"
              title="Notifications"
              aria-label="Notifications"
              onClick={() => setNotifOpen(v => !v)}
              className="topbar-icon-btn"
            >
              <Bell className="w-4 h-4" />
              <span className="notif-badge" />
            </button>

            {notifOpen && (
              <>
                <button
                  type="button"
                  aria-label="Close notifications"
                  className="fixed inset-0 z-20"
                  onClick={() => setNotifOpen(false)}
                />
                <div className="notif-panel animate-fade-up">
                  <p className="notif-header">Notifications</p>
                  {notifs.map((n) => (
                    <div key={n.title} className="notif-item">
                      <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 prog-fill ${n.dotCls}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold text-t1">{n.title}</p>
                        <p className="text-[11px] mt-0.5 text-t3 truncate">{n.desc}</p>
                      </div>
                      <span className="text-[10px] text-t3 shrink-0">{n.time}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <CommandPalette isOpen={cmdOpen} onClose={() => setCmdOpen(false)} />
    </>
  );
}
