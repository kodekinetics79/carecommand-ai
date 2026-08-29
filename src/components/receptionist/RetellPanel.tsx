import { useCallback, useMemo } from 'react';
import { Code2, Loader2 } from 'lucide-react';
import { Field, TextInput } from '../ui/Field';
import { receptionistApi as api, type RetellConfig } from '../../lib/receptionist';
import { useResource } from '../../hooks/useResource';
import { receivedData } from '../../lib/resourceState';
import { CopyButton, KV } from './shared';
import { LoadFailureNotice } from './MutationNotice';

// ===== RetellAI Panel ======================================================

export function RetellPanel({ campaignId }: { campaignId: string }) {
  const loadConfig = useCallback(() => api.getRetellConfig(campaignId), [campaignId]);
  const { state, reload } = useResource<RetellConfig>(loadConfig);
  const config = receivedData(state);

  const fullJson = useMemo(() => (config ? JSON.stringify(config, null, 2) : ''), [config]);

  if (state.status === 'error') {
    return (
      <div className="cc-card p-6">
        <LoadFailureNotice what="The RetellAI export configuration" message={state.failure.message} onRetry={reload} />
      </div>
    );
  }
  if (!config) return <div className="cc-card p-10 text-center text-sm text-t3" role="status"><Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Building preview/export config…</div>;

  return (
    <div className="space-y-4">
      <div className="cc-card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-t1 inline-flex items-center gap-2"><Code2 className="w-4 h-4 text-indigo" /> Preview/export configuration — not deployed</h3>
          <CopyButton value={fullJson} label="Copy full JSON" />
        </div>
        <p role="note" className="text-xs text-t3">Copying this JSON does not change the live provider agent. Verify the linked deployment above before campaign activation.</p>
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

      <div className="cc-card p-5 space-y-2">
        <h3 className="text-sm font-bold text-t1">Dynamic variables</h3>
        <div className="grid gap-2 md:grid-cols-2">
          {Object.entries(config.dynamicVariables).map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--b1)] bg-[var(--s3)] px-3 py-1.5">
              <code className="text-[11px] font-semibold text-violet-v">{`{{${k}}}`}</code>
              <span className="text-[11px] text-t2 truncate">{v || '—'}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
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
            {config.callOutcomeFields.map((f, i) => (
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
    </div>
  );
}
