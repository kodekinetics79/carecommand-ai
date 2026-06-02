import { Cloud, CreditCard, Globe2, Mail, MessageCircle, MessagesSquare, Monitor, Phone, CheckCircle2, AlertCircle, Plus, Zap, ArrowRight, RefreshCw } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import { integrations } from '../data/mockIntegrations';
import { useApiResource } from '../hooks/useApiResource';
import { mapIntegration, type ApiIntegration } from '../lib/apiAdapters';

const iconMap: Record<string, React.ElementType> = {
  MessagesSquare,
  MessageCircle,
  Mail,
  Globe2,
  CreditCard,
  Phone,
  Monitor,
  BookOpen: Cloud,
};

const statusConfig = {
  connected:     { label: 'Connected',    color: 'text-emerald-v', bg: 'badge badge-emerald', dot: 'bg-emerald-500' },
  disconnected:  { label: 'Disconnected', color: 'text-t2',        bg: 'badge badge-blue',    dot: 'bg-slate-400' },
  error:         { label: 'Error',        color: 'text-red-v',     bg: 'badge badge-red',     dot: 'bg-red-500' },
  'coming-soon': { label: 'Coming Soon',  color: 'text-amber-v',   bg: 'badge badge-amber',   dot: 'bg-amber-400' },
};

const categoryColors: Record<string, string> = {
  Messaging:   'badge badge-blue',
  Marketing:   'badge badge-violet',
  Reputation:  'badge badge-amber',
  Payments:    'badge badge-emerald',
  Accounting:  'badge badge-blue',
  Telephony:   'badge badge-cyan',
  Booking:     'badge badge-indigo',
};

const suggestedIntegrations = [
  { name: 'Calendly', category: 'Booking', desc: 'Self-booking for consultations and virtual visits.' },
  { name: 'Xero', category: 'Accounting', desc: 'Financial sync for UK clinics — alternative to QuickBooks.' },
  { name: 'Trustpilot', category: 'Reputation', desc: 'Review collection and brand reputation management.' },
];

