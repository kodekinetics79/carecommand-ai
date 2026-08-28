import type { ReactNode } from 'react';
import { AlertTriangle, Inbox, RefreshCw } from 'lucide-react';
import EmptyStatePremium from './EmptyStatePremium';
import { resolveResourceState, type ResourceFailure, type ResourceState } from '../../lib/resourceState';

interface EmptyClaim {
  icon?: ReactNode;
  /** A statement about the workspace, not about the request. */
  title: string;
  /** Say that the request succeeded and carried no records. */
  description: string;
  cta?: { label: string; onClick: () => void };
}

interface ResourceSectionProps<T> {
  /**
   * What the user was trying to see, written as it should read mid-sentence:
   * "Team members could not be loaded". Names the failure in plain language.
   */
  label: string;
  state: ResourceState<T>;
  /** Wire this whenever the caller can re-issue the request. */
  onRetry?: () => void;
  /** Replace the default shimmer (for example a chart-shaped placeholder). */
  loading?: ReactNode;
  /** Rows in the default shimmer. */
  lines?: number;
  /** Size of each default shimmer row. */
  rowClassName?: string;
  /** Only rendered after a successful response. */
  empty?: EmptyClaim;
  /** Override emptiness for payloads that are not plain lists. */
  isEmpty?: (data: T) => boolean;
  /** Tighter error box for KPI tiles and other small slots. */
  compact?: boolean;
  className?: string;
  children: (data: T) => ReactNode;
}

/**
 * Renders exactly one of loading | error | empty | ready.
 *
 * `children` is a render prop, so the received value is the only way to reach
 * a number: there is no code path that can print a figure, a dash or "none"
 * for a request that failed or has not answered yet.
 */
export default function ResourceSection<T>({
  label, state, onRetry, loading, lines = 3, rowClassName, empty, isEmpty, compact = false, className, children,
}: ResourceSectionProps<T>) {
  const view = resolveResourceState(state, isEmpty);

  if (view.status === 'loading') {
    return loading ?? <ResourceSkeleton label={label} lines={lines} rowClassName={rowClassName} className={className} />;
  }

  if (view.status === 'error') {
    return <ResourceErrorNotice title={`${label} could not be loaded`} failure={view.failure} onRetry={onRetry} compact={compact} className={className} />;
  }

  if (view.status === 'empty') {
    return (
      <EmptyStatePremium
        icon={empty?.icon ?? <Inbox className="w-5 h-5" />}
        title={empty?.title ?? `No ${label.toLowerCase()} recorded`}
        description={empty?.description ?? `${label} loaded successfully and the workspace returned no records.`}
        cta={empty?.cta}
      />
    );
  }

  return <>{children(view.data)}</>;
}

/**
 * The failure state. It names what failed, says it in plain language, states
 * that nothing may be read from the panel, and offers the retry.
 */
export function ResourceErrorNotice({
  title, failure, onRetry, compact = false, className = '',
}: {
  /** The whole headline, e.g. "Team members could not be loaded". */
  title: string;
  failure: ResourceFailure;
  onRetry?: () => void;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={`rounded-xl border border-[rgba(220,38,38,0.18)] bg-[var(--red-soft)] ${compact ? 'p-3' : 'p-4'} ${className}`}
    >
      <p className={`flex items-start gap-1.5 font-semibold text-red-v ${compact ? 'text-[11px]' : 'text-sm'}`}>
        <AlertTriangle className={`${compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} shrink-0 mt-px`} aria-hidden="true" />
        {title}
      </p>
      <p className={`mt-1 text-t2 ${compact ? 'text-[10px] leading-snug' : 'text-xs'}`}>{failure.message}</p>
      {!compact && (
        <p className="mt-1 text-[11px] text-t3">
          Nothing on this panel loaded, so no figure here should be read as zero, empty or healthy.
        </p>
      )}
      {!compact && failure.permissionDenied && (
        <p className="mt-1 text-[11px] text-t3">Trying again will only succeed once an administrator grants you access.</p>
      )}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className={`mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] bg-[var(--s1)] font-semibold text-t1 hover:bg-[var(--s2)] transition ${compact ? 'px-2.5 py-1 text-[10px]' : 'px-3 py-1.5 text-xs'}`}
        >
          <RefreshCw className={compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} aria-hidden="true" />
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * The loading state. Announced rather than silent, and guaranteed to end: the
 * hook that owns the state stops waiting after its watchdog fires.
 */
export function ResourceSkeleton({ label, lines = 3, className = '', rowClassName }: {
  label: string; lines?: number; className?: string; rowClassName?: string;
}) {
  return (
    <div className={`space-y-2 ${className}`} aria-busy="true" aria-live="polite">
      {Array.from({ length: lines }).map((_, index) => (
        <div key={index} className={`skeleton-line ${rowClassName ?? 'h-14 rounded-xl'}`} />
      ))}
      <span className="sr-only">Loading {label}…</span>
    </div>
  );
}
