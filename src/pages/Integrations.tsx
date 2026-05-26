import { Cloud, CreditCard, Globe2, Mail, MessageCircle, MessagesSquare, Monitor, Phone, CheckCircle2, AlertCircle, Plus, Zap, ArrowRight, RefreshCw } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import { integrations } from '../data/mockIntegrations';

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
  connected:     { label: 'Connected',    color: 'text-emerald-700', bg: 'bg-emerald-100', dot: 'bg-emerald-500' },
  disconnected:  { label: 'Disconnected', color: 'text-slate-600',   bg: 'bg-slate-100',   dot: 'bg-slate-400' },
  error:         { label: 'Error',        color: 'text-red-700',     bg: 'bg-red-100',     dot: 'bg-red-500' },
  'coming-soon': { label: 'Coming Soon',  color: 'text-amber-700',   bg: 'bg-amber-100',   dot: 'bg-amber-400' },
};

const categoryColors: Record<string, string> = {
  Messaging:   'bg-blue-100 text-blue-700',
  Marketing:   'bg-violet-100 text-violet-700',
  Reputation:  'bg-amber-100 text-amber-700',
  Payments:    'bg-emerald-100 text-emerald-700',
  Accounting:  'bg-slate-100 text-slate-600',
  Telephony:   'bg-cyan-100 text-cyan-700',
  Booking:     'bg-indigo-100 text-indigo-700',
};

const connectedCount = integrations.filter(i => i.status === 'connected').length;
const disconnectedCount = integrations.filter(i => i.status === 'disconnected').length;

const suggestedIntegrations = [
  { name: 'Calendly', category: 'Booking', desc: 'Self-booking for consultations and virtual visits.' },
  { name: 'Xero', category: 'Accounting', desc: 'Financial sync for UK clinics — alternative to QuickBooks.' },
  { name: 'Trustpilot', category: 'Reputation', desc: 'Review collection and brand reputation management.' },
];

export default function Integrations() {
  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Integrations Hub"
        subtitle="Connect messaging, payment, analytics, and practice infrastructure to automate your entire operation."
        badge={`${connectedCount} Connected`}
        badgeColor="blue"
        actions={
          <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition shadow-md shadow-blue-500/20">
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
            {integrations.map((integration) => {
              const Icon = iconMap[integration.icon as string] || Cloud;
              const sc = statusConfig[integration.status as keyof typeof statusConfig];
              const catColor = categoryColors[integration.category] || 'bg-slate-100 text-slate-600';
              return (
                <div key={integration.id} className={`p-4 rounded-2xl border transition-all hover:shadow-sm ${
                  integration.status === 'disconnected' ? 'border-slate-200 bg-slate-50/50' :
                  integration.status === 'error' ? 'border-red-200 bg-red-50/30' :
                  integration.status === 'coming-soon' ? 'border-amber-200 bg-amber-50/30' :
                  'border-slate-200 hover:border-blue-200'
                }`}>
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className="flex items-center gap-3">
                      <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                        integration.status === 'connected' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'
                      }`}>
                        <Icon className="w-4 h-4" />
                      </div>
                      <div>
                        <p className="text-xs font-bold text-slate-900">{integration.name}</p>
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${catColor}`}>{integration.category}</span>
                      </div>
                    </div>
                    <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${sc.bg} ${sc.color}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${sc.dot}`} />
                      {sc.label}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 mb-2.5 leading-relaxed">{integration.description}</p>
                  <div className="flex items-center justify-between gap-2">
                    {integration.lastSync
                      ? <span className="text-[10px] text-slate-400">Last sync: {integration.lastSync}</span>
                      : <span className="text-[10px] text-slate-400">Not synced</span>
                    }
                    {integration.status === 'disconnected'
                      ? <button type="button" className="text-[10px] font-semibold text-blue-600 bg-blue-50 px-2 py-1 rounded-lg hover:bg-blue-100 transition-colors">Connect</button>
                      : <button type="button" className="text-[10px] font-semibold text-slate-500 hover:text-slate-700 transition-colors flex items-center gap-0.5"><RefreshCw className="w-3 h-3" /> Sync</button>
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
            <div className="rounded-2xl border border-amber-200/60 bg-amber-50 p-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <div>
                  <p className="text-xs font-bold text-amber-700">Integration Attention Needed</p>
                  <p className="text-[11px] text-amber-600 mt-0.5">QuickBooks is disconnected. Financial data is not syncing. Reconnect to restore accounting reconciliation.</p>
                  <button type="button" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-amber-700 bg-amber-100 px-3 py-1.5 rounded-lg hover:bg-amber-200 transition-colors">
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
                <div key={s.name} className="p-3.5 rounded-xl border border-dashed border-slate-200 hover:border-blue-300 hover:bg-blue-50/30 transition-all">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <p className="text-xs font-bold text-slate-900">{s.name}</p>
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${categoryColors[s.category] || 'bg-slate-100 text-slate-600'}`}>{s.category}</span>
                  </div>
                  <p className="text-[11px] text-slate-500 mb-2">{s.desc}</p>
                  <button type="button" className="inline-flex items-center gap-1 text-[10px] font-semibold text-blue-600 hover:text-blue-700">
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
                { label: 'WhatsApp messages sent', value: '4,820', color: 'text-blue-700' },
                { label: 'Appointment reminders triggered', value: '1,204', color: 'text-emerald-700' },
                { label: 'Missed-call recoveries', value: '89', color: 'text-violet-700' },
                { label: 'Payments processed', value: '£48,200', color: 'text-amber-700' },
              ].map((stat) => (
                <div key={stat.label} className="flex items-center justify-between gap-3 p-2.5 rounded-xl border border-slate-100 hover:bg-slate-50 transition-colors">
                  <p className="text-[11px] font-medium text-slate-600">{stat.label}</p>
                  <p className={`text-xs font-bold ${stat.color}`}>{stat.value}</p>
                </div>
              ))}
            </div>
            <button type="button" className="mt-3 w-full flex items-center justify-center gap-1 text-xs font-semibold text-blue-600 py-2 border border-dashed border-blue-200 rounded-xl hover:bg-blue-50 transition-colors">
              View full automation log <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </BentoCard>
        </div>
      </div>
    </div>
  );
}
