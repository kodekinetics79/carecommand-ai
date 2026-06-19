import { buildApp } from './app';
import { env } from './config/env';
import { db } from './lib/db';
import { autopilotQueue } from './workers/queues';

const app = await buildApp();

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
