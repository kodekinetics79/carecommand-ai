import { useMemo, useState } from 'react';
import { ArrowRight, Mail, Sparkles, Users2, TrendingDown, Phone, MessageSquare, Globe, Zap } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import ProgressBar from '../components/ui/ProgressBar';
import BentoCard from '../components/ui/BentoCard';
import RiskBadge from '../components/ui/RiskBadge';
import { leads, patients } from '../data/mockPatients';
import { campaigns } from '../data/mockCampaigns';
import { formatNumber } from '../utils/formatters';
import { useApiResource } from '../hooks/useApiResource';
import { mapLead, mapPatient, type ApiLead, type ApiPatient } from '../lib/apiAdapters';

const stages = ['new-inquiry', 'contacted', 'booked', 'visited', 'follow-up', 'retained', 'lost'] as const;
type Stage = typeof stages[number];

const stageConfig: Record<Stage, { label: string; color: string; bg: string }> = {
  'new-inquiry': { label: 'New Inquiry', color: 'text-blue-v', bg: 'bg-[var(--blue-soft)] border-[var(--b1)]' },
  'contacted': { label: 'Contacted', color: 'text-cyan-v', bg: 'bg-[var(--blue-soft)] border-[var(--b1)]' },
  'booked': { label: 'Booked', color: 'text-violet-v', bg: 'bg-[var(--violet-soft)] border-[var(--b1)]' },
  'visited': { label: 'Visited', color: 'text-emerald-v', bg: 'bg-[var(--emerald-soft)] border-[var(--b1)]' },
  'follow-up': { label: 'Follow-up', color: 'text-amber-v', bg: 'bg-[var(--amber-soft)] border-[var(--b1)]' },
  'retained': { label: 'Retained', color: 'text-emerald-v', bg: 'bg-[var(--emerald-soft)] border-[var(--b1)]' },
  'lost': { label: 'Lost', color: 'text-red-v', bg: 'bg-[var(--red-soft)] border-[var(--b1)]' },
};

const channelIcon: Record<string, React.ReactNode> = {
  whatsapp: <MessageSquare className="w-3 h-3" />,
  call: <Phone className="w-3 h-3" />,
  email: <Mail className="w-3 h-3" />,
  sms: <MessageSquare className="w-3 h-3" />,
  website: <Globe className="w-3 h-3" />,
};

const daysSince = (date: string) => Math.floor((new Date('2025-05-26').getTime() - new Date(date).getTime()) / 86400000);

const lifecycleConfig: Record<string, { label: string; badgeClass: string }> = {
  active: { label: 'Active', badgeClass: 'badge badge-emerald' },
  retained: { label: 'Retained', badgeClass: 'badge badge-emerald' },
  'at-risk': { label: 'At Risk', badgeClass: 'badge badge-amber' },
  inactive: { label: 'Inactive', badgeClass: 'badge badge-red' },
  new: { label: 'New', badgeClass: 'badge badge-blue' },
  lost: { label: 'Lost', badgeClass: 'badge badge-blue' },
};

