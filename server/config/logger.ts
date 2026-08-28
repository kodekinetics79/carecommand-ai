import { env } from './env';

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
};
