import type { OutboundControlStatus, OutboundStopResult } from '../../../lib/receptionist';
import { ConfirmedButton } from '../shared';

export function OutboundStopCard({ control, result, canStop, stopping, error, onStop, onRetry }: {
  control: OutboundControlStatus | null;
  result: OutboundStopResult | null;
  canStop: boolean;
  stopping: boolean;
  error: string | null;
  onStop: (reason: string) => Promise<void>;
  onRetry: () => Promise<void>;
}) {
  if (!control) return (
    <div role="alert" className="cc-card border-l-4 border-l-red-v p-4">
      <p className="text-sm font-bold text-red-v">Outbound safety status is unavailable</p>
      <p className="text-xs text-t3 mt-1">Launch controls remain disabled until tenant emergency-stop status is verified.</p>
      <button type="button" onClick={() => void onRetry()} className="mt-2 rounded-lg border border-[var(--b1)] px-3 py-1.5 text-xs font-semibold text-t2">Retry status</button>
    </div>
  );
  return (
    <div role={control.stopped ? 'alert' : 'status'} className={`cc-card border-l-4 p-4 ${control.stopped ? 'border-l-red-v' : 'border-l-emerald-v'}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className={`text-sm font-bold ${control.stopped ? 'text-red-v' : 'text-t1'}`}>{control.stopped ? 'Tenant outbound is stopped' : 'Tenant outbound stop is not active'}</p>
          <p className="text-xs text-t3 mt-1">
            {control.stopped
              ? 'No new outbound calls may launch. Only the independent platform safety control can clear this tenant-wide stop.'
              : canStop ? 'Owners and administrators can fail safe immediately. This status does not prove any campaign is otherwise ready.' : 'Only an owner or administrator can activate the emergency stop.'}
          </p>
          {control.stopped && control.reason && <p className="text-xs text-t2 mt-2"><span className="font-semibold">Recorded reason:</span> {control.reason}</p>}
          {control.stopped && control.changedAt && <p className="text-[11px] text-t3 mt-1">Stop state last changed {new Date(control.changedAt).toLocaleString()}.</p>}
        </div>
        {!control.stopped && canStop && (
          <ConfirmedButton
            dialogTitle="Stop all outbound AI calls?"
            message="Activate the tenant-wide emergency stop now. Active provider calls will be canceled where possible; uncertain provider outcomes remain blocked for reconciliation."
            confirmLabel="Activate emergency stop"
            tone="red"
            requireReason
            reasonLabel="Emergency stop reason"
            disabled={stopping}
            onConfirm={onStop}
            className="rounded-lg bg-red-v px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
          >{stopping ? 'Stopping…' : 'Emergency stop'}</ConfirmedButton>
        )}
      </div>
      {result && (
        <div className="mt-3 rounded-lg border border-[var(--b1)] p-3 text-xs text-t2">
          Cancellation requested for {result.activeCancellation.requested}; confirmed {result.activeCancellation.confirmed}; failed {result.activeCancellation.failed}; unconfirmed {result.activeCancellation.unconfirmed}; unbound intents quarantined {result.activeCancellation.unboundIntentsQuarantined}; reconciliation required {result.activeCancellation.reconciliationRequired}.
          <span className="block mt-1 text-t3">Review tasks {result.activeCancellation.reviewRecorded}/{result.activeCancellation.reconciliationRequired}; signals {result.activeCancellation.signalRecorded}/{result.activeCancellation.reconciliationRequired}; stop audit {result.activeCancellation.auditRecorded ? 'recorded' : 'degraded'}.</span>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-xs font-semibold text-red-v">{error} Treat outbound as stopped or unknown until status is verified.</p>}
    </div>
  );
}
