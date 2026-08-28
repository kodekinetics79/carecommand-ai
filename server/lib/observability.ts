import { env } from '../config/env';

// ===========================================================================
// Observability: error capture.
//
// Vendor-neutral seam for shipping unhandled errors to an APM/error tracker.
// The HTTP error handler calls captureException() for 5xx responses with
// id-only context (requestId, route, method, tenantId, userId, statusCode) —
// never request bodies, headers, or PHI. A reporter (e.g. Sentry) is registered
// at boot via setErrorReporter(); until then, errors are still recorded as
// structured `event: 'exception'` logs, which an upstream log drain can alert on.
//
// Wiring Sentry (when ready): `npm i @sentry/node`, then in server/index.ts:
//   import * as Sentry from '@sentry/node';
//   if (env.SENTRY_DSN) {
//     Sentry.init({ dsn: env.SENTRY_DSN, environment: env.SERVICE_ENV ?? env.NODE_ENV,
//       release: env.RELEASE, tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE });
//     setErrorReporter((err, ctx) => Sentry.captureException(err, { extra: { ...ctx } }));
//   }
// ===========================================================================

export interface ErrorContext {
  requestId?: string;
  route?: string;
  method?: string;
  tenantId?: string;
  userId?: string;
  statusCode?: number;
}

export type ErrorReporter = (error: Error, context: ErrorContext) => void;

interface MinimalLogger {
  error: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
}

let reporter: ErrorReporter | null = null;
let warnedMissingReporter = false;

/** Register (or clear) the external error reporter. Returns the previous one. */
export function setErrorReporter(fn: ErrorReporter | null): ErrorReporter | null {
  const previous = reporter;
  reporter = fn;
  if (fn) warnedMissingReporter = false;
  return previous;
}

export function hasErrorReporter(): boolean {
  return reporter !== null;
}

/**
 * Record an unhandled exception. Always emits a structured log; forwards to the
 * registered reporter when present. Never throws — telemetry must not break a
 * request path.
 */
export function captureException(error: Error, context: ErrorContext = {}, logger?: MinimalLogger): void {
  const log = logger ?? console;
  log.error(
    {
      event: 'exception',
      err: { type: error.name, message: error.message, stack: error.stack },
      ...context,
      release: env.RELEASE,
      serviceEnv: env.SERVICE_ENV ?? env.NODE_ENV,
    },
    'unhandled exception',
  );

  if (reporter) {
    try {
      reporter(error, context);
    } catch {
      // swallow: a failing reporter must never propagate into the request path
    }
    return;
  }

  // DSN configured but nothing wired it up — surface the misconfiguration once.
  if (env.SENTRY_DSN && !warnedMissingReporter) {
    warnedMissingReporter = true;
    log.warn({ event: 'observability.reporter_missing' }, 'SENTRY_DSN is set but no error reporter is registered (call registerSentry at boot)');
  }
}

/**
 * Activate the durable error reporter at boot. No-op unless SENTRY_DSN is set.
 *
 * @sentry/node is loaded via dynamic import so it is NOT a hard dependency: a
 * deploy without the package (or without a DSN) still boots and keeps emitting
 * structured `event: 'exception'` logs — this only *adds* durable capture when
 * both are present. Call once from server/index.ts and server/workers/index.ts.
 *
 * Returns true if Sentry was activated. Never throws — telemetry setup must not
 * block startup.
 */
export async function registerSentry(logger?: MinimalLogger): Promise<boolean> {
  const log = logger ?? console;
  if (!env.SENTRY_DSN) return false;

  try {
    // Optional dependency: `npm i @sentry/node` to enable. Kept as a dynamic,
    // string-built specifier so bundlers/type-checkers don't require it present.
    const moduleName = '@sentry/node';
    const Sentry = (await import(/* @vite-ignore */ moduleName)) as {
      init: (opts: Record<string, unknown>) => void;
      captureException: (err: unknown, hint?: { extra?: Record<string, unknown> }) => void;
    };

    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.SERVICE_ENV ?? env.NODE_ENV,
      release: env.RELEASE,
      tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    });

    setErrorReporter((error, context) => {
      Sentry.captureException(error, { extra: { ...context } });
    });

    log.warn({ event: 'observability.sentry_active', serviceEnv: env.SERVICE_ENV ?? env.NODE_ENV }, 'Sentry error reporter active');
    return true;
  } catch (error) {
    // Package missing or init failed — degrade to structured logs, don't crash.
    log.warn(
      { event: 'observability.sentry_unavailable', err: (error as Error).message },
      'SENTRY_DSN is set but @sentry/node could not be loaded; run `npm i @sentry/node`. Falling back to structured error logs.',
    );
    return false;
  }
}
