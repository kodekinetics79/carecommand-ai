import { useCallback, useEffect, useState } from 'react';
import { Plus, Phone, PhoneOutgoing } from 'lucide-react';
import { Field, Select } from '../../ui/Field';
import { receptionistApi as api, type OutboundCampaign, type CallTarget, type OutboundTargetCandidate } from '../../../lib/receptionist';
import { formatEnumLabel, maskedPhone } from '../helpers';
import { ConfirmedButton } from '../shared';

export function TargetList({ campaign, targets, onAdded, onCall, canCall }: { campaign: OutboundCampaign; targets: CallTarget[]; onAdded: () => void; onCall: (t: CallTarget) => void; canCall: boolean }) {
  const [candidates, setCandidates] = useState<OutboundTargetCandidate[]>([]);
  const targetIdentityKey = targets
    .map(target => target.patientId ?? target.leadId ?? target.id)
    .sort()
    .join(',');
  const [selectedCandidate, setSelectedCandidate] = useState('');
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const loadCandidates = useCallback(async () => {
    try {
      const rows = await api.listOutboundTargetCandidates(campaign.id);
      setCandidates(rows); setCandidateError(null);
    } catch {
      setCandidateError('Authorized target candidates could not be loaded. Existing rows are preserved; do not infer that no candidates exist.');
    }
  }, [campaign.id]);
  useEffect(() => {
    let active = true;
    void api.listOutboundTargetCandidates(campaign.id).then(rows => {
      if (!active) return;
      setCandidates(rows); setCandidateError(null);
    }).catch(() => {
      if (active) setCandidateError('Authorized target candidates could not be loaded. Existing rows are preserved; do not infer that no candidates exist.');
    });
    return () => { active = false; };
  }, [campaign.id, targetIdentityKey]);

  async function add() {
    const candidate = candidates.find(item => `${item.type}:${item.id}` === selectedCandidate);
    if (!candidate) return;
    setBusy(true);
    try {
      await api.addTargets(campaign.id, [{
        ...(candidate.type === 'patient' ? { patientId: candidate.id } : { leadId: candidate.id }),
      }]);
      setSelectedCandidate('');
      onAdded();
    } finally {
      setBusy(false);
    }
  }

  async function remove(target: CallTarget) {
    setDeletingId(target.id);
    try {
      await api.deleteTarget(campaign.id, target.id);
      onAdded();
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="cc-card p-5 space-y-3">
      <h4 className="text-sm font-bold text-t1 flex items-center gap-2"><Phone className="w-4 h-4 text-indigo" /> Target list ({targets.length})</h4>
      {candidateError && <div role="alert" className="rounded-lg border border-red-v/40 bg-[var(--red-soft)] p-2 text-xs text-red-v">{candidateError} <button type="button" onClick={() => void loadCandidates()} className="ml-2 underline font-semibold">Retry</button></div>}
      <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
        <Field label="Authorized patient or lead">
          <Select aria-label="Authorized outbound target" value={selectedCandidate} onChange={e => setSelectedCandidate(e.target.value)}>
            <option value="">Select an identity with a canonical phone</option>
            {candidates.filter(candidate => candidate.voiceAuthorizationReady).map(candidate => <option key={`${candidate.type}:${candidate.id}`} value={`${candidate.type}:${candidate.id}`}>{candidate.name} · {maskedPhone(candidate.phone)} · {candidate.voiceAuthorizationReason === 'compatible_immutable_consent' ? 'compatible consent evidence' : 'treatment/operations authority'}</option>)}
          </Select>
        </Field>
        <button type="button" disabled={busy || !selectedCandidate} onClick={add} className="inline-flex items-center gap-2 rounded-xl border border-[var(--b1)] px-4 py-2 text-sm font-semibold text-t2 hover:bg-[var(--s2)] disabled:opacity-50 h-[38px]"><Plus className="w-4 h-4" /> Add</button>
      </div>
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
