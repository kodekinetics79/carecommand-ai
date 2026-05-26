import { ShieldCheck, AlertCircle, FileText, CheckCircle2, Clock, Sparkles, ArrowRight, Lock, Eye } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';

const auditLogs = [
  { id: 'log1', event: 'Marketing consent granted', user: 'System (WhatsApp opt-in)', date: '26 May 2026, 09:12', type: 'consent' },
  { id: 'log2', event: 'Customer record accessed', user: 'Dr. Sarah Mitchell', date: '26 May 2026, 10:00', type: 'access' },
  { id: 'log3', event: 'Data sharing request approved', user: 'Compliance Team', date: '25 May 2026, 16:30', type: 'approval' },
  { id: 'log4', event: 'Review campaign template updated', user: 'Marketing Admin', date: '24 May 2026, 14:20', type: 'change' },
  { id: 'log5', event: 'Opt-out processed for Tom Nakamura', user: 'System (SMS reply)', date: '23 May 2026, 11:05', type: 'optout' },
  { id: 'log6', event: 'GDPR data export requested', user: 'Grace Adeyemi (customer)', date: '22 May 2026, 09:40', type: 'export' },
];

const logTypeConfig: Record<string, { color: string; bg: string }> = {
  consent:  { color: 'text-emerald-700', bg: 'bg-emerald-100' },
  access:   { color: 'text-blue-700',    bg: 'bg-blue-100' },
  approval: { color: 'text-violet-700',  bg: 'bg-violet-100' },
  change:   { color: 'text-amber-700',   bg: 'bg-amber-100' },
  optout:   { color: 'text-red-700',     bg: 'bg-red-100' },
  export:   { color: 'text-slate-700',   bg: 'bg-slate-100' },
};

const consentChannels = [
  { channel: 'WhatsApp', opted: 68, total: 80, pct: 85 },
  { channel: 'SMS',      opted: 55, total: 80, pct: 69 },
  { channel: 'Email',    opted: 72, total: 80, pct: 90 },
  { channel: 'Marketing',opted: 62, total: 80, pct: 78 },
];

const guardrails = [
  { rule: 'No clinical diagnosis or medical advice generated', status: 'active' },
  { rule: 'Clinical questions routed to provider, not answered automatically', status: 'active' },
  { rule: 'Marketing messages sent only to opted-in customers', status: 'active' },
  { rule: 'Role-based access: front desk cannot view financial records', status: 'active' },
  { rule: 'All AI-generated content reviewed before sending', status: 'active' },
  { rule: 'Data retained per GDPR 6-year retention policy', status: 'active' },
];

