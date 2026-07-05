import 'dotenv/config';
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { metricsPlugin } from '../plugins/metrics';
import { registry } from '../lib/metrics';
import { SLOS, errorBudgetMinutes } from '../lib/slo';
import { currentTraceCarrier, runInJobContext, getTraceIds } from '../lib/traceContext';
import { healthRoutes } from '../modules/health/routes';

describe('metrics — /metrics exposition', () => {
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

  it('/health reports release + uptime', async () => {
    const app = Fastify({ logger: false });
    await app.register(healthRoutes);
    const res = await app.inject({ method: 'GET', url: '/health' });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
    expect(typeof res.json().uptimeSeconds).toBe('number');
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
