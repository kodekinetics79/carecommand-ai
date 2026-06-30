import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';

// Sub-module / detail routes whose natural "up" target isn't derivable from the
// path alone. Used only as the fallback when there is no in-app history to pop
// (deep link, hard refresh) so the user is never stranded.
const SUBROUTE_PARENTS: Record<string, string> = {
  '/insurance-eligibility': '/insurance',
  '/integration-setup': '/integrations',
  '/sync-logs': '/devices',
  '/enrollments': '/monitoring',
  '/rpm-readiness': '/monitoring',
  '/receptionist-studio': '/ai-receptionist',
  '/reactivation': '/crm',
};

/** Best-effort parent route for a path (used only when history can't be popped). */
function parentRouteFor(pathname: string, home = '/'): string {
  if (/^\/patients\/[^/]+$/.test(pathname)) return '/patients';
  if (pathname.startsWith('/compliance/')) return '/compliance';
  if (pathname.startsWith('/client/') && pathname !== '/client') return '/client';
  return SUBROUTE_PARENTS[pathname] ?? home;
}

interface BackButtonProps {
  /** Root path where the button is hidden (no "up" from the home screen). */
  home?: string;
  className?: string;
}

/**
 * Smart back control. Prefers true "previous screen" (history pop) and falls
 * back to the section parent (or home) on a fresh load with no history, so it
 * always lands somewhere sensible inside the app rather than leaving it.
 */
export default function BackButton({ home = '/', className = '' }: BackButtonProps) {
  const navigate = useNavigate();
  const location = useLocation();

  if (location.pathname === home) return null;

  // location.key === 'default' means this is the first entry (no prior in-app
  // navigation to pop back to).
  const hasHistory = location.key !== 'default';
  const onBack = () => {
    if (hasHistory) navigate(-1);
    else navigate(parentRouteFor(location.pathname, home));
  };

  return (
    <button
      type="button"
      onClick={onBack}
      aria-label="Go back to the previous screen"
      title="Back"
      className={`inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] bg-white px-2 py-1.5 text-[12px] font-medium text-t2 hover:bg-[var(--s2)] hover:text-t1 transition shrink-0 ${className}`}
    >
      <ChevronLeft className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span className="hidden sm:inline">Back</span>
    </button>
  );
}
