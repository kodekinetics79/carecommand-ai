import { useEffect, useId, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { Field, Select, TextInput } from '../ui/Field';
import { receptionistApi as api, type SchedulingBranch } from '../../lib/receptionist';
import { receptionistClinicApi, type ClinicRow } from '../../lib/receptionistClinic';
import { countryOptions, languageOptions, timezoneOptions, useReceptionistCatalog } from '../../lib/receptionistCatalog';
import { useResource } from '../../hooks/useResource';
import { receivedData, resourceFailure } from '../../lib/resourceState';
import { isBusy, useMutationState } from '../../hooks/useMutationState';
import { LoadFailureNotice, MutationNotice } from './MutationNotice';

const loadSchedulingBranches = () => api.listSchedulingBranches();

/**
 * Creating a clinic used to submit two fields and let the server fill in a
 * timezone, a language and a disclosure nobody chose (M22). Every one of
 * those is caller-facing: the timezone decides when the agent says the clinic
 * is open, and the country decides which emergency number it speaks. So they
 * are asked for here, defaulted from the tenant's own active scheduling
 * branch rather than from a constant, and nothing is submitted silently.
 */
export function CreateClinicDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (clinic: ClinicRow) => Promise<void> | void }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const branchesResource = useResource<SchedulingBranch[]>(loadSchedulingBranches);
  const branchFailure = resourceFailure(branchesResource.state);
  const branches = receivedData(branchesResource.state);
  const activeBranches = branches?.filter(branch => branch.active) ?? [];
  const catalogResource = useReceptionistCatalog();
  const catalog = receivedData(catalogResource.state);
  const createState = useMutationState();

  const [form, setForm] = useState({ name: '', phone: '', country: '', timezone: '', defaultLanguage: '' });
  const [seeded, setSeeded] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // Seed once, from the tenant's own data: the first active branch's timezone,
  // the country whose catalog entry matches it if there is exactly one, and
  // the first language that already has an approved pack for that country.
  if (!seeded && branches && catalog) {
    const timezone = activeBranches[0]?.timezone ?? '';
    const country = catalog.countries.find(entry => entry.defaultLanguages.length > 0 && catalog.localePacks.some(pack => pack.country === entry.code && pack.status === 'APPROVED'))?.code ?? '';
    const approved = catalog.localePacks.find(pack => pack.status === 'APPROVED' && (!country || pack.country === country));
    setSeeded(true);
    setForm(previous => ({ ...previous, timezone, country, defaultLanguage: approved?.language ?? '' }));
  }

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>('input')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); previouslyFocused?.focus(); };
  }, [onClose]);

  const set = <K extends keyof typeof form>(key: K, value: string) => setForm(previous => ({ ...previous, [key]: value }));
  const noBranch = Boolean(branches) && activeBranches.length === 0;
  const fieldErrors = createState.state.status === 'error' ? createState.state.fieldErrors : {};

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!form.name.trim() || !form.phone.trim() || !form.country || !form.timezone || !form.defaultLanguage) {
      setLocalError('Name, phone, country, timezone and default language are all required — none of them can be guessed for you.');
      return;
    }
    setLocalError(null);
    const created = await createState.run(() => receptionistClinicApi.createClinic({
      name: form.name.trim(), phone: form.phone.trim(), country: form.country, timezone: form.timezone, defaultLanguage: form.defaultLanguage,
    }));
    if (created) {
      await onCreated(created);
      onClose();
    }
  }

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-4" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/45 backdrop-blur-sm animate-fade-in" />
      <div ref={dialogRef} className="relative w-full max-w-lg glass-surface rounded-2xl p-5 animate-fade-up">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="text-sm font-bold text-t1">Create clinic</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-t2">The country and timezone decide what the agent tells callers — which emergency number it speaks, and when it says you are open. No live provider is contacted.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-t3 hover:text-t1"><X className="h-4 w-4" aria-hidden="true" /></button>
        </div>

        {branchFailure && <LoadFailureNotice what="Scheduling branches" message={branchFailure.message} onRetry={branchesResource.reload} className="mb-3" />}
        {noBranch && (
          <p role="alert" className="mb-3 rounded-lg border border-amber-v/40 bg-[var(--amber-soft)] px-3 py-2 text-xs font-semibold text-amber-v">
            Add an active scheduling branch first. A receptionist clinic takes its timezone from a branch, and cannot book without one.
          </p>
        )}

        <form className="space-y-3" onSubmit={submit}>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Clinic name" required>
              <TextInput value={form.name} placeholder="Example Health" onChange={e => set('name', e.target.value)} />
            </Field>
            <Field label="Trusted inbound phone number" required hint={fieldErrors.phone?.[0] ?? 'E.164, including the country code.'}>
              <TextInput value={form.phone} placeholder="+12125550100" aria-invalid={Boolean(fieldErrors.phone)} onChange={e => set('phone', e.target.value)} />
            </Field>
            <Field label="Country" required hint={fieldErrors.country?.[0] ?? 'Decides the emergency number the agent speaks.'}>
              <Select value={form.country} onChange={e => set('country', e.target.value)}>
                <option value="">{catalogResource.state.status === 'loading' ? 'Loading countries…' : 'Select a country'}</option>
                {countryOptions(catalog, form.country || null).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </Select>
            </Field>
            <Field label="Timezone" required hint={activeBranches[0] ? `Defaulted from branch ${activeBranches[0].name}.` : undefined}>
              <Select value={form.timezone} onChange={e => set('timezone', e.target.value)}>
                <option value="">{catalogResource.state.status === 'loading' ? 'Loading timezones…' : 'Select a timezone'}</option>
                {timezoneOptions(catalog, form.timezone || null).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </Select>
            </Field>
            <div className="md:col-span-2">
              <Field label="Default language" required hint="A campaign can only be activated in a language whose locale pack is approved.">
                <Select value={form.defaultLanguage} onChange={e => set('defaultLanguage', e.target.value)}>
                  <option value="">{catalogResource.state.status === 'loading' ? 'Loading languages…' : 'Select a language'}</option>
                  {languageOptions(catalog, form.defaultLanguage || null, form.country || null).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </Select>
              </Field>
            </div>
          </div>

          {localError && <p role="alert" className="text-[12px] font-semibold text-red-v">{localError}</p>}
          <MutationNotice state={createState.state} showSaved={false} />

          <div className="flex gap-2 pt-1">
            <button type="submit" disabled={noBranch || isBusy(createState.state)} className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--indigo)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
              {isBusy(createState.state) && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />} Create clinic
            </button>
            <button type="button" disabled={isBusy(createState.state)} onClick={onClose} className="rounded-xl border border-[var(--b1)] px-4 py-2 text-sm font-semibold text-t2 hover:bg-[var(--s2)] disabled:opacity-50">Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
