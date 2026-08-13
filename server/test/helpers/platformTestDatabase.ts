import { Pool } from 'pg';

const TEST_PASSWORD = 'carecommand-platform-test-only-2026';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function normalizedPort(url: URL): string {
  return url.port || '5432';
}

/** Provision a disposable/local app_platform login for automated tests only. */
export async function ensurePlatformTestDatabaseUrl(): Promise<string> {
  // A disposable lifecycle must keep both database planes on its generated
  // database. An inherited local URL would make platform requests read a
  // different catalog from the owner-only fixtures. Its credentials, however,
  // must remain stable because PostgreSQL roles are cluster-wide: changing the
  // password for one disposable database otherwise breaks later suites that
  // still use the configured local PLATFORM_DATABASE_URL.
  const disposableDatabase = process.env.RLS_DISPOSABLE_DB;
  const configuredPlatformUrl = process.env.PLATFORM_DATABASE_URL
    ? new URL(process.env.PLATFORM_DATABASE_URL)
    : undefined;
  if (configuredPlatformUrl?.username !== undefined && configuredPlatformUrl.username !== 'app_platform') {
    throw new Error('Test PLATFORM_DATABASE_URL must use app_platform.');
  }
  if (!disposableDatabase && configuredPlatformUrl) return configuredPlatformUrl.toString();

  if (!process.env.DATABASE_MIGRATION_URL) throw new Error('DATABASE_MIGRATION_URL is required for platform tests.');
  const ownerUrl = new URL(process.env.DATABASE_MIGRATION_URL);
  if (!LOCAL_HOSTS.has(ownerUrl.hostname)) {
    throw new Error('Refusing to provision app_platform credentials on a non-local database.');
  }
  if (disposableDatabase && decodeURIComponent(ownerUrl.pathname.slice(1)) !== disposableDatabase) {
    throw new Error('Disposable platform test database must match RLS_DISPOSABLE_DB.');
  }

  let platformPassword = TEST_PASSWORD;
  if (configuredPlatformUrl) {
    if (
      !LOCAL_HOSTS.has(configuredPlatformUrl.hostname)
      || configuredPlatformUrl.hostname !== ownerUrl.hostname
      || normalizedPort(configuredPlatformUrl) !== normalizedPort(ownerUrl)
    ) {
      throw new Error('Disposable PLATFORM_DATABASE_URL must use the same local PostgreSQL server as DATABASE_MIGRATION_URL.');
    }
    if (!configuredPlatformUrl.password) throw new Error('Test PLATFORM_DATABASE_URL must include an app_platform password.');
    platformPassword = decodeURIComponent(configuredPlatformUrl.password);
  }

  const owner = new Pool({ connectionString: ownerUrl.toString(), max: 1 });
  try {
    await owner.query(`SELECT pg_advisory_lock(7645300133000)`);
    await owner.query(`ALTER ROLE app_platform PASSWORD ${sqlLiteral(platformPassword)}`);
  } finally {
    await owner.query(`SELECT pg_advisory_unlock(7645300133000)`).catch(() => undefined);
    await owner.end();
  }
  const platformUrl = new URL(ownerUrl);
  platformUrl.username = 'app_platform';
  platformUrl.password = platformPassword;
  platformUrl.searchParams.set('schema', 'public');
  return platformUrl.toString();
}
