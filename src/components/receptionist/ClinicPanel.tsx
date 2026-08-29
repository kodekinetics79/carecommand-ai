import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Field, TextInput, TextArea, Select } from '../ui/Field';
import { receptionistApi as api, LANGUAGE_OPTIONS, TIMEZONE_OPTIONS, type Clinic } from '../../lib/receptionist';
import { ConfirmedButton, SaveBar } from './shared';
import { LocationsEditor } from './LocationsEditor';

// ===== Clinic Panel ========================================================

export function ClinicPanel({ clinic, onChanged }: { clinic: Clinic; onChanged: () => Promise<unknown> }) {
  const [draft, setDraft] = useState<Clinic>(clinic);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(clinic);
  const set = <K extends keyof Clinic>(key: K, value: Clinic[K]) => setDraft(prev => ({ ...prev, [key]: value }));

  async function save() {
    setBusy(true);
    try {
      await api.updateClinic(clinic.id, {
        name: draft.name, phone: draft.phone, logoUrl: draft.logoUrl, website: draft.website,
        addressLine: draft.addressLine, timezone: draft.timezone, defaultLanguage: draft.defaultLanguage,
        complianceDisclosure: draft.complianceDisclosure, humanFallbackNumber: draft.humanFallbackNumber,
        doNotContactPolicy: draft.doNotContactPolicy, active: draft.active,
      });
      await onChanged();
      setSavedAt(Date.now());
    } finally { setBusy(false); }
  }

  async function deleteClinic() {
    await api.deleteClinic(clinic.id);
    await onChanged();
  }

  return (
    <div className="space-y-4">
      <div className="cc-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-t1">Clinic Profile</h3>
          <ConfirmedButton
            dialogTitle="Delete clinic configuration?"
            message={`Delete ${clinic.name} and all receptionist campaigns under it? This cannot be undone.`}
            confirmLabel="Delete clinic"
            tone="red"
            onConfirm={deleteClinic}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-red-v hover:bg-[var(--red-soft)]"
          >
            <Trash2 className="w-3 h-3" /> Delete
          </ConfirmedButton>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Clinic name" required><TextInput value={draft.name} onChange={e => set('name', e.target.value)} /></Field>
          <Field label="Phone number" required><TextInput value={draft.phone} onChange={e => set('phone', e.target.value)} /></Field>
          <Field label="Website"><TextInput value={draft.website ?? ''} onChange={e => set('website', e.target.value)} placeholder="https://" /></Field>
          <Field label="Logo URL"><TextInput value={draft.logoUrl ?? ''} onChange={e => set('logoUrl', e.target.value)} placeholder="https://…/logo.png" /></Field>
          <Field label="Address"><TextInput value={draft.addressLine ?? ''} onChange={e => set('addressLine', e.target.value)} /></Field>
          <Field label="Human fallback number" hint="Used when a caller asks for a person or escalation is needed.">
            <TextInput value={draft.humanFallbackNumber ?? ''} onChange={e => set('humanFallbackNumber', e.target.value)} />
          </Field>
          <Field label="Timezone">
            <Select value={draft.timezone} onChange={e => set('timezone', e.target.value)}>
              {TIMEZONE_OPTIONS.map(tz => <option key={tz} value={tz}>{tz}</option>)}
            </Select>
          </Field>
          <Field label="Default language">
            <Select value={draft.defaultLanguage} onChange={e => set('defaultLanguage', e.target.value)}>
              {LANGUAGE_OPTIONS.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Approved opening disclosure" hint="Paste the exact clinic- and counsel-approved jurisdictional wording. It must identify the assistant as AI; text alone is not consent evidence." required>
          <TextArea rows={2} value={draft.complianceDisclosure} onChange={e => set('complianceDisclosure', e.target.value)} />
        </Field>
        <Field label="Do-not-contact policy" hint="How the agent handles a request to stop being contacted.">
          <TextArea rows={2} value={draft.doNotContactPolicy} onChange={e => set('doNotContactPolicy', e.target.value)} />
        </Field>
        <SaveBar dirty={dirty} busy={busy} onSave={save} savedAt={savedAt} />
      </div>

      <LocationsEditor clinic={clinic} onChanged={onChanged} />
    </div>
  );
}
