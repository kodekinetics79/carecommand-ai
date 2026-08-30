import { useState } from 'react';
import { Plus, Trash2, MapPin, Pencil, Loader2 } from 'lucide-react';
import { Field, TextInput, TextArea, Select, Toggle } from '../ui/Field';
import { receptionistApi as api, type SchedulingBranch } from '../../lib/receptionist';
import { receptionistClinicApi, type ClinicRow, type LocationInput, type LocationRow } from '../../lib/receptionistClinic';
import { useResource } from '../../hooks/useResource';
import { receivedData, resourceFailure } from '../../lib/resourceState';
import { isBusy, useMutationState } from '../../hooks/useMutationState';
import { ConfirmedButton } from './shared';
import { LoadFailureNotice, MutationNotice } from './MutationNotice';

// Module scope on purpose: `useResource` keys the request on the loader's identity.
const loadSchedulingBranches = () => api.listSchedulingBranches();

interface LocationForm {
  name: string;
  address: string;
  phone: string;
  branchId: string;
  accessNotes: string;
  active: boolean;
}

const EMPTY_FORM: LocationForm = { name: '', address: '', phone: '', branchId: '', accessNotes: '', active: true };

/**
 * Locations map the receptionist to scheduling branches. The timezone is the
 * branch's (derived server-side; never sent), and opening hours inherit the
 * clinic's — the per-location override exists in the API but the pilot UI is
 * inherit-only, so this editor never sends `workingHours` and never clears one
 * that was set through the API.
 */
