import { useState } from 'react';
import { Siren } from 'lucide-react';
import { criticalSignal, frontDeskApi, type TaskSummary } from '../../lib/frontDesk';
import { notifyFrontDeskMutated } from '../../hooks/useFrontDeskPoll';
import { describeMutationFailure, type MutationError } from '../../hooks/useMutationState';
import { formatClinicTime } from '../../lib/frontDeskTime';

/**
 * Unacknowledged emergencies from the shared summary. One row per task with an
 * Acknowledge button; there is no client-side dismiss — the banner clears only
 * when the server records the acknowledgement and the next summary no longer
 * lists the task (design-C4 §2.1).
 *
 * Two things this banner is NOT allowed to do (D7, D8):
 *   - print the preview's length as the count. The preview is capped at five,
 *     so nine emergencies read as five and callers 6-9 were invisible. The
 *     headline is the server's real count; where only the capped preview is
 *     available the headline says "5 or more", never "5".
 *   - announce work that is not a receptionist emergency. The preview query is
 *     tenant-wide, so a critical ops or insurance task could reach the front
 *     desk labelled as a clinical emergency. `criticalSignal` drops any row
 *     that declares a workflow of its own that is not the receptionist's.
 */
export function CriticalSignalBanner({
  summary,
  timezone,
  canAcknowledge,
  onAcknowledged,
}: {
  summary: TaskSummary | null;
  timezone: string;
  canAcknowledge: boolean;
  onAcknowledged?: () => void | Promise<void>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<MutationError | null>(null);
  const signal = criticalSignal(summary);
  const items = signal.rows;
  if (items.length === 0) return null;
  const headline = signal.count === 1 && signal.exact
    ? '1 emergency needs acknowledgement'
    : `${signal.count}${signal.exact ? '' : ' or more'} emergenc${signal.count === 1 ? 'y needs' : 'ies need'} acknowledgement`;

  async function acknowledge(id: string) {
    setBusyId(id);
    setFailure(null);
    try {
      await frontDeskApi.acknowledgeTask(id);
      notifyFrontDeskMutated();
      await onAcknowledged?.();
    } catch (error) {
      setFailure(describeMutationFailure(error));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div role="alert" aria-label="Unacknowledged emergencies" className="rounded-2xl border border-red-v/50 bg-[var(--red-soft)] p-4 space-y-2">
      <div className="flex items-center gap-2">
        <Siren className="h-5 w-5 text-red-v shrink-0" aria-hidden="true" />
        <p className="text-sm font-bold text-red-v">{headline}</p>
      </div>
      <ul className="space-y-1.5">
        {items.map(item => (
          <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-v/30 bg-[var(--s2)] px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-t1 truncate">{item.title}</p>
              <p className="text-[11px] text-t3">{item.clinicName ?? 'Clinic not recorded'} · {formatClinicTime(item.createdAt, timezone) || 'time unknown'}</p>
            </div>
            {canAcknowledge ? (
              <button
                type="button"
                disabled={busyId === item.id}
                onClick={() => void acknowledge(item.id)}
                aria-label={`Acknowledge ${item.title}`}
                className="rounded-lg bg-red-v px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {busyId === item.id ? 'Acknowledging…' : 'Acknowledge'}
              </button>
            ) : (
              <span className="text-[11px] text-t3">Your role cannot acknowledge tasks.</span>
            )}
          </li>
        ))}
      </ul>
      {signal.hidden > 0 && (
        <p className="text-[11px] font-semibold text-red-v">
          …and {signal.hidden} more not listed here. Acknowledge these first — the next {signal.hidden === 1 ? 'one appears' : 'ones appear'} as you clear them.
        </p>
      )}
      {!signal.exact && (
        <p className="text-[11px] text-t3">
          This server sends the first {items.length} unacknowledged emergencies without a total, so there may be more than {items.length}.
        </p>
      )}
      {failure && (
        <p role="alert" className="text-xs font-semibold text-red-v">{failure.message}{failure.code ? ` (code: ${failure.code})` : ''}</p>
      )}
    </div>
  );
}
