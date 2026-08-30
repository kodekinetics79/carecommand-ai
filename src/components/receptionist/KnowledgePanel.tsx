import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, BookOpen, CheckCircle2, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { Field, Select, TextArea, TextInput, Toggle } from '../ui/Field';
import {
  emptyKnowledgeDocument, normalizeKnowledgeDocument, receptionistClinicApi,
  type ClinicRow, type KnowledgeDocument, type KnowledgeFaq, type KnowledgePayer, type KnowledgeView, type VoiceServiceRow,
} from '../../lib/receptionistClinic';
import { useReceptionistCatalog } from '../../lib/receptionistCatalog';
import { useResource } from '../../hooks/useResource';
import { receivedData, resourceFailure } from '../../lib/resourceState';
import { isBusy, useMutationState } from '../../hooks/useMutationState';
import { durationLabel } from '../../lib/services';
import { LoadFailureNotice, MutationNotice } from './MutationNotice';

export const SERVICES_HREF = '/scheduling?tab=services';
const TEXT_MAX = 600;
const FAQ_MAX = 50;

function newId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

/**
 * The clinic knowledge the agent is allowed to speak: which plans are
 * accepted, how payment and new patients are handled, what counts as urgent
 * (distinct from a life-threatening emergency, which is the locale pack's
 * job), and the FAQ. Editing writes a DRAFT; only an approved snapshot is
 * rendered into the prompt, so nothing typed here reaches a caller until a
 * human approves it.
 *
 * Services are NOT part of this document — they are ServiceCatalogItem rows,
 * edited by the voice sub-panel below so there is one source of truth.
 */
