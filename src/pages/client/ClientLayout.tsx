import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { HeartPulse, Home, CalendarDays, ClipboardList, FileText, ShieldCheck, CreditCard, User, Bell, LogOut, Loader2 } from 'lucide-react';
import { portalClient, getPortalToken, setPortalToken } from '../../lib/portalClient';

// Patient-safe navigation only — no staff/admin/AI/revenue/compliance/audit.
const NAV = [
  { to: '/client', label: 'Home', icon: Home, end: true },
  { to: '/client/appointments', label: 'Appointments', icon: CalendarDays },
  { to: '/client/requests', label: 'Requests', icon: ClipboardList },
  { to: '/client/intake', label: 'Intake', icon: FileText },
  { to: '/client/insurance', label: 'Insurance', icon: ShieldCheck },
  { to: '/client/payments', label: 'Payments', icon: CreditCard },
  { to: '/client/profile', label: 'Profile', icon: User },
  { to: '/client/preferences', label: 'Preferences', icon: Bell },
];

export default function ClientLayout() {
  const navigate = useNavigate();
  const [me, setMe] = useState<{ displayName: string; clinicName: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getPortalToken()) { navigate('/client/login', { replace: true }); return; }
    let active = true;
    void (async () => {
      try { const m = await portalClient.me(); if (active) setMe(m); }
      catch { navigate('/client/login', { replace: true }); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [navigate]);

  async function logout() { try { await portalClient.logout(); } catch { /* ignore */ } setPortalToken(null); navigate('/client/login'); }

  if (loading) return <div className="min-h-screen grid place-items-center bg-[var(--bg)]"><Loader2 className="w-6 h-6 animate-spin text-indigo" /></div>;

  return (
    <div className="min-h-screen bg-[var(--bg)] flex flex-col">
      <header className="sticky top-0 z-30 bg-[var(--s1)] border-b border-[var(--b1)] px-4 sm:px-6 h-14 flex items-center justify-between">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-[var(--indigo)] grid place-items-center shrink-0"><HeartPulse className="w-4 h-4 text-white" /></div>
          <div className="min-w-0 leading-tight"><p className="text-sm font-bold text-t1 truncate">{me?.clinicName ?? 'Patient Portal'}</p><p className="text-[10px] text-t3">Patient portal</p></div>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden sm:block text-[12px] font-semibold text-t2">{me?.displayName}</span>
          <button type="button" onClick={logout} title="Sign out" aria-label="Sign out" className="topbar-icon-btn"><LogOut className="w-4 h-4" /></button>
        </div>
      </header>

      {/* Horizontal nav (mobile-friendly, scrollable) */}
      <nav className="sticky top-14 z-20 bg-[var(--s1)] border-b border-[var(--b1)] px-2 sm:px-4 overflow-x-auto" aria-label="Portal sections">
        <div className="flex gap-1 py-2 min-w-max">
          {NAV.map(item => (
            <NavLink key={item.to} to={item.to} end={item.end}
              className={({ isActive }) => `inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${isActive ? 'bg-[var(--indigo)] text-white' : 'text-t3 hover:text-t1 hover:bg-[var(--s3)]'}`}>
              <item.icon className="w-3.5 h-3.5" /> {item.label}
            </NavLink>
          ))}
        </div>
      </nav>

      <main className="flex-1 max-w-3xl w-full mx-auto px-4 sm:px-6 py-6 animate-fade-up">
        <Outlet />
      </main>
    </div>
  );
}
