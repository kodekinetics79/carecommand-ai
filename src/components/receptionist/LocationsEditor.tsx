import { useState } from 'react';
import { Plus, Trash2, MapPin, Pencil, Loader2, X } from 'lucide-react';
import { Field, TextInput, Select, Toggle } from '../ui/Field';
import { receptionistApi as api, TIMEZONE_OPTIONS, type Clinic, type Location, type SchedulingBranch, type WeeklyHours } from '../../lib/receptionist';
import { useResource } from '../../hooks/useResource';
import { receivedData, resourceFailure } from '../../lib/resourceState';
import { isBusy, useMutationState } from '../../hooks/useMutationState';
import { ConfirmedButton } from './shared';
import { LoadFailureNotice, MutationNotice } from './MutationNotice';

// Module scope on purpose: `useResource` keys the request on the loader's identity.
const loadSchedulingBranches = () => api.listSchedulingBranches();

const DAY_OPTIONS = [
  ['monday', 'Monday'], ['tuesday', 'Tuesday'], ['wednesday', 'Wednesday'],
  ['thursday', 'Thursday'], ['friday', 'Friday'], ['saturday', 'Saturday'], ['sunday', 'Sunday'],
] as const;

type DayKey = typeof DAY_OPTIONS[number][0];

function defaultWeeklyHours(): Record<DayKey, { open: boolean; start: string; end: string }> {
  return Object.fromEntries(DAY_OPTIONS.map(([day]) => [day, {
    open: !['saturday', 'sunday'].includes(day),
    start: '09:00',
    end: '17:00',
  }])) as Record<DayKey, { open: boolean; start: string; end: string }>;
}

function editableWeeklyHours(hours: WeeklyHours | null | undefined) {
  const defaults = defaultWeeklyHours();
  for (const [day] of DAY_OPTIONS) {
    const saved = hours?.[day];
    if (saved) defaults[day] = {
      open: saved.open,
      start: saved.start ?? defaults[day].start,
      end: saved.end ?? defaults[day].end,
    };
  }
  return defaults;
}

