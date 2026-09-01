import { useMemo, useState } from 'react';
import { AlertTriangle, RefreshCw, Trash2 } from 'lucide-react';
import { Field, TextInput, TextArea, Select } from '../ui/Field';
import { receptionistApi as api, type WeeklyHours } from '../../lib/receptionist';
import { changedKeys, receptionistClinicApi, sameWeeklyHours, type ClinicPatchInput, type ClinicRow } from '../../lib/receptionistClinic';
import { countryOptions, languageOptions, packStatusFor, timezoneOptions, useReceptionistCatalog, type SelectOption } from '../../lib/receptionistCatalog';
import { receivedData, resourceFailure } from '../../lib/resourceState';
import { isBusy, savedAtOf, useMutationState } from '../../hooks/useMutationState';
import type { TimeStyle } from '../../lib/clinicTime';
import { ConfirmedButton, SaveBar } from './shared';
import { LoadFailureNotice, MutationNotice } from './MutationNotice';
import { LocationsEditor } from './LocationsEditor';
import { HoursEditor } from './HoursEditor';
import { ClosuresEditor } from './ClosuresEditor';
import { TransferReadinessBadge } from './TransferReadinessBadge';

// ===== Clinic Panel ========================================================

/** The editable subset, with every optional string normalised to `null` when blank. */
interface ClinicDraft {
  name: string;
  phone: string;
  inboundNumber: string | null;
  logoUrl: string | null;
  website: string | null;
  addressLine: string | null;
  country: string | null;
  timezone: string;
  defaultLanguage: string;
  complianceDisclosure: string | null;
  humanFallbackNumber: string | null;
  doNotContactPolicy: string | null;
  workingHours: WeeklyHours | null;
  active: boolean;
}

const DRAFT_KEYS: Array<keyof ClinicDraft> = [
  'name', 'phone', 'inboundNumber', 'logoUrl', 'website', 'addressLine', 'country', 'timezone', 'defaultLanguage',
  'complianceDisclosure', 'humanFallbackNumber', 'doNotContactPolicy', 'workingHours', 'active',
];

const blank = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? '';
  return trimmed ? trimmed : null;
};

function toDraft(clinic: ClinicRow): ClinicDraft {
  return {
    name: clinic.name,
    phone: clinic.phone,
    inboundNumber: blank(clinic.inboundNumber),
    logoUrl: blank(clinic.logoUrl),
    website: blank(clinic.website),
    addressLine: blank(clinic.addressLine),
    country: blank(clinic.country ?? null),
    timezone: clinic.timezone,
    defaultLanguage: clinic.defaultLanguage,
    complianceDisclosure: blank(clinic.complianceDisclosure),
    humanFallbackNumber: blank(clinic.humanFallbackNumber),
    doNotContactPolicy: blank(clinic.doNotContactPolicy),
    workingHours: clinic.workingHours ?? null,
    active: clinic.active,
  };
}

const HTTP_URL = /^https?:\/\/\S+$/i;

/** Preview wording only; the approved pack decides what the agent actually says. */
function previewTimeStyle(language: string): TimeStyle {
  return /^en-(US|CA)$/i.test(language) ? '12h' : '24h';
}

