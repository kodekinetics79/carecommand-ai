import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env';
import {
  registry,
  httpRequestDuration,
  httpRequestsTotal,
  httpRequestErrorsTotal,
  metricsAccess,
  sampleQueueDepths,
} from '../lib/metrics';
import { refreshDependencyGauges } from '../modules/health/checks';
import { ALL_QUEUES } from '../workers/queues';

// Per-request start time, kept off the public request type.
const START = Symbol('metricsStart');

declare module 'fastify' {
  interface FastifyRequest {
    [START]?: bigint;
  }
}

/**
 * Records HTTP metrics and exposes /metrics for scraping.
 *
 * Route label uses the matched route template (`request.routeOptions.url`), not
 * the raw URL, so path params (ids/tokens/PHI) never leak into label values and
 * series cardinality stays bounded. Unmatched routes collapse to "unmatched".
 */
export const metricsPlugin = fp(async app => {
  if (!env.METRICS_ENABLED) return;

  app.addHook('onRequest', async (request: FastifyRequest) => {
    request[START] = process.hrtime.bigint();
  });

  app.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const start = request[START];
    if (start === undefined) return;
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;

    const route = request.routeOptions?.url ?? 'unmatched';
    // Don't self-instrument the scrape endpoint or the liveness probe — pure noise.
    if (route === '/metrics' || route === '/health/live') return;

    const labels = {
      method: request.method,
      route,
      status_code: String(reply.statusCode),
    };
    httpRequestDuration.observe(labels, seconds);
    httpRequestsTotal.inc(labels);
    if (reply.statusCode >= 500) {
      httpRequestErrorsTotal.inc({ method: request.method, route });
    }
  });

  // Scrape endpoint. In production it MUST be protected: without METRICS_TOKEN
  // set we return 404 rather than expose internal route cardinality / traffic
  // shape to the internet. Scrapers authenticate with a bearer token
  // (constant-time comparison — see metricsAccess in lib/metrics.ts).
  app.get('/metrics', async (request, reply) => {
    const access = metricsAccess(request.headers.authorization);
    if (access === 'not_found') return reply.code(404).send();
    if (access === 'unauthorized') return reply.code(401).send();

    // Refresh queue-depth and dependency gauges on scrape so the API surfaces
    // backlog and Postgres/Redis health even if the worker is down and no
    // external monitor is polling /health/ready. Cheap; failure-tolerant.
    await Promise.all([
      // Derived from the registry, never restated. This list used to name
      // three queues by hand and had silently gone stale: monitoring-safety,
      // eligibility-reconciliation and receptionist-call-reconciliation could
      // back up to any depth and `/metrics` reported nothing, so the
      // QueueBacklogGrowing alert could not fire for them at all.
      sampleQueueDepths([...ALL_QUEUES]),
      refreshDependencyGauges(),
    ]);

    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });
});