export function LocationsEditor({ clinic, onChanged }: { clinic: Clinic; onChanged: () => Promise<unknown> }) {
  const locations = clinic.locations ?? [];
  const branchesResource = useResource<SchedulingBranch[]>(loadSchedulingBranches);
  const branchFailure = resourceFailure(branchesResource.state);
  const branches = receivedData(branchesResource.state) ?? [];
  const branchesLoading = branchesResource.state.status === 'loading';
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState({ name: '', address: '', phone: '', branchId: '', timezone: clinic.timezone, active: true, hours: defaultWeeklyHours() });
  const [formError, setFormError] = useState<string | null>(null);
  const saveState = useMutationState();
  const removeState = useMutationState();

  const setFormValue = <K extends keyof typeof form>(key: K, value: typeof form[K]) => setForm(previous => ({ ...previous, [key]: value }));

  function beginCreate() {
    const branch = branches.find(row => row.active);
    setForm({ name: '', address: '', phone: '', branchId: branch?.id ?? '', timezone: branch?.timezone ?? clinic.timezone, active: true, hours: defaultWeeklyHours() });
    setFormError(null);
    saveState.reset();
    setEditingId('new');
  }

  function beginEdit(location: Location) {
    setForm({
      name: location.name, address: location.address, phone: location.phone ?? '', branchId: location.branchId ?? '',
      timezone: location.timezone ?? clinic.timezone, active: location.active,
      hours: editableWeeklyHours(location.workingHours),
    });
    setFormError(null);
    saveState.reset();
    setEditingId(location.id);
  }

  async function saveLocation() {
    if (!form.name.trim() || !form.address.trim() || !form.branchId) {
      setFormError('Name, address, and an active scheduling branch are required.');
      return;
    }
    const workingHours = Object.fromEntries(DAY_OPTIONS.map(([day]) => [day, form.hours[day].open
      ? { open: true, start: form.hours[day].start, end: form.hours[day].end }
      : { open: false }])) as WeeklyHours;
    setFormError(null);
    const saved = await saveState.run(async () => {
      const payload = {
        name: form.name.trim(), address: form.address.trim(), phone: form.phone.trim() || null,
        branchId: form.branchId, timezone: form.timezone, active: form.active, workingHours,
      };
      if (editingId === 'new') await api.createLocation({ clinicId: clinic.id, ...payload });
      else if (editingId) await api.updateLocation(editingId, payload);
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

  function branchLabel(location: Location): string {
    if (branchFailure) return 'Branch mapping unavailable — scheduling branches could not be loaded';
    if (branchesLoading) return 'Loading scheduling branches…';
    return branches.find(branch => branch.id === location.branchId)?.name ?? 'Not mapped — booking disabled';
  }

  return (
    <div className="cc-card p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-t1 inline-flex items-center gap-2"><MapPin className="w-4 h-4 text-indigo" /> Locations</h3>
        <button type="button" onClick={editingId === 'new' ? () => setEditingId(null) : beginCreate} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-indigo hover:bg-[var(--s3)]">
          {editingId === 'new' ? <X className="w-3 h-3" /> : <Plus className="w-3 h-3" />} {editingId === 'new' ? 'Cancel new location' : 'Add location'}
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
              <p className="text-[11px] text-t3 truncate">{loc.address}{loc.phone ? ` · ${loc.phone}` : ''} · {loc.timezone ?? clinic.timezone}</p>
              <p className="text-[10px] text-t3 truncate">Scheduling branch: {branchLabel(loc)}</p>
            </div>
            <div className="flex gap-2">
              <button type="button" aria-label="Edit location" title="Edit location" onClick={() => beginEdit(loc)} className="text-t3 hover:text-indigo shrink-0"><Pencil className="w-3.5 h-3.5" /></button>
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
              ><Trash2 className="w-3.5 h-3.5" /></ConfirmedButton>
            </div>
          </div>
        ))}
      </div>
      {editingId && (
        <div className="grid gap-3 md:grid-cols-2 rounded-xl border border-dashed border-[var(--b2)] p-3">
          <Field label="Location name" required><TextInput value={form.name} onChange={e => setFormValue('name', e.target.value)} /></Field>
          <Field label="Scheduling branch" required>
            <Select value={form.branchId} disabled={branchesLoading || Boolean(branchFailure)} onChange={e => {
              const branch = branches.find(row => row.id === e.target.value);
              setForm(previous => ({ ...previous, branchId: e.target.value, timezone: branch?.timezone ?? previous.timezone }));
            }}>
              <option value="">{branchFailure ? 'Branches could not be loaded' : branchesLoading ? 'Loading branches…' : 'Select an active branch'}</option>
              {branches.filter(branch => branch.active || branch.id === form.branchId).map(branch => <option key={branch.id} value={branch.id} disabled={!branch.active}>{branch.name}{!branch.active ? ' (inactive)' : ''}</option>)}
            </Select>
          </Field>
          <Field label="Address" required><TextInput value={form.address} onChange={e => setFormValue('address', e.target.value)} /></Field>
          <Field label="Phone (E.164)"><TextInput placeholder="+12125550100" value={form.phone} onChange={e => setFormValue('phone', e.target.value)} /></Field>
          <Field label="Timezone" required><Select value={form.timezone} onChange={e => setFormValue('timezone', e.target.value)}>{TIMEZONE_OPTIONS.map(zone => <option key={zone}>{zone}</option>)}</Select></Field>
          <div className="space-y-2 md:col-span-2" aria-label="Location hours by day">
            <p className="text-xs font-semibold text-t2">Hours by day</p>
            {DAY_OPTIONS.map(([day, label]) => {
              const hours = form.hours[day];
              return (
                <div key={day} className="grid grid-cols-[110px_1fr_1fr] items-end gap-2 rounded-lg border border-[var(--b1)] p-2">
                  <Toggle
                    checked={hours.open}
                    onChange={open => setForm(previous => ({ ...previous, hours: { ...previous.hours, [day]: { ...previous.hours[day], open } } }))}
                    label={label}
                  />
                  <Field label="Open"><TextInput aria-label={`${label} open time`} disabled={!hours.open} type="time" value={hours.start} onChange={event => setForm(previous => ({ ...previous, hours: { ...previous.hours, [day]: { ...previous.hours[day], start: event.target.value } } }))} /></Field>
                  <Field label="Close"><TextInput aria-label={`${label} close time`} disabled={!hours.open} type="time" value={hours.end} onChange={event => setForm(previous => ({ ...previous, hours: { ...previous.hours, [day]: { ...previous.hours[day], end: event.target.value } } }))} /></Field>
                </div>
              );
            })}
          </div>
          <Toggle checked={form.active} onChange={value => setFormValue('active', value)} label="Location active" />
          <div className="flex items-end justify-end gap-2">
            <button type="button" onClick={() => setEditingId(null)} className="rounded-xl border border-[var(--b1)] px-3 py-2 text-sm font-semibold text-t2">Cancel</button>
            <button type="button" disabled={isBusy(saveState.state)} onClick={saveLocation} className="inline-flex items-center gap-2 rounded-xl bg-indigo px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">
              {isBusy(saveState.state) && <Loader2 className="w-4 h-4 animate-spin" />}{isBusy(saveState.state) ? 'Saving…' : 'Save location'}
            </button>
          </div>
          {formError && <p role="alert" className="md:col-span-2 text-xs font-semibold text-red-v">{formError}</p>}
          <MutationNotice state={saveState.state} showSaved={false} className="md:col-span-2" />
        </div>
      )}
    </div>
  );
}