export function KnowledgePanel({ clinic }: { clinic: ClinicRow }) {
  const loadKnowledge = useCallback(() => receptionistClinicApi.getKnowledge(clinic.id), [clinic.id]);
  const resource = useResource<KnowledgeView>(loadKnowledge);
  const failure = resourceFailure(resource.state);
  const view = receivedData(resource.state);
  const catalogResource = useReceptionistCatalog();
  const faqMax = receivedData(catalogResource.state)?.limits.faqMax ?? FAQ_MAX;

  const [baseline, setBaseline] = useState<KnowledgeView | null>(null);
  const [draft, setDraft] = useState<KnowledgeDocument>(emptyKnowledgeDocument());
  const saveState = useMutationState();
  const approveState = useMutationState();

  // Restart the draft from the server whenever a new view arrives (first load,
  // our own save, or the stale-revision reload).
  if (view && view !== baseline) {
    setBaseline(view);
    setDraft(normalizeKnowledgeDocument(view.draft));
  }

  const dirty = useMemo(() => Boolean(baseline) && JSON.stringify(draft) !== JSON.stringify(normalizeKnowledgeDocument(baseline?.draft)), [draft, baseline]);
  const validation = baseline?.validation ?? { ok: true, issues: [] };
  const stale = (saveState.state.status === 'error' && saveState.state.code === 'STALE_REVISION')
    || (approveState.state.status === 'error' && approveState.state.code === 'STALE_REVISION');

  const set = <K extends keyof KnowledgeDocument>(key: K, value: KnowledgeDocument[K]) => setDraft(previous => ({ ...previous, [key]: value }));

  async function saveDraft() {
    if (!baseline) return;
    const saved = await saveState.run(() => receptionistClinicApi.saveKnowledge(clinic.id, { expectedRevision: baseline.draftRevision, draft }));
    if (saved) resource.reload();
  }

  async function approve() {
    if (!baseline) return;
    const approved = await approveState.run(() => receptionistClinicApi.approveKnowledge(clinic.id, { expectedRevision: baseline.draftRevision }), { successMessage: 'Approved' });
    if (approved) resource.reload();
  }

  function approvalHeadline(): string {
    if (!baseline) return '';
    if (!baseline.approvedRevision) return 'Not configured — the agent has no approved knowledge to answer from.';
    const who = baseline.approvedBy?.displayName ?? 'a colleague';
    const when = baseline.approvedAt ? new Date(baseline.approvedAt).toLocaleDateString() : 'an earlier date';
    const head = `Approved rev ${baseline.approvedRevision} by ${who} on ${when}`;
    return baseline.dirty || dirty ? `${head} · the draft has unapproved changes` : head;
  }

  return (
    <div className="space-y-4">
      <div className="cc-card p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-t1 inline-flex items-center gap-2"><BookOpen className="w-4 h-4 text-indigo" aria-hidden="true" /> Clinic knowledge</h3>
          {baseline && (
            <span className={`badge ${baseline.approvedRevision && !baseline.dirty && !dirty ? 'badge-emerald' : baseline.approvedRevision ? 'badge-amber' : 'badge-red'}`}>{approvalHeadline()}</span>
          )}
        </div>
        <p className="text-[11px] text-t3">Only the approved snapshot is rendered into the agent prompt. Saving a draft changes nothing a caller hears until it is approved.</p>

        {resource.state.status === 'loading' && (
          <p className="inline-flex items-center gap-2 text-xs text-t3" aria-live="polite"><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Loading clinic knowledge…</p>
        )}
        {failure && <LoadFailureNotice what="Clinic knowledge" message={failure.message} onRetry={resource.reload} />}

        {baseline && (
          <>
            <section className="space-y-2" aria-labelledby="knowledge-payers">
              <div className="flex items-center justify-between">
                <h4 id="knowledge-payers" className="text-xs font-bold uppercase tracking-wide text-t3">Accepted plans</h4>
                <button type="button" onClick={() => set('acceptedPayers', [...draft.acceptedPayers, { id: newId('payer'), name: '', plans: [], source: 'manual' }])} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-indigo hover:bg-[var(--s3)]"><Plus className="w-3 h-3" aria-hidden="true" /> Add plan</button>
              </div>
              {draft.acceptedPayers.length === 0 && <p className="text-xs text-t3">No plans listed. The agent will say it cannot confirm coverage over the phone.</p>}
              {draft.acceptedPayers.map((payer, index) => (
                <PayerRow
                  key={payer.id}
                  payer={payer}
                  duplicate={draft.acceptedPayers.some((other, otherIndex) => otherIndex !== index && other.name.trim().toLowerCase() === payer.name.trim().toLowerCase() && payer.name.trim().length > 0)}
                  onChange={next => set('acceptedPayers', draft.acceptedPayers.map((row, rowIndex) => rowIndex === index ? next : row))}
                  onRemove={() => set('acceptedPayers', draft.acceptedPayers.filter((_, rowIndex) => rowIndex !== index))}
                />
              ))}
            </section>

            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Payment policy" hint={`${draft.paymentPolicy.length}/${TEXT_MAX} characters — spoken when a caller asks about cost or paying.`}>
                <TextArea rows={3} maxLength={TEXT_MAX} value={draft.paymentPolicy} onChange={e => set('paymentPolicy', e.target.value)} />
              </Field>
              <Field label="New-patient policy" hint={`${draft.newPatientPolicy.length}/${TEXT_MAX} characters — spoken to a caller who has never visited.`}>
                <TextArea rows={3} maxLength={TEXT_MAX} value={draft.newPatientPolicy} onChange={e => set('newPatientPolicy', e.target.value)} />
              </Field>
            </div>

            <section className="space-y-2 rounded-xl border border-[var(--b1)] p-3" aria-labelledby="knowledge-urgent">
              <h4 id="knowledge-urgent" className="text-xs font-bold uppercase tracking-wide text-t3">Urgent care</h4>
              <p className="text-[11px] text-t3">Clinically urgent, not life-threatening. A life-threatening call is routed to the emergency number in the approved locale pack, never to these words.</p>
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="What counts as urgent" hint="Used to decide whether to offer the soonest slot or the on-call number.">
                  <TextArea rows={2} maxLength={TEXT_MAX} value={draft.urgentCare.whatCountsAsUrgent} onChange={e => set('urgentCare', { ...draft.urgentCare, whatCountsAsUrgent: e.target.value })} />
                </Field>
                <Field label="Same-day policy">
                  <TextArea rows={2} maxLength={TEXT_MAX} value={draft.urgentCare.sameDayPolicy} onChange={e => set('urgentCare', { ...draft.urgentCare, sameDayPolicy: e.target.value })} />
                </Field>
              </div>
              <Field label="On-call number" hint="Optional. Spoken only for urgent clinical cases; leave blank to hand off to staff instead.">
                <TextInput value={draft.urgentCare.onCallNumber ?? ''} placeholder="+442071234570" onChange={e => set('urgentCare', { ...draft.urgentCare, onCallNumber: e.target.value.trim() || null })} />
              </Field>
            </section>

            <section className="space-y-2" aria-labelledby="knowledge-faq">
              <div className="flex items-center justify-between">
                <h4 id="knowledge-faq" className="text-xs font-bold uppercase tracking-wide text-t3">FAQ ({draft.faq.length}/{faqMax})</h4>
                <button
                  type="button"
                  disabled={draft.faq.length >= faqMax}
                  onClick={() => set('faq', [...draft.faq, { id: newId('faq'), question: '', answer: '' }])}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-indigo hover:bg-[var(--s3)] disabled:opacity-40"
                ><Plus className="w-3 h-3" aria-hidden="true" /> Add question</button>
              </div>
              {draft.faq.length === 0 && <p className="text-xs text-t3">No questions yet. The agent will hand off anything it was not taught.</p>}
              {draft.faq.map((entry, index) => (
                <FaqRow
                  key={entry.id}
                  entry={entry}
                  onChange={next => set('faq', draft.faq.map((row, rowIndex) => rowIndex === index ? next : row))}
                  onRemove={() => set('faq', draft.faq.filter((_, rowIndex) => rowIndex !== index))}
                />
              ))}
            </section>

            {!validation.ok && validation.issues.length > 0 && (
              <div role="alert" className="rounded-lg border border-amber-v/40 bg-[var(--amber-soft)] px-3 py-2 text-xs text-amber-v">
                <p className="font-semibold inline-flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" /> This draft cannot be approved yet</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {validation.issues.map(issue => <li key={`${issue.path}-${issue.message}`}>{issue.path}: {issue.message}</li>)}
                </ul>
              </div>
            )}

            {stale ? (
              <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-v/40 bg-[var(--amber-soft)] px-3 py-2 text-xs text-amber-v">
                <span className="font-semibold">Someone else saved this knowledge; reload to see their changes.</span>
                <button type="button" onClick={() => { saveState.reset(); approveState.reset(); resource.reload(); }} className="inline-flex items-center gap-1 rounded-lg border border-amber-v/40 px-2.5 py-1 text-[11px] font-semibold hover:bg-[var(--s2)]"><RefreshCw className="h-3 w-3" aria-hidden="true" /> Reload</button>
              </div>
            ) : (
              <>
                <MutationNotice state={saveState.state} showSaved={false} />
                <MutationNotice state={approveState.state} />
              </>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2">
              <button type="button" disabled={!dirty || isBusy(saveState.state)} onClick={saveDraft} className="inline-flex items-center gap-2 rounded-xl border border-[var(--b1)] px-4 py-2 text-sm font-semibold text-t2 hover:bg-[var(--s3)] disabled:opacity-40">
                {isBusy(saveState.state) && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />} Save draft
              </button>
              <button
                type="button"
                disabled={!validation.ok || dirty || isBusy(approveState.state)}
                title={!validation.ok ? 'Fix the issues listed above before approving' : dirty ? 'Save the draft before approving it' : undefined}
                onClick={approve}
                className="inline-flex items-center gap-2 rounded-xl bg-indigo px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40"
              >
                {isBusy(approveState.state) ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="w-4 h-4" aria-hidden="true" />} Approve
              </button>
            </div>
          </>
        )}
      </div>

      <VoiceServicesPanel />
    </div>
  );
}

function PayerRow({ payer, duplicate, onChange, onRemove }: { payer: KnowledgePayer; duplicate: boolean; onChange: (next: KnowledgePayer) => void; onRemove: () => void }) {
  return (
    <div className="grid gap-2 rounded-xl border border-[var(--b1)] p-2.5 md:grid-cols-[1fr_1fr_auto]">
      <Field label="Plan or payer name" required>
        <TextInput value={payer.name} aria-invalid={duplicate} onChange={e => onChange({ ...payer, name: e.target.value })} />
      </Field>
      <Field label="Plans" hint="Comma separated. Optional.">
        <TextInput value={(payer.plans ?? []).join(', ')} onChange={e => onChange({ ...payer, plans: e.target.value.split(',').map(part => part.trim()).filter(Boolean) })} />
      </Field>
      <div className="flex items-end">
        <button type="button" aria-label={`Remove plan ${payer.name || 'unnamed'}`} onClick={onRemove} className="rounded-lg border border-[var(--b1)] px-2 py-2 text-t3 hover:text-red-v"><Trash2 className="w-3.5 h-3.5" aria-hidden="true" /></button>
      </div>
      {duplicate && <p role="alert" className="md:col-span-3 text-xs font-semibold text-red-v">Two entries have this name. Approval will be refused until one is removed.</p>}
    </div>
  );
}

function FaqRow({ entry, onChange, onRemove }: { entry: KnowledgeFaq; onChange: (next: KnowledgeFaq) => void; onRemove: () => void }) {
  return (
    <div className="grid gap-2 rounded-xl border border-[var(--b1)] p-2.5 md:grid-cols-[1fr_1.4fr_auto]">
      <Field label="Question" required><TextInput value={entry.question} maxLength={200} onChange={e => onChange({ ...entry, question: e.target.value })} /></Field>
      <Field label="Answer the agent will speak" required><TextArea rows={2} maxLength={TEXT_MAX} value={entry.answer} onChange={e => onChange({ ...entry, answer: e.target.value })} /></Field>
      <div className="flex items-end">
        <button type="button" aria-label={`Remove question ${entry.question || 'unnamed'}`} onClick={onRemove} className="rounded-lg border border-[var(--b1)] px-2 py-2 text-t3 hover:text-red-v"><Trash2 className="w-3.5 h-3.5" aria-hidden="true" /></button>
      </div>
    </div>
  );
}

const loadServices = () => receptionistClinicApi.listServices();

/**
 * Which catalog services the agent may book, and how it says them. These are
 * ServiceCatalogItem columns, edited here rather than copied into the
 * knowledge document: the prompt, the booking tool enum and this panel all
 * read the same rows.
 */
export function VoiceServicesPanel() {
  const resource = useResource<VoiceServiceRow[]>(loadServices);
  const failure = resourceFailure(resource.state);
  const services = receivedData(resource.state);
  const saveState = useMutationState();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ spokenDescription: '', bookableByVoice: false, voiceDurationMinutes: '' });

  function beginEdit(service: VoiceServiceRow) {
    setForm({
      spokenDescription: service.spokenDescription ?? '',
      bookableByVoice: Boolean(service.bookableByVoice),
      voiceDurationMinutes: service.voiceDurationMinutes ? String(service.voiceDurationMinutes) : '',
    });
    saveState.reset();
    setEditingId(service.id);
  }

  async function save(id: string) {
    const minutes = form.voiceDurationMinutes.trim() ? Number(form.voiceDurationMinutes) : null;
    const saved = await saveState.run(() => receptionistClinicApi.updateServiceVoiceFields(id, {
      spokenDescription: form.spokenDescription.trim() || null,
      bookableByVoice: form.bookableByVoice,
      voiceDurationMinutes: Number.isFinite(minutes) ? minutes : null,
    }));
    if (saved) {
      setEditingId(null);
      resource.reload();
    }
  }

  const bookable = services?.filter(service => service.bookableByVoice).length ?? 0;

  return (
    <div className="cc-card p-5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-t1">Bookable by voice</h3>
        {services && <span className={`badge ${bookable > 0 ? 'badge-emerald' : 'badge-amber'}`}>{bookable} of {services.length} services</span>}
      </div>
      <p className="text-[11px] text-t3">
        Services come from the <Link to={SERVICES_HREF} className="text-indigo underline">service catalog</Link> — one source of truth for booking, the prompt and this list. A campaign cannot go live until at least one service is bookable by voice.
      </p>
      {resource.state.status === 'loading' && (
        <p className="inline-flex items-center gap-2 text-xs text-t3" aria-live="polite"><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Loading services…</p>
      )}
      {failure && <LoadFailureNotice what="The service catalog" message={failure.message} onRetry={resource.reload} />}
      {services && services.length === 0 && (
        <p className="text-xs text-amber-v">No services in the catalog yet. <Link to={SERVICES_HREF} className="text-indigo underline">Add one</Link> before the agent can book anything.</p>
      )}
      <MutationNotice state={saveState.state} showSaved={false} />
      {services?.map(service => (
        <div key={service.id} className="rounded-xl border border-[var(--b1)] px-3 py-2.5 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-t1 truncate">{service.name} {service.bookableByVoice ? <span className="badge badge-emerald">Bookable by voice</span> : <span className="badge badge-blue">Not offered by voice</span>}</p>
              <p className="text-[11px] text-t3 truncate">{durationLabel(service.voiceDurationMinutes ?? service.defaultDurationMinutes)}{service.spokenDescription ? ` · “${service.spokenDescription}”` : ''}</p>
            </div>
            <button type="button" onClick={() => editingId === service.id ? setEditingId(null) : beginEdit(service)} className="rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-indigo hover:bg-[var(--s3)]">{editingId === service.id ? 'Cancel' : 'Edit voice settings'}</button>
          </div>
          {editingId === service.id && (
            <div className="grid gap-3 rounded-lg border border-dashed border-[var(--b2)] p-3 md:grid-cols-2">
              <div className="md:col-span-2">
                <Field label="How the agent describes it" hint="Spoken to callers. Leave blank to use the service name alone.">
                  <TextInput value={form.spokenDescription} maxLength={300} onChange={e => setForm(previous => ({ ...previous, spokenDescription: e.target.value }))} />
                </Field>
              </div>
              <Field label="Voice appointment length" hint="Minutes. Blank uses the catalog default.">
                <Select value={form.voiceDurationMinutes} onChange={e => setForm(previous => ({ ...previous, voiceDurationMinutes: e.target.value }))}>
                  <option value="">Catalog default ({service.defaultDurationMinutes} min)</option>
                  {[15, 20, 30, 45, 60, 90].map(minutes => <option key={minutes} value={minutes}>{minutes} min</option>)}
                </Select>
              </Field>
              <div className="flex items-end">
                <Toggle checked={form.bookableByVoice} onChange={value => setForm(previous => ({ ...previous, bookableByVoice: value }))} label="Bookable by voice" />
              </div>
              <div className="md:col-span-2 flex justify-end">
                <button type="button" disabled={isBusy(saveState.state)} onClick={() => save(service.id)} className="inline-flex items-center gap-2 rounded-xl bg-indigo px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">
                  {isBusy(saveState.state) && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />} Save voice settings
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
