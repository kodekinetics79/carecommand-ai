import { Rocket, CircleCheck, CircleAlert, CircleDashed, Circle } from 'lucide-react';
import type { Campaign } from '../../lib/receptionist';
import { goLiveSteps, type GoLiveStepStatus, type ProviderMode, type ReadinessResponse } from '../../lib/receptionistDeployment';
import { FixLink } from './ReadinessChecklist';

const STEP_ICON: Record<GoLiveStepStatus, { Icon: typeof CircleCheck; className: string; word: string }> = {
  done: { Icon: CircleCheck, className: 'text-emerald-v', word: 'Done' },
  warn: { Icon: CircleAlert, className: 'text-amber-v', word: 'Done with a warning' },
  todo: { Icon: Circle, className: 'text-t3', word: 'To do' },
  pending: { Icon: CircleDashed, className: 'text-t3', word: 'Not evaluated' },
};

/**
 * The ordered go-live path (contract §6): deploy → verify → forward the
 * public number to the DID → test call → activate. Each step mirrors one
 * readiness row; the card adds the two operational facts the runbook
 * mandates so nobody discovers them on launch day.
 */
export function GoLiveCard({ readiness, campaignStatus, providerMode }: {
  readiness: ReadinessResponse | null;
  campaignStatus: Campaign['status'];
  providerMode?: ProviderMode | null;
}) {
  const steps = goLiveSteps(readiness, campaignStatus);
  const done = steps.filter(step => step.status === 'done' || step.status === 'warn').length;
  return (
    <section aria-label="Go live" className="cc-card space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-2 text-sm font-bold text-t1"><Rocket className="h-4 w-4 text-indigo" aria-hidden="true" /> Go live</h3>
        <div className="flex items-center gap-2">
          {providerMode === 'mock' && <span className="badge badge-violet">mock mode</span>}
          <span className="badge badge-blue">{done}/{steps.length} steps</span>
        </div>
      </div>
      <ol className="space-y-1.5" aria-label="Go live steps">
        {steps.map((step, index) => {
          const { Icon, className, word } = STEP_ICON[step.status];
          return (
            <li key={step.key} className="flex items-start gap-2.5 rounded-lg border border-[var(--b1)] bg-[var(--s3)] px-3 py-2" data-step={step.key} data-status={step.status}>
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--indigo-soft)] text-[10px] font-bold text-indigo">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-t1">
                  <Icon className={`h-3.5 w-3.5 ${className}`} aria-hidden="true" /><span className="sr-only">{word}:</span> {step.label}
                </p>
                <p className="text-[11px] text-t3">{step.detail}</p>
              </div>
              <FixLink href={step.fixHref} label={`Fix ${step.label}`} />
            </li>
          );
        })}
      </ol>
      <ul className="space-y-1 text-[11px] text-t3">
        <li>Set the carrier's no-answer fallback to the front desk so a failed forward still reaches a person.</li>
        <li>Staff alerts for messages, handoffs and emergencies are in-app only in the pilot (banner and sidebar badge, refreshed every 20 seconds); no SMS or email alerts are sent to staff.</li>
      </ul>
    </section>
  );
}