export default function Compliance() {
  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Privacy & Communication Controls"
        subtitle="Consent management, audit trails, AI guardrails, and data governance for private clinic compliance."
        badge="All Systems Active"
        badgeColor="blue"
        actions={
          <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 transition shadow-sm">
            <FileText className="w-4 h-4" /> Download Audit Report
          </button>
        }
      />

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Marketing Consent" value="87%" subtitle="Opted in to campaigns" icon={<ShieldCheck className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Audit Events" value={auditLogs.length} subtitle="Last 7 days" icon={<Eye className="w-4 h-4" />} accent="blue" />
        <StatCard title="AI Guardrails" value={guardrails.length} subtitle="Active policies" icon={<Lock className="w-4 h-4" />} accent="violet" />
        <StatCard title="Opt-outs (30d)" value={3} subtitle="Processed automatically" icon={<AlertCircle className="w-4 h-4" />} accent="amber" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          {/* Consent breakdown */}
          <BentoCard title="Communication Consent" subtitle="Opt-in rates by channel">
            <div className="space-y-4">
              {consentChannels.map((ch) => (
                <div key={ch.channel}>
                  <div className="flex items-center justify-between gap-3 mb-1.5">
                    <p className="text-xs font-semibold text-slate-800">{ch.channel}</p>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-slate-400">{ch.opted} / {ch.total} customers</span>
                      <span className={`text-xs font-bold ${ch.pct >= 80 ? 'text-emerald-700' : ch.pct >= 60 ? 'text-amber-600' : 'text-red-600'}`}>{ch.pct}%</span>
                    </div>
                  </div>
                  <ProgressBar value={ch.pct} color={ch.pct >= 80 ? 'emerald' : ch.pct >= 60 ? 'amber' : 'red'} />
                </div>
              ))}
            </div>
            <div className="mt-4 p-3 rounded-xl bg-blue-50 border border-blue-100">
              <p className="text-[11px] text-blue-700 font-semibold">AI will only send marketing messages to consented customers. Opt-outs are processed immediately and cannot be overridden.</p>
            </div>
          </BentoCard>

          {/* Audit log */}
          <BentoCard title="Audit Log" subtitle="Recent compliance events · All branches">
            <div className="space-y-2.5">
              {auditLogs.map((log) => {
                const lc = logTypeConfig[log.type];
                return (
                  <div key={log.id} className="flex items-start gap-3 p-3 rounded-xl border border-slate-100 hover:bg-slate-50 transition-colors">
                    <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${
                      log.type === 'consent' ? 'bg-emerald-500' :
                      log.type === 'optout' ? 'bg-red-500' :
                      log.type === 'access' ? 'bg-blue-500' : 'bg-slate-400'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-slate-900">{log.event}</p>
                      <p className="text-[10px] text-slate-400 mt-0.5">{log.date} · {log.user}</p>
                    </div>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${lc.bg} ${lc.color}`}>{log.type}</span>
                  </div>
                );
              })}
            </div>
          </BentoCard>
        </div>

        <div className="space-y-4">
          {/* AI Guardrails */}
          <BentoCard title="AI Guardrails" subtitle="Active compliance policies" headerRight={<Sparkles className="w-4 h-4 text-violet-500" />}>
            <div className="space-y-2.5">
              {guardrails.map((g) => (
                <div key={g.rule} className="flex items-start gap-2.5 p-3 rounded-xl border border-emerald-100 bg-emerald-50/40">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-slate-700 font-medium leading-snug">{g.rule}</p>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* Data preferences */}
          <BentoCard title="Customer Preferences" subtitle="Communication controls">
            <div className="space-y-2.5">
              {[
                { label: 'Appointment reminders', desc: 'Auto-sent via preferred channel', enabled: true },
                { label: 'Promotional campaigns', desc: 'Only for opted-in customers', enabled: true },
                { label: 'Post-visit review requests', desc: '24h after appointment', enabled: true },
                { label: 'Winback & reactivation', desc: 'Marketing consent required', enabled: true },
              ].map((item) => (
                <div key={item.label} className="flex items-start justify-between gap-3 p-3 rounded-xl border border-slate-100 hover:bg-slate-50 transition-colors">
                  <div>
                    <p className="text-xs font-semibold text-slate-900">{item.label}</p>
                    <p className="text-[10px] text-slate-400 mt-0.5">{item.desc}</p>
                  </div>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 shrink-0">On</span>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* GDPR compliance */}
          <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-900 to-slate-800 p-4 text-white">
            <div className="flex items-center gap-2 mb-2">
              <Lock className="w-4 h-4 text-slate-400" />
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Data Governance</p>
            </div>
            <p className="text-sm font-bold text-white mb-1">GDPR Compliant</p>
            <p className="text-[11px] text-slate-400 mb-3">6-year retention policy · Right to erasure enforced · Data export available on request.</p>
            <button type="button" className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-400 hover:text-blue-300 transition-colors">
              View data policy <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Response SLA */}
          <div className="rounded-2xl border border-amber-200/60 bg-amber-50 p-4">
            <div className="flex items-start gap-3">
              <Clock className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-bold text-amber-700">Data Request SLA</p>
                <p className="text-[11px] text-amber-600 mt-0.5">1 pending GDPR data export request (Grace Adeyemi). Must be fulfilled within 30 days. 22 days remaining.</p>
                <button type="button" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-amber-700 bg-amber-100 px-3 py-1.5 rounded-lg hover:bg-amber-200 transition-colors">
                  <ArrowRight className="w-3 h-3" /> Process request
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
