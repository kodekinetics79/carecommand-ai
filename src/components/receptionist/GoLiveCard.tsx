import { Rocket, CircleCheck, CircleAlert, CircleDashed, Circle, PhoneCall, ArrowRight, Radio } from 'lucide-react';
import type { Campaign } from '../../lib/receptionist';
import {
  goLiveRail, serviceStatus,
  type GoLivePrerequisite, type GoLiveStepStatus, type ProviderMode, type ReadinessResponse,
  type ServiceState, type ServiceStatus, type VerificationView,
} from '../../lib/receptionistDeployment';
import { FixLink } from './ReadinessChecklist';

const STEP_ICON: Record<GoLiveStepStatus, { Icon: typeof CircleCheck; className: string; word: string }> = {
  done: { Icon: CircleCheck, className: 'text-emerald-v', word: 'Done' },
  warn: { Icon: CircleAlert, className: 'text-amber-v', word: 'Done with a warning' },
  todo: { Icon: Circle, className: 'text-t3', word: 'To do' },
  pending: { Icon: CircleDashed, className: 'text-t3', word: 'Not evaluated' },
};

const SERVICE_TONE: Record<ServiceState, { badge: string; dot: string }> = {
  answering: { badge: 'badge badge-emerald', dot: 'bg-emerald-v' },
  degraded: { badge: 'badge badge-amber', dot: 'bg-amber-v' },
  not_answering: { badge: 'badge badge-red', dot: 'bg-red-v' },
  unknown: { badge: 'badge badge-blue', dot: 'bg-t3' },
};

/**
 * SF-3 — the service status strip.
 *
 * One always-visible line answering the question no AI-receptionist product
 * answers today: is this clinic's line answering right now, and if not, what
 * is the one click that fixes it. Every word comes from the server's
 * readiness evaluation and its remediation catalogue.
 */
