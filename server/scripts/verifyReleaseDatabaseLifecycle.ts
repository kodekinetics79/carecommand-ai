import 'dotenv/config';

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';

import { TENANT_INTEGRITY_MANIFEST } from '../modules/platform/prismaDriftGuard';

const ACK = 'CREATE_DROP_LOCAL_RELEASE_TEST_DATABASES';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const DATABASE_PREFIX = 'carecommand_test_rc_';

function checkedAdminUrl(): URL {
  if (process.env.NODE_ENV !== 'test') throw new Error('Release database lifecycle requires NODE_ENV=test.');
  if (process.env.RELEASE_DB_LIFECYCLE_ACK !== ACK) {
    throw new Error(`Set RELEASE_DB_LIFECYCLE_ACK=${ACK} to use disposable local databases.`);
  }
  if (!process.env.DATABASE_MIGRATION_URL) throw new Error('DATABASE_MIGRATION_URL is required.');
  const url = new URL(process.env.DATABASE_MIGRATION_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error('Release database lifecycle accepts only local PostgreSQL URLs.');
  }
  if (!url.pathname || url.pathname === '/') throw new Error('Administrative URL must name a database.');
  url.searchParams.delete('schema');
  url.searchParams.delete('options');
  return url;
}

function databaseUrl(adminUrl: URL, databaseName: string): string {
  if (!new RegExp(`^${DATABASE_PREFIX}[a-z0-9_]+$`).test(databaseName) || databaseName.length > 63) {
    throw new Error(`Unsafe disposable database name: ${databaseName}`);
  }
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  url.searchParams.set('schema', 'public');
  return url.toString();
}

function checkedRuntimeUrl(databaseName: string): string {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const url = new URL(process.env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error('Release database lifecycle accepts only local PostgreSQL runtime URLs.');
  }
  return databaseUrl(url, databaseName);
}

function libpqUrl(connectionString: string): string {
  const url = new URL(connectionString);
  url.searchParams.delete('schema');
  url.searchParams.delete('options');
  return url.toString();
}

function run(command: string, args: string[], env = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`}).`));
    });
  });
}

type Snapshot = Record<string, number>;

async function snapshot(connectionString: string): Promise<Snapshot> {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const result = await pool.query<Record<string, string>>(`
      SELECT
        (SELECT count(*) FROM "Tenant")::text AS tenants,
        (SELECT count(*) FROM "Branch")::text AS clinics,
        (SELECT count(*) FROM "User")::text AS users,
        (SELECT count(*) FROM "Patient")::text AS patients,
        (SELECT count(*) FROM "Appointment")::text AS appointments,
        (SELECT count(*) FROM "ReceptionistCallLog")::text AS calls,
        (SELECT count(*) FROM "PaymentRequest")::text AS payments,
        (SELECT count(*) FROM "PatientIntakeDocument")::text AS documents,
        (SELECT count(*) FROM "NotificationEvent")::text AS notifications,
        (SELECT count(*) FROM "AuditEvent")::text AS audits,
        (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL)::text AS migrations,
        (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity)::text AS forced_rls_tables,
        (SELECT count(*) FROM pg_constraint WHERE contype='f' AND conname LIKE 'rls_fk_%' AND convalidated)::text AS tenant_integrity_fks
    `);
    return Object.fromEntries(Object.entries(result.rows[0] ?? {}).map(([key, value]) => [key, Number(value)]));
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const adminUrl = checkedAdminUrl();
  const suffix = `${Date.now()}_${process.pid}_${randomBytes(3).toString('hex')}`;
  const sourceName = `${DATABASE_PREFIX}source_${suffix}`;
  const restoreName = `${DATABASE_PREFIX}restore_${suffix}`;
  const sourceUrl = databaseUrl(adminUrl, sourceName);
  const restoreUrl = databaseUrl(adminUrl, restoreName);
  const restoreRuntimeUrl = checkedRuntimeUrl(restoreName);
  const directory = await mkdtemp(join(tmpdir(), 'carecommand-release-lifecycle-'));
  const dumpPath = join(directory, 'synthetic-functional.dump');
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });

  try {
    await admin.query(`CREATE DATABASE "${sourceName}"`);
    await run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['prisma', 'migrate', 'deploy'], {
      ...process.env,
      DATABASE_URL: sourceUrl,
      DATABASE_MIGRATION_URL: sourceUrl,
    });
    await run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'prisma/seedSynthetic.ts'], {
      ...process.env,
      NODE_ENV: 'test',
      SYNTHETIC_PROFILE: 'FUNCTIONAL',
      SYNTHETIC_DATABASE_URL: sourceUrl,
      DATABASE_MIGRATION_URL: sourceUrl,
      CONFIRM_SYNTHETIC_DATABASE: sourceName,
    });

    const before = await snapshot(sourceUrl);
    await run('pg_dump', ['--format=custom', '--no-owner', '--file', dumpPath, libpqUrl(sourceUrl)]);
    await admin.query(`CREATE DATABASE "${restoreName}"`);
    await run('pg_restore', ['--exit-on-error', '--no-owner', '--dbname', libpqUrl(restoreUrl), dumpPath]);
    const after = await snapshot(restoreUrl);

    await run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'server/scripts/verifyRlsCatalog.ts'], {
      ...process.env,
      DATABASE_URL: restoreRuntimeUrl,
      DATABASE_MIGRATION_URL: restoreUrl,
    });

    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error(`Backup/restore snapshot mismatch: ${JSON.stringify({ before, after })}`);
    }
    if (
      before.forced_rls_tables <= 0
      || before.tenant_integrity_fks !== TENANT_INTEGRITY_MANIFEST.compositeForeignKeys
    ) {
      throw new Error(`Restored security manifest mismatch: ${JSON.stringify(before)}`);
    }
    console.log(`Release database lifecycle PASS: ${JSON.stringify(after)}`);
  } finally {
    for (const databaseName of [restoreName, sourceName]) {
      if (!databaseName.startsWith(DATABASE_PREFIX)) continue;
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    }
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
