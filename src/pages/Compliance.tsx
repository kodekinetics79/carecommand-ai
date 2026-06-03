import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, AlertCircle, FileText, CheckCircle2, Clock, Sparkles, ArrowRight, Lock, Eye, Trash2, Plus, Circle } from 'lucide-react';
import PageHeader from '../components/ui/PageHeader';
import StatCard from '../components/ui/StatCard';
import BentoCard from '../components/ui/BentoCard';
import ProgressBar from '../components/ui/ProgressBar';
import { useApiResource } from '../hooks/useApiResource';
import { useCrudResource } from '../hooks/useCrudResource';
import { apiRequest } from '../lib/api';
import { mapAuditEvent, type ApiAuditEvent, type AuditLogEntry, type ApiConsentSummary } from '../lib/apiAdapters';
import { auditLogs as seedAuditLogs } from '../data/seedData';

interface ApiGuardrail { id: string; rule: string; active: boolean; sortOrder: number }
interface ApiPreference { id: string; label: string; description: string; enabled: boolean; sortOrder: number }

const fallbackAuditLogs: AuditLogEntry[] = [...seedAuditLogs];

const logTypeConfig: Record<string, { color: string; bg: string }> = {
  consent:  { color: 'text-emerald-v', bg: 'badge badge-emerald' },
  access:   { color: 'text-blue-v',    bg: 'badge badge-blue' },
  approval: { color: 'text-violet-v',  bg: 'badge badge-violet' },
  change:   { color: 'text-amber-v',   bg: 'badge badge-amber' },
  optout:   { color: 'text-red-v',     bg: 'badge badge-red' },
  export:   { color: 'text-t2',        bg: 'badge badge-blue' },
};

const purposeLabels: Record<string, string> = { WHATSAPP: 'WhatsApp', SMS: 'SMS', EMAIL: 'Email', MARKETING: 'Marketing' };

const fallbackConsentChannels = [
  { channel: 'WhatsApp', opted: 68, total: 80, pct: 85 },
  { channel: 'SMS',      opted: 55, total: 80, pct: 69 },
  { channel: 'Email',    opted: 72, total: 80, pct: 90 },
  { channel: 'Marketing',opted: 62, total: 80, pct: 78 },
];

const fallbackGuardrails: ApiGuardrail[] = [
  { id: 'g1', rule: 'No clinical diagnosis or medical advice generated', active: true, sortOrder: 0 },
  { id: 'g2', rule: 'Clinical questions routed to provider, not answered automatically', active: true, sortOrder: 1 },
  { id: 'g3', rule: 'Marketing messages sent only to opted-in customers', active: true, sortOrder: 2 },
  { id: 'g4', rule: 'Role-based access: front desk cannot view financial records', active: true, sortOrder: 3 },
  { id: 'g5', rule: 'All AI-generated content reviewed before sending', active: true, sortOrder: 4 },
  { id: 'g6', rule: 'Data retained per GDPR 6-year retention policy', active: true, sortOrder: 5 },
];

const fallbackPreferences: ApiPreference[] = [
  { id: 'p1', label: 'Appointment reminders', description: 'Auto-sent via preferred channel', enabled: true, sortOrder: 0 },
  { id: 'p2', label: 'Promotional campaigns', description: 'Only for opted-in customers', enabled: true, sortOrder: 1 },
  { id: 'p3', label: 'Post-visit review requests', description: '24h after appointment', enabled: true, sortOrder: 2 },
  { id: 'p4', label: 'Winback & reactivation', description: 'Marketing consent required', enabled: true, sortOrder: 3 },
];

