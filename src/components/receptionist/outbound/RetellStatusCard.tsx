import { Check, AlertCircle, CircleCheck, CircleAlert } from 'lucide-react';
import type { RetellStatus } from '../../../lib/receptionist';

export function RetellStatusCard({ status }: { status: RetellStatus | null }) {
  if (!status) return null;
  const ok = status.configured;
  return (
    <div className={`cc-card p-4 border-l-4 ${ok ? 'border-l-emerald-v' : 'border-l-amber-v'}`}>
      <div className="flex items-start gap-3">
        {ok ? <CircleCheck className="w-5 h-5 text-emerald-v shrink-0" /> : <CircleAlert className="w-5 h-5 text-amber-v shrink-0" />}
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-t1">Tenant Retell prerequisites {ok ? 'detected' : 'need setup'}</h3>
            {status.mock && <span className="badge badge-violet">mock mode</span>}
          </div>
          <p className="text-xs text-t3 mt-0.5">
            {ok
              ? 'Server credentials and at least one tenant agent deployment passed the status check. Each selected campaign still requires its own current authority, consent, target, quiet-hours, capacity, and stop checks at launch.'
              : 'Set the missing environment variables on the server to enable live outbound calls. Secrets are never sent to the browser.'}
          </p>
          <div className="flex flex-wrap gap-2 mt-3">
            {status.checklist.map(item => (
              <span key={item.key} className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-semibold ${item.set ? 'border-[var(--b1)] text-t2' : 'border-amber-v/40 text-amber-v'}`}>
                {item.set ? <Check className="w-3 h-3 text-emerald-v" /> : <AlertCircle className="w-3 h-3" />}
                {item.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
