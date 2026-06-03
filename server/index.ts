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

await app.listen({ host: env.API_HOST, port: env.API_PORT });
