import { Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { FrontDeskTaskRow } from '../../lib/frontDesk';
import { ReceptionistTaskCard, type TaskCardPermissions } from './ReceptionistTaskCard';
import type { ResourceFailure } from '../../lib/resourceState';

// ===========================================================================
// E11 / D9 — Service status.
//
// The one task that says "your receptionist is off the air" was the one task
// the board could not show. The hourly re-verify worker files it under a
// workflow the front-desk parser rejects, with an uppercase priority the
// critical banner does not match, so the badge, the banner, the header count
// and every lane excluded it. A clinic learned its line had stopped answering
// from a patient.
//
// So this lane sits ABOVE the caller queues, states the answering state even
// when there is nothing wrong, and renders the server's own remediation
// sentence with its Fix link. It is deliberately the first thing on the page:
// no caller lane matters if the line is not being answered.
// ===========================================================================

export function ServiceStatusLane({ rows, state, failure, timezone, can, onRetry, onChanged }: {
  rows: FrontDeskTaskRow[];
  state: 'loading' | 'ready' | 'error';
  failure: ResourceFailure | null;
  timezone: string;
  can: TaskCardPermissions;
  onRetry: () => void;
  onChanged: () => void | Promise<void>;
}) {
  return (
    <section aria-label="Service status" className="space-y-2">
      {state === 'loading' && (
        <p role="status" aria-live="polite" aria-busy="true" className="rounded-xl border border-[var(--b1)] px-3 py-2.5 text-center text-xs text-t3">
          <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" aria-hidden="true" />Checking whether the AI receptionist is answering…
        </p>
      )}

      {state === 'error' && (
        <div role="alert" className="rounded-2xl border border-red-v/40 bg-[var(--red-soft)] px-4 py-3 text-xs text-red-v">
          <p className="font-semibold">Service status could not be loaded.</p>
          <p className="mt-0.5">
            {failure?.message ?? 'The request did not complete.'} This does NOT mean the line is answering — it means nobody
            could check.
          </p>
          <button type="button" onClick={onRetry} className="mt-1.5 rounded-lg border border-red-v/40 px-2.5 py-1 text-[11px] font-semibold text-red-v hover:bg-[var(--s2)]">Retry</button>
        </div>
      )}

      {state === 'ready' && rows.length === 0 && (
        <p className="flex items-center gap-2 rounded-xl border border-emerald-v/30 bg-[var(--s2)] px-3 py-2 text-[11px] text-t2">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-v" aria-hidden="true" />
          No deployment alert is open. The receptionist raises one here the moment verification lapses or the number stops
          resolving; it is not a live probe of the phone line.
        </p>
      )}

      {state === 'ready' && rows.length > 0 && (
        <div className="space-y-2 rounded-2xl border-2 border-red-v/50 bg-[var(--red-soft)] p-3">
          <p className="flex items-center gap-2 text-sm font-bold text-red-v">
            <ShieldAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
            {rows.length === 1
              ? 'Your AI receptionist needs attention — it may not be answering calls'
              : `${rows.length} deployment alerts — your AI receptionist may not be answering calls`}
          </p>
          {rows.map(task => (
            <ReceptionistTaskCard key={task.id} task={task} timezone={timezone} can={can} onChanged={onChanged} />
          ))}
        </div>
      )}
    </section>
  );
}
