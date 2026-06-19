// Vercel Serverless Function that serves the Fastify API.
// Rewrites in vercel.json send /v1/* and /health/* here; the SPA serves the rest.
// The app is built once per warm instance and reused across requests.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '../server/app';

type App = Awaited<ReturnType<typeof buildApp>>;
let appPromise: Promise<App> | null = null;

async function getApp(): Promise<App> {
  if (!appPromise) {
    appPromise = buildApp().then(async app => {
      await app.ready();
      return app;
    });
  }
  return appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const app = await getApp();
  app.server.emit('request', req, res);
}
