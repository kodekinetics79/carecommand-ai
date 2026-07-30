import { Pool } from 'pg';

const TEST_PASSWORD = 'carecommand-platform-test-only-2026';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** Provision a disposable/local app_platform login for automated tests only. */
export async function ensurePlatformTestDatabaseUrl(): Promise<string> {
  if (process.env.PLATFORM_DATABASE_URL) {
    const configured = new URL(process.env.PLATFORM_DATABASE_URL);
    if (configured.username !== 'app_platform') throw new Error('Test PLATFORM_DATABASE_URL must use app_platform.');
    return configured.toString();
  }
  if (!process.env.DATABASE_MIGRATION_URL) throw new Error('DATABASE_MIGRATION_URL is required for platform tests.');
  const ownerUrl = new URL(process.env.DATABASE_MIGRATION_URL);
  if (!LOCAL_HOSTS.has(ownerUrl.hostname)) {
    throw new Error('Refusing to provision app_platform credentials on a non-local database.');
  }
  const owner = new Pool({ connectionString: ownerUrl.toString(), max: 1 });
  try {
    await owner.query(`SELECT pg_advisory_lock(7645300133000)`);
    await owner.query(`ALTER ROLE app_platform PASSWORD '${TEST_PASSWORD}'`);
  } finally {
    await owner.query(`SELECT pg_advisory_unlock(7645300133000)`).catch(() => undefined);
    await owner.end();
  }
  const platformUrl = new URL(ownerUrl);
  platformUrl.username = 'app_platform';
  platformUrl.password = TEST_PASSWORD;
  platformUrl.searchParams.set('schema', 'public');
  return platformUrl.toString();
}
