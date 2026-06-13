import { useEffect, useState } from 'react';
import { Loader2, ExternalLink } from 'lucide-react';
import BentoCard from '../ui/BentoCard';
import { paymentsApi, type PaymentRequestRow } from '../../lib/payments';

const STATUS_BADGE: Record<string, string> = {
  collected: 'badge-emerald', link_sent: 'badge-violet', pending: 'badge-amber',
  failed: 'badge-red', expired: 'badge-red',
};

// Deposit payment-request queue. Read-only summary; truthful statuses only.
export default function PaymentRequestsPanel() {
  const [rows, setRows] = useState<PaymentRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const data = await paymentsApi.listPaymentRequests();
        if (active) setRows(data);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : 'Failed to load payment requests');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  return (
    <BentoCard title="Deposit Payment Requests" subtitle="Generated checkout links and their status">
      {loading ? (
        <div className="py-6 text-center text-xs text-t3"><Loader2 className="inline w-4 h-4 animate-spin" /></div>
      ) : error ? (
        <p className="py-4 text-xs text-red-v">{error}</p>
      ) : rows.length === 0 ? (
        <p className="py-4 text-center text-xs text-t3">No deposit payment requests yet. Generate one from an appointment.</p>
      ) : (
        <div className="space-y-2">
          {rows.slice(0, 12).map(r => (
            <div key={r.paymentRequestId} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--b1)] px-2.5 py-2">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-t1 truncate">{r.patientName ?? 'Patient'} · {r.currency} {r.amount.toFixed(2)}</p>
                <p className="text-[10px] text-t3 truncate">{r.service ?? 'Appointment deposit'}{r.mode ? ` · ${r.mode}` : ''}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {r.followUpNeeded && <span className="text-[10px] font-semibold text-red-v">Follow up</span>}
                <span className={`badge ${STATUS_BADGE[r.status] ?? 'badge-blue'}`}>{r.status.replace('_', ' ')}</span>
                {r.paymentUrl && (
                  <a href={r.paymentUrl} target="_blank" rel="noreferrer" className="text-t3 hover:text-indigo" aria-label="Open payment link"><ExternalLink className="w-3.5 h-3.5" /></a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </BentoCard>
  );
}
