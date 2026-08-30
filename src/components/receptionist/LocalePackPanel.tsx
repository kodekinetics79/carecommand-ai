import { useState } from 'react';
import { CheckCircle2, Globe2, Loader2, ShieldCheck } from 'lucide-react';
import { Field, TextArea } from '../ui/Field';
import {
  canApproveLocalePack, groupPacks, previewValuesFor, receptionistClinicApi, renderPackTemplate, unknownPlaceholdersIn,
  PACK_PLACEHOLDERS, type ClinicRow, type LocalePackDefault, type LocalePackStrings, type LocalePackView, type LocalePacksResponse,
} from '../../lib/receptionistClinic';
import { useReceptionistCatalog } from '../../lib/receptionistCatalog';
import { useResource } from '../../hooks/useResource';
import { receivedData, resourceFailure } from '../../lib/resourceState';
import { useSession } from '../../hooks/useSession';
import { isBusy, useMutationState } from '../../hooks/useMutationState';
import { LoadFailureNotice, MutationNotice } from './MutationNotice';

const loadPacks = () => receptionistClinicApi.listLocalePacks();

/** The keys a reviewer is most likely to check first; the rest follow in server order. */
const PRIORITY_KEYS = ['disclosure.recording', 'disclosure.ai_acknowledgment', 'emergency.instruction', 'after_hours.line', 'voicemail.script'];

function orderedKeys(messages: Record<string, string>): string[] {
  const keys = Object.keys(messages);
  return [...PRIORITY_KEYS.filter(key => keys.includes(key)), ...keys.filter(key => !PRIORITY_KEYS.includes(key)).sort()];
}

/**
 * The words the agent says, versioned and approved as evidence.
 *
 * A pack is immutable once approved: an override is a new DRAFT version that
 * an OWNER or ADMIN approves, acknowledging the exact evidence hash shown on
 * screen. Previews are rendered client-side from the pack's own strings (the
 * server preview endpoint is a pilot cut), so what a reviewer reads here is
 * the same substitution the renderer performs.
 */
export function LocalePackPanel({ clinic }: { clinic: ClinicRow }) {
  const resource = useResource<LocalePacksResponse>(loadPacks);
  const failure = resourceFailure(resource.state);
  const data = receivedData(resource.state);
  const catalogResource = useReceptionistCatalog();
  const catalog = receivedData(catalogResource.state);
  const { user } = useSession();
  const canApprove = canApproveLocalePack(user?.role);
  const adoptState = useMutationState();

  const groups = groupPacks(data?.packs ?? []);
  const missing = (data?.defaults ?? []).filter(fallback => !groups.some(group => group.language === fallback.language && group.country === fallback.country));
  const catalogMissing = (catalog?.localePacks ?? []).filter(row => row.status === 'MISSING' && row.hasPlatformDefault
    && !missing.some(fallback => fallback.language === row.language && fallback.country === row.country)
    && !groups.some(group => group.language === row.language && group.country === row.country));

  async function adopt(language: string, country: string) {
    const created = await adoptState.run(() => receptionistClinicApi.createLocalePack({ language, country, from: { kind: 'platform_default' } }), { successMessage: 'Draft created from the platform default' });
    if (created) resource.reload();
  }

  return (
    <div className="cc-card p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-t1 inline-flex items-center gap-2"><Globe2 className="w-4 h-4 text-indigo" aria-hidden="true" /> Locale packs</h3>
        {!canApprove && <span className="badge badge-blue">Owner or Admin approval required</span>}
      </div>
      <p className="text-[11px] text-t3">Every caller-facing sentence, per language and country — the recording disclosure, the emergency instruction and the emergency number itself. An approved pack cannot be edited; changes create a new version to approve.</p>

      {resource.state.status === 'loading' && (
        <p className="inline-flex items-center gap-2 text-xs text-t3" aria-live="polite"><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Loading locale packs…</p>
      )}
      {failure && <LoadFailureNotice what="Locale packs" message={failure.message} onRetry={resource.reload} />}
      <MutationNotice state={adoptState.state} />

      {data && groups.length === 0 && missing.length === 0 && catalogMissing.length === 0 && (
        <p className="text-xs text-t3">No packs and no platform defaults are available for this workspace.</p>
      )}

      {missing.map(fallback => (
        <MissingPackRow key={`${fallback.language}/${fallback.country}`} language={fallback.language} country={fallback.country} defaultPack={fallback} busy={isBusy(adoptState.state)} onAdopt={() => adopt(fallback.language, fallback.country)} />
      ))}
      {catalogMissing.map(row => (
        <MissingPackRow key={`${row.language}/${row.country}`} language={row.language} country={row.country} defaultPack={null} busy={isBusy(adoptState.state)} onAdopt={() => adopt(row.language, row.country)} />
      ))}

      {groups.map(group => (
        <section key={group.key} className="space-y-2 rounded-xl border border-[var(--b1)] p-3" aria-label={`Locale pack ${group.language} ${group.country}`}>
          <h4 className="text-xs font-bold uppercase tracking-wide text-t3">{group.language} · {group.country}</h4>
          {group.packs.map(pack => (
            <PackRow key={pack.id} pack={pack} clinic={clinic} canApprove={canApprove} onChanged={resource.reload} />
          ))}
        </section>
      ))}
    </div>
  );
}

