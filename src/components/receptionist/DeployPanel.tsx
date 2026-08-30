import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Rocket, Loader2, CircleCheck, CircleX, CircleDashed, ShieldCheck, ListChecks, AlertTriangle } from 'lucide-react';
import { receptionistApi, type Campaign } from '../../lib/receptionist';
import {
  DEPLOYMENT_POLL_INTERVAL_MS, DEPLOYMENT_POLL_MAX_ATTEMPTS, blockedByOf, deployChecklistOf, deploymentApi, deriveDeployState,
  formatExpiresIn, pollLatestDeployment, retryAfterSecondsOf, verificationLine,
  type BlockedByCampaign, type Deployment, type DeploymentDiff, type DeployPanelState, type VoiceLineConfigurationExport, type VoiceLineStatusResponse,
} from '../../lib/receptionistDeployment';
import { useResource } from '../../hooks/useResource';
import { describeMutationFailure, isBusy, useMutationState, type MutationError } from '../../hooks/useMutationState';
import { receivedData } from '../../lib/resourceState';
import { CopyButton } from './shared';
import { LoadFailureNotice, MutationNotice } from './MutationNotice';
import { FixLink } from './ReadinessChecklist';
import { VOICE } from '../../lib/receptionistVocabulary';

type Phase = 'idle' | 'publish' | 'verify' | 'confirm';

const PHASES: Array<{ key: Exclude<Phase, 'idle'>; label: string }> = [
  { key: 'publish', label: 'Publish the prompt, the booking steps and the receptionist version to the line' },
  { key: 'verify', label: 'Read the live line back and compare it to this configuration' },
  { key: 'confirm', label: 'Confirm the deployment record settled' },
];

const CHANGE_LABEL: Record<string, string> = {
  prompt: 'Prompt', tools: 'Tools', intake: 'Intake schema', voice: 'Voice', language: 'Language', webhook: 'Webhook URL', beginMessage: 'Begin message',
};

const TONE_TEXT = { ok: 'text-emerald-v', warn: 'text-amber-v', error: 'text-red-v', muted: 'text-t3' } as const;

/**
 * Did the server send the provider mechanics?
 *
 * The tenant response carries voice, language, the opening line and the
 * call-outcome fields — the clinic's own content. `webhookUrl` and `tools`
 * arrive only when the caller holds `platform:voice-line-mechanics:read`, so
 * their presence IS the permission answer. Asking the payload rather than
 * asking a flag means the console procedure cannot be rendered for someone the
 * server would not have given the data to.
 */
function providerMechanicsPresent(config: VoiceLineConfigurationExport): boolean {
  return typeof config.webhookUrl === 'string' && config.webhookUrl.length > 0;
}

function toolSummary(tool: Record<string, unknown>) {
  const name = typeof tool.name === 'string' ? tool.name : 'unnamed tool';
  const url = typeof tool.url === 'string' ? tool.url : null;
  const params = tool.parameters && typeof tool.parameters === 'object' ? (tool.parameters as Record<string, unknown>) : null;
  const required = params && Array.isArray(params.required) ? (params.required as unknown[]).filter((v): v is string => typeof v === 'string') : [];
  return { name, url, required };
}

/**
 * Publish to the line. Publishing publishes (the server answers with a PUBLISHED
 * row and `verification: { status: 'pending' }`), then this panel calls
 * the line check and polls `deployments/latest` until the row settles.
 * Every state is derived from server data plus the in-flight phase; failure
 * copy is the server's `code` / `message`.
 *
 * The manual setup checklist below is the supplier's console procedure. It is
 * rendered only when the server actually sent the provider mechanics — which
 * it does only for a caller holding `platform:voice-line-mechanics:read`. That
 * is the whole gate: no flag in the browser, no hidden element a clinic can
 * reveal with devtools. If the fields are absent the block does not exist.
 */
