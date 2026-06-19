import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Search, Command, ChevronDown, ChevronRight, LogOut, Settings as SettingsIcon, Globe } from 'lucide-react';
import CommandPalette from '../ui/CommandPalette';
import { useSession } from '../../hooks/useSession';
import { usePreferences, LANGUAGES } from '../../lib/preferences';

const routeLabels: Record<string, string> = {
  '/':                 'Command Center',
  '/advisory':         'AI Briefing',
  '/opportunities':    'Opportunity Center',
  '/clinic-radar':     'Clinic Radar',
  '/benchmarking':     'Multi-Clinic Benchmarking',
  '/autopilot':        'Autopilot',
  '/crm':              'CRM',
  '/receptionist-studio': 'Receptionist Studio',
  '/campaigner':       'Campaigner',
  '/reactivation':     'Reactivation',
  '/reviews':          'Reviews',
  '/revenue':          'Revenue Leaks',
  '/revenue-protection': 'Revenue Protection',
  '/insurance':        'Insurance',
  '/insurance-eligibility': 'Insurance Eligibility',
  '/integration-setup': 'Integration Setup',
  '/enrollments':      'Device Enrollments',
  '/sync-logs':        'Provider Sync Logs',
  '/rpm-readiness':    'RPM Billing Readiness',
  '/doctor-workspace': 'Provider Performance',
  '/patients':         'Patients',
  '/patient-intake':   'Patient Intake',
  '/scheduling':       'Appointments',
  '/staff':            'Staff Tasks',
  '/compliance':       'Compliance Readiness',
  '/control-plane':    'Control Plane',
  '/admin':            'Control Plane',
  '/subscription':     'Subscription',
  '/integrations':     'Integrations',
  '/devices':          'Device Integration',
  '/monitoring':       'Remote Monitoring',
  '/settings':         'Settings',
};

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('') || '·';
}

export default function Topbar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [cmdOpen, setCmdOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const { user, signOut } = useSession();
  const { language, setLanguage } = usePreferences();

  const pageLabel = pathname === '/'
    ? 'Command Center'
    : (routeLabels[Object.keys(routeLabels).find(k => k !== '/' && pathname.startsWith(k)) ?? ''] ?? 'CareCommand');

  const workspace = user?.tenant?.name;
  const locationLabel = user?.branch?.name ?? user?.branch?.location ?? null;

  return (
    <>
      <header className="topbar">
        {/* Breadcrumb: workspace › section, with location context chip */}
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 min-w-0 flex-1 text-[13px]">
          {workspace && (
            <>
              <span className="text-t3 truncate max-w-[160px] hidden sm:inline">{workspace}</span>
              <ChevronRight className="w-3.5 h-3.5 text-t3 shrink-0 hidden sm:inline opacity-60" aria-hidden="true" />
            </>
          )}
          <span className="font-semibold text-t1 truncate">{pageLabel}</span>
          {locationLabel && (
            <span className="ml-1.5 hidden md:inline-flex items-center rounded-md border border-[var(--b1)] bg-[var(--s2)] px-2 py-0.5 text-[11px] font-medium text-t2 shrink-0">{locationLabel}</span>
          )}
        </nav>

        {/* Command search */}
        <button type="button" onClick={() => setCmdOpen(true)} className="topbar-search">
          <Search className="w-3.5 h-3.5 shrink-0" />
          <span className="topbar-search-text">Search</span>
          <kbd className="topbar-kbd"><Command className="w-2.5 h-2.5" />K</kbd>
        </button>

        {/* Language switcher — auto-translates the whole app */}
        <label className="hidden sm:inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] bg-white px-2 py-1.5" title="Language" data-no-translate>
          <Globe className="w-3.5 h-3.5 text-t3 shrink-0" aria-hidden="true" />
          <select aria-label="Language" value={language} onChange={e => setLanguage(e.target.value)}
            className="bg-transparent text-[12px] font-medium text-t2 outline-none cursor-pointer pr-1">
            {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </label>

        {/* User menu */}
        {user && (
          <div className="relative shrink-0">
            <button type="button" onClick={() => setMenuOpen(v => !v)} aria-haspopup="menu" aria-expanded={menuOpen ? 'true' : 'false'}
              className="flex items-center gap-2.5 rounded-lg border border-[var(--b1)] bg-white px-2 py-1.5 hover:bg-[var(--s2)] transition">
              <span className="logo-user w-7 h-7 rounded-full grid place-items-center text-[10px] font-bold text-white shrink-0">{initials(user.displayName)}</span>
              <span className="hidden md:flex flex-col items-start min-w-0">
                <span className="text-[12px] font-semibold leading-none text-t1 truncate max-w-[140px]">{user.displayName}</span>
                <span className="text-[10px] leading-none mt-0.5 text-t3 capitalize">{user.role.toLowerCase().replace(/_/g, ' ')}</span>
              </span>
              <ChevronDown className="w-3.5 h-3.5 text-t3 shrink-0" />
            </button>

            {menuOpen && (
              <>
                <button type="button" aria-label="Close menu" className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 top-[calc(100%+6px)] z-30 w-60 rounded-xl border border-[var(--b1)] bg-white shadow-[0_20px_48px_rgba(15,23,42,0.12),0_4px_12px_rgba(15,23,42,0.06)] overflow-hidden animate-fade-up">
                  <div className="px-4 py-3 border-b border-[var(--b1)]">
                    <p className="text-[13px] font-semibold text-t1 truncate">{user.displayName}</p>
                    <p className="text-[11px] text-t3 truncate">{user.email}</p>
                    {workspace && <p className="text-[11px] text-t3 truncate mt-1">{workspace}</p>}
                  </div>
                  <div className="p-1.5">
                    <button type="button" onClick={() => { setMenuOpen(false); navigate('/settings'); }}
                      className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] text-t2 hover:bg-[var(--s2)] transition">
                      <SettingsIcon className="w-4 h-4 text-t3" /> Account &amp; settings
                    </button>
                    <button type="button" onClick={() => { setMenuOpen(false); void signOut(); }}
                      className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] text-red-v hover:bg-[var(--red-soft)] transition">
                      <LogOut className="w-4 h-4" /> Sign out
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </header>

      <CommandPalette isOpen={cmdOpen} onClose={() => setCmdOpen(false)} />
    </>
  );
}
