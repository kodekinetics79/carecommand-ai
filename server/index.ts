// Tracing must initialise BEFORE any instrumented library (Fastify, pg, ioredis)
// is imported, so this side-effecting import stays at the very top.
import { shutdownTracing } from './lib/tracing';
import { buildApp } from './app';
import { env } from './config/env';
import { db } from './lib/db';
import { assertRlsRuntimeRole } from './lib/rlsGuard';
import { registerSentry } from './lib/observability';
import { autopilotQueue } from './workers/queues';

const app = await buildApp();

// Activate durable error capture (no-op unless SENTRY_DSN + @sentry/node present).
await registerSentry(app.log);

// Fail closed in production, and optionally in non-production via
// RLS_ENFORCE_RUNTIME_ROLE. Surfaces the prod cutover requirement at boot.
await assertRlsRuntimeRole({ logger: app.log });

async function shutdown() {
  await app.close();
  await db.$disconnect();
  await autopilotQueue.close();
  // Last, so spans emitted while draining still flush to the exporter. Tracing
  // itself never installs signal handlers or exits the process.
  await shutdownTracing();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Honor the platform-injected PORT (Railway/Render/Fly) and fall back to API_PORT.
const port = Number(process.env.PORT) || env.API_PORT;
await app.listen({ host: env.API_HOST, port });