export function DeployPanel({ campaignId, config, campaignStatus = null, onDeployingChange, pollIntervalMs = DEPLOYMENT_POLL_INTERVAL_MS, pollMaxAttempts = DEPLOYMENT_POLL_MAX_ATTEMPTS }: {
  campaignId: string;
  config: VoiceLineConfigurationExport | null;
  /** Known when the panel is hosted by Studio; drives the redeploy degrade warning. */
  campaignStatus?: Campaign['status'] | null;
  /** Raised while a deploy is publishing, so the status strip above can say the line is degraded. */
  onDeployingChange?: (deploying: boolean) => void;
  pollIntervalMs?: number;
  pollMaxAttempts?: number;
}) {
  const loadStatus = useCallback((signal: AbortSignal) => deploymentApi.voiceLineStatus({ campaignId }, signal), [campaignId]);
  const loadDiff = useCallback((signal: AbortSignal) => deploymentApi.deploymentDiff(campaignId, signal), [campaignId]);
  const statusResource = useResource<VoiceLineStatusResponse>(loadStatus);
  const diffResource = useResource<DeploymentDiff>(loadDiff);
  const status = receivedData(statusResource.state);
  const diff = receivedData(diffResource.state);

  const deployState = useMutationState();
  const [phase, setPhase] = useState<Phase>('idle');
  const [latest, setLatest] = useState<Deployment | null>(null);
  const [verifyError, setVerifyError] = useState<MutationError | null>(null);
  const [blockedBy, setBlockedBy] = useState<BlockedByCampaign[]>([]);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (cooldownUntil === null) return;
    const id = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= cooldownUntil) setCooldownUntil(null);
    }, 1000);
    return () => clearInterval(id);
  }, [cooldownUntil]);
  const cooldownSeconds = cooldownUntil === null ? 0 : Math.max(0, Math.ceil((cooldownUntil - now) / 1000));

  const reloadAll = useCallback(() => {
    statusResource.reload();
    diffResource.reload();
  }, [statusResource, diffResource]);

  // Remembered across a status refetch: reloading provider status empties
  // `status` for a moment, and the agent we just deployed must not lose its
  // "Verify again" action in that window.
  const [knownAgentId, setKnownAgentId] = useState<string | null>(null);
  const agentId = status?.agentScope.agentId ?? knownAgentId;

  async function verifyAndSettle(targetAgentId: string | null) {
    setVerifyError(null);
    if (targetAgentId) {
      setPhase('verify');
      try {
        await receptionistApi.verifyAgentProvider(targetAgentId);
      } catch (error) {
        setVerifyError(describeMutationFailure(error));
      }
    }
    setPhase('confirm');
    const settled = await pollLatestDeployment(campaignId, { intervalMs: pollIntervalMs, maxAttempts: pollMaxAttempts });
    setLatest(settled);
    setPhase('idle');
    reloadAll();
  }

  async function deploy() {
    setBlockedBy([]);
    setVerifyError(null);
    await deployState.run(async () => {
      setPhase('publish');
      let response;
      try {
        response = await deploymentApi.deploy(campaignId);
      } catch (error) {
        setPhase('idle');
        setBlockedBy(blockedByOf(error));
        const retryAfter = retryAfterSecondsOf(error);
        if (retryAfter) {
          setNow(Date.now());
          setCooldownUntil(Date.now() + retryAfter * 1000);
        }
        throw error;
      }
      setLatest(response.deployment);
      // The deploy route sends no agent row; the id we already resolved from
      // provider status is the one to verify against.
      setKnownAgentId(response.agent?.id ?? agentId);
      if (response.verification.status === 'failed') {
        setVerifyError({ status: 'error', message: response.verification.message ?? 'Verification failed.', code: response.verification.code ?? null, fieldErrors: {}, remediation: null, failure: { message: response.verification.message ?? 'Verification failed.', code: response.verification.code, timedOut: false, offline: false, permissionDenied: false, sessionExpired: false } });
        setPhase('confirm');
        const settled = await pollLatestDeployment(campaignId, { intervalMs: pollIntervalMs, maxAttempts: pollMaxAttempts });
        setLatest(settled);
        setPhase('idle');
        reloadAll();
        return;
      }
      await verifyAndSettle(response.agent?.id ?? agentId);
    }, { successMessage: 'Deployed' });
  }

  async function verifyAgain() {
    await deployState.run(() => verifyAndSettle(agentId), { successMessage: 'Verification re-run' });
  }

  const deploying = phase !== 'idle';
  // The redeploy degrade window (the agent goes UNVERIFIED between publish and
  // verify) is a fact about the live line, so it is raised to the surfaces
  // above this panel rather than only shown here.
  useEffect(() => { onDeployingChange?.(deploying); }, [deploying, onDeployingChange]);
  const deployFailure = deployState.state.status === 'error' ? deployState.state : null;
  const derived = deriveDeployState({ status, diff });
  const view: DeployPanelState = deploying ? 'deploying'
    : deployFailure ? (blockedBy.length ? 'drift-blocked' : 'deploy-failed')
      : verifyError ? 'verification-failed'
        : derived;
  const mock = status?.providerMode === 'mock' || diff?.deployment?.mock || latest?.mock || false;
  const deployment = diff?.deployment ?? null;
  const busy = isBusy(deployState.state) || deploying;
  const canDeploy = !busy && cooldownSeconds === 0 && view !== 'no-agent' && Boolean(status);

  const statusFailed = statusResource.state.status === 'error';
  const diffFailed = diffResource.state.status === 'error';

  return (
    <div className="space-y-4">
      <div className="cc-card space-y-3 p-5" data-deploy-state={view}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="inline-flex items-center gap-2 text-sm font-bold text-t1"><Rocket className="h-4 w-4 text-indigo" aria-hidden="true" /> Go live</h3>
          <div className="flex items-center gap-2">
            {mock && <span className="badge badge-violet">mock mode</span>}
            {status?.providerMode === 'unconfigured' && <span className="badge badge-amber">not connected</span>}
          </div>
        </div>

        {statusFailed && <LoadFailureNotice what="Voice line status" message={statusResource.state.status === 'error' ? statusResource.state.failure.message : ''} onRetry={statusResource.reload} />}
        {diffFailed && <LoadFailureNotice what="The deployment record" message={diffResource.state.status === 'error' ? diffResource.state.failure.message : ''} onRetry={diffResource.reload} />}
        {!status && !statusFailed && <p role="status" className="text-xs text-t3"><Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Checking the voice line…</p>}

        {view === 'no-agent' && (
          <div role="status" className="rounded-lg border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 text-xs text-t2">
            <p className="font-semibold text-t1">No receptionist is assigned to this campaign.</p>
            <p className="mt-0.5">Create or assign one in the <Link to="/receptionist-studio?tab=campaign" className="font-semibold text-indigo hover:underline">Agent &amp; Campaign</Link> tab, then publish it here.</p>
          </div>
        )}

        {view === 'never-deployed' && (
          <p className="text-xs text-t2">This campaign has never gone live. Publishing sends the generated prompt, the booking steps and the receptionist version to the {VOICE.line}, then runs a {VOICE.checkLower} to confirm the live line is running exactly that.</p>
        )}

        {campaignStatus === 'ACTIVE' && !deploying && (
          <p role="note" data-testid="redeploy-degrade-warning" className="flex items-start gap-2 rounded-lg border border-amber-v/40 bg-[var(--s3)] px-3 py-2 text-[11px] text-t1">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-v" aria-hidden="true" />
            <span>
              <span className="font-semibold">This campaign is answering calls now.</span> Publishing resets the {VOICE.checkLower}: between publishing and the check the receptionist runs on the safe steps only — a caller can leave a message or be transferred, but cannot book. The check runs immediately and usually takes seconds; stay on this screen until it finishes.
            </span>
          </p>
        )}

        {view === 'deploying' && (
          <ol className="space-y-1.5" aria-label="Deployment steps">
            {PHASES.map((step, index) => {
              const current = PHASES.findIndex(p => p.key === phase);
              const state = index < current ? 'done' : index === current ? 'running' : 'waiting';
              return (
                <li key={step.key} className="flex items-center gap-2 text-xs text-t2" data-step={step.key} data-step-state={state}>
                  {state === 'done' ? <CircleCheck className="h-4 w-4 text-emerald-v" aria-hidden="true" /> : state === 'running' ? <Loader2 className="h-4 w-4 animate-spin text-indigo" aria-hidden="true" /> : <CircleDashed className="h-4 w-4 text-t3" aria-hidden="true" />}
                  {step.label}
                </li>
              );
            })}
            <li className="text-[11px] text-t3">Usually under 30 seconds.</li>
          </ol>
        )}

        {(view === 'deployed-current' || view === 'deployed-stale') && deployment && (
          <div className={`rounded-lg border px-3 py-2 ${view === 'deployed-current' ? 'border-emerald-v/40' : 'border-amber-v/40'}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`badge ${deployment.status === 'VERIFIED' ? 'badge-emerald' : deployment.status === 'PUBLISHED' ? 'badge-amber' : 'badge-blue'}`}>{deployment.status}</span>
              <p className="font-mono text-[10px] text-t3" title="Quote this to CareCommand support">{deployment.configurationReference ?? '—'}</p>
            </div>
            <p className="mt-0.5 text-[11px] text-t3">
              {deployment.verifiedAt ? `Verified ${new Date(deployment.verifiedAt).toLocaleString()}` : deployment.publishedAt ? `Published ${new Date(deployment.publishedAt).toLocaleString()} — not verified yet` : 'Pending'}
              {status?.verification.expiresInMs !== null && status?.verification.status === 'VERIFIED' ? ` · expires in ${formatExpiresIn(status.verification.expiresInMs)}` : ''}
            </p>
            {status?.verification.status && (() => { const line = verificationLine(status.verification); return <p className={`text-[11px] font-semibold ${TONE_TEXT[line.tone]}`}>{line.text}</p>; })()}
            {view === 'deployed-stale' && diff && (
              <div className="mt-2 space-y-1.5" data-testid="deploy-changes">
                <p className="text-xs font-semibold text-amber-v">The draft differs from what is deployed:</p>
                <div className="flex flex-wrap gap-1.5" aria-label="Changed settings">
                  {diff.changed.map(key => <span key={key} className="badge badge-amber">{CHANGE_LABEL[key] ?? key}</span>)}
                </div>
                {(diff.toolsDiff.added.length + diff.toolsDiff.removed.length + diff.toolsDiff.changed.length) > 0 && (
                  <p className="text-[11px] text-t3">
                    Tools{diff.toolsDiff.added.length ? ` · added ${diff.toolsDiff.added.join(', ')}` : ''}{diff.toolsDiff.removed.length ? ` · removed ${diff.toolsDiff.removed.join(', ')}` : ''}{diff.toolsDiff.changed.length ? ` · changed ${diff.toolsDiff.changed.join(', ')}` : ''}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {view === 'deploy-failed' && (
          <div className="space-y-1.5">
            {deployFailure
              ? <MutationNotice state={deployFailure} />
              : deployment?.providerErrorCode && (
                <div role="alert" className="rounded-lg border border-red-v/40 bg-[var(--red-soft)] px-3 py-2 text-xs text-red-v">
                  <p className="font-semibold">The last deployment failed at the provider.</p>
                  <p className="font-mono text-[10px]">code: {deployment.providerErrorCode}</p>
                </div>
              )}
            {latest?.steps?.some(step => step.status === 'failed') && (
              <ul className="space-y-0.5 text-[11px] text-t3" aria-label="Deployment steps">
                {latest.steps.map(step => <li key={step.name} className="flex items-center gap-1.5">{step.status === 'ok' ? <CircleCheck className="h-3 w-3 text-emerald-v" aria-hidden="true" /> : step.status === 'failed' ? <CircleX className="h-3 w-3 text-red-v" aria-hidden="true" /> : <CircleDashed className="h-3 w-3" aria-hidden="true" />}{step.name}{step.providerErrorCode ? ` · ${step.providerErrorCode}` : ''}</li>)}
              </ul>
            )}
            {cooldownSeconds > 0 && <p role="status" className="text-[11px] font-semibold text-amber-v">Retry available in {cooldownSeconds}s.</p>}
          </div>
        )}

        {view === 'drift-blocked' && deployFailure && (
          <div role="alert" className="space-y-1 rounded-lg border border-amber-v/40 px-3 py-2 text-xs text-t1">
            <p className="font-semibold">{deployFailure.message}</p>
            {deployFailure.code && <p className="font-mono text-[10px] text-t3">code: {deployFailure.code}</p>}
            <p className="text-t2">Pause these campaigns, then deploy again:</p>
            <ul className="list-disc pl-4">
              {blockedBy.map(row => <li key={row.campaignId}><Link to={`/receptionist-studio?tab=campaign&campaign=${encodeURIComponent(row.campaignId)}`} className="font-semibold text-indigo hover:underline">{row.name}</Link></li>)}
            </ul>
          </div>
        )}

        {view === 'verification-failed' && (
          <div className="space-y-1.5">
            <div role="alert" className="rounded-lg border border-red-v/40 bg-[var(--red-soft)] px-3 py-2 text-xs text-red-v">
              <p className="font-semibold">Published, but the {VOICE.checkLower} did not pass{verifyError?.message ? `: ${verifyError.message}` : '.'}</p>
              {verifyError?.code && <p className="font-mono text-[10px]">code: {verifyError.code}</p>}
              {latest?.status && <p className="text-red-v/90">Deployment {latest.status.toLowerCase()} · {latest.configurationReference ?? '—'}</p>}
            </div>
            {status?.blockers.filter(b => b.scope === 'agent' || b.scope === 'provider').map(blocker => (
              <p key={blocker.code} className="text-[11px] text-t2"><span className="font-semibold text-t1">{blocker.title}</span> — {blocker.action} <FixLink href={blocker.fixHref} label={`Fix ${blocker.title}`} /></p>
            ))}
          </div>
        )}

        {status?.blockers.filter(b => b.scope === 'server').map(blocker => (
          <p key={blocker.code} role="alert" className="text-[11px] text-amber-v"><span className="font-semibold">{blocker.title}</span> — {blocker.action}</p>
        ))}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!canDeploy}
            onClick={deploy}
            title={view === 'no-agent' ? 'Assign a receptionist first.' : cooldownSeconds > 0 ? `Retry in ${cooldownSeconds}s` : undefined}
            className="inline-flex items-center gap-2 rounded-xl bg-indigo px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Rocket className="h-4 w-4" aria-hidden="true" />}
            {view === 'deployed-stale' ? 'Publish changes' : view === 'deploy-failed' || view === 'drift-blocked' ? (cooldownSeconds > 0 ? `Retry in ${cooldownSeconds}s` : 'Retry') : view === 'deployed-current' ? VOICE.publishAgain : VOICE.publish}
          </button>
          {(view === 'verification-failed' || (deployment && deployment.status === 'PUBLISHED')) && agentId && (
            <button type="button" disabled={busy} onClick={verifyAgain} className="inline-flex items-center gap-2 rounded-xl border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-t1 disabled:opacity-40">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> {VOICE.runCheck}
            </button>
          )}
          {deployState.state.status === 'saved' && !verifyError && <MutationNotice state={deployState.state} />}
        </div>
      </div>

      {config && providerMechanicsPresent(config) && (
        <details className="cc-card p-5" data-testid="byo-checklist">
          <summary className="cursor-pointer text-sm font-bold text-t1"><ListChecks className="mr-1.5 inline h-4 w-4 text-indigo" aria-hidden="true" /> Manual setup — CareCommand support only</summary>
          <p className="mt-2 text-xs text-t3">Configure the agent in the provider console in this order, then paste its agent id in the Agent tab and verify. Source: {config.agentSource ?? 'local'} configuration.</p>
          <ol className="mt-3 space-y-1.5" aria-label="Manual deploy checklist">
            {deployChecklistOf(config).map(item => (
              <li key={item.key} className="flex items-start gap-2 rounded-lg border border-[var(--b1)] bg-[var(--s3)] px-3 py-2" data-checklist-key={item.key}>
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--indigo-soft)] text-[10px] font-bold text-indigo">{item.step}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-t1">{item.label}</p>
                  <p className="break-words font-mono text-[11px] text-t2">{item.value}</p>
                </div>
                {item.copyable && <CopyButton value={item.value} />}
              </li>
            ))}
          </ol>
          {(config.tools ?? []).length > 0 && (
            <div className="mt-4 space-y-1.5">
              <p className="text-[11px] font-bold uppercase tracking-wide text-t3">Custom tools ({(config.tools ?? []).length})</p>
              <ul className="space-y-1.5" aria-label="Exported tools">
                {(config.tools ?? []).map((tool, index) => {
                  const summary = toolSummary(tool);
                  return (
                    <li key={`${summary.name}-${index}`} className="flex items-start gap-2 rounded-lg border border-[var(--b1)] bg-[var(--s3)] px-3 py-2" data-tool={summary.name}>
                      <div className="min-w-0 flex-1">
                        <p className="font-mono text-[11px] font-bold text-indigo">{summary.name}</p>
                        {summary.url && <p className="break-all font-mono text-[10px] text-t3">{summary.url}</p>}
                        {summary.required.length > 0 && <p className="text-[10px] text-t3">required: {summary.required.join(', ')}</p>}
                      </div>
                      <CopyButton value={JSON.stringify(tool, null, 2)} label="Copy tool" />
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </details>
      )}
    </div>
  );
}
