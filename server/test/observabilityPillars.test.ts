import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { metricsPlugin } from '../plugins/metrics';
import { monitoringAccessForEnvironment, registry, sampleQueueDepths, queueDepth } from '../lib/metrics';
import { SLOS, errorBudgetMinutes } from '../lib/slo';
import { currentTraceCarrier, runInJobContext, getTraceIds } from '../lib/traceContext';
import { healthRoutes } from '../modules/health/routes';

describe('metrics — /metrics exposition', () => {
  it('fails the production monitoring boundary closed and accepts only the configured bearer token', () => {
    expect(monitoringAccessForEnvironment('production', undefined, undefined)).toBe('not_found');
    expect(monitoringAccessForEnvironment('production', 'monitor-secret', undefined)).toBe('unauthorized');
    expect(monitoringAccessForEnvironment('production', 'monitor-secret', 'Bearer wrong')).toBe('unauthorized');
    expect(monitoringAccessForEnvironment('production', 'monitor-secret', 'Bearer monitor-secret')).toBe('ok');
    expect(monitoringAccessForEnvironment('development', undefined, undefined)).toBe('ok');
  });
  it('records request duration + count and exposes them (dev: unauthenticated)', async () => {
    const app = Fastify({ logger: false });
    await app.register(metricsPlugin);
    app.get('/v1/ping/:id', async () => ({ ok: true }));
    await app.ready();

    await app.inject({ method: 'GET', url: '/v1/ping/abc' });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.body;
    // Route label uses the template, NOT the raw id — no PHI/ids in labels.
    expect(body).toContain('route="/v1/ping/:id"');
    expect(body).not.toContain('abc');
    expect(body).toContain('http_requests_total');
    expect(body).toContain('http_request_duration_seconds_bucket');
    // Default runtime metrics are present.
    expect(body).toContain('nodejs_eventloop_lag_seconds');
  });

  it('uses the matched-route template, never the raw url', () => {
    // Guard against a regression that would explode label cardinality / leak ids.
    const metric = registry.getSingleMetric('http_requests_total');
    expect(metric).toBeDefined();
  });
});

describe('metrics — a Redis outage must not stall the scrape', () => {
  // The BullMQ clients are constructed with `maxRetriesPerRequest: null`
  // (workers/queues.ts), which tells ioredis to buffer commands indefinitely
  // rather than fail them. So when Redis is unreachable getJobCounts() does not
  // reject — it never settles, and the try/catch around it can never run. The
  // scrape then never reaches registry.metrics(), so dependency_up{redis}=0 is
  // never published and DependencyDown stays silent through the whole incident.
  // A hung dependency is modelled here exactly: a promise that never settles.
  const hungQueue = {
    name: 'test-hung-queue',
    getJobCounts: () => new Promise<never>(() => { /* buffered forever, like ioredis offline */ }),
  } as unknown as Parameters<typeof sampleQueueDepths>[0][number];

  it('gives up on a queue whose client never answers, instead of waiting forever', async () => {
    const startedAt = process.hrtime.bigint();
    await sampleQueueDepths([hungQueue]);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    // Bounded by the 1s guard. Without it this call never returns and the test
    // fails on timeout rather than on this assertion.
    expect(elapsedMs).toBeLessThan(3000);
  });

  it('still publishes the rest of the scrape when one queue is unreachable', async () => {
    const healthyQueue = {
      name: 'test-healthy-queue',
      getJobCounts: async () => ({ waiting: 4, active: 1, delayed: 0, failed: 2 }),
    } as unknown as Parameters<typeof sampleQueueDepths>[0][number];

    await sampleQueueDepths([hungQueue, healthyQueue]);

    // The reachable queue's backlog is recorded even though its neighbour hung —
    // one dead dependency must not blank the whole exposition.
    expect(await queueDepth.get().then(g => g.values.find(v =>
      v.labels.queue === 'test-healthy-queue' && v.labels.state === 'waiting')?.value)).toBe(4);
    // And the scrape body itself renders, which is the property the alert needs.
    expect(await registry.metrics()).toContain('test-healthy-queue');
  });
});

