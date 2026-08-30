import { Loader2 } from 'lucide-react';
import {
  KPI_UNAVAILABLE, formatKpiCount, formatKpiDuration, formatKpiRate, openCountOf,
  type OverviewKpis, type ReceptionistTaskKind, type TaskSummary,
} from '../../lib/frontDesk';
import { formatClinicTime } from '../../lib/frontDeskTime';
import type { ResourceFailure } from '../../lib/resourceState';

// ===========================================================================
// SF-2 — the shift report.
//
// The honest kpi-v2 block has been computed on every `/overview` call since C4
// and read by nobody: the headers still printed the legacy scalars beside it,
// which collapse null to 0 and produce the "7 calls handled / 14% booking rate"
// the contract froze as NOT evidence of receptionist capability.
//
// This is the surface that block was for — what a front-desk lead reads at
// handover. Three questions, in the order they are asked:
//
//   what the AI handled · what is still open · what needs a human now
//
// Two rules the panel keeps without exception:
//   1. A rate with no denominator is UNAVAILABLE, never 0%. Zero answered calls
//      is not a 0% booking rate; it is an unanswerable question, and printing
//      0% is the specific lie that discredited the old header.
//   2. Every number carries the server's own definition of itself. A metric an
//      owner cannot interrogate is a metric an owner cannot trust — and every
//      rival quotes a containment rate nobody can define.
// ===========================================================================

type LoadState = 'loading' | 'ready' | 'error';

function Metric({ label, value, definition, tone = 'plain' }: {
  label: string;
  value: string;
  definition?: string;
  tone?: 'plain' | 'attention';
}) {
  const unavailable = value === KPI_UNAVAILABLE;
  return (
    <div className="rounded-xl border border-[var(--b1)] bg-[var(--s3)] px-3 py-2">
      <p className="text-[10px] font-bold uppercase tracking-wide text-t3">{label}</p>
      <p className={`mt-0.5 text-lg font-bold tabular-nums leading-none ${
        unavailable ? 'text-t3' : tone === 'attention' ? 'text-red-v' : 'text-t1'
      }`}>
        {value}
      </p>
      {definition && <p className="mt-1 text-[10px] leading-snug text-t3">{definition}</p>}
      {unavailable && <p className="mt-1 text-[10px] leading-snug text-t3">Not enough data in this period to compute it. This is not a zero.</p>}
    </div>
  );
}

export function ShiftReport({ kpis, state, failure, summary, timezone, onRetry }: {
  kpis: OverviewKpis | null;
  state: LoadState;
  failure: ResourceFailure | null;
  /** The live queue, for "what is still open" — the same summary every other surface reads. */
  summary: TaskSummary | null;
  timezone: string;
  onRetry: () => void;
}) {
  const definitions = kpis?.definitions ?? ({} as Record<string, string>);
  const openKinds: ReceptionistTaskKind[] = ['message', 'human_handoff', 'missed_call', 'booking_review', 'call_denied', 'ai_declined', 'tool_failure', 'identity_locked'];
  const stillOpen = openCountOf(summary, openKinds);
  const emergenciesOpen = openCountOf(summary, ['emergency']);
  const deploymentOpen = openCountOf(summary, ['deployment_attention']);

  return (
    <section aria-label="Shift report" className="rounded-2xl border border-[var(--b1)] bg-[var(--s2)] p-4 space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-t1">Shift report</h2>
          <p className="text-[11px] text-t3">
            What the AI handled, what is still open, and what needs a human — for the handover.
          </p>
        </div>
        {state === 'ready' && kpis && (
          <p className="text-[10px] text-t3">
            Today in {kpis.period.timezone} · through {formatClinicTime(new Date().toISOString(), kpis.period.timezone) || 'now'}
            {kpis.definitions.version ? ` · ${kpis.definitions.version}` : ''}
          </p>
        )}
      </div>

      {state === 'loading' && (
        <p role="status" aria-busy="true" className="rounded-xl border border-[var(--b1)] px-3 py-4 text-center text-xs text-t3">
          <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin" aria-hidden="true" />Loading the shift report…
        </p>
      )}

      {state === 'error' && (
        <div role="alert" className="rounded-xl border border-red-v/40 bg-[var(--red-soft)] px-3 py-2.5 text-xs text-red-v">
          <p className="font-semibold">The shift report could not be loaded.</p>
          <p className="mt-0.5">{failure?.message ?? 'The request did not complete.'} No figure is shown, because none was read.</p>
          <button type="button" onClick={onRetry} className="mt-1.5 rounded-lg border border-red-v/40 px-2.5 py-1 text-[11px] font-semibold text-red-v hover:bg-[var(--s2)]">Retry</button>
        </div>
      )}

      {state === 'ready' && kpis && (
        <>
          <div>
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-t3">What the AI handled</p>
            <div className="grid gap-2 grid-cols-2 lg:grid-cols-3">
              <Metric label="Answered inbound" value={formatKpiCount(kpis.counts.answeredInbound)} definition={definitions.answeredInbound} />
              <Metric label="Handled without a human" value={formatKpiRate(kpis.rates.containedPct)} definition={definitions.containedPct} />
              <Metric label="Booked on the call" value={formatKpiRate(kpis.rates.bookingRate)} definition={definitions.bookingRate} />
              <Metric label="Average call" value={formatKpiDuration(kpis.aht)} definition={definitions.aht} />
              <Metric label="After hours" value={formatKpiRate(kpis.rates.afterHoursPct)} definition={definitions.afterHours} />
              <Metric label="Callbacks within SLA" value={formatKpiRate(kpis.rates.callbacksWithinSlaPct)} definition={definitions.callbacksWithinSla} />
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-t3">What is still open</p>
            <div className="grid gap-2 grid-cols-2 lg:grid-cols-3">
              <Metric
                label="Callers waiting on a person"
                value={stillOpen === null ? KPI_UNAVAILABLE : String(stillOpen)}
                definition="Open receptionist tasks that are not emergencies, from the live queue."
              />
              <Metric label="Booking requests to review" value={formatKpiCount(kpis.counts.pendingRequests)} />
              <Metric label="Open handoffs" value={formatKpiCount(kpis.counts.openHandoffs)} />
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-t3">What needs a human now</p>
            <div className="grid gap-2 grid-cols-2 lg:grid-cols-3">
              <Metric
                label="Emergencies open"
                value={emergenciesOpen === null ? KPI_UNAVAILABLE : String(emergenciesOpen)}
                definition="Nobody may close these but a person."
                tone={emergenciesOpen ? 'attention' : 'plain'}
              />
              <Metric
                label="Service status alerts"
                value={deploymentOpen === null ? KPI_UNAVAILABLE : String(deploymentOpen)}
                definition="Open deployment-attention tasks. Any number above zero means the line may not be answering."
                tone={deploymentOpen ? 'attention' : 'plain'}
              />
              <Metric label="Opted out on a call" value={formatKpiCount(kpis.counts.optedOut)} />
            </div>
          </div>

          <p className="text-[10px] leading-relaxed text-t3">
            Every figure above is computed from stored call records for this period in {timezone}, with its definition
            printed beside it. A rate whose denominator was empty reads “{KPI_UNAVAILABLE}” — it is never shown as 0.
          </p>
        </>
      )}
    </section>
  );
}
