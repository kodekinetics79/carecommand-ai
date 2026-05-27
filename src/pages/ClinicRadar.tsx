import { useMemo, useState } from 'react';
import { AlertCircle, BarChart3, Radar, ShieldCheck, Sparkles, TrendingUp, Zap, ArrowRight, Eye } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import RiskBadge from '../components/ui/RiskBadge';
import ProgressBar from '../components/ui/ProgressBar';
import BentoCard from '../components/ui/BentoCard';
import { radarAlerts } from '../data/mockRadar';
import { branches } from '../data/mockClinics';
import { formatCurrency } from '../utils/formatters';
import type { AlertCategory, AlertSeverity } from '../types';

const categories: { id: AlertCategory | 'all'; label: string }[] = [
  { id: 'all', label: 'All Signals' },
  { id: 'revenue', label: 'Revenue' },
  { id: 'retention', label: 'Retention' },
  { id: 'operations', label: 'Operations' },
  { id: 'reputation', label: 'Reputation' },
  { id: 'staff', label: 'Staff' },
  { id: 'inventory', label: 'Inventory' },
];

const severityOrder: Record<AlertSeverity, number> = { high: 0, medium: 1, low: 2 };

const categoryColor: Record<AlertCategory, { bg: string; text: string; dot: string }> = {
  revenue:    { bg: 'bg-[var(--emerald-soft)]', text: 'text-emerald-v', dot: 'bg-emerald-500' },
  retention:  { bg: 'bg-[var(--blue-soft)]',    text: 'text-blue-v',    dot: 'bg-blue-500' },
  operations: { bg: 'bg-[var(--violet-soft)]',  text: 'text-violet-v',  dot: 'bg-violet-500' },
  reputation: { bg: 'bg-[var(--amber-soft)]',   text: 'text-amber-v',   dot: 'bg-amber-500' },
  staff:      { bg: 'bg-[var(--blue-soft)]',    text: 'text-cyan-v',    dot: 'bg-cyan-500' },
  inventory:  { bg: 'bg-[var(--amber-soft)]',   text: 'text-amber-v',   dot: 'bg-orange-500' },
};

const severityConfig: Record<AlertSeverity, { border: string; glow: string }> = {
  high:   { border: 'border-l-red-500',   glow: 'shadow-red-500/5' },
  medium: { border: 'border-l-amber-500', glow: 'shadow-amber-500/5' },
  low:    { border: 'border-l-[var(--b2)]', glow: '' },
};

const totalOpportunity = radarAlerts.reduce((s, a) => s + (a.estimatedValue || 0), 0);
const highCount = radarAlerts.filter(a => a.severity === 'high').length;
const medCount = radarAlerts.filter(a => a.severity === 'medium').length;

