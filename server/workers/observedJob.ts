import type { Job } from 'bullmq';
import { jobDuration, jobsTotal } from '../lib/metrics';
import { runInJobContext, type TraceCarrier } from '../lib/traceContext';

// Job data may carry a W3C trace carrier injected at enqueue (see queues.ts).
type WithCarrier = { _otel?: TraceCarrier };

/**
 * Wrap a BullMQ processor so every job:
 *   1. runs inside the trace context of the request that enqueued it, and
 *   2. records job_duration_seconds + jobs_total{outcome} metrics.
 *
 * A failure re-throws (BullMQ needs it for retry/backoff), but the metric and
 * the trace context are recorded first. Pure decorator — no behaviour change to
 * the wrapped handler beyond observability.
 */
export function observed<T extends WithCarrier, R>(
  queue: string,
  handler: (job: Job<T>) => Promise<R>,
): (job: Job<T>) => Promise<R> {
  return async job => {
    const carrier = job.data?._otel;
    return runInJobContext(carrier, async () => {
      const name = job.name;
      const stop = jobDuration.startTimer({ queue, name });
      try {
        const result = await handler(job);
        jobsTotal.inc({ queue, name, outcome: 'completed' });
        return result;
      } catch (error) {
        jobsTotal.inc({ queue, name, outcome: 'failed' });
        throw error;
      } finally {
        stop();
      }
    });
  };
}
