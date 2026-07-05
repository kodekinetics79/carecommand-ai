// ===========================================================================
// Prometheus metrics registry (the "metrics" pillar).
//
// A single process-wide registry holds default Node runtime metrics (event-loop
// lag, heap, GC, handles) plus our application metrics. The Fastify plugin
// (plugins/metrics.ts) records per-request timing; the worker records job
// outcomes; and sampleQueueDepths() gauges backlog. Everything is exposed at
// /metrics for a Prometheus/Grafana Agent/OTel-collector scrape.
//
// Cardinality discipline: route labels use the *matched route template*
// (`/v1/patients/:id`), never the raw URL, so ids/PHI never become label values
// and the series count stays bounded.
// ===========================================================================

import { createHash, timingSafeEqual } from 'node:crypto';
import client from 'prom-client';
import type { Queue } from 'bullmq';
import { env } from '../config/env';

export const registry = new client.Registry();

registry.setDefaultLabels({
  service: env.OTEL_SERVICE_NAME,
  env: env.SERVICE_ENV ?? env.NODE_ENV,
});

// Node runtime + process metrics (event loop lag is the early-warning signal
// for a saturating instance).
client.collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds, by route/method/status.',
  labelNames: ['method', 'route', 'status_code'] as const,
  // Buckets tuned to the SLO (p95 < 500ms) with tail visibility to 5s.
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests, by route/method/status.',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [registry],
});

export const httpRequestErrorsTotal = new client.Counter({
  name: 'http_request_errors_total',
  help: 'HTTP responses with status >= 500, by route/method.',
  labelNames: ['method', 'route'] as const,
  registers: [registry],
});

// ── Background job metrics ────────────────────────────────────────────────
export const jobDuration = new client.Histogram({
  name: 'job_duration_seconds',
  help: 'Background job processing duration in seconds, by queue/name.',
  labelNames: ['queue', 'name'] as const,
  buckets: [0.05, 0.1, 0.5, 1, 5, 15, 30, 60, 120],
  registers: [registry],
});

export const jobsTotal = new client.Counter({
  name: 'jobs_total',
  help: 'Background jobs processed, by queue/name/outcome (completed|failed).',
  labelNames: ['queue', 'name', 'outcome'] as const,
  registers: [registry],
});

export const queueDepth = new client.Gauge({
  name: 'queue_depth',
  help: 'Jobs in a queue by state (waiting|active|delayed|failed).',
  labelNames: ['queue', 'state'] as const,
  registers: [registry],
});

// Health of external dependencies as seen by the readiness probe: 1 up, 0 down.
export const dependencyUp = new client.Gauge({
  name: 'dependency_up',
  help: 'Readiness of a critical dependency (1 = up, 0 = down).',
  labelNames: ['dependency'] as const,
  registers: [registry],
});

export type MetricsAccess = 'ok' | 'not_found' | 'unauthorized';

/**
 * Shared access rule for metrics exposition — used by both the API's /metrics
 * route (plugins/metrics.ts) and the worker's standalone listener
 * (workers/metricsServer.ts). Outside production everything is open. In
 * production METRICS_TOKEN must be configured (unset → deny-all as 404, never
 * leak that the endpoint exists) and presented as a bearer token. Tokens are
 * hashed before comparison so timingSafeEqual is constant-time even when the
 * lengths differ.
 */
export function metricsAccess(authorizationHeader: string | undefined): MetricsAccess {
  if (env.NODE_ENV !== 'production') return 'ok';
  if (!env.METRICS_TOKEN) return 'not_found';
  const provided = authorizationHeader?.startsWith('Bearer ')
    ? authorizationHeader.slice('Bearer '.length)
    : '';
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(env.METRICS_TOKEN).digest();
  return timingSafeEqual(a, b) ? 'ok' : 'unauthorized';
}

/**
 * Sample BullMQ backlog into the queue_depth gauge. Cheap (a few Redis counts);
 * call on a short interval from the worker and lazily on /metrics scrape from
 * the API. Never throws — a metrics failure must not affect the caller.
 */
// Accept any BullMQ Queue regardless of its job/name generics.
type AnyQueue = Pick<Queue<unknown, unknown, string>, 'name' | 'getJobCounts'>;

export async function sampleQueueDepths(queues: AnyQueue[]): Promise<void> {
  await Promise.all(
    queues.map(async q => {
      try {
        const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
        for (const state of ['waiting', 'active', 'delayed', 'failed'] as const) {
          queueDepth.set({ queue: q.name, state }, counts[state] ?? 0);
        }
      } catch {
        // ignore: a Redis hiccup shouldn't blank the whole scrape
      }
    }),
  );
}
