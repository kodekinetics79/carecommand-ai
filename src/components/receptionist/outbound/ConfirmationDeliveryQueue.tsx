import { ShieldCheck } from 'lucide-react';
import type { ConfirmationDelivery } from '../../../lib/receptionist';

const confirmationPresentation: Record<string, { badge: string; label: string; guidance: string; title: string }> = {
  queued: { badge: 'badge badge-blue', label: 'Waiting', guidance: 'Scheduled for delivery.', title: 'This message is waiting to be sent.' },
  retrying: { badge: 'badge badge-amber', label: 'Trying again', guidance: 'The previous attempt did not leave CareCommand. The system will try again safely.', title: 'Another safe attempt is scheduled.' },
  failed: { badge: 'badge badge-red', label: 'Needs setup', guidance: 'The message could not be sent. Ask your CareCommand administrator to check messaging setup.', title: 'Messaging setup needs attention.' },
  dead_lettered: { badge: 'badge badge-red', label: 'Needs attention', guidance: 'Automatic attempts stopped. Check the patient record before contacting them manually.', title: 'Staff review is required.' },
  delivery_unknown: { badge: 'badge badge-red', label: 'Check before resending', guidance: 'It may already have been sent. Check delivery history before trying again to avoid a duplicate.', title: 'The delivery result is uncertain.' },
  suppressed: { badge: 'badge badge-blue', label: 'Not sent', guidance: 'Consent, contact preferences, or the appointment status prevented this message.', title: 'The message was safely excluded.' },
  accepted: { badge: 'badge badge-emerald', label: 'Submitted', guidance: 'Sent to the messaging service; delivery is not confirmed yet.', title: 'The message was submitted for delivery.' },
  delivered: { badge: 'badge badge-emerald', label: 'Delivered', guidance: 'Delivery was confirmed.', title: 'The message reached its destination.' },
};

export function ConfirmationDeliveryQueue({ deliveries, loadFailed, onRetry }: { deliveries: ConfirmationDelivery[]; loadFailed: boolean; onRetry: () => Promise<void> }) {
  return (
    <div className="cc-card p-5">
      <h3 className="text-sm font-bold text-t1 mb-1 flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-indigo" /> Appointment messages ({deliveries.length})</h3>
      <p className="text-xs text-t3 mb-3">See which reminders are waiting, sent, delivered, or need attention. Uncertain messages are not resent automatically.</p>
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
                  {delivery.acceptedAt && !delivery.deliveredAt && <span>Submitted {new Date(delivery.acceptedAt).toLocaleString()}</span>}
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
