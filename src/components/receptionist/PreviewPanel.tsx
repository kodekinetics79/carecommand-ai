import { useEffect, useState } from 'react';
import { Bot, Sparkles, Check, Megaphone, ListChecks, Loader2 } from 'lucide-react';
import { receptionistApi as api, type PromptResult } from '../../lib/receptionist';
import { CopyButton, SampleCard } from './shared';

// ===== Preview Panel =======================================================

export function PreviewPanel({ campaignId }: { campaignId: string }) {
  const [result, setResult] = useState<PromptResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.getPrompt(campaignId).then(r => { if (active) setResult(r); }).catch(e => { if (active) setError(e instanceof Error ? e.message : 'Failed'); });
    return () => { active = false; };
  }, [campaignId]);

  if (error) return <div className="cc-card p-6 text-sm text-red-v">{error}</div>;
  if (!result) return <div className="cc-card p-10 text-center text-sm text-t3"><Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Generating preview…</div>;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <SampleCard icon={<Sparkles className="w-4 h-4 text-violet-v" />} title="Sample greeting" text={result.samples.greeting} />
        <SampleCard icon={<Megaphone className="w-4 h-4 text-indigo" />} title="Sample pitch" text={result.samples.pitch} />
      </div>
      <div className="cc-card p-5 space-y-2">
        <h3 className="text-sm font-bold text-t1 inline-flex items-center gap-2"><ListChecks className="w-4 h-4 text-indigo" /> Sample intake questions</h3>
        {result.samples.intakeQuestions.length === 0 ? <p className="text-xs text-t3">No intake fields configured.</p> : (
          <ol className="space-y-1.5">
            {result.samples.intakeQuestions.map((q, i) => (
              <li key={i} className="flex gap-2.5 text-sm text-t2">
                <span className="w-5 h-5 rounded-full bg-[var(--indigo-soft)] text-indigo text-[10px] font-bold flex items-center justify-center shrink-0">{i + 1}</span>
                {q}
              </li>
            ))}
          </ol>
        )}
      </div>
      <SampleCard icon={<Check className="w-4 h-4 text-emerald-v" />} title="Sample confirmation" text={result.samples.confirmation} />
      <div className="cc-card p-5 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-t1 inline-flex items-center gap-2"><Bot className="w-4 h-4 text-violet-v" /> Generated system prompt</h3>
          <CopyButton value={result.systemPrompt} label="Copy prompt" />
        </div>
        <pre className="max-h-[480px] overflow-auto rounded-xl border border-[var(--b1)] bg-[var(--s3)] p-4 text-[12px] leading-relaxed text-t2 whitespace-pre-wrap font-mono">{result.systemPrompt}</pre>
      </div>
    </div>
  );
}
