import type { FastifyPluginAsync } from 'fastify';
import { db } from '../../lib/db';
import { buildReceptionistCatalog } from '../../lib/receptionist/catalog';
import { receptionistRead } from './shared';

// Server-served option catalog. The client renders what this returns rather
// than compiling timezone/country/language lists into the bundle, so adding a
// country is a server change. C5 contributes the `voices` and `providerMode`
// sections from server/lib/retell.ts.
export const catalogRoutes: FastifyPluginAsync = async app => {
  app.get('/catalog', { preHandler: receptionistRead }, async request => {
    return buildReceptionistCatalog(db, request.auth.tenantId);
  });
};