export default function ClinicRadar() {
  const [activeCategory, setActiveCategory] = useState<AlertCategory | 'all'>('all');
  const [activeTab, setActiveTab] = useState<'opportunity' | 'risk'>('opportunity');

  const filtered = useMemo(() => {
    let list = activeCategory === 'all' ? radarAlerts : radarAlerts.filter(a => a.category === activeCategory);
    if (activeTab === 'risk') list = list.filter(a => a.severity === 'high' || a.severity === 'medium');
    return [...list].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  }, [activeCategory, activeTab]);

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="ClinicRadar AI"
        subtitle="Real-time intelligence board for revenue signals, retention risks, and branch health."
        badge={`${radarAlerts.length} Active Signals`}
        badgeColor="red"
        actions={
          <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-[var(--s3)] px-4 py-2 text-sm font-semibold text-t1 hover:bg-[var(--s3)] border border-[var(--b1)] transition">
            <Radar className="w-4 h-4" /> Refresh Insights
          </button>
        }
      />

      {/* Summary KPI strip */}
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <div className="bg-[var(--s2)] rounded-2xl border border-[var(--b1)] p-4">
          <p className="text-[10px] font-bold uppercase tracking-widest text-t3 mb-2">Total Opportunity</p>
          <p className="text-2xl font-bold text-t1 tabular-nums">{formatCurrency(totalOpportunity)}</p>
          <p className="text-xs text-t3 mt-0.5">Across all active signals</p>
        </div>
        <div className="bg-[var(--red-soft)] rounded-2xl border border-[var(--b1)] p-4">
          <p className="text-[10px] font-bold uppercase tracking-widest text-red-v mb-2">High Priority</p>
          <p className="text-2xl font-bold text-red-v tabular-nums">{highCount}</p>
          <p className="text-xs text-red-v/70 mt-0.5">Signals needing action now</p>
        </div>
        <div className="bg-[var(--amber-soft)] rounded-2xl border border-[var(--b1)] p-4">
          <p className="text-[10px] font-bold uppercase tracking-widest text-amber-v mb-2">Medium Priority</p>
          <p className="text-2xl font-bold text-amber-v tabular-nums">{medCount}</p>
          <p className="text-xs text-amber-v/70 mt-0.5">Monitor and schedule</p>
        </div>
        <div className="bg-[var(--violet-soft)] rounded-2xl border border-[var(--b1)] p-4">
          <p className="text-[10px] font-bold uppercase tracking-widest text-violet-v mb-2">AI Confidence</p>
          <p className="text-2xl font-bold text-violet-v tabular-nums">84%</p>
          <p className="text-xs text-violet-v/70 mt-0.5">Average signal confidence</p>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        {/* Main alert board */}
        <div className="space-y-4">

          {/* Filters */}
          <div className="cc-card p-4">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-2 flex-wrap">
                {categories.map(cat => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setActiveCategory(cat.id)}
                    className={`px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                      activeCategory === cat.id
                        ? 'bg-[var(--indigo)] text-white'
                        : 'bg-[var(--s3)] text-t2 hover:bg-[var(--s3)] hover:text-t1'
                    }`}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1 bg-[var(--s3)] p-1 rounded-xl shrink-0">
                <button
                  type="button"
                  onClick={() => setActiveTab('opportunity')}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${activeTab === 'opportunity' ? 'bg-[var(--s2)] text-t1' : 'text-t3'}`}
                >
                  Opportunities
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('risk')}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${activeTab === 'risk' ? 'bg-[var(--s2)] text-t1' : 'text-t3'}`}
                >
                  Risks
                </button>
              </div>
            </div>

            <div className="space-y-3">
              {filtered.map((alert) => {
                const cat = categoryColor[alert.category];
                const sev = severityConfig[alert.severity];
                const confidence = alert.severity === 'high' ? 88 : alert.severity === 'medium' ? 72 : 55;
                return (
                  <div key={alert.id} className={`rounded-2xl border border-[var(--b1)] border-l-2 p-4 hover:bg-[var(--s3)] transition-all ${sev.border} ${sev.glow}`}>
                    <div className="flex items-start gap-3">
                      <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${cat.bg}`}>
                        <span className={`w-2.5 h-2.5 rounded-full ${cat.dot}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-3 mb-1">
                          <p className="text-sm font-bold text-t1 leading-tight">{alert.title}</p>
                          <div className="flex items-center gap-2 shrink-0">
                            {alert.estimatedValue && (
                              <span className="badge badge-emerald">
                                {formatCurrency(alert.estimatedValue)}
                              </span>
                            )}
                            <RiskBadge level={alert.severity} size="sm" />
                          </div>
                        </div>

                        <div className="flex items-center gap-2 mb-2">
                          <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full ${cat.bg} ${cat.text}`}>
                            {alert.category}
                          </span>
                          {alert.branchId && (
                            <span className="text-[10px] text-t3">·</span>
                          )}
                        </div>

                        <p className="text-xs text-t3 leading-relaxed mb-3">{alert.description}</p>

                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-2 flex-1">
                            <span className="text-[10px] font-medium text-t3 uppercase tracking-wide whitespace-nowrap">AI confidence</span>
                            <div className="flex gap-0.5 flex-1 max-w-[80px]">
                              {[...Array(5)].map((_, i) => (
                                <div key={i} className={`flex-1 h-1 rounded-full ${i < Math.round(confidence / 20) ? 'bg-blue-500' : 'bg-[var(--b2)]'}`} />
                              ))}
                            </div>
                            <span className="text-[10px] font-semibold text-t3">{confidence}%</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <button type="button" className="inline-flex items-center gap-1.5 text-xs font-semibold text-t3 hover:text-t2 transition-colors">
                              <Eye className="w-3 h-3" /> Details
                            </button>
                            <button type="button" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--indigo)] text-white text-xs font-semibold hover:opacity-90 transition-colors">
                              <Zap className="w-3 h-3" /> Run Action
                            </button>
                          </div>
                        </div>

                        <div className="mt-3 p-2.5 rounded-xl bg-[var(--s3)] border border-[var(--b1)]">
                          <p className="text-[11px] font-semibold text-t2">
                            <span className="text-t3 mr-1">Recommended:</span>
                            {alert.action}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right sidebar */}
        <div className="space-y-4">
          {/* Branch heatmap */}
          <BentoCard title="Branch Health Heatmap" subtitle="Comparative performance" headerRight={<BarChart3 className="w-4 h-4 text-t3" />}>
            <div className="space-y-3">
              {branches.map((branch) => (
                <div key={branch.id}>
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <p className="text-xs font-semibold text-t2 truncate">{branch.name}</p>
                    <span className={`badge ${
                      branch.healthScore >= 75 ? 'badge-emerald' :
                      branch.healthScore >= 55 ? 'badge-amber' :
                      'badge-red'
                    }`}>{branch.healthScore}/100</span>
                  </div>
                  <ProgressBar value={branch.healthScore} />
                  <div className="flex items-center gap-3 mt-1.5 text-[11px] text-t3">
                    <span>{branch.utilization}% util</span>
                    <span>·</span>
                    <span className={branch.missedCalls > 10 ? 'text-red-v font-semibold' : ''}>{branch.missedCalls} missed calls</span>
                    <span>·</span>
                    <span>{branch.openSlots} open slots</span>
                  </div>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* Signal timeline */}
          <BentoCard title="Signal Timeline" subtitle="Recent detections">
            <div className="space-y-3">
              {radarAlerts.slice(0, 6).map((alert, i) => (
                <div key={alert.id} className="flex items-start gap-3">
                  <div className="flex flex-col items-center gap-1">
                    <div className={`w-2 h-2 rounded-full mt-1 shrink-0 ${
                      alert.severity === 'high' ? 'bg-red-500' :
                      alert.severity === 'medium' ? 'bg-amber-500' : 'bg-[var(--b2)]'
                    }`} />
                    {i < 5 && <div className="w-px h-6 bg-[var(--b1)]" />}
                  </div>
                  <div className="flex-1 min-w-0 pb-1">
                    <p className="text-xs font-semibold text-t1 leading-tight">{alert.title.split(':')[0]}</p>
                    <p className="text-[10px] text-t3 mt-0.5">
                      {new Date(alert.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} ·{' '}
                      {new Date(alert.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* AI Guardrails */}
          <BentoCard title="AI Safe Operations" subtitle="Guardrails active">
            <div className="space-y-2.5">
              {[
                { text: 'No clinical diagnosis in AI outreach', ok: true },
                { text: 'Consent verified before any marketing', ok: true },
                { text: 'Audit trail for all sensitive access', ok: true },
                { text: 'Opt-out compliance enforced', ok: true },
              ].map((g, i) => (
                <div key={i} className="flex items-center gap-2.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                  <p className="text-xs text-t2">{g.text}</p>
                </div>
              ))}
            </div>
            <div className="mt-3 p-3 rounded-xl bg-[var(--emerald-soft)] border border-[var(--b1)]">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-3.5 h-3.5 text-emerald-v shrink-0" />
                <p className="text-xs font-semibold text-emerald-v">All guardrails operational · No violations detected</p>
              </div>
            </div>
          </BentoCard>

          {/* Quick actions */}
          <BentoCard title="Quick Actions" subtitle="Common commands">
            <div className="space-y-2">
              {[
                { label: 'Launch winback campaign', icon: <Sparkles className="w-3.5 h-3.5" /> },
                { label: 'Fill empty Westside slots', icon: <AlertCircle className="w-3.5 h-3.5" /> },
                { label: 'Assign missed-call queue', icon: <TrendingUp className="w-3.5 h-3.5" /> },
              ].map((a) => (
                <button key={a.label} type="button" className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-[var(--b1)] hover:border-[var(--b2)] hover:bg-[var(--s3)] transition-all text-left group">
                  <div className="text-t3 group-hover:text-indigo transition-colors">{a.icon}</div>
                  <span className="text-xs font-semibold text-t2 group-hover:text-t1 transition-colors flex-1">{a.label}</span>
                  <ArrowRight className="w-3.5 h-3.5 text-t3 group-hover:text-indigo transition-all" />
                </button>
              ))}
            </div>
          </BentoCard>
        </div>
      </div>
    </div>
  );
}
