import { Mail, MessageSquare, Phone, Megaphone, Ban, ShieldCheck } from 'lucide-react';
import type { ConsentFlags } from '../../lib/crmService';

// Consent-aware badges. Do-not-contact takes precedence and is shown in red.
// "Campaign-ready" (green) means marketing consent is present.
export default function ConsentBadgeGroup({ consent, compact = false }: { consent: ConsentFlags; compact?: boolean }) {
  if (consent.doNotContact) {
    return <span className="badge badge-red"><Ban className="w-3 h-3" aria-hidden="true" /> Do not contact</span>;
  }
  const channels: Array<{ on: boolean; icon: typeof Mail; label: string }> = [
    { on: consent.email, icon: Mail, label: 'Email' },
    { on: consent.sms, icon: MessageSquare, label: 'SMS' },
    { on: consent.whatsapp, icon: MessageSquare, label: 'WhatsApp' },
    { on: consent.voice, icon: Phone, label: 'Voice' },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Communication consent">
      {channels.filter(c => c.on).map(c => (
        <span key={c.label} className="inline-flex items-center gap-0.5 rounded-full bg-[var(--s3)] text-t2 px-1.5 py-0.5 text-[9px] font-semibold" title={`${c.label} allowed`}>
          <c.icon className="w-2.5 h-2.5" aria-hidden="true" />{!compact && c.label}
        </span>
      ))}
      {consent.campaignReady
        ? <span className="badge badge-emerald"><ShieldCheck className="w-3 h-3" aria-hidden="true" /> Campaign-ready</span>
        : <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-soft text-amber-v px-1.5 py-0.5 text-[9px] font-semibold" title="No marketing consent"><Megaphone className="w-2.5 h-2.5" aria-hidden="true" /> Transactional only</span>}
    </div>
  );
}
