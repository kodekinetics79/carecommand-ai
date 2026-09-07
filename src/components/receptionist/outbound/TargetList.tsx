import { useCallback, useEffect, useState } from 'react';
import { Check, Phone, PhoneOutgoing, Search, Settings2, UsersRound } from 'lucide-react';
import { Select } from '../../ui/Field';
import { receptionistApi as api, type OutboundCampaign, type CallTarget, type OutboundTargetCandidate, type OutboundTargetCandidateAppointment } from '../../../lib/receptionist';
import { ApiError } from '../../../lib/api';
import { describeFailure, type ResourceFailure } from '../../../lib/resourceState';
import { isBusy, useMutationState } from '../../../hooks/useMutationState';
import { formatEnumLabel, maskedPhone } from '../helpers';
import { ConfirmedButton } from '../shared';
import { LoadFailureNotice, MutationNotice } from '../MutationNotice';

/**
 * Why the candidate list is not showing rows. `policy_missing` is the 409 the
 * server answers when the campaign has no purpose / legal basis / policy
 * version yet: that is a configuration step, not a load failure, and it gets
 * a guided state instead of the red "could not be loaded" notice.
 */
type CandidateState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'policy_missing'; message: string }
  | { status: 'error'; failure: ResourceFailure };

export const POLICY_MISSING_GUIDANCE = 'Set purpose, legal basis and policy version on this campaign before selecting targets.';

function candidateFailureState(error: unknown): CandidateState {
  if (error instanceof ApiError && error.status === 409) return { status: 'policy_missing', message: error.message };
  return { status: 'error', failure: describeFailure(error) };
}

