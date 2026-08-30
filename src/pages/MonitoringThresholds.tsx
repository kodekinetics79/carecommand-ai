import { useCallback, useState } from 'react';
import { RefreshCw, Plus, Loader2, Trash2, SlidersHorizontal, AlertTriangle } from 'lucide-react';
import BentoCard from '../components/ui/BentoCard';
import PageHeader from '../components/ui/PageHeader';
import ResourceSection from '../components/ui/ResourceSection';
import { useResource } from '../hooks/useResource';
import { apiRequest } from '../lib/api';

/**
 * Where a clinic sets the numbers its own alerts fire on.
 *
 * Until this screen existed there was no write path to MonitoringRule anywhere
 * in the product — no route, no UI, no seeder — so every tenant ran on the
 * built-in default bands with no way to change them. A clinic managing a
 * patient whose protocol makes the default wrong had no recourse in either
 * direction: the product cried wolf, or it stayed silent.
 *
 * The reading cadence matters even more than the bands. `missedAfterHours`
 * lives only on this model, and the missed-reading detector skips any patient
 * whose cadence is unset — so with no rules in existence it checked nothing and
 * the "Missed Readings" figure was structurally zero in every tenant, forever.
 * The worker was running the whole time. It had nothing to evaluate.
 */

interface Rule {
  id: string;
  scope: 'organization' | 'branch' | 'patient' | 'device_type';
  branchId: string | null;
  patientId: string | null;
  deviceType: string | null;
  readingType: string;
  minValue: number | null;
  maxValue: number | null;
  criticalMin: number | null;
  criticalMax: number | null;
  missedAfterHours: number | null;
  priority: number;
  active: boolean;
}
interface Band { min: number; max: number; critMin: number; critMax: number; unit: string; label: string }
interface RulesPage {
  rules: Rule[];
  defaults: Record<string, Band>;
  readingTypes: string[];
}

const SCOPE_LABEL: Record<string, string> = {
  organization: 'Whole clinic',
  branch: 'One branch',
  patient: 'One patient',
  device_type: 'A device type',
};

const emptyDraft = {
  readingType: 'glucose',
  minValue: '', maxValue: '', criticalMin: '', criticalMax: '',
  missedAfterHours: '',
};

const num = (v: string) => (v.trim() === '' ? null : Number(v));

