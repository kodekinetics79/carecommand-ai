// ===========================================================================
// Service Level Objectives — the commitments we measure against.
//
// This is the single source of truth for "what does healthy mean". The alert
// rules in ops/prometheus/alerts.yml are derived from these numbers; keep them
// in sync. Exposed at GET /health/slo so the target is discoverable and can be
// asserted in tests.
//
// Each SLO pairs a target (the commitment) with the SLI (how it is measured
// from the /metrics stream) and an error budget (the allowance for failure over
// the window). Alerts fire on fast burn of the budget, not on every blip.
// ===========================================================================

export interface Slo {
  id: string;
  description: string;
  /** Objective as a fraction (0.995 = 99.5%), a latency ceiling in ms, or a count ceiling. */
  target: number;
  unit: 'ratio' | 'milliseconds' | 'count';
  window: '30d';
  /** How the SLI is computed from Prometheus metrics. */
  sli: string;
}

export const SLOS: Slo[] = [
  {
    id: 'availability',
    description: 'API readiness — successful (non-5xx) responses.',
    target: 0.995, // 99.5% ⇒ 216 min (~3h36m) error budget / 30d
    unit: 'ratio',
    window: '30d',
    sli: '1 - (sum(rate(http_request_errors_total[5m])) / sum(rate(http_requests_total[5m])))',
  },
  {
    id: 'latency',
    description: 'p95 request latency stays fast.',
    target: 500, // ms
    unit: 'milliseconds',
    window: '30d',
    sli: 'histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le)) * 1000',
  },
  {
    id: 'job_success',
    description: 'Background jobs complete (autopilot/campaign/compliance).',
    target: 0.99, // 99%
    unit: 'ratio',
    window: '30d',
    sli: 'sum(rate(jobs_total{outcome="completed"}[30m])) / sum(rate(jobs_total[30m]))',
  },
  {
    id: 'queue_freshness',
    description: 'Queues drain — backlog does not pile up.',
    target: 100, // waiting jobs; sustained above → alert
    unit: 'count',
    window: '30d',
    sli: 'max(queue_depth{state="waiting"})',
  },
];

/** Error-budget minutes for a ratio SLO over a 30-day window. */
export function errorBudgetMinutes(target: number): number {
  return Math.round((1 - target) * 30 * 24 * 60);
}
