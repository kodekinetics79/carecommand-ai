import { useCallback, useEffect, useRef, useState } from 'react';
import { PhoneOff, Activity, Loader2, AlertCircle, PhoneCall, PhoneOutgoing } from 'lucide-react';
import { Field, TextInput } from '../../ui/Field';
import { receptionistApi as api, OUTBOUND_RECONCILIATION_WARNING, launchControlsBlocked, mergeReconciliationRefresh, presentLaunchResult, clearTransportAmbiguityToken, readTransportAmbiguityToken, transportAmbiguityStorageKey, writeTransportAmbiguityToken, type CallLog, type RetellStatus, type OutboundCampaign, type CallTarget, type OutboundReconciliationEvidence } from '../../../lib/receptionist';
import { describeFailure } from '../../../lib/resourceState';
import { isBusy, useMutationState } from '../../../hooks/useMutationState';
import { formatEnumLabel, maskedPhone, maskedProviderId, outcomeBadge } from '../helpers';
import { ConfirmedButton } from '../shared';
import { MutationNotice } from '../MutationNotice';
import { TargetList } from './TargetList';

export function CampaignDetail({ campaign, status, outboundStopped, onChanged }: { campaign: OutboundCampaign; status: RetellStatus | null; outboundStopped: boolean; onChanged: () => void }) {
  const transportAmbiguityKey = transportAmbiguityStorageKey(campaign.id);
  const [targets, setTargets] = useState<CallTarget[]>([]);
  const [logs, setLogs] = useState<CallLog[]>([]);
  const [reconciliations, setReconciliations] = useState<OutboundReconciliationEvidence[]>([]);
  const [reconciliationVerified, setReconciliationVerified] = useState(false);
  const [phone, setPhone] = useState('');
  const [firstName, setFirstName] = useState('');
  const [launchMsg, setLaunchMsg] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const [transportAmbiguityToken, setTransportAmbiguityToken] = useState<string | null>(() => readTransportAmbiguityToken(window.localStorage, transportAmbiguityKey));
  const [launching, setLaunching] = useState(false);
  const campaignAction = useMutationState();
  const campaignActionPending = isBusy(campaignAction.state);
  const summaryRef = useRef<HTMLDivElement | null>(null);
  const [attachingLiveTarget, setAttachingLiveTarget] = useState(false);
  const [syncingCallId, setSyncingCallId] = useState<string | null>(null);
  const [providerStatusByCall, setProviderStatusByCall] = useState<Record<string, string>>({});
  const [detailErrors, setDetailErrors] = useState<string[]>([]);

  const reloadDetail = useCallback(async () => {
    const [targetResult, logResult, reconciliationResult] = await Promise.allSettled([
      api.listTargets(campaign.id),
      api.listOutboundCallLogs(campaign.id),
      api.listOutboundReconciliations(campaign.id),
    ]);
    setDetailErrors([
      ...(targetResult.status === 'rejected' ? [`Targets could not be loaded (${describeFailure(targetResult.reason).message})`] : []),
      ...(logResult.status === 'rejected' ? [`Call logs could not be loaded (${describeFailure(logResult.reason).message})`] : []),
      ...(reconciliationResult.status === 'rejected' ? [`Reconciliation safety evidence could not be loaded (${describeFailure(reconciliationResult.reason).message})`] : []),
    ]);
    if (targetResult.status === 'fulfilled') setTargets(targetResult.value);
    if (logResult.status === 'fulfilled') setLogs(logResult.value);
    setReconciliations(current => mergeReconciliationRefresh(current, reconciliationResult.status === 'fulfilled'
      ? { ok: true, rows: reconciliationResult.value }
      : { ok: false }));
    setReconciliationVerified(reconciliationResult.status === 'fulfilled');
  }, [campaign.id]);

  useEffect(() => {
    void (async () => { await reloadDetail(); })();
  }, [reloadDetail, transportAmbiguityKey]);

  const persistTransportAmbiguity = (token: string) => {
    setTransportAmbiguityToken(token);
    writeTransportAmbiguityToken(window.localStorage, transportAmbiguityKey, token);
  };

  async function verifyAndClearTransportAmbiguity() {
    setLaunching(true);
    try {
      if (!transportAmbiguityToken) return;
      const [attempt, durableRows] = await Promise.all([
        api.verifyClearLaunchAttempt(campaign.id, transportAmbiguityToken),
        api.listOutboundReconciliations(campaign.id),
        api.listOutboundCallLogs(campaign.id),
        api.listTargets(campaign.id),
      ]);
      setReconciliations(durableRows);
      setReconciliationVerified(true);
      if (!attempt.cleared || durableRows.length > 0) {
        setLaunchMsg({ kind: 'err', text: `${OUTBOUND_RECONCILIATION_WARNING}. Server attempt proof is ${attempt.proof}; resolve durable evidence before clearing this block.` });
        return;
      }
      clearTransportAmbiguityToken(window.localStorage, transportAmbiguityKey);
      setTransportAmbiguityToken(null);
      setLaunchMsg({ kind: 'warn', text: `Server-fenced attempt proof (${attempt.proof}) and durable call evidence were verified. The transport block was explicitly cleared.` });
    } catch (error) {
      setReconciliationVerified(false);
      setLaunchMsg({ kind: 'err', text: `${OUTBOUND_RECONCILIATION_WARNING}. Durable evidence refresh failed (${describeFailure(error).message}), so the launch block remains.` });
    } finally {
      setLaunching(false);
    }
  }

  async function launch(targetId?: string, toPhone?: string) {
    const dial = toPhone ?? phone;
    if (!targetId && !dial) return;
    setLaunching(true); setLaunchMsg(null);
    try {
      const res = await api.launchCall(campaign.id, {
        ...(dial ? { phone: dial } : {}),
        firstName: firstName || undefined,
        targetId,
      });
      const presentation = presentLaunchResult(res);
      setLaunchMsg({ kind: presentation.kind, text: presentation.text });
      if (res.status === 'transport_ambiguous') persistTransportAmbiguity(res.clientAttemptToken);
      if (res.status === 'launched' && !res.trackingDegraded) {
        setPhone('');
      }
      if (presentation.refresh) {
        await reloadDetail();
        onChanged();
      }
    } catch (error) {
      setReconciliationVerified(false);
      setLaunchMsg({ kind: 'err', text: `The launch response was lost (${describeFailure(error).message}). ${OUTBOUND_RECONCILIATION_WARNING}. Refresh durable evidence and verify provider state before any retry.` });
      await reloadDetail();
    } finally {
      setLaunching(false);
    }
  }

  async function attachAuthorizedLiveTestTarget() {
    setAttachingLiveTarget(true); setLaunchMsg(null);
    try {
      const attached = await api.attachLiveTestTarget(campaign.id, {
        firstName: 'Jordan',
        lastName: 'Test',
        scenario: 'attended synthetic live voice UAT',
        acknowledgeAuthorizedSyntheticRecipient: true,
        acknowledgeSyntheticConsentEvidence: true,
      });
      setLaunchMsg({ kind: 'ok', text: `Authorized synthetic recipient ${attached.destinationMasked} is attached to this campaign.` });
      await reloadDetail();
    } catch (error) {
      setLaunchMsg({ kind: 'err', text: error instanceof Error ? error.message : 'The authorized synthetic recipient could not be attached.' });
    } finally {
      setAttachingLiveTarget(false);
    }
  }

  async function syncProviderCall(callLogId: string) {
    setSyncingCallId(callLogId); setLaunchMsg(null);
    try {
      const result = await api.syncOutboundProviderCall(campaign.id, callLogId);
      setProviderStatusByCall(current => ({ ...current, [callLogId]: `${formatEnumLabel(result.providerStatus)} · ${result.durationSeconds}s${result.costNativeUnits === null ? '' : ' · provider cost recorded'}` }));
      setLaunchMsg({
        kind: result.outcome === 'ESCALATED' ? 'warn' : 'ok',
        text: result.outcome === 'ESCALATED'
          ? 'The provider call ended without signed analyzed-webhook evidence. CareCommand created a staff review task instead of fabricating a successful outcome.'
          : `Provider lifecycle synchronized as ${formatEnumLabel(result.providerStatus)}.`,
      });
      await reloadDetail();
    } catch (error) {
      setLaunchMsg({ kind: 'err', text: error instanceof Error ? error.message : 'Provider lifecycle could not be synchronized.' });
    } finally {
      setSyncingCallId(null);
    }
  }

  const transportAmbiguous = transportAmbiguityToken !== null;
  const configured = status?.configured ?? false;
  const reconciliationBlocksLaunch = launchControlsBlocked({ transportAmbiguous, reconciliationVerified, reconciliations });

  async function approveAndRun() {
    setLaunchMsg(null);
    // rethrow: the confirmation dialog stays open and shows the cause itself.
    await campaignAction.run(async () => {
      await api.approveOutboundCampaign(campaign.id, 'RUNNING');
      await onChanged();
    }, { successMessage: 'Authority approved and campaign started.', rethrow: true });
  }

  async function pauseCampaign() {
    setLaunchMsg(null);
    await campaignAction.run(async () => {
      await api.updateOutboundCampaign(campaign.id, { status: 'PAUSED' });
      await onChanged();
    }, { successMessage: 'Campaign paused. No new calls can launch.' });
  }

  function goToCampaignSettings() {
    summaryRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    summaryRef.current?.focus?.();
  }

  return (
    <div className="space-y-5">
      {detailErrors.length > 0 && (
        <div role="alert" className="rounded-xl border border-red-v/40 bg-[var(--red-soft)] p-3 flex items-center justify-between gap-3">
          <p className="text-xs text-red-v">{detailErrors.join(' ')} Existing rows remain visible; retry before acting.</p>
          <button type="button" onClick={() => void reloadDetail()} className="rounded-lg border border-[var(--b1)] px-2.5 py-1 text-xs font-semibold text-t2">Retry</button>
        </div>
      )}
      {transportAmbiguous && (
        <div role="alert" aria-live="assertive" className="cc-card border-l-4 border-l-red-v p-4">
          <p className="text-sm font-bold text-red-v">{OUTBOUND_RECONCILIATION_WARNING}</p>
          <p className="mt-1 text-xs text-t2">The launch transport failed after submission. Launch controls remain blocked until provider and durable call evidence are independently reconciled.</p>
          <button type="button" disabled={launching} onClick={() => void verifyAndClearTransportAmbiguity()} className="mt-2 rounded-lg border border-red-v/40 px-3 py-1.5 text-xs font-semibold text-red-v disabled:opacity-50">Refresh all durable evidence and clear only if no reconciliation remains</button>
        </div>
      )}
      {reconciliations.length > 0 && (
        <div role="alert" aria-live="assertive" className="cc-card border-l-4 border-l-red-v p-4">
          <p className="text-sm font-bold text-red-v">Critical reconciliation required: {OUTBOUND_RECONCILIATION_WARNING}</p>
          <p className="mt-1 text-xs text-t2">This warning was reconstructed from durable call and target evidence and remains after refresh or navigation until backend reconciliation evidence is resolved.</p>
          <div className="mt-3 space-y-2">
            {reconciliations.map(row => (
              <div key={row.localCallLogId} className="rounded-lg border border-red-v/30 bg-[var(--red-soft)] p-2 text-[11px] text-t2">
                <p><span className="font-semibold">Local call log ID:</span> <span className="font-mono">{row.localCallLogId}</span></p>
                <p><span className="font-semibold">Provider call ID:</span> <span className="font-mono">{maskedProviderId(row.providerCallId)}</span></p>
                <p className="text-t3">Evidence: {row.triggerSources.join(', ')}{row.signalIds.length ? ` · signals ${row.signalIds.join(', ')}` : ''}{row.reviewTaskIds.length ? ` · review tasks ${row.reviewTaskIds.join(', ')}` : ''}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      <div ref={summaryRef} tabIndex={-1} id={`outbound-campaign-${campaign.id}-settings`} className="cc-card p-5 space-y-3 outline-none">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-bold text-t1">{campaign.name}</h3>
          <div className="flex items-center gap-2">
            <span className="badge badge-blue">{formatEnumLabel(campaign.status)}</span>
            {campaign.status === 'RUNNING'
              ? <button type="button" disabled={campaignActionPending} onClick={pauseCampaign} className="rounded-lg border border-[var(--b1)] px-2.5 py-1 text-xs font-semibold text-t2">Pause</button>
              : <ConfirmedButton
                  dialogTitle="Approve and start outbound campaign?"
                  message={`Authorize policy ${campaign.policyVersion ?? 'not configured'} and allow this campaign to place calls to its approved targets. Provider configuration and all launch gates still apply.`}
                  confirmLabel="Approve and start"
                  tone="amber"
                  disabled={campaignActionPending || !campaign.policyVersion}
                  onConfirm={approveAndRun}
                  className="rounded-lg bg-indigo px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50"
                >Approve and start</ConfirmedButton>}
          </div>
        </div>
        <p className="text-[11px] text-t3">
          Policy {campaign.policyVersion ?? 'not configured'} · purpose {campaign.purpose ? formatEnumLabel(campaign.purpose) : 'not set'} · legal basis {campaign.legalBasis ? formatEnumLabel(campaign.legalBasis) : 'not set'} · {campaign.authorityApprovedAt ? `approved ${new Date(campaign.authorityApprovedAt).toLocaleString()} by ${campaign.authorityApprovedById ?? 'unknown'}` : 'not approved'}
          {campaign.authorityFingerprint ? ` · evidence ${campaign.authorityFingerprint.slice(0, 12)}…` : ''}
        </p>
        <MutationNotice state={campaignAction.state} />
        <p className="text-xs text-t3 whitespace-pre-wrap">{campaign.script}</p>
        <div className="flex flex-wrap gap-1.5">
          {campaign.requiredFields.map(f => <span key={f} className="badge badge-violet">{f}</span>)}
          <span className="badge badge-blue">{campaign.bookingMode === 'DIRECT_BOOKING_IF_SLOT_AVAILABLE' ? 'Direct booking' : 'Request only'}</span>
        </div>
      </div>

      {status?.liveTest?.enabled && (
        <div className={`cc-card border-l-4 p-4 ${status.liveTest.active ? 'border-l-emerald-v' : 'border-l-amber-v'}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-t1">Attended synthetic live voice UAT</p>
              <p className="mt-1 text-xs text-t2">
                Destination {status.liveTest.allowedDestinationMasked ?? 'not configured'} · {status.liveTest.callsRemaining} calls remaining · {status.liveTest.minutesRemaining} minutes remaining · one active call at a time.
              </p>
              <p className="mt-1 text-[11px] text-t3">
                Window {status.liveTest.windowStart}–{status.liveTest.windowEnd} {status.liveTest.timezone}. Authorization expires {status.liveTest.expiresAt ? new Date(status.liveTest.expiresAt).toLocaleString() : 'not configured'}.
              </p>
              {!status.liveTest.active && <p role="alert" className="mt-2 text-xs font-semibold text-amber-v">Blocked: {formatEnumLabel(status.liveTest.blockingReason ?? status.liveTest.admissionReason ?? 'live test not ready')}</p>}
            </div>
            <ConfirmedButton
              dialogTitle="Attach the environment-authorized synthetic recipient?"
              message="This creates or reuses a clearly synthetic lead and campaign target for the one masked destination authorized in the local process environment. It does not expose or accept a phone number from the browser."
              confirmLabel="Attach synthetic recipient"
              tone="amber"
              disabled={!status.liveTest.active || attachingLiveTarget}
              onConfirm={attachAuthorizedLiveTestTarget}
              className="rounded-lg border border-emerald-v/40 px-3 py-1.5 text-xs font-semibold text-emerald-v disabled:opacity-50"
            >
              {attachingLiveTarget ? 'Attaching…' : 'Attach authorized synthetic recipient'}
            </ConfirmedButton>
          </div>
        </div>
      )}

      {/* Launch test call */}
      <div className="cc-card p-5 space-y-3">
        <h4 className="text-sm font-bold text-t1 flex items-center gap-2"><PhoneCall className="w-4 h-4 text-indigo" /> Launch a call</h4>
        {outboundStopped && (
          <div role="alert" className="flex items-center gap-2 rounded-lg border border-red-v/40 bg-[var(--red-soft)] px-3 py-2 text-xs font-semibold text-red-v">
            <PhoneOff className="w-4 h-4" /> Launch disabled: tenant emergency-stop status is active or unavailable.
          </div>
        )}
        {!configured && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-v/40 bg-amber-v/5 px-3 py-2 text-xs text-amber-v">
            <AlertCircle className="w-4 h-4" /> Retell isn’t configured — launching returns a setup-required notice instead of placing a call.
          </div>
        )}
        {status?.adhocTestCallsAllowed ? (
          <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
            <Field label="Test-call phone number" hint="When a provider is configured, this action may place a real call."><TextInput value={phone} onChange={e => setPhone(e.target.value)} placeholder="+1 555 010 0000" /></Field>
            <Field label="First name (optional)"><TextInput value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="Jordan" /></Field>
            <ConfirmedButton
              dialogTitle="Place test call?"
              message={`A configured provider may immediately dial ${phone || 'the entered number'}. Confirm the number is approved for this pilot test.`}
              confirmLabel="Place test call"
              tone="amber"
              disabled={launching || outboundStopped || reconciliationBlocksLaunch || !phone || campaign.status !== 'RUNNING' || !configured}
              onConfirm={() => launch()}
              className="inline-flex items-center gap-2 rounded-xl bg-indigo px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 h-[38px]"
            >
              {launching ? <Loader2 className="w-4 h-4 animate-spin" /> : <PhoneOutgoing className="w-4 h-4" />} Place test call
            </ConfirmedButton>
          </div>
        ) : <p className="text-xs text-t3">Calls must use an authorized patient or lead target below. During live UAT, attach the environment-authorized synthetic recipient and launch it from the target row; the browser cannot supply or change the number.</p>}
        {launchMsg && (
          <p role={launchMsg.kind === 'err' ? 'alert' : 'status'} aria-live={launchMsg.kind === 'err' ? 'assertive' : 'polite'} className={`text-xs ${launchMsg.kind === 'ok' ? 'text-emerald-v' : launchMsg.kind === 'warn' ? 'text-amber-v' : 'text-red-v'}`}>{launchMsg.text}</p>
        )}
      </div>

      {/* Targets */}
      <TargetList campaign={campaign} targets={targets} onAdded={reloadDetail} onCall={(t) => launch(t.id)} canCall={!launching && !outboundStopped && !reconciliationBlocksLaunch && configured && campaign.status === 'RUNNING'} onConfigure={goToCampaignSettings} />

      {/* Call logs */}
      <div className="cc-card p-5">
        <h4 className="text-sm font-bold text-t1 mb-3 flex items-center gap-2"><Activity className="w-4 h-4 text-indigo" /> Call logs</h4>
        {logs.length === 0 ? <p className="text-xs text-t3">No calls placed yet.</p> : (
          <div className="space-y-1.5">
            {logs.map(l => (
              <div key={l.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--b1)] px-3 py-2 text-xs">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={outcomeBadge[l.outcome] ?? 'badge badge-blue'}>{formatEnumLabel(l.outcome)}</span>
                    <span className="text-t2">{l.callerName || maskedPhone(l.callerPhone)}</span>
                    <span className="text-t3">{maskedPhone(l.callerPhone)}</span>
                  </div>
                  <p className="mt-1 text-[10px] text-t3 font-mono">{maskedProviderId(l.retellCallId)}{providerStatusByCall[l.id] ? ` · ${providerStatusByCall[l.id]}` : ''}</p>
                </div>
                <button
                  type="button"
                  disabled={!l.retellCallId || syncingCallId === l.id}
                  onClick={() => void syncProviderCall(l.id)}
                  className="rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-indigo disabled:opacity-50"
                >
                  {syncingCallId === l.id ? 'Refreshing…' : 'Refresh provider status'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