export default function Integrations() {
  const { data: integrationRecords, source } = useApiResource<ApiIntegration, typeof integrations[number]>('/v1/integrations', integrations, mapIntegration);
  const connectedCount = integrationRecords.filter(integration => integration.status === 'connected').length;
  const disconnectedCount = integrationRecords.filter(integration => integration.status === 'disconnected').length;

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Integrations Hub"
        subtitle="Connect messaging, payment, analytics, and practice infrastructure to automate your entire operation."
        badge={`${connectedCount} Connected · ${source === 'live' ? 'Live DB' : 'Demo'}`}
        badgeColor="blue"
        actions={
          <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--indigo-mid)] transition">
            <Plus className="w-4 h-4" /> Add Integration
          </button>
        }
      />

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Connected" value={connectedCount} subtitle="Live integrations" icon={<CheckCircle2 className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Disconnected" value={disconnectedCount} subtitle="Needs attention" icon={<AlertCircle className="w-4 h-4" />} accent="red" />
        <StatCard title="Data Syncs" value="1,240" subtitle="Last 24 hours" icon={<RefreshCw className="w-4 h-4" />} accent="blue" />
        <StatCard title="Automation Events" value="347" subtitle="Triggered this week" icon={<Zap className="w-4 h-4" />} accent="violet" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        {/* Integration cards */}
        <BentoCard title="Connected Services" subtitle="All integrations · Live status">
          <div className="grid gap-3 sm:grid-cols-2">
            {integrationRecords.map((integration) => {
              const Icon = iconMap[integration.icon as string] || Cloud;
              const sc = statusConfig[integration.status as keyof typeof statusConfig];
              const catColor = categoryColors[integration.category] || 'badge badge-blue';
              return (
                <div key={integration.id} className={`p-4 rounded-2xl border transition-all hover:bg-[var(--s3)] ${
                  integration.status === 'disconnected' ? 'border-[var(--b1)] bg-[var(--s2)]' :
                  integration.status === 'error' ? 'border-[var(--b2)] bg-[var(--red-soft)]' :
                  integration.status === 'coming-soon' ? 'border-[var(--b2)] bg-[var(--amber-soft)]' :
                  'border-[var(--b1)] hover:border-[var(--b2)]'
                }`}>
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex items-center gap-3">
                      <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                        integration.status === 'connected' ? 'bg-[var(--blue-soft)] text-blue-v' : 'bg-[var(--s3)] text-t3'
                      }`}>
                        <Icon className="w-4 h-4" />
                      </div>
                      <div>
                        <p className="text-xs font-bold text-t1">{integration.name}</p>
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${catColor}`}>{integration.category}</span>
                      </div>
                    </div>
                    <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${sc.bg}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${sc.dot}`} />
                      {sc.label}
                    </span>
                  </div>
                  <p className="text-[11px] text-t3 mb-2.5 leading-relaxed">{integration.description}</p>
                  <div className="flex items-center justify-between gap-2">
                    {integration.lastSync
                      ? <span className="text-[10px] text-t3">Last sync: {integration.lastSync}</span>
                      : <span className="text-[10px] text-t3">Not synced</span>
                    }
                    {integration.status === 'disconnected'
                      ? <button type="button" className="text-[10px] font-semibold text-indigo bg-[var(--indigo-soft)] px-2 py-1 rounded-lg hover:bg-[var(--s3)] transition-colors">Connect</button>
                      : <button type="button" className="text-[10px] font-semibold text-t2 hover:text-t1 transition-colors flex items-center gap-0.5"><RefreshCw className="w-3 h-3" /> Sync</button>
                    }
                  </div>
                </div>
              );
            })}
          </div>
        </BentoCard>

        <div className="space-y-4">
          {/* Disconnected alert */}
          {disconnectedCount > 0 && (
            <div className="rounded-2xl border border-[var(--b1)] bg-[var(--amber-soft)] p-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-4 h-4 text-amber-v shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-bold text-amber-v">Integration Attention Needed</p>
                  <p className="text-[11px] text-amber-v mt-0.5">QuickBooks is disconnected. Financial data is not syncing. Reconnect to restore accounting reconciliation.</p>
                  <button type="button" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-amber-v bg-[var(--s3)] px-3 py-1.5 rounded-lg hover:bg-[var(--s2)] transition-colors">
                    <Zap className="w-3 h-3" /> Reconnect now
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Suggested integrations */}
          <BentoCard title="Suggested Integrations" subtitle="Expand your automation stack">
            <div className="space-y-2.5">
              {suggestedIntegrations.map((s) => (
                <div key={s.name} className="p-3.5 rounded-xl border border-dashed border-[var(--b2)] hover:border-[var(--b3)] hover:bg-[var(--s3)] transition-all">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <p className="text-xs font-bold text-t1">{s.name}</p>
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${categoryColors[s.category] || 'badge badge-blue'}`}>{s.category}</span>
                  </div>
                  <p className="text-[11px] text-t3 mb-2">{s.desc}</p>
                  <button type="button" className="inline-flex items-center gap-1 text-[10px] font-semibold text-indigo hover:text-blue-v">
                    <Plus className="w-3 h-3" /> Add integration
                  </button>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* Automation stats */}
          <BentoCard title="Automation Performance" subtitle="This month">
            <div className="space-y-2.5">
              {[
                { label: 'WhatsApp messages sent', value: '4,820', color: 'text-blue-v' },
                { label: 'Appointment reminders triggered', value: '1,204', color: 'text-emerald-v' },
                { label: 'Missed-call recoveries', value: '89', color: 'text-violet-v' },
                { label: 'Payments processed', value: '£48,200', color: 'text-amber-v' },
              ].map((stat) => (
                <div key={stat.label} className="flex items-center justify-between gap-3 p-2.5 rounded-xl border border-[var(--b1)] hover:bg-[var(--s3)] transition-colors">
                  <p className="text-[11px] font-medium text-t2">{stat.label}</p>
                  <p className={`text-xs font-bold ${stat.color}`}>{stat.value}</p>
                </div>
              ))}
            </div>
            <button type="button" className="mt-3 w-full flex items-center justify-center gap-1 text-xs font-semibold text-indigo py-2 border border-dashed border-[var(--b2)] rounded-xl hover:bg-[var(--s3)] transition-colors">
              View full automation log <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </BentoCard>
        </div>
      </div>
    </div>
  );
}
