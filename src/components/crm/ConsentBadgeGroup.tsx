import { Mail, MessageSquare, Phone, ShieldAlert, ShieldX } from 'lucide-react';
import type { ConsentEvidenceStatus, ConsentFlags } from '../../lib/crmService';

// Evidence badges show only canonical persisted state. They do not imply that a
// record is campaign-ready; dispatch re-checks consent and suppression.
export default function ConsentBadgeGroup({ consent, compact = false }: { consent: ConsentFlags; compact?: boolean }) {
  const channels: Array<{ status: ConsentEvidenceStatus; icon: typeof Mail; label: string }> = [
    { status: consent.email, icon: Mail, label: 'Email' },
    { status: consent.sms, icon: MessageSquare, label: 'SMS' },
    { status: consent.whatsapp, icon: MessageSquare, label: 'WhatsApp' },
    { status: consent.voice, icon: Phone, label: 'Voice' },
  ];
  if (!consent.evidenceAvailable) {
    return <span className="badge badge-amber" title="No canonical channel consent is available in this view"><ShieldAlert className="w-3 h-3" aria-hidden="true" /> Consent evidence unavailable</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Stored communication-consent evidence">
      {channels.filter(c => c.status !== 'unknown').map(c => (
        <span key={c.label} className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${c.status === 'opted_in' ? 'bg-[var(--blue-soft)] text-blue-v' : 'bg-red-soft text-red-v'}`} title={c.status === 'opted_in' ? `${c.label}: a prior affirmative preference is stored; this is not purpose-specific live outreach authority` : `${c.label}: stored opt-out evidence`}>
          <c.icon className="w-2.5 h-2.5" aria-hidden="true" />{!compact && c.label}
          {c.status === 'opted_in' ? <ShieldAlert className="w-2.5 h-2.5" aria-hidden="true" /> : <ShieldX className="w-2.5 h-2.5" aria-hidden="true" />}
        </span>
      ))}
      <span className="inline-flex items-center gap-0.5 rounded-full bg-[var(--s3)] text-t3 px-1.5 py-0.5 text-[9px] font-semibold" title="Consent and suppression are verified again when dispatch is requested">
        <ShieldAlert className="w-2.5 h-2.5" aria-hidden="true" /> {compact ? 'Re-check at dispatch' : 'Dispatch verification required'}
      </span>
    </div>
  );
}
