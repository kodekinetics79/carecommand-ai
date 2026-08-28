import { buildApp } from './app';
import { env } from './config/env';
import { db } from './lib/db';
import { assertRlsRuntimeRole } from './lib/rlsGuard';
import { autopilotQueue } from './workers/queues';

const app = await buildApp();

// Fail closed (when RLS_ENFORCE_RUNTIME_ROLE=true) or loudly warn if the runtime
// DB role can bypass tenant RLS. Surfaces the prod cutover requirement at boot.
await assertRlsRuntimeRole({ logger: app.log });

async function shutdown() {
  await app.close();
  await db.$disconnect();
  await autopilotQueue.close();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Honor the platform-injected PORT (Railway/Render/Fly) and fall back to API_PORT.
const port = Number(process.env.PORT) || env.API_PORT;
await app.listen({ host: env.API_HOST, port });
