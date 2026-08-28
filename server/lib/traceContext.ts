// ===========================================================================
// Cross-process trace propagation for BullMQ jobs.
//
// OpenTelemetry propagates context automatically within a process, but a job
// enqueued by the API and executed later by the worker crosses a process (and
// time) boundary Redis knows nothing about. We carry the W3C trace context
// (`traceparent` / `tracestate`) inside the job payload:
//
//   API:    enqueue(..., { ...data, _otel: currentTraceCarrier() })
//   Worker: runInJobContext(job.data._otel, () => handle(job))
//
// The result: the span the worker creates is a child of the request span that
// enqueued it, so one trace_id spans HTTP request → job → worker. Everything
// degrades to a plain function call when OTEL_ENABLED is off.
//
// getTraceIds() exposes the active trace/span id for log correlation regardless
// of whether propagation came from HTTP headers or a job carrier.
// ===========================================================================

import { context, propagation, trace } from '@opentelemetry/api';

export type TraceCarrier = Record<string, string>;

/** Snapshot the current trace context into a plain object safe to JSON-serialize. */
export function currentTraceCarrier(): TraceCarrier | undefined {
  const carrier: TraceCarrier = {};
  propagation.inject(context.active(), carrier);
  return Object.keys(carrier).length ? carrier : undefined;
}

/**
 * Run `fn` inside the trace context extracted from a job carrier. When the
 * carrier is missing (job enqueued before this shipped, or tracing off), `fn`
 * runs in the current context — no error, no orphaned span.
 */
export function runInJobContext<T>(carrier: TraceCarrier | undefined, fn: () => T): T {
  if (!carrier) return fn();
  const active = propagation.extract(context.active(), carrier);
  return context.with(active, fn);
}

/**
 * The active trace and span ids, or nulls when there is no valid span (tracing
 * disabled, or outside a span). Used to stamp logs so they join the trace.
 */
export function getTraceIds(): { traceId: string | null; spanId: string | null } {
  const span = trace.getActiveSpan();
  const ctx = span?.spanContext();
  if (!ctx || ctx.traceId === '00000000000000000000000000000000') {
    return { traceId: null, spanId: null };
  }
  return { traceId: ctx.traceId, spanId: ctx.spanId };
}