export function LocationsEditor({ clinic, onChanged }: { clinic: ClinicRow; onChanged: () => Promise<unknown> }) {
  const locations = clinic.locations ?? [];
  const branchesResource = useResource<SchedulingBranch[]>(loadSchedulingBranches);
  const branchFailure = resourceFailure(branchesResource.state);
  // A body that is not a list is a broken contract, not zero branches: keep
  // the list empty so the panel says "could not be loaded" rather than
  // throwing and taking the whole Clinic Profile tab down.
  const loadedBranches = receivedData(branchesResource.state);
  const branches = Array.isArray(loadedBranches) ? loadedBranches : [];
  const branchesLoading = branchesResource.state.status === 'loading';
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState<LocationForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const saveState = useMutationState();
  const removeState = useMutationState();
  const fieldErrors = saveState.state.status === 'error' ? saveState.state.fieldErrors : {};

  const setFormValue = <K extends keyof LocationForm>(key: K, value: LocationForm[K]) => setForm(previous => ({ ...previous, [key]: value }));

  function beginCreate() {
    const branch = branches.find(row => row.active);
    setForm({ ...EMPTY_FORM, branchId: branch?.id ?? '' });
    setFormError(null);
    saveState.reset();
    setEditingId('new');
  }

  function beginEdit(location: LocationRow) {
    setForm({ name: location.name, address: location.address, phone: location.phone ?? '', branchId: location.branchId ?? '', accessNotes: location.accessNotes ?? '', active: location.active });
    setFormError(null);
    saveState.reset();
    setEditingId(location.id);
  }

  async function saveLocation() {
    if (!form.name.trim() || !form.address.trim() || !form.branchId) {
      setFormError('Name, address, and an active scheduling branch are required.');
      return;
    }
    setFormError(null);
    const saved = await saveState.run(async () => {
      const payload: LocationInput = {
        name: form.name.trim(), address: form.address.trim(), phone: form.phone.trim() || null,
        branchId: form.branchId, active: form.active, accessNotes: form.accessNotes.trim() || null,
      };
      if (editingId === 'new') await receptionistClinicApi.createLocation({ clinicId: clinic.id, ...payload });
      else if (editingId) await receptionistClinicApi.updateLocation(editingId, payload);
      await onChanged();
      return true;
    });
    if (saved) setEditingId(null);
  }

  async function remove(id: string) {
    await removeState.run(async () => {
      await api.deleteLocation(id);
      await onChanged();
    }, { rethrow: true });
  }

  function branchOf(branchId: string | null): SchedulingBranch | null {
    return branches.find(branch => branch.id === branchId) ?? null;
  }

  function branchLabel(location: LocationRow): string {
    if (branchFailure) return 'Branch mapping unavailable — scheduling branches could not be loaded';
    if (branchesLoading) return 'Loading scheduling branches…';
    return branchOf(location.branchId)?.name ?? 'Not mapped — booking disabled';
  }

  function timezoneLabel(location: LocationRow): string {
    const branch = branchOf(location.branchId);
    const zone = location.timezone ?? branch?.timezone ?? clinic.timezone;
    return branch ? `Derived from branch ${branch.name}: ${zone}` : zone;
  }

  const selectedBranch = branchOf(form.branchId);

  return (
    <div className="cc-card p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-t1 inline-flex items-center gap-2"><MapPin className="w-4 h-4 text-indigo" aria-hidden="true" /> Locations</h3>
        <button type="button" onClick={editingId === 'new' ? () => setEditingId(null) : beginCreate} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-indigo hover:bg-[var(--s3)]">
          <Plus className="w-3 h-3" aria-hidden="true" /> Add location
        </button>
      </div>
      {branchFailure && (
        <LoadFailureNotice what="Scheduling branches" message={`${branchFailure.message} Branch mappings below cannot be shown; existing locations are unchanged.`} onRetry={branchesResource.reload} />
      )}
      <MutationNotice state={removeState.state} showSaved={false} />
      {locations.length === 0 && editingId !== 'new' && <p className="text-xs text-t3">No locations yet. Map a receptionist location to an active scheduling branch before calls can book.</p>}
      <div className="space-y-2">
        {locations.map(loc => (
          <div key={loc.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--b1)] px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-t1 truncate">{loc.name} {!loc.active && <span className="badge badge-amber">Inactive</span>}</p>
              <p className="text-[11px] text-t3 truncate">{loc.address}{loc.phone ? ` · ${loc.phone}` : ''}</p>
              <p className="text-[10px] text-t3 truncate">Scheduling branch: {branchLabel(loc)} · Timezone: {timezoneLabel(loc)}</p>
              <p className="text-[10px] text-t3 truncate">Hours: {loc.workingHours ? 'custom (set via API)' : 'uses clinic hours'}{loc.accessNotes ? ` · Access: ${loc.accessNotes}` : ''}</p>
            </div>
            <div className="flex gap-2">
              <button type="button" aria-label="Edit location" title="Edit location" onClick={() => beginEdit(loc)} className="text-t3 hover:text-indigo shrink-0"><Pencil className="w-3.5 h-3.5" aria-hidden="true" /></button>
              <ConfirmedButton
                dialogTitle="Remove location?"
                message={`Remove ${loc.name} from this receptionist configuration? Existing scheduling records are not changed.`}
                confirmLabel="Remove location"
                tone="red"
                ariaLabel={`Remove location ${loc.name}`}
                buttonTitle="Remove location"
                disabled={isBusy(removeState.state)}
                onConfirm={() => remove(loc.id)}
                className="text-t3 hover:text-red-v shrink-0"
              ><Trash2 className="w-3.5 h-3.5" aria-hidden="true" /></ConfirmedButton>
            </div>
          </div>
        ))}
      </div>
      {editingId && (
        <div className="grid gap-3 md:grid-cols-2 rounded-xl border border-dashed border-[var(--b2)] p-3">
          <Field label="Location name" required><TextInput value={form.name} onChange={e => setFormValue('name', e.target.value)} /></Field>
          <Field label="Scheduling branch" required>
            <Select value={form.branchId} disabled={branchesLoading || Boolean(branchFailure)} onChange={e => setFormValue('branchId', e.target.value)}>
              <option value="">{branchFailure ? 'Branches could not be loaded' : branchesLoading ? 'Loading branches…' : 'Select an active branch'}</option>
              {branches.filter(branch => branch.active || branch.id === form.branchId).map(branch => <option key={branch.id} value={branch.id} disabled={!branch.active}>{branch.name}{!branch.active ? ' (inactive)' : ''}</option>)}
            </Select>
          </Field>
          <Field label="Address" required><TextInput value={form.address} onChange={e => setFormValue('address', e.target.value)} /></Field>
          <Field label="Phone (E.164)" hint={fieldErrors.phone?.[0]}><TextInput placeholder="+12125550100" value={form.phone} aria-invalid={Boolean(fieldErrors.phone)} onChange={e => setFormValue('phone', e.target.value)} /></Field>
          <div className="md:col-span-2 rounded-lg border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-[11px] text-t3">
            <p><span className="font-bold uppercase tracking-wide">Timezone</span> · {selectedBranch ? `Derived from branch ${selectedBranch.name}: ${selectedBranch.timezone}` : 'Derived from the selected scheduling branch'}</p>
            <p><span className="font-bold uppercase tracking-wide">Hours</span> · Uses clinic hours.</p>
          </div>
          <div className="md:col-span-2">
            <Field label="Access notes" hint="Spoken to callers who ask about parking or how to get in.">
              <TextArea rows={2} maxLength={600} value={form.accessNotes} onChange={e => setFormValue('accessNotes', e.target.value)} />
            </Field>
          </div>
          <Toggle checked={form.active} onChange={value => setFormValue('active', value)} label="Location active" />
          <div className="flex items-end justify-end gap-2">
            <button type="button" onClick={() => setEditingId(null)} className="rounded-xl border border-[var(--b1)] px-3 py-2 text-sm font-semibold text-t2">Cancel</button>
            <button type="button" disabled={isBusy(saveState.state)} onClick={saveLocation} className="inline-flex items-center gap-2 rounded-xl bg-indigo px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">
              {isBusy(saveState.state) && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}{isBusy(saveState.state) ? 'Saving…' : 'Save location'}
            </button>
          </div>
          {formError && <p role="alert" className="md:col-span-2 text-xs font-semibold text-red-v">{formError}</p>}
          <MutationNotice state={saveState.state} showSaved={false} className="md:col-span-2" />
        </div>
      )}
    </div>
  );
}
