import { useEffect, useState } from 'react';
import { Workflow, Play, Loader2, Plus, Trash2 } from 'lucide-react';
import EmptyStatePremium from '../ui/EmptyStatePremium';
import { crmService, type AutomationRule, type RuleTemplate } from '../../lib/crmService';

export default function AutomationRulesPanel({ onNavigate }: { onNavigate: (route: string) => void }) {
  const [rules, setRules] = useState<AutomationRule[] | null>(null);
  const [catalog, setCatalog] = useState<RuleTemplate[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; note: string; route: string | null } | null>(null);
  const [adding, setAdding] = useState(false);

  async function load() {
    const [r, c] = await Promise.all([crmService.getAutomationRules(), crmService.getAutomationCatalog().catch(() => [])]);
    setRules(r); setCatalog(c);
  }
  useEffect(() => { let a = true; void (async () => { try { const [r, c] = await Promise.all([crmService.getAutomationRules(), crmService.getAutomationCatalog().catch(() => [])]); if (a) { setRules(r); setCatalog(c); } } catch { if (a) setRules([]); } })(); return () => { a = false; }; }, []);

  async function toggle(rule: AutomationRule) { setBusy(rule.id); try { await crmService.toggleAutomationRule(rule.id, !rule.enabled); await load(); } finally { setBusy(null); } }
  async function run(rule: AutomationRule) { setBusy(rule.id); setResult(null); try { const res = await crmService.runAutomationRule(rule.id); setResult({ id: rule.id, note: res.note, route: res.route }); await load(); } catch (e) { setResult({ id: rule.id, note: e instanceof Error ? e.message : 'Run failed', route: null }); } finally { setBusy(null); } }
  async function remove(rule: AutomationRule) { setBusy(rule.id); try { await crmService.deleteAutomationRule(rule.id); await load(); } finally { setBusy(null); } }
  async function add(key: string) { setBusy(key); try { await crmService.createAutomationRule(key); setAdding(false); await load(); } finally { setBusy(null); } }

  if (rules === null) return <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton-line h-16 rounded-xl" />)}</div>;

  const usedKeys = new Set(rules.map(r => r.templateKey));
  const available = catalog.filter(t => !usedKeys.has(t.key));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-t3">Trigger → action rules. Toggle to enable; run on demand to evaluate against live data.</p>
        {available.length > 0 && <button type="button" onClick={() => setAdding(v => !v)} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"><Plus className="w-3.5 h-3.5" /> Add rule</button>}
      </div>

      {adding && (
        <div className="rounded-xl border border-[var(--b1)] bg-[var(--s2)] p-3 space-y-2">
          <p className="text-[10px] font-bold uppercase tracking-wide text-t3">Add from catalog</p>
          {available.map(t => (
            <button key={t.key} type="button" disabled={busy === t.key} onClick={() => add(t.key)} className="w-full flex items-center justify-between gap-3 rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3 py-2 text-left hover:border-[var(--b2)] disabled:opacity-50">
              <span className="text-[12px] text-t2">{t.description}</span>
              {busy === t.key ? <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo" /> : <Plus className="w-3.5 h-3.5 text-indigo" />}
            </button>
          ))}
        </div>
      )}

      {rules.length === 0 ? (
        <EmptyStatePremium icon={<Workflow className="w-5 h-5" />} title="No automation rules yet" description="Add a rule from the catalog to start automating callbacks, reactivation, and slot-fill." cta={available.length ? { label: 'Add a rule', onClick: () => setAdding(true) } : undefined} />
      ) : rules.map(r => (
        <div key={r.id} className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3">
          <div className="flex items-center gap-3">
            <Workflow className={`w-4 h-4 shrink-0 ${r.enabled ? 'text-violet-v' : 'text-t3'}`} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-t1 leading-tight">{r.name}</p>
              <p className="text-[10px] text-t3 mt-0.5">{r.matchesNow ?? 0} record(s) match now{r.runCount > 0 ? ` · run ${r.runCount}× · last ${r.lastRunAt ? new Date(r.lastRunAt).toLocaleString() : '—'}` : ''}</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button type="button" disabled={busy === r.id || !r.enabled} onClick={() => run(r)} title="Run now" aria-label={`Run rule ${r.name}`} className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-t2 hover:bg-[var(--s2)] disabled:opacity-40">
                {busy === r.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} Run
              </button>
              <button type="button" role="switch" aria-checked={r.enabled ? 'true' : 'false'} aria-label={`${r.enabled ? 'Disable' : 'Enable'} ${r.name}`} onClick={() => toggle(r)} disabled={busy === r.id}
                className={`relative w-9 h-5 rounded-full shrink-0 transition-colors ${r.enabled ? 'bg-[var(--indigo)]' : 'bg-[var(--b2)]'}`}>
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${r.enabled ? 'left-[18px]' : 'left-0.5'}`} />
              </button>
              <button type="button" onClick={() => remove(r)} disabled={busy === r.id} aria-label={`Delete ${r.name}`} className="text-t3 hover:text-red-v"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          </div>
          {result?.id === r.id && (
            <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-emerald-soft border border-[rgba(5,150,105,0.2)] px-3 py-1.5 text-[11px] text-emerald-v">
              <span>{result.note}</span>
              {result.route && <button type="button" onClick={() => onNavigate(result.route!)} className="font-semibold underline shrink-0">Open module</button>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
