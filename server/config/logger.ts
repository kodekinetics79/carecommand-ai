import { env } from './env';
import { getTraceIds } from '../lib/traceContext';

// Shared Fastify/pino logger options. Centralised so the redaction policy is
// applied identically by the HTTP app and any other logger we construct, and so
// it can be unit-tested. Fastify's default request serializer does not log
// headers, but we redact defensively in case a serializer/route ever logs
// `req.headers`, cookies, or webhook signatures — keeping secrets/PHI-adjacent
// material out of logs (a HIPAA non-negotiable).

export const REDACTED = '[redacted]';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-cc-signature"]',
  'req.headers["stripe-signature"]',
  'req.headers["x-retell-signature"]',
  'req.headers["x-platform-token"]',
  'res.headers["set-cookie"]',
  // belt-and-braces for any object we log with these shapes
  'authorization',
  'password',
  'token',
  'refreshToken',
];

export const loggerOptions = {
  level: env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: REDACTED },
  // Correlate the three pillars: stamp the active trace/span id onto every log
  // line so a log entry links straight to its distributed trace (and vice
  // versa). No-op when tracing is disabled — getTraceIds() returns nulls, which
  // pino omits. Named `trace_id`/`span_id` to match OTel log-correlation
  // conventions most backends key on.
  mixin() {
    const { traceId, spanId } = getTraceIds();
    return traceId ? { trace_id: traceId, span_id: spanId } : {};
  },
};
