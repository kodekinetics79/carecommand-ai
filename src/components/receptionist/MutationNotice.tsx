import type { ReactNode } from 'react';
import { AlertCircle, Check } from 'lucide-react';
import type { MutationState } from '../../hooks/useMutationState';

/**
 * Renders the outcome of a `useMutationState` run: the server's own error
 * (role="alert", with its code and an optional action), a "Saved" pill, or
 * nothing at all. Idle and busy render nothing — the calling control shows
 * its own spinner.
 */
export function MutationNotice({
  state,
  onRetry,
  retryLabel = 'Retry',
  action,
  showSaved = true,
  savedLabel = 'Saved',
  className = '',
}: {
  state: MutationState;
  /** Offered as a button inside the alert. */
  onRetry?: () => void;
  retryLabel?: string;
  /** Any extra action (a link to the place that fixes the cause). */
  action?: ReactNode;
  /** Set false where a SaveBar already shows the saved pill. */
  showSaved?: boolean;
  savedLabel?: string;
  className?: string;
}) {
  if (state.status === 'error') {
    return (
      <div role="alert" className={`flex flex-wrap items-start gap-2 rounded-lg border border-red-v/40 bg-[var(--red-soft)] px-3 py-2 text-xs text-red-v ${className}`}>
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{state.message}</p>
          {Object.keys(state.fieldErrors).length > 1 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {Object.entries(state.fieldErrors).slice(1).map(([field, messages]) => (
                <li key={field}>{field}: {messages[0]}</li>
              ))}
            </ul>
          )}
          {state.code && <p className="mt-0.5 font-mono text-[10px] text-red-v/80">code: {state.code}</p>}
          {(onRetry || action) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {onRetry && (
                <button type="button" onClick={onRetry} className="rounded-lg border border-red-v/40 px-2.5 py-1 text-[11px] font-semibold text-red-v hover:bg-[var(--s2)]">{retryLabel}</button>
              )}
              {action}
            </div>
          )}
        </div>
      </div>
    );
  }
  if (state.status === 'saved' && showSaved) {
    return (
      <span role="status" className={`inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-v ${className}`}>
        <Check className="h-3.5 w-3.5" aria-hidden="true" /> {state.message ?? savedLabel}
      </span>
    );
  }
  return null;
}

/**
 * The same visual contract for a failed LOAD (not a mutation): "could not
 * load" with the real cause and a Retry. Use it wherever a panel must not
 * pretend a failed request was an empty result.
 */
export function LoadFailureNotice({ what, message, onRetry, className = '' }: { what: string; message: string; onRetry?: () => void; className?: string }) {
  return (
    <div role="alert" className={`flex flex-wrap items-start gap-2 rounded-lg border border-red-v/40 bg-[var(--red-soft)] px-3 py-2 text-xs text-red-v ${className}`}>
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{what} could not be loaded.</p>
        <p className="mt-0.5 text-red-v/90">{message}</p>
        {onRetry && (
          <button type="button" onClick={onRetry} className="mt-1.5 rounded-lg border border-red-v/40 px-2.5 py-1 text-[11px] font-semibold text-red-v hover:bg-[var(--s2)]">Retry</button>
        )}
      </div>
    </div>
  );
}
