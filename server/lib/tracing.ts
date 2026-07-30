// ===========================================================================
// OpenTelemetry tracing bootstrap.
//
// This MUST be imported before Fastify, pg, ioredis/bullmq, or any other
// instrumented library so the selected instrumentations can patch them. Import it at
// the very top of the process entrypoint (server/index.ts, server/workers/index.ts)
// BEFORE anything else, e.g.:
//
//     import { shutdownTracing } from './lib/tracing';   // side-effecting: starts the SDK
//     import { buildApp } from './app';
//
// Behaviour is fully gated by OTEL_ENABLED. When off (the default) the SDK is
// never started and there is zero runtime overhead — the module just exports
// helpers that no-op. When on, it exports OTLP/HTTP spans for Fastify, HTTP,
// pg, and ioredis, and propagates W3C `traceparent` context across process
// boundaries (see traceContext.ts for the BullMQ job carrier).
//
// The same trace_id is surfaced to logs via getTraceContext(), so logs, metrics
// (exemplars), and traces all correlate on one id — the whole point of the
// three pillars.
//
// The process owner (index.ts / workers/index.ts) calls shutdownTracing() at
// the END of its own graceful shutdown. Tracing never installs signal handlers
// and never calls process.exit — a premature exit here would kill in-flight
// requests and job drains.
// ===========================================================================

import { createRequire } from 'node:module';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { env } from '../config/env';
import { URL_SPAN_ATTRIBUTES, scrubUrlAttribute } from './spanRedaction';

// This package is ESM ("type": "module"), so there is no global `require`.
// createRequire gives us a real one, keeping the (large) OTel dependency tree
// lazily loaded — a disabled deploy pays nothing — without crashing module
// evaluation the moment OTEL_ENABLED=true.
const require = createRequire(import.meta.url);

interface TracingSdk {
  start(): void;
  shutdown(): Promise<void>;
}

let sdk: TracingSdk | null = null;

// Rewrites URL-bearing span attributes before export so path tokens
// (/public/:token routes), resource ids, and query strings never reach the
// tracing backend. Runs ahead of the batch processor in the pipeline — the
// exporter only ever sees scrubbed spans. See lib/spanRedaction.ts.
class RedactUrlSpanProcessor implements SpanProcessor {
  onStart(): void {}
  onEnd(span: ReadableSpan): void {
    const attributes = span.attributes as Record<string, unknown>;
    for (const key of URL_SPAN_ATTRIBUTES) {
      const value = attributes[key];
      if (typeof value === 'string') attributes[key] = scrubUrlAttribute(key, value);
    }
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export function startTracing(serviceName = env.OTEL_SERVICE_NAME): void {
  if (sdk) return;
  if (!env.OTEL_ENABLED) return;

  // Deferred requires — keep them out of the module's static import graph so a
  // disabled deploy pays nothing.
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
  const { FastifyInstrumentation } = require('@opentelemetry/instrumentation-fastify');
  const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg');
  const { IORedisInstrumentation } = require('@opentelemetry/instrumentation-ioredis');
  const { resourceFromAttributes } = require('@opentelemetry/resources');
  const {
    ATTR_SERVICE_NAME,
    ATTR_SERVICE_VERSION,
  } = require('@opentelemetry/semantic-conventions');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const {
    BatchSpanProcessor,
    TraceIdRatioBasedSampler,
    ParentBasedSampler,
  } = require('@opentelemetry/sdk-trace-base');

  const headers = parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS);

  const exporter = new OTLPTraceExporter({
    url: env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/traces`
      : undefined, // falls back to localhost:4318 collector
    headers,
  });

  const nodeSdk: TracingSdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: env.RELEASE ?? '0.0.0',
      'deployment.environment': env.SERVICE_ENV ?? env.NODE_ENV,
    }),
    // Redaction first, then batching/export — order matters.
    spanProcessors: [new RedactUrlSpanProcessor(), new BatchSpanProcessor(exporter)],
    // Parent-based so a sampled inbound request keeps its children sampled; the
    // root decision is ratio-based to cap volume in production.
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(env.OTEL_TRACES_SAMPLER_RATIO),
    }),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req: { url?: string }) =>
          req.url === '/health/live' || req.url === '/metrics',
      }),
      new FastifyInstrumentation(),
      new PgInstrumentation(),
      new IORedisInstrumentation(),
    ],
  });

  sdk = nodeSdk;
  nodeSdk.start();

  console.info(
    JSON.stringify({
      event: 'otel.started',
      service: serviceName,
      endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'default-collector',
      sampleRatio: env.OTEL_TRACES_SAMPLER_RATIO,
    }),
  );
}

/**
 * Flush pending spans and stop the SDK. No-op when tracing never started.
 * Call at the END of the owning process's graceful shutdown so spans emitted
 * while draining still export. Never throws.
 */
export async function shutdownTracing(): Promise<void> {
  const active = sdk;
  sdk = null;
  if (!active) return;
  await active.shutdown().catch(() => {});
}

function parseOtlpHeaders(raw?: string): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

// Start on import (side-effecting) so a bare `import './lib/tracing'` is enough.
startTracing();
