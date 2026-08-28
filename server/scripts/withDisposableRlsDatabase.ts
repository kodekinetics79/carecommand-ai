import 'dotenv/config';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

export const DISPOSABLE_ACK = 'CREATE_AND_DROP_LOCAL_RLS_TEST_DATABASE';
export const DISPOSABLE_PREFIX = 'carecommand_rls_behavior_';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function normalizedHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

export type DisposableDatabasePlan = {
  adminUrl: string;
  ownerUrl: string;
  runtimeUrl: string;
  databaseName: string;
};

export function buildDisposableDatabasePlan(input: {
  migrationUrl?: string;
  acknowledgement?: string;
  nodeEnv?: string;
  suffix?: string;
}): DisposableDatabasePlan {
  if (input.nodeEnv === 'production') throw new Error('Refusing disposable database lifecycle in NODE_ENV=production');
  if (input.acknowledgement !== DISPOSABLE_ACK) {
    throw new Error(`Refusing database lifecycle without RLS_DISPOSABLE_DB_ACK=${DISPOSABLE_ACK}`);
  }
  if (!input.migrationUrl) throw new Error('DATABASE_MIGRATION_URL is required');

  const migration = new URL(input.migrationUrl);
  if (!['postgres:', 'postgresql:'].includes(migration.protocol)) throw new Error('Only PostgreSQL URLs are accepted');
  if (!LOCAL_HOSTS.has(normalizedHostname(migration.hostname))) throw new Error(`Refusing non-local PostgreSQL host "${migration.hostname}"`);
  if (!migration.pathname || migration.pathname === '/') throw new Error('Migration URL must name an administrative database');

  const suffix = input.suffix ?? `${Date.now()}_${process.pid}_${randomBytes(4).toString('hex')}`;
  if (!/^[a-z0-9_]+$/.test(suffix)) throw new Error('Disposable database suffix contains unsafe characters');
  const databaseName = `${DISPOSABLE_PREFIX}${suffix}`;
  if (databaseName.length > 63) throw new Error('Disposable database name exceeds PostgreSQL identifier length');

  const admin = new URL(migration);
  admin.searchParams.delete('schema');
  admin.searchParams.delete('options');
  const owner = new URL(migration);
  owner.pathname = `/${databaseName}`;
  owner.searchParams.set('schema', 'public');
  owner.searchParams.delete('options');
  const runtime = new URL(owner);
  runtime.searchParams.set('options', '-c role=app_rls');

  return {
    adminUrl: admin.toString(),
    ownerUrl: owner.toString(),
    runtimeUrl: runtime.toString(),
    databaseName,
  };
}

export function assertGeneratedDisposableName(databaseName: string): void {
  if (!/^carecommand_rls_behavior_[a-z0-9_]+$/.test(databaseName) || databaseName.length > 63) {
    throw new Error(`Refusing destructive operation for non-disposable database "${databaseName}"`);
  }
}

export function assertLocalServerAddress(serverAddress: string | null): void {
  const address = serverAddress?.split('/')[0] ?? '';
  const octets = address.split('.').map(Number);
  const privateIpv4 = octets.length === 4 && octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255) && (
    octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
    || (octets[0] === 192 && octets[1] === 168)
  );
  const localIpv6 = address === '::1' || address === '0:0:0:0:0:0:0:1' || address.toLowerCase().startsWith('fc') || address.toLowerCase().startsWith('fd');
  if (!privateIpv4 && !localIpv6) {
    throw new Error(`Refusing database lifecycle on non-local/private PostgreSQL server "${serverAddress ?? 'unknown'}"`);
  }
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed (${signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`})`));
    });
  });
}

export async function withDisposableRlsDatabase(command: string, args: string[]): Promise<void> {
  const plan = buildDisposableDatabasePlan({
    migrationUrl: process.env.DATABASE_MIGRATION_URL,
    acknowledgement: process.env.RLS_DISPOSABLE_DB_ACK,
    nodeEnv: process.env.NODE_ENV,
  });
  assertGeneratedDisposableName(plan.databaseName);
  const admin = new Pool({ connectionString: plan.adminUrl, max: 1 });
  let operationError: unknown;
  let created = false;
  try {
    const connected = await admin.query<{ database: string; server: string | null }>(
      `SELECT current_database() AS database, inet_server_addr()::text AS server`,
    );
    const expectedAdminDatabase = decodeURIComponent(new URL(plan.adminUrl).pathname.slice(1));
    if (connected.rows[0]?.database !== expectedAdminDatabase) {
      throw new Error(`Administrative connection database mismatch: expected "${expectedAdminDatabase}"`);
    }
    assertLocalServerAddress(connected.rows[0]?.server ?? null);
    await admin.query(`CREATE DATABASE "${plan.databaseName}"`);
    created = true;
    const ownerEnv = { ...process.env, DATABASE_URL: plan.ownerUrl, DATABASE_MIGRATION_URL: plan.ownerUrl };
    await run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['prisma', 'migrate', 'deploy'], ownerEnv);
    await run(command, args, {
      ...process.env,
      // This script loads .env at import (line 1), which carries
      // NODE_ENV=development, and the child inherits it. Vitest only defaults
      // NODE_ENV to "test" when nothing has set it, so every suite launched
      // through here ran believing it was a development process — and the
      // codebase's test-only guards are written to refuse in that case
      // (`autopilot execution test hook is test-only`). The disposable database
      // lifecycle is a test lifecycle by construction; say so explicitly, while
      // still letting a caller who set NODE_ENV on purpose keep their value.
      NODE_ENV: process.env.NODE_ENV === 'development' ? 'test' : (process.env.NODE_ENV ?? 'test'),
      DATABASE_URL: plan.runtimeUrl,
      DATABASE_MIGRATION_URL: plan.ownerUrl,
      SYNTHETIC_DATABASE_URL: plan.ownerUrl,
      CONFIRM_SYNTHETIC_DATABASE: plan.databaseName,
      RLS_DISPOSABLE_DB: plan.databaseName,
    });
  } catch (error) {
    operationError = error;
  }
  let cleanupError: unknown;
  try {
    if (created) {
      assertGeneratedDisposableName(plan.databaseName);
      await admin.query(`DROP DATABASE "${plan.databaseName}" WITH (FORCE)`);
    }
  } catch (error) {
    cleanupError = error;
  } finally {
    await admin.end();
  }
  if (operationError && cleanupError) {
    throw new AggregateError([operationError, cleanupError], `RLS behavioral operation and cleanup both failed for ${plan.databaseName}`);
  }
  if (operationError) throw operationError;
  if (cleanupError) throw new Error(`Failed to drop disposable database ${plan.databaseName}`, { cause: cleanupError });
}

async function main(): Promise<void> {
  const separator = process.argv.indexOf('--');
  const command = separator >= 0 ? process.argv[separator + 1] : undefined;
  const args = separator >= 0 ? process.argv.slice(separator + 2) : [];
  if (!command) throw new Error('Usage: tsx server/scripts/withDisposableRlsDatabase.ts -- <command> [...args]');
  await withDisposableRlsDatabase(command, args);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
