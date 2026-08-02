import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { ensurePlatformTestDatabaseUrl } from './helpers/platformTestDatabase';
import { ensureTestSubscriptionCatalog } from './helpers/subscriptionCatalog';

process.env.PLATFORM_DATABASE_URL = await ensurePlatformTestDatabaseUrl();

const migrationUrl = process.env.DATABASE_MIGRATION_URL;
if (!migrationUrl) throw new Error('DATABASE_MIGRATION_URL is required for test catalog fixtures.');

const catalogDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: migrationUrl }) });
try {
  await ensureTestSubscriptionCatalog(catalogDb);
} finally {
  await catalogDb.$disconnect();
}
