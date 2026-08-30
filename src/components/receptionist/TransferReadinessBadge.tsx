import { PhoneForwarded, PhoneOff } from 'lucide-react';
import { TRANSFER_REASON_COPY, transferReadinessOf, type ClinicReadiness } from '../../lib/receptionistClinic';

/**
 * Whether a caller who asks for a person can actually be transferred. Shown
 * beside the fallback number so the reason a transfer is disabled is next to
 * the field that fixes it, not buried in a campaign 409.
 */
export function TransferReadinessBadge({ readiness, fallbackNumber }: { readiness?: ClinicReadiness; fallbackNumber: string | null | undefined }) {
  const { ready, reason } = transferReadinessOf(readiness, fallbackNumber);
  if (ready) {
    return (
      <span className="badge badge-emerald inline-flex items-center gap-1" data-testid="transfer-readiness" data-ready="true">
        <PhoneForwarded className="h-3 w-3" aria-hidden="true" /> Transfer ready
      </span>
    );
  }
  return (
    <span className="badge badge-amber inline-flex items-center gap-1" data-testid="transfer-readiness" data-ready="false">
      <PhoneOff className="h-3 w-3" aria-hidden="true" /> {reason ? TRANSFER_REASON_COPY[reason] : 'Transfer not available'}
    </span>
  );
}
