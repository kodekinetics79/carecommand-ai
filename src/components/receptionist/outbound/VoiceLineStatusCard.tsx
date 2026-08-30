import { CircleCheck, CircleAlert, AlertCircle, RefreshCw } from 'lucide-react';
import {
  normalizeVoiceLineStatus, verificationLine,
  type Blocker, type VoiceLineStatusLike,
} from '../../../lib/receptionistDeployment';
import { FixLink } from '../ReadinessChecklist';

const TONE_TEXT = { ok: 'text-emerald-v', warn: 'text-amber-v', error: 'text-red-v', muted: 'text-t3' } as const;

function BlockerRow({ blocker }: { blocker: Blocker }) {
  const blocking = blocker.severity === 'blocking';
  return (
    <li className={`flex items-start gap-2 rounded-lg border px-3 py-2 ${blocking ? 'border-amber-v/40' : 'border-[var(--b1)]'}`} data-blocker={blocker.code} data-severity={blocker.severity}>
      <AlertCircle className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${blocking ? 'text-amber-v' : 'text-t3'}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-t1">{blocker.title}</p>
        {blocker.action && <p className="text-[11px] text-t3">{blocker.action}</p>}
        <p className="font-mono text-[10px] text-t3/80">{blocker.code} · {blocker.scope}</p>
      </div>
      <FixLink href={blocker.fixHref} label={`Fix ${blocker.title}`} />
    </li>
  );
}

/**
 * Voice-line readiness for the selected scope. Renders the server's blockers
 * (title, action, fix link) verbatim — which is why this card needed almost no
 * work here: the copy it prints is the remediation catalogue's, and that is
 * where the supplier's name was removed. Also prints the line-check expiry with
 * whether auto-renewal is really running, and the attended-UAT block only when
 * the server sent one (demo profile).
 */
export function VoiceLineStatusCard({ status, onRefresh }: { status: VoiceLineStatusLike | null; onRefresh?: () => void }) {
  if (!status) return null;
  const view = normalizeVoiceLineStatus(status);
  const blocking = view.blockers.filter(blocker => blocker.severity === 'blocking');
  const ok = view.providerConfigured && view.agentReady && blocking.length === 0;
  const line = view.verification.status ? verificationLine(view.verification) : null;
  const uat = view.attendedUat;

  return (
    <div className={`cc-card border-l-4 p-4 ${ok ? 'border-l-emerald-v' : 'border-l-amber-v'}`}>
      <div className="flex items-start gap-3">
        {ok ? <CircleCheck className="h-5 w-5 shrink-0 text-emerald-v" aria-hidden="true" /> : <CircleAlert className="h-5 w-5 shrink-0 text-amber-v" aria-hidden="true" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-bold text-t1">Voice line {ok ? '— ready' : '— needs attention'}</h3>
            {view.providerMode === 'mock' && <span className="badge badge-violet">mock mode</span>}
            {view.providerMode === 'unconfigured' && <span className="badge badge-amber">not connected</span>}
            {onRefresh && (
              <button type="button" onClick={onRefresh} className="ml-auto inline-flex items-center gap-1 rounded-lg border border-[var(--b1)] px-2 py-1 text-[11px] font-semibold text-t2 hover:bg-[var(--s2)]">
                <RefreshCw className="h-3 w-3" aria-hidden="true" /> Refresh
              </button>
            )}
          </div>
          <p className="mt-0.5 text-xs text-t3">
            {view.agentScope.agentName ? `Receptionist ${view.agentScope.agentName}. ` : ''}
            {ok
              ? 'The line is connected and the published configuration passed its check. Each campaign still needs its own readiness checks before activation.'
              : blocking.length
                ? `${blocking.length} blocking item${blocking.length === 1 ? '' : 's'} before calls can be placed or answered.`
                : 'No blocking items; review the warnings below.'}
          </p>
          {line && <p className={`mt-1 text-xs font-semibold ${TONE_TEXT[line.tone]}`} data-verification={view.verification.status ?? ''}>{line.text}</p>}
          {view.blockers.length > 0 && (
            <ul className="mt-3 space-y-1.5" aria-label="Voice line blockers">
              {view.blockers.map(blocker => <BlockerRow key={blocker.code} blocker={blocker} />)}
            </ul>
          )}
          {uat && (
            <div className="mt-3 rounded-lg border border-[var(--b1)] bg-[var(--s3)] px-3 py-2" data-testid="attended-uat">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs font-semibold text-t1">Attended live-test authorization</p>
                <span className={`badge ${uat.active ? 'badge-emerald' : 'badge-amber'}`}>{uat.active ? 'active' : 'blocked'}</span>
              </div>
              <p className="mt-0.5 text-[11px] text-t3">
                Destination {uat.allowedDestinationMasked ?? 'not configured'} · {uat.callsRemaining} call{uat.callsRemaining === 1 ? '' : 's'} remaining · {uat.minutesRemaining} minute{uat.minutesRemaining === 1 ? '' : 's'} remaining · window {uat.windowStart}–{uat.windowEnd} {uat.timezone}
              </p>
              {!uat.active && (uat.blockingReason || uat.admissionReason) && (
                <p className="mt-0.5 font-mono text-[10px] text-amber-v">{uat.blockingReason ?? uat.admissionReason}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
