import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { ensurePlatformTestDatabaseUrl } from './helpers/platformTestDatabase';
import { ensureTestSubscriptionCatalog } from './helpers/subscriptionCatalog';

// Queue modules parse env at import time. Give every Vitest file sandbox a
// disposable namespace so retained BullMQ jobs cannot cross test datasets.
process.env.QUEUE_NAMESPACE ??= `test-${process.pid}-${Date.now()}-${process.env.VITEST_POOL_ID ?? '0'}`;

process.env.PLATFORM_DATABASE_URL = await ensurePlatformTestDatabaseUrl();

const migrationUrl = process.env.DATABASE_MIGRATION_URL;
if (!migrationUrl) throw new Error('DATABASE_MIGRATION_URL is required for test catalog fixtures.');

const catalogDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: migrationUrl }) });
try {
  await ensureTestSubscriptionCatalog(catalogDb);
} finally {
  await catalogDb.$disconnect();
}
