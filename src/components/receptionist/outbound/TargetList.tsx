import { useCallback, useEffect, useState } from 'react';
import { Plus, Phone, PhoneOutgoing, Settings2 } from 'lucide-react';
import { Field, Select } from '../../ui/Field';
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
  const [selectedCandidate, setSelectedCandidate] = useState('');
  const [selectedAppointment, setSelectedAppointment] = useState('');
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
  const selectedCandidateRow = candidates.find(item => `${item.type}:${item.id}` === selectedCandidate) ?? null;

  function chooseCandidate(value: string) {
    setSelectedCandidate(value);
    const candidate = candidates.find(item => `${item.type}:${item.id}` === value);
    if (reminderCampaign && candidate?.type === 'patient' && candidate.appointments.length === 1) {
      setSelectedAppointment(candidate.appointments[0].appointmentId);
    } else {
      setSelectedAppointment('');
    }
  }

  async function add() {
    const candidate = candidates.find(item => `${item.type}:${item.id}` === selectedCandidate);
    if (!candidate) return;
    const appointment = reminderCampaign
      ? candidate.appointments.find(item => item.appointmentId === selectedAppointment)
      : null;
    // A reminder without an appointment binding is a call that can say nothing
    // truthful about the visit. Refuse it in the UI as well as at the backend.
    if (reminderCampaign && (!appointment || candidate.type !== 'patient')) return;

    await addState.run(async () => {
      await api.addTargets(campaign.id, [{
        ...(candidate.type === 'patient' ? { patientId: candidate.id } : { leadId: candidate.id }),
        ...(appointment ? { appointmentId: appointment.appointmentId } : {}),
      }]);
      setSelectedCandidate('');
      setSelectedAppointment('');
      onAdded();
    }, { successMessage: reminderCampaign ? `${candidate.name} added for appointment confirmation` : `${candidate.name} added to the target list` });
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
  const readyCandidates = candidates.filter(candidate => candidate.voiceAuthorizationReady);
  // An appointment-reminder campaign is not a generic calling list. Only a
  // patient with an upcoming, still-attendable appointment can be selected.
  const eligibleCandidates = reminderCampaign
    ? readyCandidates.filter(candidate => candidate.type === 'patient' && candidate.appointments.length > 0)
    : readyCandidates;
  const appointmentChoices = reminderCampaign && selectedCandidateRow?.type === 'patient'
    ? selectedCandidateRow.appointments
    : [];
  const addDisabled = busy || !selectedCandidate || (reminderCampaign && !selectedAppointment);

  return (
    <div className="cc-card p-5 space-y-3">
      <h4 className="text-sm font-bold text-t1 flex items-center gap-2"><Phone className="w-4 h-4 text-indigo" /> Target list ({targets.length})</h4>
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
      {reminderCampaign && !policyMissing && candidateState.status !== 'error' && (
        <div className="rounded-lg border border-[var(--b1)] bg-[var(--s2)] px-3 py-2 text-xs text-t2">
          <span className="font-semibold text-t1">Appointment confirmation:</span> choose the patient and the exact upcoming visit this call is about. CareCommand reads the appointment again when the call is placed, so the receptionist does not rely on static campaign text.
        </div>
      )}
      <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
        <Field label={reminderCampaign ? 'Patient to call' : 'Authorized patient or lead'}>
          <Select aria-label="Authorized outbound target" value={selectedCandidate} disabled={policyMissing || candidateState.status === 'loading'} onChange={e => chooseCandidate(e.target.value)}>
            <option value="">
              {policyMissing ? 'Configure the campaign policy first'
                : candidateState.status === 'loading' ? 'Loading authorized identities…'
                  : candidateState.status === 'ready' && eligibleCandidates.length === 0
                    ? reminderCampaign ? 'No authorized patient with an upcoming appointment yet' : 'No authorized identity with a canonical phone yet'
                    : reminderCampaign ? 'Select a patient with an upcoming appointment' : 'Select an identity with a canonical phone'}
            </option>
            {eligibleCandidates.map(candidate => <option key={`${candidate.type}:${candidate.id}`} value={`${candidate.type}:${candidate.id}`}>
              {candidate.name} · {maskedPhone(candidate.phone)}{reminderCampaign ? ` · ${candidate.appointments.length} upcoming appointment${candidate.appointments.length === 1 ? '' : 's'}` : ` · ${candidate.voiceAuthorizationReason === 'compatible_immutable_consent' ? 'compatible consent evidence' : 'treatment/operations authority'}`}
            </option>)}
          </Select>
        </Field>
        <button type="button" disabled={addDisabled} onClick={add} className="inline-flex items-center gap-2 rounded-xl border border-[var(--b1)] px-4 py-2 text-sm font-semibold text-t2 hover:bg-[var(--s2)] disabled:opacity-50 h-[38px]"><Plus className="w-4 h-4" /> Add</button>
      </div>
      {reminderCampaign && selectedCandidateRow?.type === 'patient' && (
        <Field label="Appointment to confirm" required>
          <Select aria-label="Appointment to confirm" value={selectedAppointment} onChange={e => setSelectedAppointment(e.target.value)}>
            <option value="">Select the exact appointment this call is about</option>
            {appointmentChoices.map(appointment => (
              <option key={appointment.appointmentId} value={appointment.appointmentId}>{appointmentOptionLabel(appointment)}</option>
            ))}
          </Select>
        </Field>
      )}
      <MutationNotice state={addState.state} onRetry={selectedCandidate && (!reminderCampaign || selectedAppointment) ? add : undefined} />
      <MutationNotice state={removeState.state} showSaved={false} />
      {targets.length > 0 && (
        <div className="space-y-1.5">
              {targets.map(t => (
                (() => {
                  const candidate = candidates.find(item => item.id === (t.patientId ?? t.leadId));
                  const consentReady = candidate?.voiceAuthorizationReady === true;
                  return (
                <div key={t.id} className="flex items-center justify-between rounded-lg border border-[var(--b1)] px-3 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="badge badge-blue">{formatEnumLabel(t.status)}</span>
                    <span className="text-t2">{[t.firstName, t.lastName].filter(Boolean).join(' ') || maskedPhone(t.phone)}</span>
                    <span className="text-t3">{maskedPhone(t.phone)}</span>
                    {t.appointmentId && <span className="text-t3">· appointment linked</span>}
                  </div>
                  <div className="flex items-center gap-2">
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
                  </div>
                </div>
                  );
                })()
              ))}
        </div>
      )}
    </div>
  );
}