function MissingPackRow({ language, country, defaultPack, busy, onAdopt }: { language: string; country: string; defaultPack: LocalePackDefault | null; busy: boolean; onAdopt: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-amber-v/50 px-3 py-2.5" data-testid={`pack-missing-${language}-${country}`}>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-t1">{language} · {country} <span className="badge badge-amber">Missing</span></p>
        <p className="text-[11px] text-t3">No pack for this language and country, so a campaign in it cannot be activated.{defaultPack ? ` A platform default (v${defaultPack.version}, emergency number ${defaultPack.strings.emergencyNumber}) is available.` : ' A platform default is available.'}</p>
      </div>
      <button type="button" disabled={busy} onClick={onAdopt} className="inline-flex items-center gap-2 rounded-xl border border-[var(--b1)] px-3 py-1.5 text-xs font-semibold text-indigo hover:bg-[var(--s3)] disabled:opacity-40">
        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />} Adopt platform default
      </button>
    </div>
  );
}

function PackRow({ pack, clinic, canApprove, onChanged }: { pack: LocalePackView; clinic: ClinicRow; canApprove: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(pack.status === 'DRAFT');
  const [messages, setMessages] = useState<Record<string, string>>(pack.strings.messages);
  const [activeKey, setActiveKey] = useState<string>(() => orderedKeys(pack.strings.messages)[0] ?? '');
  const saveState = useMutationState();
  const approveState = useMutationState();
  const editable = pack.status === 'DRAFT';
  const dirty = JSON.stringify(messages) !== JSON.stringify(pack.strings.messages);
  const values = previewValuesFor(clinic, pack.strings);
  const template = messages[activeKey] ?? '';
  const unknown = unknownPlaceholdersIn(template);

  async function save() {
    const strings: Partial<LocalePackStrings> = { messages };
    const saved = await saveState.run(() => receptionistClinicApi.updateLocalePack(pack.id, { expectedUpdatedAt: pack.updatedAt, strings }));
    if (saved) onChanged();
  }

  async function approve() {
    const approved = await approveState.run(() => receptionistClinicApi.approveLocalePack(pack.id, { acknowledgedEvidenceHash: pack.evidenceHash }), { successMessage: 'Pack approved' });
    if (approved) onChanged();
  }

  const statusBadge = pack.status === 'APPROVED' ? 'badge-emerald' : pack.status === 'DRAFT' ? 'badge-amber' : 'badge-blue';

  return (
    <div className="rounded-xl border border-[var(--b1)] px-3 py-2.5 space-y-2" data-testid={`pack-${pack.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-t1">Version {pack.version} <span className={`badge ${statusBadge}`}>{pack.status}</span></p>
          <p className="text-[11px] text-t3">
            Emergency number {pack.strings.emergencyNumber} · {pack.strings.timeStyle} · {pack.approvedBy ? `approved by ${pack.approvedBy.displayName}` : pack.status === 'DRAFT' ? 'not approved' : 'retired'}
            {pack.boundActiveCampaigns > 0 ? ` · ${pack.boundActiveCampaigns} active campaign${pack.boundActiveCampaigns === 1 ? '' : 's'} bound` : ''}
          </p>
          <p className="font-mono text-[10px] text-t3 break-all">evidence {pack.evidenceHash}</p>
        </div>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-t2 hover:bg-[var(--s3)]">{open ? 'Hide wording' : 'Review wording'}</button>
      </div>

      {open && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Message keys">
            {orderedKeys(messages).map(key => (
              <button key={key} type="button" aria-pressed={key === activeKey} onClick={() => setActiveKey(key)} className={`rounded-lg border px-2 py-1 font-mono text-[10px] ${key === activeKey ? 'border-indigo bg-[var(--indigo-soft)] text-indigo' : 'border-[var(--b1)] text-t3 hover:text-t2'}`}>{key}</button>
            ))}
          </div>

          <Field label={editable ? `Wording for ${activeKey}` : `Approved wording for ${activeKey}`}>
            <TextArea rows={3} readOnly={!editable} value={template} onChange={e => setMessages(previous => ({ ...previous, [activeKey]: e.target.value }))} />
          </Field>

          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Available placeholders">
            {PACK_PLACEHOLDERS.map(placeholder => (
              <button
                key={placeholder}
                type="button"
                disabled={!editable}
                aria-pressed={template.includes(`{{${placeholder}}}`)}
                onClick={() => setMessages(previous => ({ ...previous, [activeKey]: `${previous[activeKey] ?? ''}{{${placeholder}}}` }))}
                className={`rounded-full border px-2 py-0.5 font-mono text-[10px] disabled:opacity-40 ${template.includes(`{{${placeholder}}}`) ? 'border-indigo bg-[var(--indigo-soft)] text-indigo' : 'border-[var(--b1)] text-t3'}`}
              >{`{{${placeholder}}}`}</button>
            ))}
          </div>

          {unknown.length > 0 && (
            <p role="alert" className="text-xs font-semibold text-red-v">Unknown placeholder{unknown.length === 1 ? '' : 's'}: {unknown.map(name => `{{${name}}}`).join(', ')}. The server will refuse this pack.</p>
          )}

          <div className="rounded-lg border border-[var(--b1)] bg-[var(--s3)] px-3 py-2">
            <p className="text-[10px] font-bold uppercase tracking-wide text-t3">Preview — what the caller hears</p>
            <p className="mt-0.5 text-xs text-t1" data-testid={`preview-${pack.id}`}>{renderPackTemplate(template, values) || '—'}</p>
          </div>

          {editable && (
            <>
              <MutationNotice state={saveState.state} showSaved={false} />
              <div className="flex justify-end">
                <button type="button" disabled={!dirty || isBusy(saveState.state)} onClick={save} className="inline-flex items-center gap-2 rounded-xl border border-[var(--b1)] px-3 py-1.5 text-xs font-semibold text-t2 hover:bg-[var(--s3)] disabled:opacity-40">
                  {isBusy(saveState.state) && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />} Save draft wording
                </button>
              </div>
            </>
          )}

          {pack.status === 'DRAFT' && (
            <div className="space-y-2 rounded-lg border border-[var(--b1)] p-2.5">
              <p className="text-[11px] text-t3 inline-flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" /> Approving records this exact wording as evidence under hash <span className="font-mono break-all">{pack.evidenceHash}</span> and retires the previous approved version.</p>
              <MutationNotice state={approveState.state} />
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={!canApprove || dirty || isBusy(approveState.state)}
                  title={!canApprove ? 'Owner or Admin approval required' : dirty ? 'Save the wording before approving it' : undefined}
                  onClick={approve}
                  className="inline-flex items-center gap-2 rounded-xl bg-indigo px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
                >
                  {isBusy(approveState.state) ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />} Approve pack
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
