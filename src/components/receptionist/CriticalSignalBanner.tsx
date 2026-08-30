import { useState } from 'react';
import { Siren } from 'lucide-react';
import { frontDeskApi, type TaskSummary } from '../../lib/frontDesk';
import { notifyFrontDeskMutated } from '../../hooks/useFrontDeskPoll';
import { describeMutationFailure, type MutationError } from '../../hooks/useMutationState';
import { formatClinicTime } from '../../lib/frontDeskTime';

/**
 * Unacknowledged critical tasks (emergencies) from the shared summary. One
 * row per task with an Acknowledge button; there is no client-side dismiss —
 * the banner clears only when the server records the acknowledgement and the
 * next summary no longer lists the task (design-C4 §2.1).
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
  const items = summary?.unacknowledgedCritical ?? [];
  if (items.length === 0) return null;

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
        <p className="text-sm font-bold text-red-v">
          {items.length === 1 ? '1 emergency needs acknowledgement' : `${items.length} emergencies need acknowledgement`}
        </p>
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
      {failure && (
        <p role="alert" className="text-xs font-semibold text-red-v">{failure.message}{failure.code ? ` (code: ${failure.code})` : ''}</p>
      )}
    </div>
  );
}
