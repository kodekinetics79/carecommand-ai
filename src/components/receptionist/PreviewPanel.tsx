import { useCallback } from 'react';
import { Bot, PhoneIncoming, PhoneOutgoing, Sparkles, Wrench, ShieldAlert, Loader2, Mic } from 'lucide-react';
import { deploymentApi, type PreviewResponse, type PreviewTurn } from '../../lib/receptionistDeployment';
import { useResource } from '../../hooks/useResource';
import { CopyButton } from './shared';
import { LoadFailureNotice } from './MutationNotice';

// ===== Preview Panel =======================================================

const SPEAKER: Record<PreviewTurn['speaker'], { label: string; className: string }> = {
  agent: { label: 'Agent', className: 'bg-[var(--indigo-soft)] text-indigo' },
  caller: { label: 'Caller', className: 'bg-[var(--s3)] text-t2' },
  tool: { label: 'Tool', className: 'bg-[var(--violet-soft)] text-violet-v' },
};

function Transcript({ icon, title, turns, emptyText }: { icon: React.ReactNode; title: string; turns: PreviewTurn[]; emptyText: string }) {
  return (
    <section className="cc-card space-y-2 p-5" aria-label={title}>
      <h3 className="inline-flex items-center gap-2 text-sm font-bold text-t1">{icon} {title}</h3>
      {turns.length === 0 ? <p className="text-xs text-t3">{emptyText}</p> : (
        <ol className="space-y-1.5">
          {turns.map((turn, index) => {
            const speaker = SPEAKER[turn.speaker] ?? SPEAKER.caller;
            return (
              <li key={index} className="flex gap-2.5 text-sm text-t2">
                <span className={`mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase ${speaker.className}`}>{speaker.label}</span>
                <span className="min-w-0">
                  <span className={turn.speaker === 'tool' ? 'font-mono text-[12px]' : ''}>{turn.text}</span>
                  {turn.note && <span className="block text-[11px] text-t3">{turn.note}</span>}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/**
 * What the receptionist will say, from `GET /campaigns/:id/preview`: the
 * opening sequence, an inbound and an outbound sample, the tools it can call,
 * the composed disclosure, and the placeholders that would block a deploy.
 * The web-call button is designed but not wired in the pilot.
 */
export function PreviewPanel({ campaignId }: { campaignId: string }) {
  const loadPreview = useCallback((signal: AbortSignal) => deploymentApi.preview(campaignId, signal), [campaignId]);
  const { state, reload } = useResource<PreviewResponse>(loadPreview);

  if (state.status === 'error') {
    return (
      <div className="cc-card p-6">
        <LoadFailureNotice what="The receptionist preview" message={state.failure.message} onRetry={reload} />
      </div>
    );
  }
  if (state.status === 'loading') return <div className="cc-card p-10 text-center text-sm text-t3" role="status"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" aria-hidden="true" /> Generating preview…</div>;
  const result = state.data;
  const placeholders = result.placeholders ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-t3">
          Previewing <span className="font-semibold text-t1">{result.agent.name}</span> · {result.agent.voice} · {result.agent.language}
        </p>
        <button
          type="button"
          disabled
          aria-disabled="true"
          title="Web calls arrive after pilot hardening — place a real test call from a staff phone instead."
          className="inline-flex items-center gap-2 rounded-xl border border-[var(--b1)] px-3 py-2 text-xs font-semibold text-t3 opacity-60"
        >
          <Mic className="h-3.5 w-3.5" aria-hidden="true" /> Talk to your receptionist
        </button>
      </div>

      {(result.agent.placeholder || placeholders.length > 0) && (
        <div role="alert" className="cc-card space-y-1.5 border-l-4 border-l-amber-v p-4">
          <p className="inline-flex items-center gap-2 text-sm font-bold text-t1"><ShieldAlert className="h-4 w-4 text-amber-v" aria-hidden="true" /> {result.agent.placeholder ? `Placeholder agent — create an agent to replace ${result.agent.name}` : 'Placeholder text blocks deployment'}</p>
          {placeholders.length > 0 && (
            <ul className="space-y-0.5 text-xs text-t2" aria-label="Placeholders">
              {placeholders.map((row, index) => (
                <li key={`${row.field}-${index}`}><span className="font-semibold text-t1">{row.field}</span>: “{row.value}” <span className="font-mono text-[10px] text-t3">{row.reason}</span></li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-t3">Deploy refuses placeholder text; replace it in the Agent &amp; Campaign tab.</p>
        </div>
      )}

      <section className="cc-card space-y-2 p-5" aria-label="Opening disclosure">
        <h3 className="inline-flex items-center gap-2 text-sm font-bold text-t1"><Sparkles className="h-4 w-4 text-violet-v" aria-hidden="true" /> Opening disclosure</h3>
        <p className="text-sm leading-relaxed text-t2">{result.disclosure.composed}</p>
        <div className="grid gap-2 md:grid-cols-2">
          <div className="rounded-lg border border-[var(--b1)] bg-[var(--s3)] px-3 py-2">
            <p className="text-[10px] font-bold uppercase tracking-wide text-t3">Baseline (required)</p>
            <p className="text-xs text-t2">{result.disclosure.baseline}</p>
          </div>
          <div className="rounded-lg border border-[var(--b1)] bg-[var(--s3)] px-3 py-2">
            <p className="text-[10px] font-bold uppercase tracking-wide text-t3">Clinic addition</p>
            <p className="text-xs text-t2">{result.disclosure.additional.trim() ? result.disclosure.additional : 'None — the baseline disclosure is used on its own.'}</p>
          </div>
        </div>
      </section>

      <Transcript icon={<Sparkles className="h-4 w-4 text-violet-v" aria-hidden="true" />} title="Opening sequence" turns={result.openingSequence} emptyText="No opening sequence generated." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Transcript icon={<PhoneIncoming className="h-4 w-4 text-emerald-v" aria-hidden="true" />} title="Inbound sample" turns={result.inboundSample} emptyText="No inbound sample generated." />
        <Transcript icon={<PhoneOutgoing className="h-4 w-4 text-indigo" aria-hidden="true" />} title="Outbound sample" turns={result.outboundSample} emptyText="No outbound sample generated." />
      </div>

      <section className="cc-card space-y-2 p-5" aria-label="Tools">
        <h3 className="inline-flex items-center gap-2 text-sm font-bold text-t1"><Wrench className="h-4 w-4 text-indigo" aria-hidden="true" /> Tools the receptionist can call</h3>
        {result.tools.length === 0 ? <p className="text-xs text-t3">No tools exported for this campaign.</p> : (
          <ul className="space-y-1.5">
            {result.tools.map(tool => (
              <li key={tool.name} className="rounded-lg border border-[var(--b1)] bg-[var(--s3)] px-3 py-2" data-tool={tool.name}>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="text-[11px] font-bold text-indigo">{tool.name}</code>
                  <span className="badge badge-blue">{tool.kind}</span>
                  {tool.requiresConsent && <span className="badge badge-amber">after consent</span>}
                </div>
                <p className="mt-0.5 text-[11px] text-t3">{tool.description}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="cc-card space-y-2 p-5">
        <div className="flex items-center justify-between">
          <h3 className="inline-flex items-center gap-2 text-sm font-bold text-t1"><Bot className="h-4 w-4 text-violet-v" aria-hidden="true" /> Generated system prompt</h3>
          <CopyButton value={result.systemPrompt} label="Copy prompt" />
        </div>
        <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap rounded-xl border border-[var(--b1)] bg-[var(--s3)] p-4 font-mono text-[12px] leading-relaxed text-t2">{result.systemPrompt}</pre>
      </div>
    </div>
  );
}