export default function CRM() {
  const [inactiveSegment, setInactiveSegment] = useState('60');
  const [searchQuery, setSearchQuery] = useState('');
  const { data: leadRecords, source: leadSource } = useApiResource<ApiLead, typeof leads[number]>('/v1/leads?limit=100', leads, mapLead);
  const { data: customerRecords } = useApiResource<ApiPatient, typeof patients[number]>('/v1/patients?limit=100', patients, mapPatient);

  const churnRisk = useMemo(() => customerRecords.length > 0 ? Math.round(customerRecords.reduce((s, p) => s + p.churnRisk, 0) / customerRecords.length) : 0, [customerRecords]);
  const avgLTV = useMemo(() => customerRecords.length > 0 ? Math.round(customerRecords.reduce((s, p) => s + p.lifetimeValue, 0) / customerRecords.length) : 0, [customerRecords]);
  const atRiskCount = useMemo(() => customerRecords.filter(p => p.lifecycleStage === 'at-risk' || p.lifecycleStage === 'inactive').length, [customerRecords]);
  const totalPipelineValue = useMemo(() => leadRecords.reduce((s, l) => s + l.estimatedValue, 0), [leadRecords]);

  const stageLeads = useMemo(() => {
    const map: Record<string, typeof leads> = {};
    stages.forEach(s => { map[s] = leadRecords.filter(l => l.stage === s); });
    return map;
  }, [leadRecords]);

  const inactiveCounts = useMemo(() => ({
    '30': customerRecords.filter(p => { const d = daysSince(p.lastVisit); return d > 30 && d <= 60; }).length,
    '60': customerRecords.filter(p => { const d = daysSince(p.lastVisit); return d > 60 && d <= 90; }).length,
    '90': customerRecords.filter(p => { const d = daysSince(p.lastVisit); return d > 90 && d <= 180; }).length,
    '180': customerRecords.filter(p => daysSince(p.lastVisit) > 180).length,
  }), [customerRecords]);

  const filteredPatients = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return customerRecords.filter(p => !q || p.name.toLowerCase().includes(q) || p.tags.some(t => t.includes(q)));
  }, [customerRecords, searchQuery]);

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="GrowthPulse CRM"
        subtitle="Lead pipeline, customer lifecycle, and revenue retention intelligence."
        badge={`${leadRecords.length} Open Leads · ${leadSource === 'live' ? 'Live DB' : 'Demo'}`}
        badgeColor="blue"
        actions={
          <div className="flex gap-2">
            <button type="button" className="inline-flex items-center gap-2 rounded-xl border border-[var(--b2)] bg-[var(--s2)] px-4 py-2 text-sm font-semibold text-t1 hover:bg-[var(--s3)] transition">
              <Mail className="w-4 h-4" /> Export Segment
            </button>
            <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 transition">
              <Sparkles className="w-4 h-4" /> Create Campaign
            </button>
          </div>
        }
      />

      {/* KPI Row */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Open Pipeline" value={`£${formatNumber(totalPipelineValue)}`} subtitle="Estimated lead value" icon={<TrendingDown className="w-4 h-4" />} accent="blue" />
        <StatCard title="At-Risk Customers" value={atRiskCount} subtitle="Need reactivation" icon={<Users2 className="w-4 h-4" />} accent="amber" />
        <StatCard title="Avg Churn Risk" value={`${churnRisk}%`} subtitle="Across customer base" icon={<TrendingDown className="w-4 h-4" />} accent="red" />
        <StatCard title="Avg Lifetime Value" value={`£${formatNumber(avgLTV)}`} subtitle="Per customer" trend={8} icon={<Users2 className="w-4 h-4" />} accent="emerald" />
      </div>

      {/* Pipeline Board */}
      <BentoCard title="Lead Conversion Pipeline" subtitle="Lead-to-booking funnel" headerRight={
        <button type="button" className="text-xs font-semibold text-indigo flex items-center gap-1 hover:opacity-80">View leads <ArrowRight className="w-3 h-3" /></button>
      }>
        <div className="grid gap-2 grid-cols-7">
          {stages.map((stage) => {
            const cfg = stageConfig[stage];
            const count = stageLeads[stage]?.length || 0;
            const val = stageLeads[stage]?.reduce((s, l) => s + l.estimatedValue, 0) || 0;
            return (
              <div key={stage} className={`rounded-xl border p-3 ${cfg.bg}`}>
                <p className={`text-[10px] font-bold uppercase tracking-widest mb-2 ${cfg.color}`}>{cfg.label}</p>
                <p className="text-2xl font-bold text-t1">{count}</p>
                <p className={`text-[11px] font-semibold mt-1 ${cfg.color}`}>£{val.toLocaleString()}</p>
                <ProgressBar value={count} max={leadRecords.length} color={stage === 'lost' ? 'red' : stage === 'retained' ? 'emerald' : 'blue'} className="mt-2" />
              </div>
            );
          })}
        </div>
      </BentoCard>

      {/* Main two-column layout */}
      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">

        {/* Left: Customer table */}
        <div className="space-y-4">
          <BentoCard title="Customer Intelligence" subtitle="Top retention opportunities" headerRight={
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search customers..."
              className="text-xs px-3 py-1.5 border border-[var(--b1)] rounded-xl bg-[var(--s3)] text-t1 placeholder:text-t3 focus:outline-none focus:ring-2 focus:ring-[var(--indigo)] focus:border-transparent w-44"
            />
          }>
            <div className="space-y-2">
              {filteredPatients.slice(0, 10).map((p) => {
                const lc = lifecycleConfig[p.lifecycleStage] || lifecycleConfig.active;
                const lastSeen = daysSince(p.lastVisit);
                return (
                  <div key={p.id} className="flex items-center gap-3 p-3 rounded-xl border border-[var(--b1)] hover:border-[var(--b2)] hover:bg-[var(--s3)] transition-all cursor-pointer group">
                    <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-400 to-violet-500 flex items-center justify-center text-white text-[11px] font-bold shrink-0">
                      {p.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-t1 group-hover:text-indigo transition-colors">{p.name}</p>
                        <span className={lc.badgeClass}>{lc.label}</span>
                        {p.familyAccountId && <span className="badge badge-violet">Family</span>}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 text-[11px] text-t3">
                        <span>Last seen {lastSeen}d ago</span>
                        <span>·</span>
                        <span>LTV £{p.lifetimeValue.toLocaleString()}</span>
                        <span>·</span>
                        <span>{p.visitCount} visits</span>
                        {p.tags.slice(0, 1).map(t => (
                          <span key={t} className="px-1.5 py-0.5 bg-[var(--s3)] rounded text-[10px] text-t3">{t}</span>
                        ))}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <RiskBadge level={p.churnRisk >= 70 ? 'high' : p.churnRisk >= 40 ? 'medium' : 'low'} label={`${p.churnRisk}% risk`} size="sm" />
                      {p.outstandingBalance > 0 && (
                        <p className="text-[10px] text-amber-v font-semibold mt-1">£{p.outstandingBalance} outstanding</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </BentoCard>

          {/* Latest leads */}
          <BentoCard title="Latest Inbound Leads" subtitle="Recent inquiries" headerRight={
            <button type="button" className="text-xs font-semibold text-indigo hover:opacity-80 flex items-center gap-1">All leads <ArrowRight className="w-3 h-3" /></button>
          }>
            <div className="space-y-2">
              {leadRecords.slice(0, 6).map((lead) => {
                const cfg = stageConfig[lead.stage];
                return (
                  <div key={lead.id} className="flex items-center gap-3 p-3 rounded-xl border border-[var(--b1)] hover:border-[var(--b2)] hover:bg-[var(--s3)] transition-all">
                    <div className="w-7 h-7 rounded-xl bg-[var(--s3)] flex items-center justify-center text-t2 shrink-0">
                      {channelIcon[lead.channel] || <Phone className="w-3 h-3" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-t1">{lead.name}</p>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${cfg.bg} ${cfg.color}`}>{cfg.label}</span>
                      </div>
                      <p className="text-[11px] text-t3">{lead.service} · via {lead.source}</p>
                    </div>
                    <span className="text-xs font-bold text-emerald-v shrink-0">£{lead.estimatedValue.toLocaleString()}</span>
                  </div>
                );
              })}
            </div>
          </BentoCard>
        </div>

        {/* Right sidebar */}
        <div className="space-y-4">

          {/* Inactive segments */}
          <BentoCard title="Inactive Customer Segments" subtitle="Reactivation opportunities">
            <div className="flex items-center gap-1 bg-[var(--s3)] p-1 rounded-xl mb-4">
              {['30', '60', '90', '180'].map(d => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setInactiveSegment(d)}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-semibold transition-all ${inactiveSegment === d ? 'bg-[var(--s2)] text-t1' : 'text-t3'}`}
                >
                  {d}d+
                </button>
              ))}
            </div>
            <div className="space-y-2.5">
              {Object.entries(inactiveCounts).map(([range, count]) => {
                const estValue = count * avgLTV * 0.18;
                return (
                  <div key={range} className={`rounded-xl border p-3.5 transition-all ${inactiveSegment === range ? 'border-[var(--b2)] bg-[var(--blue-soft)]' : 'border-[var(--b1)]'}`}>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <p className="text-sm font-bold text-t1">{range}–{parseInt(range) === 180 ? '365' : parseInt(range) + 30}d inactive</p>
                      <span className="badge badge-blue">{count} customers</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <p className="text-xs text-t2">Est. recoverable revenue</p>
                      <p className="text-xs font-bold text-emerald-v">£{Math.round(estValue).toLocaleString()}</p>
                    </div>
                    <button type="button" className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg border border-dashed border-[var(--b2)] text-xs font-semibold text-indigo hover:bg-[var(--s3)] transition-colors">
                      <Zap className="w-3 h-3" /> Launch Reactivation Campaign
                    </button>
                  </div>
                );
              })}
            </div>
          </BentoCard>

          {/* Next-best actions */}
          <BentoCard title="AI-Recommended Retention Plays" subtitle="Next best actions" headerRight={
            <Sparkles className="w-4 h-4 text-violet-v" />
          }>
            <div className="space-y-2.5">
              {[
                { title: 'Send reactivation to 90-day inactive customers', sub: '18% conversion rate via WhatsApp / SMS', impact: '£6,200', urgency: 'high' },
                { title: 'Assign premium dermatology leads to coordinator', sub: 'Dr. Okafor and Dr. Nwosu for high LTV accounts', impact: '£4,800', urgency: 'medium' },
                { title: 'Promote family wellness package to overdue accounts', sub: 'Family accounts deliver 2.4× higher retention', impact: '£3,100', urgency: 'low' },
              ].map((item) => (
                <div key={item.title} className="p-3.5 rounded-xl border border-[var(--b1)] hover:border-[var(--b2)] hover:bg-[var(--s3)] transition-all">
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <p className="text-xs font-bold text-t1 leading-tight">{item.title}</p>
                    <span className="badge badge-emerald shrink-0">{item.impact}</span>
                  </div>
                  <p className="text-[11px] text-t3 mb-2">{item.sub}</p>
                  <button type="button" className="inline-flex items-center gap-1 text-xs font-semibold text-indigo hover:opacity-80">
                    Take action <ArrowRight className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* Campaign performance */}
          <BentoCard title="Recent Campaign ROI" subtitle="Campaign highlights">
            <div className="space-y-3">
              {campaigns.slice(0, 3).map((c) => (
                <div key={c.id} className="p-3 rounded-xl border border-[var(--b1)]">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <p className="text-xs font-bold text-t1 truncate">{c.name}</p>
                    <span className={`${
                      c.status === 'active' ? 'badge badge-emerald' :
                      c.status === 'completed' ? 'badge badge-blue' :
                      'badge badge-amber'
                    }`}>{c.status}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div>
                      <p className="text-sm font-bold text-t1">{c.audienceSize}</p>
                      <p className="text-[10px] text-t3">Audience</p>
                    </div>
                    <div>
                      <p className="text-sm font-bold text-emerald-v">{c.booked}</p>
                      <p className="text-[10px] text-t3">Booked</p>
                    </div>
                    <div>
                      <p className="text-sm font-bold text-t1">£{c.revenue.toLocaleString()}</p>
                      <p className="text-[10px] text-t3">Revenue</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </BentoCard>
        </div>
      </div>
    </div>
  );
}
