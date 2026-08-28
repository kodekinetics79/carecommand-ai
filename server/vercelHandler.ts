// Bundle entry for the Vercel Serverless Function. esbuild bundles this (and the
// whole server tree) into api/_bundle.mjs at build time, so there are no
// extensionless relative imports left for Node's ESM loader to choke on.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from './app';
import { assertRlsRuntimeRole } from './lib/rlsGuard';

type App = Awaited<ReturnType<typeof buildApp>>;
let appPromise: Promise<App> | null = null;

async function getApp(): Promise<App> {
  if (!appPromise) {
    appPromise = buildApp().then(async app => {
      await app.ready();
      // Boot-time RLS runtime-role guard (see server/lib/rlsGuard.ts). On a
      // cold start this loudly surfaces — or, when enforced, rejects — a DB role
      // that can bypass tenant RLS.
      await assertRlsRuntimeRole({ logger: app.log });
      return app;
    });
  }
  return appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const app = await getApp();
  app.server.emit('request', req, res);
}