export default function Compliance() {
  const navigate = useNavigate();
  const { data: auditLogs } = useApiResource<ApiAuditEvent, AuditLogEntry>(
    '/v1/compliance/audit-log?limit=20',
    fallbackAuditLogs,
    mapAuditEvent,
  );
  const [consentChannels, setConsentChannels] = useState(fallbackConsentChannels);

  useEffect(() => {
    let active = true;
    apiRequest<ApiConsentSummary>('/v1/compliance/consent-summary')
      .then(summary => {
        if (!active || summary.channels.length === 0) return;
        setConsentChannels(summary.channels.map(ch => ({
          channel: purposeLabels[ch.purpose] ?? ch.purpose,
          opted: ch.opted,
          total: ch.total,
          pct: ch.pct,
        })));
      })
      .catch(() => { /* keep demo fallback */ });
    return () => { active = false; };
  }, []);

  const marketingPct = consentChannels.find(ch => ch.channel === 'Marketing')?.pct ?? 0;

  const guardrails = useCrudResource<ApiGuardrail>('/v1/settings/guardrails', fallbackGuardrails);
  const preferences = useCrudResource<ApiPreference>('/v1/settings/preferences', fallbackPreferences);
  const [newGuardrail, setNewGuardrail] = useState('');
  const [showGuardrailForm, setShowGuardrailForm] = useState(false);
  const activeGuardrails = guardrails.data.filter(g => g.active).length;

  async function addGuardrail() {
    if (!newGuardrail.trim()) return;
    await guardrails.create({ rule: newGuardrail.trim(), active: true, sortOrder: guardrails.data.length });
    setNewGuardrail('');
    setShowGuardrailForm(false);
  }

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Privacy & Communication Controls"
        subtitle="Consent management, audit trails, AI guardrails, and data governance for private clinic compliance."
        badge="All Systems Active"
        badgeColor="blue"
        actions={
          <button type="button" onClick={() => navigate('/settings')} className="inline-flex items-center gap-2 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--indigo-mid)] transition shadow-sm">
            <FileText className="w-4 h-4" /> Download Audit Report
          </button>
        }
      />

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCard title="Marketing Consent" value={`${marketingPct}%`} subtitle="Opted in to campaigns" icon={<ShieldCheck className="w-4 h-4" />} accent="emerald" />
        <StatCard title="Audit Events" value={auditLogs.length} subtitle="Last 7 days" icon={<Eye className="w-4 h-4" />} accent="blue" />
        <StatCard title="AI Guardrails" value={activeGuardrails} subtitle="Active policies" icon={<Lock className="w-4 h-4" />} accent="violet" />
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
                    <p className="text-xs font-semibold text-t1">{ch.channel}</p>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-t3">{ch.opted} / {ch.total} customers</span>
                      <span className={`text-xs font-bold ${ch.pct >= 80 ? 'text-emerald-v' : ch.pct >= 60 ? 'text-amber-v' : 'text-red-v'}`}>{ch.pct}%</span>
                    </div>
                  </div>
                  <ProgressBar value={ch.pct} color={ch.pct >= 80 ? 'emerald' : ch.pct >= 60 ? 'amber' : 'red'} />
                </div>
              ))}
            </div>
            <div className="mt-4 p-3 rounded-xl bg-[var(--blue-soft)] border border-[var(--b1)]">
              <p className="text-[11px] text-blue-v font-semibold">AI will only send marketing messages to consented customers. Opt-outs are processed immediately and cannot be overridden.</p>
            </div>
          </BentoCard>

          {/* Audit log */}
          <BentoCard title="Audit Log" subtitle="Recent compliance events · All branches">
            <div className="space-y-2.5">
              {auditLogs.map((log) => {
                const lc = logTypeConfig[log.type];
                return (
                  <div key={log.id} className="flex items-start gap-3 p-3 rounded-xl border border-[var(--b1)] hover:bg-[var(--s3)] transition-colors">
                    <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${
                      log.type === 'consent' ? 'bg-emerald-500' :
                      log.type === 'optout' ? 'bg-red-500' :
                      log.type === 'access' ? 'bg-blue-500' : 'bg-slate-400'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-t1">{log.event}</p>
                      <p className="text-[10px] text-t3 mt-0.5">{log.date} · {log.user}</p>
                    </div>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${lc.bg}`}>{log.type}</span>
                  </div>
                );
              })}
            </div>
          </BentoCard>
        </div>

        <div className="space-y-4">
          {/* AI Guardrails */}
          <BentoCard title="AI Guardrails" subtitle="Active compliance policies" headerRight={<Sparkles className="w-4 h-4 text-violet-500" />}>
            {guardrails.error && <p className="text-[11px] text-red-v mb-2">{guardrails.error}</p>}
            <div className="space-y-2.5">
              {guardrails.data.map((g) => (
                <div key={g.id} className={`flex items-start gap-2.5 p-3 rounded-xl border border-[var(--b1)] group ${g.active ? 'bg-[var(--emerald-soft)]' : 'bg-[var(--s2)]'}`}>
                  <button type="button" disabled={guardrails.busy} onClick={() => guardrails.update(g.id, { active: !g.active })} className="shrink-0 mt-0.5 disabled:opacity-40" aria-label={g.active ? 'Deactivate guardrail' : 'Activate guardrail'}>
                    {g.active ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-v" /> : <Circle className="w-3.5 h-3.5 text-t3" />}
                  </button>
                  <p className={`flex-1 text-[11px] font-medium leading-snug ${g.active ? 'text-t2' : 'text-t3 line-through'}`}>{g.rule}</p>
                  <button type="button" disabled={guardrails.busy} onClick={() => guardrails.remove(g.id)} className="text-t3 hover:text-red-v transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-40 shrink-0" aria-label="Delete guardrail">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
            {showGuardrailForm ? (
              <div className="mt-3 p-3 rounded-xl border border-[var(--b2)] bg-[var(--s2)] space-y-2">
                <input value={newGuardrail} onChange={e => setNewGuardrail(e.target.value)} placeholder="New guardrail policy" className="w-full px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s1)] text-xs text-t1 outline-none focus:border-[var(--b3)]" />
                <div className="flex gap-2">
                  <button type="button" disabled={guardrails.busy} onClick={addGuardrail} className="flex-1 py-2 rounded-lg bg-[var(--indigo)] text-white text-xs font-semibold hover:bg-[var(--indigo-mid)] transition disabled:opacity-40">Add</button>
                  <button type="button" onClick={() => setShowGuardrailForm(false)} className="px-3 py-2 rounded-lg border border-[var(--b1)] text-t2 text-xs font-semibold hover:bg-[var(--s3)] transition">Cancel</button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setShowGuardrailForm(true)} className="mt-3 w-full py-2 border border-dashed border-[var(--b2)] rounded-xl text-xs font-semibold text-t3 hover:border-[var(--b3)] hover:text-indigo hover:bg-[var(--s3)] transition-all inline-flex items-center justify-center gap-1">
                <Plus className="w-3.5 h-3.5" /> Add guardrail
              </button>
            )}
          </BentoCard>

          {/* Data preferences */}
          <BentoCard title="Customer Preferences" subtitle="Communication controls">
            {preferences.error && <p className="text-[11px] text-red-v mb-2">{preferences.error}</p>}
            <div className="space-y-2.5">
              {preferences.data.map((item) => (
                <div key={item.id} className="flex items-start justify-between gap-3 p-3 rounded-xl border border-[var(--b1)] hover:bg-[var(--s3)] transition-colors group">
                  <div>
                    <p className="text-xs font-semibold text-t1">{item.label}</p>
                    <p className="text-[10px] text-t3 mt-0.5">{item.description}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button type="button" disabled={preferences.busy} onClick={() => preferences.update(item.id, { enabled: !item.enabled })} className={`text-[10px] font-bold px-2 py-0.5 rounded-full transition disabled:opacity-40 ${item.enabled ? 'badge badge-emerald' : 'badge badge-blue'}`}>
                      {item.enabled ? 'On' : 'Off'}
                    </button>
                    <button type="button" disabled={preferences.busy} onClick={() => preferences.remove(item.id)} className="text-t3 hover:text-red-v transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-40" aria-label="Delete preference">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </BentoCard>

          {/* GDPR compliance */}
          <div className="rounded-2xl border border-[var(--b2)] bg-[var(--s2)] p-4">
            <div className="flex items-center gap-2 mb-2">
              <Lock className="w-4 h-4 text-t3" />
              <p className="text-[10px] font-bold uppercase tracking-widest text-t3">Data Governance</p>
            </div>
            <p className="text-sm font-bold text-t1 mb-1">GDPR Compliant</p>
            <p className="text-[11px] text-t3 mb-3">6-year retention policy · Right to erasure enforced · Data export available on request.</p>
            <button type="button" onClick={() => navigate('/settings')} className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-v hover:text-cyan-v transition-colors">
              View data policy <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Response SLA */}
          <div className="rounded-2xl border border-[var(--b1)] bg-[var(--amber-soft)] p-4">
            <div className="flex items-start gap-3">
              <Clock className="w-4 h-4 text-amber-v shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-bold text-amber-v">Data Request SLA</p>
                <p className="text-[11px] text-amber-v mt-0.5">1 pending GDPR data export request (Grace Adeyemi). Must be fulfilled within 30 days. 22 days remaining.</p>
                <button type="button" onClick={() => navigate('/settings')} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-amber-v bg-[var(--amber-soft)] px-3 py-1.5 rounded-lg hover:bg-[var(--s3)] transition-colors">
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
