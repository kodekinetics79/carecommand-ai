import { env } from './env';
import { getTraceIds } from '../lib/traceContext';
import { scrubUrlAttribute } from '../lib/spanRedaction';

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

/**
 * Fastify's default request serializer logs `req.url` verbatim, which put PHI
 * and live credentials into application logs at `info`:
 *   GET /v1/patients?search=Jane%20Doe          -> a patient name
 *   GET /v1/intake/public/<token>               -> a single-use patient token
 *   GET /v1/payments/public/checkout/<token>    -> a payment credential
 *   GET /v1/pilot/share/<token>                 -> a share credential
 * Traces already solve this with scrubUrlAttribute (query string dropped
 * wholesale, 16+ char path segments replaced). Logs now use the same function,
 * so the two pillars redact identically instead of one leaking what the other
 * protects.
 */
export function serializeLoggedRequest(request: {
  method?: string;
  url?: string;
  ip?: string;
  headers?: Record<string, unknown>;
  routeOptions?: { url?: string };
}) {
  const url = request.url ?? '';
  return {
    method: request.method,
    // Prefer the route template ("/v1/patients/:patientId"), which can never
    // carry a value; fall back to the scrubbed URL for unrouted requests (404s,
    // malformed paths) so those stay legible without leaking.
    url: request.routeOptions?.url ?? scrubUrlAttribute('url.path', url),
    remoteAddress: request.ip,
  };
}

export const loggerOptions = {
  level: env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: REDACTED },
  serializers: { req: serializeLoggedRequest },
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
