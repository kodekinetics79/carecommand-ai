import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Save, GripVertical, ChevronUp, ChevronDown, ListChecks, Loader2 } from 'lucide-react';
import { Field, TextInput, TextArea, Toggle } from '../ui/Field';
import { receptionistApi as api, FIELD_CATALOG, type Clinic, type Campaign, type IntakeField, type FieldType } from '../../lib/receptionist';
import { describeFailure, type ResourceFailure } from '../../lib/resourceState';
import { isBusy, useMutationState } from '../../hooks/useMutationState';
import { ConfirmedButton } from './shared';
import { LoadFailureNotice, MutationNotice } from './MutationNotice';

// ===== Intake Builder ======================================================

export function IntakeBuilder({ campaign, onChanged }: { campaign: Campaign; clinic: Clinic; onChanged: () => Promise<unknown> }) {
  const [fields, setFields] = useState<IntakeField[]>(campaign.intakeFields ?? []);
  const [loaded, setLoaded] = useState(false);
  const [loadFailure, setLoadFailure] = useState<ResourceFailure | null>(null);
  const addState = useMutationState();
  const reorderState = useMutationState();
  const [reordering, setReordering] = useState(false);

  const loadFields = useCallback(async () => {
    try {
      const rows = await api.listIntakeFields(campaign.id);
      setFields(rows);
      setLoadFailure(null);
      setLoaded(true);
    } catch (error) {
      setLoadFailure(describeFailure(error));
    }
  }, [campaign.id]);

  const refresh = useCallback(async () => {
    const rows = await api.listIntakeFields(campaign.id);
    setFields(rows);
    await onChanged();
  }, [campaign.id, onChanged]);

  useEffect(() => { void (async () => { await loadFields(); })(); }, [loadFields]);

  const usedTypes = new Set(fields.map(f => f.fieldType));
  const busy = isBusy(addState.state) || reordering;

  async function addField(type: FieldType) {
    const meta = FIELD_CATALOG.find(f => f.type === type)!;
    await addState.run(async () => {
      // Preferred-location choices are compiled from the campaign's mapped
      // location UUIDs. Sending display-name options creates a second source
      // of truth and is rejected by the server contract.
      await api.createIntakeField({ campaignId: campaign.id, fieldType: type, label: meta.label, aiQuestion: meta.question, options: [], sortOrder: fields.length });
      await refresh();
    }, { successMessage: `${meta.label} added` });
  }

  async function move(index: number, dir: -1 | 1) {
    if (reordering) return;
    const previous = fields;
    const next = [...fields];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    // Optimistic: show the new order at once, but roll back to the order the
    // server still holds when the reorder is refused.
    setFields(next);
    setReordering(true);
    const persisted = await reorderState.run(async () => {
      const rows = await api.reorderIntakeFields(campaign.id, next.map(f => f.id));
      await onChanged();
      return Array.isArray(rows) && rows.length === next.length ? rows : next;
    }, { successMessage: 'Order saved' });
    setFields(persisted ?? previous);
    setReordering(false);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_240px]">
      <div className="cc-card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-t1 inline-flex items-center gap-2"><ListChecks className="w-4 h-4 text-indigo" /> Intake fields ({fields.length})</h3>
          <span className="text-[10px] text-t3">Collected in this order during the call</span>
        </div>
        {loadFailure && <LoadFailureNotice what="Intake fields" message={loadFailure.message} onRetry={() => void loadFields()} />}
        <MutationNotice state={reorderState.state} savedLabel="Order saved" />
        <MutationNotice state={addState.state} />
        {loaded && !loadFailure && fields.length === 0 && <p className="text-xs text-t3 py-6 text-center">No fields yet. Add from the catalog →</p>}
        {!loaded && !loadFailure && fields.length === 0 && <p role="status" className="text-xs text-t3 py-6 text-center"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading intake fields…</p>}
        <div className="space-y-2">
          {fields.map((field, index) => (
            <IntakeFieldRow
              key={field.id}
              field={field}
              isFirst={index === 0}
              isLast={index === fields.length - 1}
              moveDisabled={reordering}
              onMoveUp={() => move(index, -1)}
              onMoveDown={() => move(index, 1)}
              onChanged={refresh}
            />
          ))}
        </div>
      </div>

      <div className="cc-card p-4 space-y-3 lg:sticky lg:top-4 self-start">
        <p className="text-[10px] font-bold uppercase tracking-widest text-t3">Field catalog</p>
        {['Identity', 'Contact', 'Scheduling', 'Clinical', 'Compliance', 'Custom'].map(group => (
          <div key={group} className="space-y-1.5">
            <p className="text-[10px] font-semibold text-t3">{group}</p>
            {FIELD_CATALOG.filter(f => f.group === group).map(f => {
              const isCustom = f.group === 'Custom';
              const disabled = busy || Boolean(loadFailure) || (!isCustom && usedTypes.has(f.type));
              return (
                <button key={f.type} type="button" disabled={disabled} onClick={() => addField(f.type)}
                  className="w-full flex items-center justify-between gap-2 rounded-lg border border-[var(--b1)] px-2.5 py-1.5 text-left text-[11px] font-semibold text-t2 hover:bg-[var(--s3)] hover:text-indigo disabled:opacity-30 disabled:hover:bg-transparent">
                  {f.label}
                  <Plus className="w-3 h-3 shrink-0" />
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function IntakeFieldRow({ field, isFirst, isLast, moveDisabled, onMoveUp, onMoveDown, onChanged }: {
  field: IntakeField; isFirst: boolean; isLast: boolean; moveDisabled: boolean; onMoveUp: () => void; onMoveDown: () => void; onChanged: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<IntakeField>(field);
  const saveState = useMutationState();
  const removeState = useMutationState();
  const busy = isBusy(saveState.state) || isBusy(removeState.state);
  const dirty = JSON.stringify(draft) !== JSON.stringify(field);
  const set = <K extends keyof IntakeField>(key: K, value: IntakeField[K]) => setDraft(prev => ({ ...prev, [key]: value }));
  // Preferred-location choices come from the campaign's active mapped
  // locations. A second hand-maintained option list can drift from scheduling
  // and previously made Retell export fail at runtime.
  const hasOptions = field.fieldType === 'CUSTOM_DROPDOWN';

  async function save() {
    const saved = await saveState.run(async () => {
      await api.updateIntakeField(field.id, {
        label: draft.label, aiQuestion: draft.aiQuestion, validationRule: draft.validationRule,
        required: draft.required, confirmationRequired: draft.confirmationRequired, options: draft.options,
      });
      await onChanged();
      return true;
    });
    if (saved) setExpanded(false);
  }

  async function remove() {
    await removeState.run(async () => {
      await api.deleteIntakeField(field.id);
      await onChanged();
    }, { rethrow: true });
  }

  return (
    <div className="rounded-xl border border-[var(--b1)] bg-[var(--s2)]">
      <div className="flex items-center gap-2 px-3 py-2.5">
        <div className="flex flex-col">
          <button type="button" aria-label="Move field up" title="Move up" disabled={isFirst || moveDisabled || busy} onClick={onMoveUp} className="text-t3 hover:text-indigo disabled:opacity-20"><ChevronUp className="w-3.5 h-3.5" /></button>
          <button type="button" aria-label="Move field down" title="Move down" disabled={isLast || moveDisabled || busy} onClick={onMoveDown} className="text-t3 hover:text-indigo disabled:opacity-20"><ChevronDown className="w-3.5 h-3.5" /></button>
        </div>
        <GripVertical className="w-3.5 h-3.5 text-t3 shrink-0" />
        <button type="button" onClick={() => setExpanded(e => !e)} className="flex-1 min-w-0 text-left">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-t1 truncate">{field.label}</p>
            {field.required ? <span className="badge badge-red">Required</span> : <span className="badge badge-blue">Optional</span>}
            {field.confirmationRequired && <span className="badge badge-violet">Confirm</span>}
          </div>
          <p className="text-[11px] text-t3 truncate mt-0.5">“{field.aiQuestion}”</p>
        </button>
        <ConfirmedButton
          dialogTitle="Remove intake field?"
          message={`Remove ${field.label} from this campaign's call intake flow?`}
          confirmLabel="Remove field"
          tone="red"
          ariaLabel={`Remove field ${field.label}`}
          buttonTitle="Remove field"
          disabled={busy}
          onConfirm={remove}
          className="text-t3 hover:text-red-v shrink-0"
        ><Trash2 className="w-3.5 h-3.5" /></ConfirmedButton>
      </div>
      {removeState.state.status === 'error' && <div className="px-3 pb-2"><MutationNotice state={removeState.state} showSaved={false} /></div>}
      {expanded && (
        <div className="border-t border-[var(--b1)] p-3 space-y-3">
          <Field label="Display label"><TextInput value={draft.label} onChange={e => set('label', e.target.value)} /></Field>
          <Field label="AI question wording"><TextArea rows={2} value={draft.aiQuestion} onChange={e => set('aiQuestion', e.target.value)} /></Field>
          <Field label="Validation rule" hint="Plain-language hint the agent uses to validate the answer.">
            <TextInput value={draft.validationRule ?? ''} onChange={e => set('validationRule', e.target.value)} />
          </Field>
          {hasOptions && (
            <Field label="Options" hint="Comma separated choices.">
              <TextInput value={draft.options.join(', ')} onChange={e => set('options', e.target.value.split(',').map(o => o.trim()).filter(Boolean))} />
            </Field>
          )}
          <div className="flex flex-wrap gap-3">
            <Toggle checked={draft.required} onChange={v => set('required', v)} label="Required" />
            <Toggle checked={draft.confirmationRequired} onChange={v => set('confirmationRequired', v)} label="Read back to confirm" />
          </div>
          <MutationNotice state={saveState.state} showSaved={false} onRetry={dirty ? save : undefined} />
          <div className="flex justify-end">
            <button type="button" disabled={!dirty || busy} onClick={save} className="inline-flex items-center gap-2 rounded-xl bg-indigo px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">
              {isBusy(saveState.state) ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save field
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
