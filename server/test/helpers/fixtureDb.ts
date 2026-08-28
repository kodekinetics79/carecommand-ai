import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';

const migrationUrl = process.env.DATABASE_MIGRATION_URL;

if (!migrationUrl) {
  throw new Error('DATABASE_MIGRATION_URL is required for owner-only test fixtures');
}

/**
 * Schema-owner client used only for synthetic fixture setup, cleanup and
 * out-of-band assertions. Application requests continue to use app_rls, so
 * this client can never be isolation evidence by itself.
 */
export const fixtureDb = new PrismaClient({
  adapter: new PrismaPg({ connectionString: migrationUrl }),
});