export function ServiceStatusStrip({ status, className = '' }: { status: ServiceStatus; className?: string }) {
  const tone = SERVICE_TONE[status.state];
  return (
    <div
      role="status"
      aria-label="Receptionist service status"
      data-service-state={status.state}
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2 ${className}`}
    >
      <span className="inline-flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
        <span className={tone.badge}>{status.headline}</span>
      </span>
      <p className="min-w-0 flex-1 text-[11px] text-t2">{status.detail}</p>
      {status.action && <p className="text-[11px] font-semibold text-t1">{status.action}</p>}
      <FixLink href={status.fixHref} label={`Fix ${status.action ?? status.headline}`} />
    </div>
  );
}

/**
 * SF-4 — the go-live rail.
 *
 * The ordered path (contract §6): clinic prerequisites → deploy → verify →
 * forward the public number to the DID → test call → activate, ending with
 * the number a patient dials in large type. Each step mirrors one readiness
 * row and carries the server's own remediation title and fix link, so the
 * owner always sees what is blocking the line and the one click that clears
 * it. A row the server did not evaluate stays pending — never assumed done.
 */
export function GoLiveCard({
  readiness, campaignStatus, providerMode, prerequisites = [], verification = null, deploying = false,
}: {
  readiness: ReadinessResponse | null;
  campaignStatus: Campaign['status'];
  providerMode?: ProviderMode | null;
  /** Clinic-level blockers (country, hours, locale pack) that precede every step below. */
  prerequisites?: GoLivePrerequisite[];
  verification?: VerificationView | null;
  /** A deploy is publishing right now, so the agent is briefly unverified. */
  deploying?: boolean;
}) {
  const rail = goLiveRail({ readiness, campaignStatus, prerequisites });
  const status = serviceStatus({ campaignStatus, readiness, verification, deploying });
  const mode = providerMode ?? readiness?.providerMode ?? null;
  return (
    <section aria-label="Go live" className="cc-card space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-2 text-sm font-bold text-t1"><Rocket className="h-4 w-4 text-indigo" aria-hidden="true" /> Go live</h3>
        <div className="flex items-center gap-2">
          {mode === 'mock' && <span className="badge badge-violet">mock mode</span>}
          {mode === 'unconfigured' && <span className="badge badge-amber">provider unconfigured</span>}
          <span className="badge badge-blue">{rail.done}/{rail.total} steps</span>
        </div>
      </div>

      <ServiceStatusStrip status={status} />

      {deploying && (
        <p role="alert" data-testid="degrade-window" className="rounded-lg border border-amber-v/40 bg-[var(--s3)] px-3 py-2 text-[11px] text-t1">
          <span className="font-semibold">Redeploy in progress.</span> Until verification completes the agent is unverified, so a caller reaching this line can only leave a message or be transferred — it cannot book. Do not leave this window open longer than it takes to verify.
        </p>
      )}

      {rail.next && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-indigo/40 bg-[var(--indigo-soft)] px-3 py-2" data-testid="next-action">
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-indigo" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-xs"><span className="font-semibold text-t1">Next: {rail.next.label}</span> <span className="text-t2">{rail.next.detail}</span></p>
          <FixLink href={rail.next.fixHref} label={`Fix ${rail.next.label}`} />
        </div>
      )}

      {rail.prerequisites.length > 0 && (
        <div className="space-y-1.5" data-testid="clinic-prerequisites">
          <p className="text-[11px] font-bold uppercase tracking-wide text-t3">Clinic prerequisites</p>
          <ul className="space-y-1.5" aria-label="Clinic prerequisites">
            {rail.prerequisites.map(item => (
              <li key={item.code} className="flex items-start gap-2.5 rounded-lg border border-amber-v/40 bg-[var(--s3)] px-3 py-2" data-prerequisite={item.code}>
                <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-v" aria-hidden="true" />
                <p className="min-w-0 flex-1 text-xs font-semibold text-t1">{item.label}</p>
                <FixLink href={item.fixHref} label={`Fix ${item.label}`} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <ol className="space-y-1.5" aria-label="Go live steps">
        {rail.steps.map((step, index) => {
          const { Icon, className, word } = STEP_ICON[step.status];
          return (
            <li key={step.key} className="flex items-start gap-2.5 rounded-lg border border-[var(--b1)] bg-[var(--s3)] px-3 py-2" data-step={step.key} data-status={step.status}>
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--indigo-soft)] text-[10px] font-bold text-indigo">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-t1">
                  <Icon className={`h-3.5 w-3.5 ${className}`} aria-hidden="true" /><span className="sr-only">{word}:</span> {step.label}
                </p>
                {step.title && <p className="text-[11px] font-semibold text-amber-v">{step.title}</p>}
                <p className="text-[11px] text-t3">{step.detail}</p>
              </div>
              <FixLink href={step.fixHref} label={`Fix ${step.label}`} />
            </li>
          );
        })}
      </ol>

      <div className="rounded-lg border border-[var(--b1)] bg-[var(--s3)] px-3 py-2" data-testid="dial-this-number">
        <p className="text-[10px] font-bold uppercase tracking-widest text-t3">The number a patient dials</p>
        {rail.boundNumber
          ? (
            <p className="mt-0.5 inline-flex items-center gap-2 text-2xl font-bold tabular-nums tracking-tight text-t1">
              <PhoneCall className="h-5 w-5 text-emerald-v" aria-hidden="true" />{rail.boundNumber}
            </p>
          )
          : (
            <p className="mt-0.5 inline-flex items-center gap-2 text-xs text-t2">
              <Radio className="h-3.5 w-3.5 text-t3" aria-hidden="true" />
              Not confirmed yet. The number appears here once the provider tells us which line answers with this deployment — until then nothing on this screen proves a caller can reach you.
            </p>
          )}
      </div>

      <ul className="space-y-1 text-[11px] text-t3">
        <li>Set the carrier&apos;s no-answer fallback to the front desk so a failed forward still reaches a person.</li>
        <li>Staff alerts for messages, handoffs and emergencies are in-app only in the pilot (banner and sidebar badge, refreshed every 20 seconds); no SMS or email alerts are sent to staff.</li>
      </ul>
    </section>
  );
}
