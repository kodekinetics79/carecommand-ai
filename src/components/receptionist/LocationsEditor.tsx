import { useEffect, useState } from 'react';
import { Plus, Trash2, MapPin, Pencil } from 'lucide-react';
import { Field, TextInput, Select, Toggle } from '../ui/Field';
import { receptionistApi as api, TIMEZONE_OPTIONS, type Clinic, type Location, type SchedulingBranch, type WeeklyHours } from '../../lib/receptionist';
import { ConfirmedButton } from './shared';

export function LocationsEditor({ clinic, onChanged }: { clinic: Clinic; onChanged: () => Promise<unknown> }) {
  const locations = clinic.locations ?? [];
  const [branches, setBranches] = useState<SchedulingBranch[]>([]);
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState({ name: '', address: '', phone: '', branchId: '', timezone: clinic.timezone, active: true, hoursStart: '09:00', hoursEnd: '17:00' });
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.listSchedulingBranches().then(rows => { if (active) setBranches(rows); }).catch(e => {
      if (active) setFormError(e instanceof Error ? e.message : 'Unable to load scheduling branches');
    });
    return () => { active = false; };
  }, []);

  const setFormValue = <K extends keyof typeof form>(key: K, value: typeof form[K]) => setForm(previous => ({ ...previous, [key]: value }));

  function beginCreate() {
    const branch = branches.find(row => row.active);
    setForm({ name: '', address: '', phone: '', branchId: branch?.id ?? '', timezone: branch?.timezone ?? clinic.timezone, active: true, hoursStart: '09:00', hoursEnd: '17:00' });
    setFormError(null);
    setEditingId('new');
  }

  function beginEdit(location: Location) {
    const monday = location.workingHours?.monday;
    setForm({
      name: location.name, address: location.address, phone: location.phone ?? '', branchId: location.branchId ?? '',
      timezone: location.timezone ?? clinic.timezone, active: location.active,
      hoursStart: monday?.start ?? '09:00', hoursEnd: monday?.end ?? '17:00',
    });
    setFormError(null);
    setEditingId(location.id);
  }

  async function saveLocation() {
    if (!form.name.trim() || !form.address.trim() || !form.branchId) {
      setFormError('Name, address, and an active scheduling branch are required.');
      return;
    }
    const weekdays: WeeklyHours = {
      monday: { open: true, start: form.hoursStart, end: form.hoursEnd },
      tuesday: { open: true, start: form.hoursStart, end: form.hoursEnd },
      wednesday: { open: true, start: form.hoursStart, end: form.hoursEnd },
      thursday: { open: true, start: form.hoursStart, end: form.hoursEnd },
      friday: { open: true, start: form.hoursStart, end: form.hoursEnd },
      saturday: { open: false }, sunday: { open: false },
    };
    setBusy(true);
    setFormError(null);
    try {
      const payload = {
        name: form.name.trim(), address: form.address.trim(), phone: form.phone.trim() || null,
        branchId: form.branchId, timezone: form.timezone, active: form.active, workingHours: weekdays,
      };
      if (editingId === 'new') await api.createLocation({ clinicId: clinic.id, ...payload });
      else if (editingId) await api.updateLocation(editingId, payload);
      setEditingId(null);
      await onChanged();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Unable to save location');
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    await api.deleteLocation(id);
    await onChanged();
  }

  return (
    <div className="cc-card p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-t1 inline-flex items-center gap-2"><MapPin className="w-4 h-4 text-indigo" /> Locations</h3>
        <button type="button" onClick={editingId === 'new' ? () => setEditingId(null) : beginCreate} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-indigo hover:bg-[var(--s3)]">
          <Plus className="w-3 h-3" /> Add location
        </button>
      </div>
      {locations.length === 0 && editingId !== 'new' && <p className="text-xs text-t3">No locations yet. Map a receptionist location to an active scheduling branch before calls can book.</p>}
      <div className="space-y-2">
        {locations.map(loc => (
          <div key={loc.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--b1)] px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-t1 truncate">{loc.name} {!loc.active && <span className="badge badge-amber">Inactive</span>}</p>
              <p className="text-[11px] text-t3 truncate">{loc.address}{loc.phone ? ` · ${loc.phone}` : ''} · {loc.timezone ?? clinic.timezone}</p>
              <p className="text-[10px] text-t3 truncate">Scheduling branch: {branches.find(branch => branch.id === loc.branchId)?.name ?? 'Not mapped — booking disabled'}</p>
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
            <Select value={form.branchId} onChange={e => {
              const branch = branches.find(row => row.id === e.target.value);
              setForm(previous => ({ ...previous, branchId: e.target.value, timezone: branch?.timezone ?? previous.timezone }));
            }}>
              <option value="">Select an active branch</option>
              {branches.filter(branch => branch.active || branch.id === form.branchId).map(branch => <option key={branch.id} value={branch.id} disabled={!branch.active}>{branch.name}{!branch.active ? ' (inactive)' : ''}</option>)}
            </Select>
          </Field>
          <Field label="Address" required><TextInput value={form.address} onChange={e => setFormValue('address', e.target.value)} /></Field>
          <Field label="Phone (E.164)"><TextInput placeholder="+12125550100" value={form.phone} onChange={e => setFormValue('phone', e.target.value)} /></Field>
          <Field label="Timezone" required><Select value={form.timezone} onChange={e => setFormValue('timezone', e.target.value)}>{TIMEZONE_OPTIONS.map(zone => <option key={zone}>{zone}</option>)}</Select></Field>
          <div className="grid grid-cols-2 gap-2"><Field label="Weekday open"><TextInput type="time" value={form.hoursStart} onChange={e => setFormValue('hoursStart', e.target.value)} /></Field><Field label="Weekday close"><TextInput type="time" value={form.hoursEnd} onChange={e => setFormValue('hoursEnd', e.target.value)} /></Field></div>
          <Toggle checked={form.active} onChange={value => setFormValue('active', value)} label="Location active" />
          <div className="flex items-end justify-end gap-2">
            <button type="button" onClick={() => setEditingId(null)} className="rounded-xl border border-[var(--b1)] px-3 py-2 text-sm font-semibold text-t2">Cancel</button>
            <button type="button" disabled={busy} onClick={saveLocation} className="rounded-xl bg-indigo px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">{busy ? 'Saving…' : 'Save location'}</button>
          </div>
          {formError && <p className="md:col-span-2 text-xs font-semibold text-red-v">{formError}</p>}
        </div>
      )}
    </div>
  );
}
