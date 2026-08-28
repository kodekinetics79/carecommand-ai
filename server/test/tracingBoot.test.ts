import { describe, it, expect } from 'vitest';

// Regression guard for the two failure modes that shipped dark because every
// other test runs with telemetry OFF:
//   1. tracing.ts used bare `require()` in an ESM process — OTEL_ENABLED=true
//      crashed the API/worker at boot (ReferenceError during module evaluation).
//   2. nothing ever asserted the enabled path produces usable spans.
// This file boots the REAL tracing module with OTEL_ENABLED=true (exporter
// pointed at a black hole — export failure never affects span creation) and
// asserts spans exist and correlate through getTraceIds().
describe('tracing — enabled boot path', () => {
  it('starts the SDK under ESM and yields spans that correlate to logs', { timeout: 20_000 }, async () => {
    process.env.OTEL_ENABLED = 'true';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:1';

    // Dynamic imports so the env overrides above land before config/env parses.
    const { startTracing, shutdownTracing } = await import('../lib/tracing'); // self-starts on import
    startTracing(); // idempotent second call must not throw

    const { context, trace } = await import('@opentelemetry/api');
    const { getTraceIds } = await import('../lib/traceContext');

    const span = trace.getTracer('boot-smoke').startSpan('smoke');
    expect(span.spanContext().traceId).not.toBe('00000000000000000000000000000000');

    // The pino mixin correlation path: inside the span's context, getTraceIds
    // must surface the same trace id that the SDK minted.
    let ids: { traceId: string | null; spanId: string | null } = { traceId: null, spanId: null };
    context.with(trace.setSpan(context.active(), span), () => {
      ids = getTraceIds();
    });
    expect(ids.traceId).toBe(span.spanContext().traceId);

    span.end();
    await shutdownTracing(); // flush-only; must never throw or exit the process
  });
});
