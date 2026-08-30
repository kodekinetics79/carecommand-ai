import { useCallback, useMemo } from 'react';
import { Code2, Loader2 } from 'lucide-react';
import { Field, TextInput } from '../ui/Field';
import { receptionistApi as api, type Campaign, type VoiceLineConfiguration } from '../../lib/receptionist';
import { useResource } from '../../hooks/useResource';
import { receivedData } from '../../lib/resourceState';
import { CopyButton, KV } from './shared';
import { LoadFailureNotice } from './MutationNotice';
import { DeployPanel } from './DeployPanel';

// ===== Go live =============================================================
// This tab is the publish host. DeployPanel owns publish / line check / status.
//
// The raw provider export that used to sit under it — the full JSON with a
// "Copy full JSON" button, the callback URL, the dynamic-variable table and
// the booking function schema — is gone from the tenant's view. Its own note
// admitted what it was ("copying this JSON does not change the live agent"):
// a diagnostic for us, printed for them, that happened to disclose the whole
// integration. The server no longer sends those fields unless the caller holds
// `platform:voice-line-mechanics:read`, so the block below renders only when
// they are actually present. That is the gate — there is nothing here to
// unhide.

export function GoLivePanel({ campaignId, campaignStatus = null, onDeployingChange, onConfigure }: {
  campaignId: string;
  campaignStatus?: Campaign['status'] | null;
  onDeployingChange?: (deploying: boolean) => void;
  onConfigure?: (target: 'campaign' | 'intake') => void;
}) {
  const loadConfig = useCallback(() => api.getVoiceLineConfiguration(campaignId), [campaignId]);
  const { state, reload } = useResource<VoiceLineConfiguration>(loadConfig);
  const config = receivedData(state);

  const fullJson = useMemo(() => (config ? JSON.stringify(config, null, 2) : ''), [config]);

  return (
    <div className="space-y-4">
      <DeployPanel campaignId={campaignId} config={config} campaignStatus={campaignStatus} onDeployingChange={onDeployingChange} />

      {state.status === 'error' && (
        <div className="cc-card p-6 space-y-2">
          <LoadFailureNotice what="The voice line configuration" message={state.failure.message} onRetry={reload} />
          {['invalid_receptionist_configuration', 'invalid_intake_configuration'].includes(state.failure.code ?? '') && onConfigure && (
            // A 409 here is a configuration step, not a dead end: send the
            // operator to the exact screen that produces a valid export.
            <button type="button" onClick={() => onConfigure(state.failure.code === 'invalid_intake_configuration' ? 'intake' : 'campaign')} className="rounded-lg border border-[var(--b1)] px-2.5 py-1 text-[11px] font-semibold text-t2 hover:bg-[var(--s2)]">
              {state.failure.code === 'invalid_intake_configuration' ? 'Open Intake Builder' : 'Open campaign settings'}
            </button>
          )}
        </div>
      )}
      {!config && state.status !== 'error' && (
        <div className="cc-card p-10 text-center text-sm text-t3" role="status"><Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Building the voice line configuration…</div>
      )}

      {config && typeof config.webhookUrl === 'string' && (
        <details className="space-y-4" data-testid="export-configuration">
          <summary className="cursor-pointer text-sm font-bold text-t1"><Code2 className="mr-1.5 inline h-4 w-4 text-indigo" aria-hidden="true" /> Provider export (CareCommand support only) — not deployed</summary>
          <div className="cc-card mt-4 p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-t1 inline-flex items-center gap-2"><Code2 className="w-4 h-4 text-indigo" /> Provider export — not deployed</h3>
              <CopyButton value={fullJson} label="Copy full JSON" />
            </div>
            <p role="note" className="text-xs text-t3">Copying this JSON does not change the live line. Run the line check above before campaign activation.</p>
            <div className="grid gap-3 md:grid-cols-3">
              <KV label="Voice ID" value={config.voiceId} />
              <KV label="Language" value={config.language} />
              <KV label="Begin message" value={config.beginMessage} mono={false} />
            </div>
            <Field label="Webhook URL">
              <div className="flex gap-2">
                <TextInput readOnly value={config.webhookUrl} className="font-mono text-xs" />
                <CopyButton value={config.webhookUrl} />
              </div>
            </Field>
          </div>

          <div className="cc-card mt-4 p-5 space-y-2">
            <h3 className="text-sm font-bold text-t1">Dynamic variables</h3>
            <div className="grid gap-2 md:grid-cols-2">
              {Object.entries(config.dynamicVariables ?? {}).map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--b1)] bg-[var(--s3)] px-3 py-1.5">
                  <code className="text-[11px] font-semibold text-violet-v">{`{{${k}}}`}</code>
                  <span className="text-[11px] text-t2 truncate">{v || '—'}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="cc-card p-5 space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-t1">Booking function schema</h3>
                <CopyButton value={JSON.stringify(config.bookingFunction, null, 2)} />
              </div>
              <pre className="max-h-80 overflow-auto rounded-xl border border-[var(--b1)] bg-[var(--s3)] p-3 text-[11px] leading-relaxed text-t2 font-mono">{JSON.stringify(config.bookingFunction, null, 2)}</pre>
            </div>
            <div className="cc-card p-5 space-y-2">
              <h3 className="text-sm font-bold text-t1">Call-outcome extraction fields</h3>
              <div className="space-y-1.5">
                {(config.callOutcomeFields ?? []).map((f, i) => (
                  <div key={i} className="rounded-lg border border-[var(--b1)] bg-[var(--s3)] px-3 py-2">
                    <div className="flex items-center gap-2">
                      <code className="text-[11px] font-bold text-indigo">{String(f.name)}</code>
                      <span className="badge badge-blue">{String(f.type)}</span>
                    </div>
                    <p className="text-[11px] text-t3 mt-0.5">{String(f.description)}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