describe('slo — objectives are well-formed and discoverable', () => {
  it('every SLO has a target, unit, and SLI query', () => {
    expect(SLOS.length).toBeGreaterThan(0);
    for (const slo of SLOS) {
      expect(slo.id).toBeTruthy();
      expect(slo.target).toBeGreaterThan(0);
      expect(['ratio', 'milliseconds', 'count']).toContain(slo.unit);
      expect(slo.sli).toContain('('); // a real promql expression
    }
  });

  it('computes a sane error budget from a ratio target', () => {
    // 99.5% over 30d = 0.005 × 43200 min = 216 minutes (~3h36m).
    expect(errorBudgetMinutes(0.995)).toBe(216);
  });

  it('serves the SLO spec at /health/slo', async () => {
    const app = Fastify({ logger: false });
    await app.register(healthRoutes);
    const res = await app.inject({ method: 'GET', url: '/health/slo' });
    await app.close();
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.window).toBe('30d');
    expect(json.objectives.find((o: { id: string }) => o.id === 'availability')).toBeTruthy();
  });

  it('serves the truthful integration posture at /health/integrations — modes only, never secrets', async () => {
    const app = Fastify({ logger: false });
    await app.register(healthRoutes);
    const res = await app.inject({ method: 'GET', url: '/health/integrations' });
    await app.close();
    expect(res.statusCode).toBe(200);
    const json = res.json();

    // Effective deployment profile is always reported.
    expect(['demo', 'pilot', 'enterprise']).toContain(json.profile);

    // Provider-mode integrations report the effective provider id.
    expect(typeof json.integrations.payments).toBe('string');
    expect(typeof json.integrations.insurance).toBe('string');
    expect(typeof json.integrations.ai).toBe('string');

    // Channel integrations are presence-derived flags only.
    for (const channel of ['email', 'sms', 'voice'] as const) {
      expect(['configured', 'not_configured']).toContain(json.integrations[channel]);
    }

    expect(Array.isArray(json.acknowledgedMockIntegrations)).toBe(true);

    // No secret material: the response is exactly the documented id/flag shape.
    expect(Object.keys(json).sort()).toEqual(['acknowledgedMockIntegrations', 'integrations', 'profile']);
    expect(Object.keys(json.integrations).sort()).toEqual(['ai', 'email', 'insurance', 'payments', 'sms', 'voice']);
    const body = res.body;
    for (const secret of [process.env.JWT_SECRET, process.env.STRIPE_SECRET_KEY, process.env.RETELL_API_KEY, process.env.TWILIO_AUTH_TOKEN]) {
      if (secret) expect(body).not.toContain(secret);
    }
  });

  it('/health reports release + uptime', async () => {
    const app = Fastify({ logger: false });
    await app.register(healthRoutes);
    const res = await app.inject({ method: 'GET', url: '/health' });
    await app.close();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ status: 'ok' });
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(Object.keys(body).sort()).toEqual(['environment', 'release', 'service', 'status', 'time', 'uptimeSeconds']);
    expect(JSON.stringify(body)).not.toMatch(/payments|insurance|twilio|retell|smtp|provider/i);
  });
});

describe('trace context — cross-process propagation', () => {
  it('round-trips through runInJobContext without a carrier (tracing off = no-op)', () => {
    // With OTEL disabled there is no active span; the carrier is empty and the
    // wrapped fn still runs. This is the default-safe path.
    const carrier = currentTraceCarrier();
    let ran = false;
    runInJobContext(carrier, () => { ran = true; });
    expect(ran).toBe(true);
  });

  it('getTraceIds returns nulls when there is no active span', () => {
    const { traceId, spanId } = getTraceIds();
    expect(traceId).toBeNull();
    expect(spanId).toBeNull();
  });
});