function GroupedOptions({ options }: { options: SelectOption[] }) {
  const groups = new Map<string, SelectOption[]>();
  for (const option of options) {
    const key = option.group ?? '';
    groups.set(key, [...(groups.get(key) ?? []), option]);
  }
  return (
    <>
      {[...groups.entries()].map(([group, items]) => group
        ? <optgroup key={group} label={group}>{items.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</optgroup>
        : items.map(option => <option key={option.value} value={option.value}>{option.label}</option>))}
    </>
  );
}

export function ClinicPanel({ clinic, onChanged }: { clinic: ClinicRow; onChanged: () => Promise<unknown> }) {
  const stored = useMemo(() => toDraft(clinic), [clinic]);
  const [baselineKey, setBaselineKey] = useState(() => JSON.stringify(stored));
  const [draft, setDraft] = useState<ClinicDraft>(stored);
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});
  const saveState = useMutationState();
  const removeState = useMutationState();
  const catalogResource = useReceptionistCatalog();
  const catalog = receivedData(catalogResource.state);
  const catalogFailure = resourceFailure(catalogResource.state);
  const readiness = clinic.readiness;

  // The row the server holds is the source of truth: after a reload (our own
  // save, or the STALE_REVISION "Reload" action) the draft restarts from it.
  // Done during render rather than in an effect so the very first paint after
  // a reload already shows the server's values instead of the stale draft.
  //
  // Compared by VALUE. The identity compare this replaces reset the draft on
  // every reload of the clinic list — so adding a location below, or any
  // sibling panel calling `onChanged`, silently discarded half-typed hours and
  // disclosure edits even though not one stored field had changed.
  const storedKey = JSON.stringify(stored);
  if (baselineKey !== storedKey) {
    setBaselineKey(storedKey);
    setDraft(stored);
  }

  const hoursDirty = !sameWeeklyHours(stored.workingHours, draft.workingHours);
  const changes = changedKeys(stored, draft, DRAFT_KEYS.filter(key => key !== 'workingHours'));
  const dirty = Object.keys(changes).length > 0 || hoursDirty;
  const set = <K extends keyof ClinicDraft>(key: K, value: ClinicDraft[K]) => setDraft(prev => ({ ...prev, [key]: value }));
  const setText = (key: 'inboundNumber' | 'logoUrl' | 'website' | 'addressLine' | 'complianceDisclosure' | 'humanFallbackNumber' | 'doNotContactPolicy', value: string) => set(key, blank(value));

  const serverFieldErrors = saveState.state.status === 'error' ? saveState.state.fieldErrors : {};
  const fieldError = (key: string): string | null => localErrors[key] ?? serverFieldErrors[key]?.[0] ?? null;
  const stale = saveState.state.status === 'error' && saveState.state.code === 'STALE_REVISION';

  async function save() {
    const nextLocal: Record<string, string> = {};
    if (draft.website && !HTTP_URL.test(draft.website)) nextLocal.website = 'Enter a full URL starting with http:// or https://';
    if (draft.logoUrl && !HTTP_URL.test(draft.logoUrl)) nextLocal.logoUrl = 'Enter a full URL starting with http:// or https://';
    setLocalErrors(nextLocal);
    if (Object.keys(nextLocal).length > 0) return;

    const body: ClinicPatchInput = { ...changes };
    if (hoursDirty) body.workingHours = draft.workingHours;
    if (clinic.updatedAt) body.expectedUpdatedAt = clinic.updatedAt;
    await saveState.run(async () => {
      await receptionistClinicApi.updateClinic(clinic.id, body);
      await onChanged();
    });
  }

  async function reloadAfterStale() {
    saveState.reset();
    await onChanged();
  }

  async function deleteClinic() {
    // rethrow: the confirmation dialog stays open and shows the cause itself.
    await removeState.run(async () => {
      await api.deleteClinic(clinic.id);
      await onChanged();
    }, { rethrow: true });
  }

  const pack = packStatusFor(catalog, draft.defaultLanguage, draft.country);
  const timeStyle = previewTimeStyle(draft.defaultLanguage);

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
            disabled={isBusy(removeState.state)}
            onConfirm={deleteClinic}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-red-v hover:bg-[var(--red-soft)]"
          >
            <Trash2 className="w-3 h-3" aria-hidden="true" /> Delete
          </ConfirmedButton>
        </div>
        <MutationNotice state={removeState.state} showSaved={false} />
        {catalogFailure && (
          <LoadFailureNotice what="The receptionist catalog" message={`${catalogFailure.message} Country, timezone and language lists cannot be offered; the stored values are shown as-is.`} onRetry={catalogResource.reload} />
        )}
        {!draft.country && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-v/40 bg-[var(--amber-soft)] px-3 py-2 text-xs text-amber-v" data-testid="country-blocker">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-semibold">Country not set — activation is blocked</p>
              <p>Emergency wording and phone formatting depend on this. Choose the country the clinic operates in.</p>
            </div>
          </div>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Clinic name" required><TextInput value={draft.name} onChange={e => set('name', e.target.value)} /></Field>
          <Field label="Phone number" required hint={fieldError('phone') ?? undefined}>
            <TextInput value={draft.phone} aria-invalid={Boolean(fieldError('phone'))} onChange={e => set('phone', e.target.value)} />
          </Field>
          <Field label="AI voice line" hint={fieldError('inboundNumber') ?? 'The dedicated number patients dial to reach this receptionist. Leave blank until a line is assigned.'}>
            <TextInput value={draft.inboundNumber ?? ''} placeholder="+12125550100" aria-invalid={Boolean(fieldError('inboundNumber'))} onChange={e => setText('inboundNumber', e.target.value)} />
          </Field>
          <Field label="Website" hint={fieldError('website') ?? undefined}>
            <TextInput value={draft.website ?? ''} placeholder="https://" aria-invalid={Boolean(fieldError('website'))} onChange={e => setText('website', e.target.value)} />
          </Field>
          <Field label="Logo URL" hint={fieldError('logoUrl') ?? undefined}>
            <TextInput value={draft.logoUrl ?? ''} placeholder="https://…/logo.png" aria-invalid={Boolean(fieldError('logoUrl'))} onChange={e => setText('logoUrl', e.target.value)} />
          </Field>
          <Field label="Address"><TextInput value={draft.addressLine ?? ''} onChange={e => setText('addressLine', e.target.value)} /></Field>
          <div className="space-y-1.5">
            <Field label="Human fallback number" hint={fieldError('humanFallbackNumber') ?? 'Used when a caller asks for a person or escalation is needed. Clear it to disable transfers.'}>
              <TextInput value={draft.humanFallbackNumber ?? ''} placeholder="+12125550100" aria-invalid={Boolean(fieldError('humanFallbackNumber'))} onChange={e => setText('humanFallbackNumber', e.target.value)} />
            </Field>
            <TransferReadinessBadge readiness={dirty ? undefined : readiness} fallbackNumber={draft.humanFallbackNumber} />
          </div>
          <Field label="Country" required hint="ISO country. Never inferred from the timezone.">
            <Select value={draft.country ?? ''} disabled={catalogResource.state.status === 'loading'} onChange={e => set('country', e.target.value || null)}>
              <option value="">{catalogResource.state.status === 'loading' ? 'Loading countries…' : 'Select a country'}</option>
              <GroupedOptions options={countryOptions(catalog, draft.country)} />
            </Select>
          </Field>
          <Field label="Timezone" required>
            <Select value={draft.timezone} onChange={e => set('timezone', e.target.value)}>
              <GroupedOptions options={timezoneOptions(catalog, draft.timezone)} />
            </Select>
          </Field>
          <Field label="Default language" required hint={pack ? (pack.status === 'APPROVED' ? 'An approved locale pack exists for this language and country.' : pack.status === 'DRAFT' ? 'The locale pack for this language and country is still a draft — approve it in the Knowledge tab.' : 'No locale pack for this language and country yet — adopt one in the Knowledge tab.') : undefined}>
            <Select value={draft.defaultLanguage} onChange={e => set('defaultLanguage', e.target.value)}>
              <GroupedOptions options={languageOptions(catalog, draft.defaultLanguage, draft.country)} />
            </Select>
          </Field>
        </div>
        <Field label="Supplemental opening disclosure" hint="Optional sentence added to the locale pack's disclosure. The pack carries the baseline AI and recording wording; this is for clinic- or counsel-specific additions.">
          <TextArea rows={2} value={draft.complianceDisclosure ?? ''} onChange={e => setText('complianceDisclosure', e.target.value)} />
        </Field>
        <Field label="Do-not-contact policy note" hint="Optional staff note on how stop requests are handled. The spoken acknowledgement comes from the locale pack.">
          <TextArea rows={2} value={draft.doNotContactPolicy ?? ''} onChange={e => setText('doNotContactPolicy', e.target.value)} />
        </Field>
        <HoursEditor label="Opening hours" value={draft.workingHours} onChange={next => set('workingHours', next)} timeStyle={timeStyle} />
        {stale ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-v/40 bg-[var(--amber-soft)] px-3 py-2 text-xs text-amber-v">
            <span className="font-semibold">Someone else saved this clinic; reload to see their changes.</span>
            <button type="button" onClick={reloadAfterStale} className="inline-flex items-center gap-1 rounded-lg border border-amber-v/40 px-2.5 py-1 text-[11px] font-semibold hover:bg-[var(--s2)]"><RefreshCw className="h-3 w-3" aria-hidden="true" /> Reload</button>
          </div>
        ) : (
          <MutationNotice state={saveState.state} showSaved={false} onRetry={dirty ? save : undefined} />
        )}
        <SaveBar dirty={dirty} busy={isBusy(saveState.state)} onSave={save} savedAt={savedAtOf(saveState.state)} />
      </div>

      <LocationsEditor clinic={clinic} onChanged={onChanged} />
      <ClosuresEditor clinicId={clinic.id} locations={clinic.locations ?? []} timezone={clinic.timezone} locale={clinic.defaultLanguage} />
    </div>
  );
}
