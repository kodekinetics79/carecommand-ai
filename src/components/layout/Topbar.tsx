import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Search, Bell, Command, Zap } from 'lucide-react';
import CommandPalette from '../ui/CommandPalette';

const routeLabels: Record<string, string> = {
  '/':                'Dashboard',
  '/clinic-radar':    'Clinic Radar',
  '/crm':             'CRM Pipeline',
  '/campaigner':      'Campaigner',
  '/reviews':         'Reviews & Referrals',
  '/revenue':         'RevenuePulse',
  '/ai-receptionist': 'AI Receptionist',
  '/scheduling':      'Scheduling',
  '/doctor-workspace':'Provider Productivity',
  '/staff':           'Staff Workflow',
  '/inventory':       'Inventory',
  '/labs':            'Documents',
  '/telehealth':      'Virtual Visits',
  '/patients':        'Customer360',
  '/compliance':      'Privacy & Compliance',
  '/integrations':    'Integrations',
  '/settings':        'Settings',
};

const notifs = [
  { title: '3 critical stock alerts',    desc: 'Botox critically low at Downtown',          time: '2m', dotCls: 'pf-red' },
  { title: 'SLA breach — Jake Williams', desc: 'Response time exceeds 6-min threshold',     time: '8m', dotCls: 'pf-amber' },
  { title: 'AI recovered £840 today',    desc: '6 missed-call bookings converted',          time: '1h', dotCls: 'pf-emerald' },
  { title: 'New 1-star review',          desc: 'Unresponded negative review — Southbank',   time: '2h', dotCls: 'pf-red' },
];

export default function Topbar() {
  const { pathname } = useLocation();
  const [cmdOpen,   setCmdOpen]   = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);

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
            <span className="text-[10px] font-semibold topbar-live-text">Live</span>
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
          <button type="button" className="topbar-ai-btn">
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