function appointmentOptionLabel(appointment: OutboundTargetCandidateAppointment): string {
  let when = appointment.startsAt;
  try {
    when = new Intl.DateTimeFormat(undefined, {
      timeZone: appointment.timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(appointment.startsAt));
  } catch {
    // The server is authoritative for timezone validity. If a malformed value
    // still reaches the browser, show the ISO instant instead of hiding the row.
  }
  return [
    when,
    appointment.service,
    appointment.clinician ? `with ${appointment.clinician}` : null,
    appointment.location,
  ].filter(Boolean).join(' · ');
}

export function TargetList({ campaign, targets, onAdded, onCall, canCall, onConfigure }: {
  campaign: OutboundCampaign;
  targets: CallTarget[];
  onAdded: () => void;
  onCall: (t: CallTarget) => void;
  canCall: boolean;
  /** Takes the user to where purpose / legal basis / policy version are set. */
  onConfigure?: () => void;
}) {
  const [candidates, setCandidates] = useState<OutboundTargetCandidate[]>([]);
  const [candidateState, setCandidateState] = useState<CandidateState>({ status: 'loading' });
  const targetIdentityKey = targets
    .map(target => target.patientId ?? target.leadId ?? target.id)
    .sort()
    .join(',');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedCandidates, setSelectedCandidates] = useState<string[]>([]);
  const [selectedAppointments, setSelectedAppointments] = useState<Record<string, string>>({});
  const addState = useMutationState();
  const removeState = useMutationState();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const busy = isBusy(addState.state) || isBusy(removeState.state);

  const loadCandidates = useCallback(async () => {
    setCandidateState({ status: 'loading' });
    try {
      const rows = await api.listOutboundTargetCandidates(campaign.id);
      setCandidates(rows);
      setCandidateState({ status: 'ready' });
    } catch (error) {
      setCandidateState(candidateFailureState(error));
    }
  }, [campaign.id]);

  useEffect(() => {
    let active = true;
    void api.listOutboundTargetCandidates(campaign.id).then(rows => {
      if (!active) return;
      setCandidates(rows);
      setCandidateState({ status: 'ready' });
    }).catch(error => {
      if (active) setCandidateState(candidateFailureState(error));
    });
    return () => { active = false; };
  }, [campaign.id, targetIdentityKey]);

  const reminderCampaign = campaign.purpose === 'APPOINTMENT_REMINDER';
  const candidateKey = (candidate: OutboundTargetCandidate) => `${candidate.type}:${candidate.id}`;
  const alreadyAdded = new Set(targets.map(target => target.patientId ? `patient:${target.patientId}` : target.leadId ? `lead:${target.leadId}` : ''));
  const candidateIsSelectable = (candidate: OutboundTargetCandidate) => candidate.voiceAuthorizationReady
    && !alreadyAdded.has(candidateKey(candidate))
    && (!reminderCampaign || (candidate.type === 'patient' && candidate.appointments.length > 0));
  const normalizedQuery = query.trim().toLowerCase();
  const visibleCandidates = candidates.filter(candidate => !normalizedQuery
    || candidate.name.toLowerCase().includes(normalizedQuery)
    || candidate.phone.includes(normalizedQuery));
  const selectableVisible = visibleCandidates.filter(candidateIsSelectable);
  const allVisibleSelected = selectableVisible.length > 0 && selectableVisible.every(candidate => selectedCandidates.includes(candidateKey(candidate)));

  function toggleCandidate(candidate: OutboundTargetCandidate) {
    if (!candidateIsSelectable(candidate)) return;
    const key = candidateKey(candidate);
    setSelectedCandidates(current => current.includes(key) ? current.filter(value => value !== key) : [...current, key]);
    if (reminderCampaign && candidate.type === 'patient' && candidate.appointments.length === 1) {
      setSelectedAppointments(current => ({ ...current, [key]: candidate.appointments[0].appointmentId }));
    }
  }

  function toggleAllVisible() {
    const visibleKeys = selectableVisible.map(candidateKey);
    setSelectedCandidates(current => allVisibleSelected
      ? current.filter(key => !visibleKeys.includes(key))
      : Array.from(new Set([...current, ...visibleKeys])));
    if (!allVisibleSelected && reminderCampaign) {
      setSelectedAppointments(current => ({
        ...current,
        ...Object.fromEntries(selectableVisible
          .filter(candidate => candidate.type === 'patient' && candidate.appointments.length === 1)
          .map(candidate => [candidateKey(candidate), candidate.appointments[0].appointmentId])),
      }));
    }
  }

  async function addSelected() {
    const selectedRows = candidates.filter(candidate => selectedCandidates.includes(candidateKey(candidate)) && candidateIsSelectable(candidate));
    const payload = selectedRows.flatMap(candidate => {
      const appointmentId = selectedAppointments[candidateKey(candidate)];
      if (reminderCampaign && (!appointmentId || candidate.type !== 'patient')) return [];
      return [{
        ...(candidate.type === 'patient' ? { patientId: candidate.id } : { leadId: candidate.id }),
        ...(appointmentId ? { appointmentId } : {}),
      }];
    });
    if (payload.length === 0 || payload.length !== selectedRows.length) return;
    await addState.run(async () => {
      await api.addTargets(campaign.id, payload);
      setSelectedCandidates([]);
      setSelectedAppointments({});
      setQuery('');
      setPickerOpen(false);
      onAdded();
    }, { successMessage: `${payload.length} ${payload.length === 1 ? 'person' : 'people'} added to this call list` });
  }

  async function remove(target: CallTarget) {
    setDeletingId(target.id);
    try {
      await removeState.run(async () => {
        await api.deleteTarget(campaign.id, target.id);
        onAdded();
      }, { rethrow: true });
    } finally {
      setDeletingId(null);
    }
  }

  const policyMissing = candidateState.status === 'policy_missing';
  const selectedRows = candidates.filter(candidate => selectedCandidates.includes(candidateKey(candidate)));
  const selectedMissingAppointment = reminderCampaign && selectedRows.some(candidate => !selectedAppointments[candidateKey(candidate)]);
  const addDisabled = busy || selectedRows.length === 0 || selectedMissingAppointment;

  return (
    <div className="cc-card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--b1)] px-5 py-4">
        <div>
          <h4 className="flex items-center gap-2 text-sm font-bold text-t1"><Phone className="h-4 w-4 text-indigo" /> People to contact</h4>
          <p className="mt-1 text-xs text-t3">{targets.length} {targets.length === 1 ? 'person' : 'people'} saved to this call list</p>
        </div>
        <button
          type="button"
          disabled={policyMissing}
          onClick={() => setPickerOpen(open => !open)}
          className="inline-flex items-center gap-2 rounded-xl bg-indigo px-3.5 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
        >
          <UsersRound className="h-4 w-4" aria-hidden="true" /> {pickerOpen ? 'Close patient picker' : 'Add patients'}
        </button>
      </div>
      <div className="space-y-3 p-5">
      {candidateState.status === 'error' && (
        <LoadFailureNotice
          what="Authorized target candidates"
          message={`${candidateState.failure.message} Existing rows are preserved; do not infer that no candidates exist.`}
          onRetry={() => void loadCandidates()}
        />
      )}
      {policyMissing && (
        <div role="status" className="flex flex-wrap items-start gap-2 rounded-lg border border-amber-v/40 bg-amber-v/5 px-3 py-2 text-xs text-amber-v">
          <Settings2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-t1">{POLICY_MISSING_GUIDANCE}</p>
            <p className="mt-0.5 text-t2">Targets cannot be selected until the campaign states why it is calling and under which authority. {candidateState.message}</p>
            {onConfigure && (
              <button type="button" onClick={onConfigure} className="mt-1.5 rounded-lg border border-amber-v/40 px-2.5 py-1 text-[11px] font-semibold text-amber-v hover:bg-[var(--s2)]">Go to campaign settings</button>
            )}
          </div>
        </div>
      )}
      {reminderCampaign && pickerOpen && !policyMissing && candidateState.status !== 'error' && (
        <div className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-xs text-t2">
          <span className="font-semibold text-t1">Appointment confirmation:</span> choose the patient and the exact upcoming visit this call is about. CareCommand reads the appointment again when the call is placed, so the receptionist does not rely on static campaign text.
        </div>
      )}
      {pickerOpen && !policyMissing && candidateState.status !== 'error' && (
        <div className="overflow-hidden rounded-2xl border border-[var(--b1)] bg-[var(--s1)]">
          <div className="flex flex-col gap-3 border-b border-[var(--b1)] bg-[var(--s2)] p-3 sm:flex-row sm:items-center sm:justify-between">
            <label className="relative block flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-t3" aria-hidden="true" />
              <span className="sr-only">Search patients</span>
              <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by name or phone" className="h-10 w-full rounded-xl border border-[var(--b1)] bg-[var(--s1)] pl-9 pr-3 text-sm text-t1 outline-none transition focus:border-indigo focus:ring-2 focus:ring-indigo/20" />
            </label>
            <button type="button" disabled={selectableVisible.length === 0} onClick={toggleAllVisible} className="rounded-lg px-3 py-2 text-xs font-semibold text-indigo hover:bg-[var(--indigo-soft)] disabled:opacity-50">
              {allVisibleSelected ? 'Clear shown' : `Select all shown (${selectableVisible.length})`}
            </button>
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            {candidateState.status === 'loading' && <p className="p-5 text-sm text-t3">Loading patients…</p>}
            {candidateState.status === 'ready' && visibleCandidates.length === 0 && <p className="p-5 text-sm text-t3">No patients match this search.</p>}
            {candidateState.status === 'ready' && visibleCandidates.map(candidate => {
              const key = candidateKey(candidate);
              const selectable = candidateIsSelectable(candidate);
              const selected = selectedCandidates.includes(key);
              const unavailableReason = alreadyAdded.has(key)
                ? 'Already on this list'
                : !candidate.voiceAuthorizationReady
                  ? formatEnumLabel(candidate.voiceAuthorizationReason)
                  : reminderCampaign && (candidate.type !== 'patient' || candidate.appointments.length === 0)
                    ? 'No upcoming appointment'
                    : null;
              return (
                <div key={key} className={`border-b border-[var(--b1)] px-3 py-3 last:border-b-0 ${selected ? 'bg-[var(--indigo-soft)]' : ''}`}>
                  <div className="flex items-start gap-3">
                    <input type="checkbox" aria-label={`Select ${candidate.name}`} checked={selected} disabled={!selectable} onChange={() => toggleCandidate(candidate)} className="mt-1 h-4 w-4 rounded border-[var(--b2)] text-indigo focus:ring-indigo" />
                    <button type="button" disabled={!selectable} onClick={() => toggleCandidate(candidate)} className="min-w-0 flex-1 text-left disabled:cursor-not-allowed">
                      <span className="block text-sm font-semibold text-t1">{candidate.name}</span>
                      <span className="mt-0.5 block text-xs text-t3">{maskedPhone(candidate.phone)} · {candidate.type === 'patient' ? 'Patient' : 'Lead'}</span>
                    </button>
                    {unavailableReason ? <span className="rounded-full bg-[var(--s3)] px-2 py-1 text-[10px] font-semibold text-t3">{unavailableReason}</span> : <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-v"><Check className="h-3 w-3" aria-hidden="true" /> Ready</span>}
                  </div>
                  {reminderCampaign && selected && candidate.type === 'patient' && (
                    <div className="ml-7 mt-2">
                      <Select aria-label={`Appointment for ${candidate.name}`} value={selectedAppointments[key] ?? ''} onChange={event => setSelectedAppointments(current => ({ ...current, [key]: event.target.value }))}>
                        <option value="">Select the appointment this call is about</option>
                        {candidate.appointments.map(appointment => <option key={appointment.appointmentId} value={appointment.appointmentId}>{appointmentOptionLabel(appointment)}</option>)}
                      </Select>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--b1)] bg-[var(--s2)] p-3">
            <p className="text-xs font-semibold text-t2">{selectedRows.length} selected</p>
            <button type="button" disabled={addDisabled} onClick={addSelected} className="inline-flex items-center gap-2 rounded-xl bg-indigo px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
              Save to list
            </button>
          </div>
        </div>
      )}
      <MutationNotice state={addState.state} onRetry={selectedRows.length > 0 && !selectedMissingAppointment ? addSelected : undefined} />
      <MutationNotice state={removeState.state} showSaved={false} />
      {targets.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-[var(--b1)]">
          <table className="min-w-[680px] w-full text-left text-xs">
            <thead className="bg-[var(--s2)] text-t3"><tr><th className="px-3 py-2.5 font-semibold">Person</th><th className="px-3 py-2.5 font-semibold">Status</th><th className="px-3 py-2.5 font-semibold">Visit</th><th className="px-3 py-2.5 text-right font-semibold">Actions</th></tr></thead>
            <tbody>
              {targets.map(t => (
                (() => {
                  const candidate = candidates.find(item => item.id === (t.patientId ?? t.leadId));
                  const consentReady = candidate?.voiceAuthorizationReady === true;
                  return (
                <tr key={t.id} className="border-t border-[var(--b1)] first:border-t-0">
                  <td className="px-3 py-3"><span className="block font-semibold text-t1">{[t.firstName, t.lastName].filter(Boolean).join(' ') || 'Saved contact'}</span><span className="text-t3">{maskedPhone(t.phone)}</span></td>
                  <td className="px-3 py-3"><span className="badge badge-blue">{formatEnumLabel(t.status)}</span></td>
                  <td className="px-3 py-3 text-t3">{t.appointmentId ? 'Appointment linked' : '—'}</td>
                  <td className="px-3 py-3"><div className="flex justify-end gap-2">
                    <button type="button" disabled={!canCall || t.status !== 'PENDING' || !consentReady} title={!consentReady ? `Target is not authorized for this exact campaign (${candidate?.voiceAuthorizationReason ?? 'authorization evidence unavailable'})` : !canCall ? 'Campaign must be running, provider-ready, and not emergency-stopped' : t.status !== 'PENDING' ? `Target is ${t.status}` : 'Call target'} onClick={() => onCall(t)} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1 font-semibold text-indigo hover:bg-[var(--s2)] disabled:opacity-50">
                      <PhoneOutgoing className="w-3 h-3" /> Call
                    </button>
                    <ConfirmedButton
                      dialogTitle="Remove outbound target?"
                      message={`Remove ${[t.firstName, t.lastName].filter(Boolean).join(' ') || t.phone} from this campaign? No call is placed by this action.`}
                      confirmLabel="Remove target"
                      tone="red"
                      disabled={busy || deletingId === t.id}
                      onConfirm={() => remove(t)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--b1)] px-2.5 py-1 font-semibold text-red-v hover:bg-[var(--red-soft)] disabled:opacity-50"
                    >
                      {deletingId === t.id ? 'Removing…' : 'Remove'}
                    </ConfirmedButton>
                  </div></td>
                </tr>
                  );
                })()
              ))}
            </tbody>
          </table>
        </div>
      )}
      </div>
    </div>
  );
}
