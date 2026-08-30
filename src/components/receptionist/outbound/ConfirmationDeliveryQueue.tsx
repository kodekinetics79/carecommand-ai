import { ShieldCheck } from 'lucide-react';
import type { ConfirmationDelivery } from '../../../lib/receptionist';

const confirmationPresentation: Record<string, { badge: string; label: string; guidance: string; title: string }> = {
  queued: { badge: 'badge badge-blue', label: 'Queued', guidance: 'Waiting for the delivery worker.', title: 'No provider submission has been attempted yet.' },
  retrying: { badge: 'badge badge-amber', label: 'Retrying', guidance: 'A known non-submission is scheduled for another attempt.', title: 'The prior attempt is known not to have been submitted to the provider.' },
  failed: { badge: 'badge badge-red', label: 'Failed', guidance: 'Check configuration before the next scheduled attempt.', title: 'The provider did not accept this attempt; retry policy may continue.' },
  dead_lettered: { badge: 'badge badge-red', label: 'Needs action', guidance: 'Resolve the failure and contact the patient manually only after checking consent and duplicate risk.', title: 'Automatic attempts stopped without provider acceptance.' },
  delivery_unknown: { badge: 'badge badge-red', label: 'Reconcile', guidance: 'Review provider logs before any manual resend; delivery may already have occurred.', title: 'Provider acceptance is ambiguous. Automatic resend is disabled to prevent duplicates.' },
  suppressed: { badge: 'badge badge-blue', label: 'Suppressed', guidance: 'No message was sent because consent, do-not-contact, or appointment state blocked it.', title: 'Suppressed before provider submission.' },
  accepted: { badge: 'badge badge-emerald', label: 'Provider accepted', guidance: 'Delivery is not yet proven.', title: 'The provider accepted the message. This does not prove recipient delivery.' },
  delivered: { badge: 'badge badge-emerald', label: 'Delivered', guidance: 'Provider delivery evidence was recorded.', title: 'Delivery evidence was received and recorded.' },
};

export function ConfirmationDeliveryQueue({ deliveries, loadFailed, onRetry }: { deliveries: ConfirmationDelivery[]; loadFailed: boolean; onRetry: () => Promise<void> }) {
  return (
    <div className="cc-card p-5">
      <h3 className="text-sm font-bold text-t1 mb-1 flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-indigo" /> Appointment confirmation delivery ({deliveries.length})</h3>
      <p className="text-xs text-t3 mb-3">Provider acceptance and confirmed delivery are shown separately. Red items require staff review and are never silently retried when acceptance is uncertain.</p>
      {loadFailed ? (
        <div role="alert" className="rounded-lg border border-red-v/40 bg-[var(--red-soft)] p-3 flex items-center justify-between gap-3">
          <p className="text-xs text-red-v">Delivery evidence is unavailable. Do not assume confirmations were sent or delivered.</p>
          <button type="button" onClick={() => void onRetry()} className="rounded-lg border border-[var(--b1)] px-2.5 py-1 text-xs font-semibold text-t2">Retry</button>
        </div>
      ) : deliveries.length === 0 ? <p className="text-xs text-t3">No confirmation delivery events yet.</p> : (
        <div className="space-y-2">
          {deliveries.map(delivery => {
            const presentation = confirmationPresentation[delivery.status] ?? confirmationPresentation.failed;
            return (
              <div key={delivery.id} className="rounded-lg border border-[var(--b1)] px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={presentation.badge} title={presentation.title}>{presentation.label}</span>
                      <span className="text-sm font-semibold text-t1 truncate">{delivery.patientName || 'Patient'} · {delivery.channel.toUpperCase()}</span>
                    </div>
                    <p className="mt-1 text-[11px] text-t3">{presentation.guidance}</p>
                  </div>
                  <span className="text-[11px] text-t3 shrink-0">Attempt {delivery.attempts}/{delivery.maxAttempts}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-t3">
                  {delivery.appointmentService && <span>{delivery.appointmentService}</span>}
                  {delivery.appointmentStartsAt && <span>{new Date(delivery.appointmentStartsAt).toLocaleString()}</span>}
                  {delivery.failureReason && <span className="text-red-v">Code: {delivery.failureReason}</span>}
                  {delivery.acceptedAt && !delivery.deliveredAt && <span>Accepted {new Date(delivery.acceptedAt).toLocaleString()}</span>}
                  {delivery.deliveredAt && <span>Delivered {new Date(delivery.deliveredAt).toLocaleString()}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