export default function MonitoringThresholds() {
  const { state, reload } = useResource<RulesPage>('/v1/monitoring/rules');
  const [draft, setDraft] = useState(emptyDraft);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    setBusy('new');
    setError(null);
    try {
      await apiRequest('/v1/monitoring/rules', {
        method: 'POST',
        body: JSON.stringify({
          scope: 'organization',
          readingType: draft.readingType,
          minValue: num(draft.minValue),
          maxValue: num(draft.maxValue),
          criticalMin: num(draft.criticalMin),
          criticalMax: num(draft.criticalMax),
          missedAfterHours: num(draft.missedAfterHours),
        }),
      });
      setDraft(emptyDraft);
      setShowForm(false);
      reload();
    } catch (e) {
      // The server refuses an incoherent band — an inverted range, or critical
      // bounds inside the safe range — because such a rule fails silently
      // rather than loudly. Show exactly what it said.
      setError(e instanceof Error ? e.message : 'Could not save this rule');
    } finally { setBusy(null); }
  }, [draft, reload]);

  const deactivate = useCallback(async (rule: Rule) => {
    setBusy(rule.id);
    setError(null);
    try {
      await apiRequest(`/v1/monitoring/rules/${rule.id}`, { method: 'DELETE' });
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not deactivate this rule');
    } finally { setBusy(null); }
  }, [reload]);

  return (
    <div className="space-y-6 pb-8">
      <PageHeader
        title="Alert Thresholds"
        subtitle="The values your clinic's alerts fire on, and how long a patient may go without reporting before someone is told."
        actions={
          <div className="flex items-center gap-2">
            <button type="button" onClick={reload} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] bg-white px-3 py-1.5 text-[13px] font-semibold text-t1 hover:bg-[var(--s2)] transition">
              <RefreshCw className="w-3.5 h-3.5 text-t3" /> Refresh
            </button>
            <button type="button" onClick={() => setShowForm(v => !v)} className="inline-flex items-center gap-2 rounded-lg bg-[var(--indigo)] px-3.5 py-2 text-[13px] font-semibold text-white hover:opacity-90 transition">
              <Plus className="w-4 h-4" /> Add a rule
            </button>
          </div>
        }
      />

      <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[11px] font-medium text-red-700">
        These are operational routing thresholds — they decide when staff are asked to look at something. They are not diagnosis, treatment guidance, or a substitute for the clinic&rsquo;s escalation plan.
      </div>

      {error && <div role="alert" className="rounded-xl border border-[var(--b1)] bg-[var(--amber-soft)] p-3 text-[13px] text-amber-v">{error}</div>}

      <ResourceSection
        label="Alert thresholds"
        state={state}
        onRetry={reload}
        lines={3}
        rowClassName="h-20 rounded-xl"
      >
        {page => (
          <div className="space-y-6">
            {showForm && (
              <div className="rounded-xl border border-[var(--b2)] bg-[var(--s2)] p-4 space-y-3">
                <div className="grid gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
                  <label className="block space-y-1">
                    <span className="text-[11px] font-semibold text-t2">Reading</span>
                    <select aria-label="Reading type" value={draft.readingType} onChange={e => setDraft(d => ({ ...d, readingType: e.target.value }))} className={inputCls}>
                      {page.readingTypes.map(t => <option key={t} value={t}>{page.defaults[t]?.label ?? t}</option>)}
                    </select>
                  </label>
                  {([
                    ['minValue', 'Safe low'], ['maxValue', 'Safe high'],
                    ['criticalMin', 'Critical low'], ['criticalMax', 'Critical high'],
                  ] as const).map(([key, label]) => (
                    <label key={key} className="block space-y-1">
                      <span className="text-[11px] font-semibold text-t2">{label}</span>
                      <input
                        aria-label={label}
                        type="number"
                        value={draft[key]}
                        placeholder={String(page.defaults[draft.readingType]?.[key === 'minValue' ? 'min' : key === 'maxValue' ? 'max' : key === 'criticalMin' ? 'critMin' : 'critMax'] ?? '')}
                        onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))}
                        className={inputCls}
                      />
                    </label>
                  ))}
                  <label className="block space-y-1">
                    <span className="text-[11px] font-semibold text-t2">Missed after (h)</span>
                    <input aria-label="Missed after hours" type="number" value={draft.missedAfterHours} placeholder="e.g. 24" onChange={e => setDraft(d => ({ ...d, missedAfterHours: e.target.value }))} className={inputCls} />
                  </label>
                </div>
                <p className="text-[11px] text-t3">
                  Leave a value blank to keep the built-in default for it. Setting <strong>Missed after</strong> is what makes the system watch for a patient who stops reporting — without it, nothing is looking.
                </p>
                <div className="flex gap-2">
                  <button type="button" disabled={busy === 'new'} onClick={() => void save()} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-3.5 py-2 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
                    {busy === 'new' ? <Loader2 className="w-4 h-4 animate-spin" /> : <SlidersHorizontal className="w-4 h-4" />} Save rule
                  </button>
                  <button type="button" onClick={() => setShowForm(false)} className="rounded-lg border border-[var(--b1)] px-3 py-2 text-[13px] font-semibold text-t2 hover:bg-[var(--s3)]">Cancel</button>
                </div>
              </div>
            )}

            <BentoCard title="Your rules" subtitle="Applied ahead of the built-in defaults below">
              {page.rules.filter(r => r.active).length === 0 ? (
                <div className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-4">
                  <p className="text-[13px] font-semibold text-t1">No rules of your own yet</p>
                  <p className="text-[12px] text-t2 mt-1">
                    Your clinic is running entirely on the defaults below. Nothing is watching for missed readings until you set a <strong>Missed after</strong> value on at least one reading type.
                  </p>
                  <button type="button" onClick={() => setShowForm(true)} className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg bg-[var(--indigo)] px-3 py-1.5 text-[12px] font-semibold text-white hover:opacity-90">
                    <Plus className="w-3.5 h-3.5" /> Add your first rule
                  </button>
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-[var(--b1)]">
                  <table className="w-full border-collapse text-left">
                    <thead>
                      <tr className="bg-[var(--s2)] border-b border-[var(--b1)]">
                        <th className={thCls}>Reading</th><th className={thCls}>Applies to</th><th className={thCls}>Safe range</th>
                        <th className={thCls}>Critical</th><th className={thCls}>Missed after</th><th className={`${thCls} text-right`}>Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--b1)]">
                      {page.rules.filter(r => r.active).map(r => {
                        const band = page.defaults[r.readingType];
                        const unit = band?.unit ?? '';
                        const show = (v: number | null, fallback: number | undefined) =>
                          v != null ? `${v}${unit}` : fallback != null ? `${fallback}${unit} (default)` : '—';
                        return (
                          <tr key={r.id} className="hover:bg-[var(--s2)] transition-colors">
                            <td className="px-4 py-2.5 text-[13px] font-semibold text-t1 whitespace-nowrap">{band?.label ?? r.readingType}</td>
                            <td className="px-4 py-2.5 text-[12px] text-t2 whitespace-nowrap">{SCOPE_LABEL[r.scope] ?? r.scope}</td>
                            <td className="px-4 py-2.5 text-[12px] text-t2 whitespace-nowrap">{show(r.minValue, band?.min)} – {show(r.maxValue, band?.max)}</td>
                            <td className="px-4 py-2.5 text-[12px] text-t2 whitespace-nowrap">{show(r.criticalMin, band?.critMin)} / {show(r.criticalMax, band?.critMax)}</td>
                            <td className="px-4 py-2.5 text-[12px] whitespace-nowrap">
                              {r.missedAfterHours != null
                                ? <span className="text-t2">{r.missedAfterHours}h</span>
                                : <span className="inline-flex items-center gap-1 text-amber-v"><AlertTriangle className="w-3 h-3" /> not watched</span>}
                            </td>
                            <td className="px-4 py-2.5 text-right whitespace-nowrap">
                              <button
                                type="button"
                                disabled={busy === r.id}
                                onClick={() => void deactivate(r)}
                                aria-label={`Deactivate the ${band?.label ?? r.readingType} rule`}
                                title="Deactivate — the rule is kept so past alerts keep their explanation"
                                className="inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] px-2 py-1 text-[11px] font-semibold text-t2 hover:text-red-v hover:border-red-v/30 disabled:opacity-50"
                              >
                                {busy === r.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />} Deactivate
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </BentoCard>

            <BentoCard title="Built-in defaults" subtitle="What every reading is scored against unless one of your rules applies">
              <div className="overflow-x-auto rounded-xl border border-[var(--b1)]">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="bg-[var(--s2)] border-b border-[var(--b1)]">
                      <th className={thCls}>Reading</th><th className={thCls}>Safe range</th><th className={thCls}>Critical below / above</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--b1)]">
                    {Object.entries(page.defaults).map(([key, band]) => (
                      <tr key={key}>
                        <td className="px-4 py-2.5 text-[13px] font-semibold text-t1 whitespace-nowrap">{band.label}</td>
                        <td className="px-4 py-2.5 text-[12px] text-t2 whitespace-nowrap">{band.min}{band.unit} – {band.max}{band.unit}</td>
                        <td className="px-4 py-2.5 text-[12px] text-t2 whitespace-nowrap">{band.critMin}{band.unit} / {band.critMax}{band.unit}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </BentoCard>
          </div>
        )}
      </ResourceSection>
    </div>
  );
}

const inputCls = 'w-full px-3 py-2 rounded-lg border border-[var(--b1)] bg-[var(--s1)] text-xs text-t1 outline-none focus:border-[var(--b3)]';
const thCls = 'px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-t3';
