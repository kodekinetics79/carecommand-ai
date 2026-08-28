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
      // Boot-time RLS runtime-role guard. Production always fails closed; dev
      // can opt in via RLS_ENFORCE_RUNTIME_ROLE.
      await assertRlsRuntimeRole({ logger: app.log });
      return app;
    }).catch((error: unknown) => {
      // A rejected boot must not stay memoised. Without this, one transient
      // failure (a database or Redis hiccup during cold start) is cached for
      // the life of the instance, and every subsequent request on that lambda
      // re-awaits the same rejection and returns 500 — permanently, until the
      // instance is recycled. Clearing the memo lets the next request retry.
      appPromise = null;
      throw error;
    });
  }
  return appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const app = await getApp();
  app.server.emit('request', req, res);
}
