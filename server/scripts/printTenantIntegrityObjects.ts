import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Print the exact set of tenant-integrity objects the migrations produce.
 *
 * Run this against a database built FROM EMPTY - the disposable-DB wrapper does
 * exactly that - because a long-lived local database can carry a shape no fresh
 * build produces, and a pin generated from one is worse than no pin at all.
 *
 *   RLS_DISPOSABLE_DB_ACK=CREATE_AND_DROP_LOCAL_RLS_TEST_DATABASE \
 *     npx tsx server/scripts/withDisposableRlsDatabase.ts -- \
 *     npx tsx server/scripts/printTenantIntegrityObjects.ts
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
try {
  const rows = await db.$queryRaw<Array<{ name: string }>>`
    SELECT conname AS name
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND c.conname LIKE 'rls_fk_%'
    UNION ALL
    SELECT indexname AS name FROM pg_indexes
    WHERE schemaname = 'public' AND (indexname LIKE 'rls_ix_%' OR indexname LIKE 'rls_uq_%')
    ORDER BY name
  `;
  const names = rows.map(r => r.name).sort();
  process.stdout.write(`${JSON.stringify(names, null, 2)}\n`);
  process.stderr.write(`${names.length} tenant-integrity objects\n`);
} finally {
  await db.$disconnect();
}
