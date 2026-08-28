import 'dotenv/config';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Pool, type PoolClient } from 'pg';

const ownerUrl = process.env.SYNTHETIC_DATABASE_URL ?? process.env.DATABASE_MIGRATION_URL;
const runtimeUrl = process.env.DATABASE_URL;
const expectedDatabase = process.env.RLS_DISPOSABLE_DB;
if (!ownerUrl || !runtimeUrl || !expectedDatabase) throw new Error('Benchmark requires the guarded disposable-database wrapper');
if (!/^carecommand_rls_behavior_[a-z0-9_]+$/.test(expectedDatabase)) throw new Error('Refusing benchmark outside a disposable database');
if (process.env.SYNTHETIC_PROFILE !== 'PILOT') throw new Error('Benchmark requires SYNTHETIC_PROFILE=PILOT');

const owner = new Pool({ connectionString: ownerUrl, max: 1 });
const runtime = new Pool({ connectionString: runtimeUrl, max: 2 });
const platformUrl = new URL(ownerUrl);
platformUrl.searchParams.set('options', '-c role=app_platform');
const platform = new Pool({ connectionString: platformUrl.toString(), max: 1 });

type Measurement = { name: string; rows: number; samplesMs: number[]; maxMs: number };

async function measure(client: PoolClient, name: string, sql: string, values: unknown[] = []): Promise<Measurement> {
  const samplesMs: number[] = [];
  let rows = 0;
  for (let run = 0; run < 3; run += 1) {
    const start = performance.now();
    const result = await client.query(sql, values);
    samplesMs.push(Number((performance.now() - start).toFixed(2)));
    rows = result.rowCount ?? result.rows.length;
  }
  const maxMs = Math.max(...samplesMs);
  if (maxMs > 750) throw new Error(`${name} exceeded the local 750ms regression budget (${maxMs}ms)`);
  return { name, rows, samplesMs, maxMs };
}

async function main(): Promise<void> {
  const identity = await owner.query<{ database: string; tenant_id: string; actor_id: string }>(`
    SELECT current_database() AS database, t.id::text AS tenant_id, u.id::text AS actor_id
    FROM "Tenant" t JOIN "User" u ON u."tenantId" = t.id AND u.active
    WHERE t.status = 'active' ORDER BY t.id, u.id LIMIT 1
  `);
  const row = identity.rows[0];
  if (!row || row.database !== expectedDatabase) throw new Error('Disposable database identity mismatch');
  const totals = await owner.query<{ patients: number; appointments: number; calls: number; documents: number; notifications: number; audits: number }>(`
    SELECT
      (SELECT count(*)::int FROM "Patient") patients,
      (SELECT count(*)::int FROM "Appointment") appointments,
      (SELECT count(*)::int FROM "ReceptionistCallLog") calls,
      (SELECT count(*)::int FROM "PatientIntakeDocument") documents,
      (SELECT count(*)::int FROM "NotificationEvent") notifications,
      (SELECT count(*)::int FROM "AuditEvent") audits
  `);
  if ((totals.rows[0]?.patients ?? 0) < 2_000 || (totals.rows[0]?.appointments ?? 0) < 4_000) {
    throw new Error('Pilot volume is incomplete');
  }

  const client = await runtime.connect();
  const measurements: Measurement[] = [];
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true), set_config('app.current_actor_id', $2, true), set_config('app.current_actor_role', 'OWNER', true), set_config('app.current_context_source', 'request', true)`, [row.tenant_id, row.actor_id]);
    measurements.push(await measure(client, 'patient-search', `SELECT id FROM "Patient" WHERE "lastName" ILIKE 'Patient%' AND "deletedAt" IS NULL ORDER BY "createdAt" DESC LIMIT 50`));
    measurements.push(await measure(client, 'appointment-calendar', `SELECT id,"startsAt",status FROM "Appointment" WHERE "startsAt" BETWEEN $1 AND $2 ORDER BY "startsAt" LIMIT 200`, [new Date('2026-01-01'), new Date('2027-01-01')]));
    measurements.push(await measure(client, 'dashboard-aggregate', `SELECT count(*)::int total, count(*) FILTER (WHERE status='CONFIRMED')::int confirmed FROM "Appointment"`));
    measurements.push(await measure(client, 'audit-search', `SELECT id,action,"occurredAt" FROM "AuditEvent" ORDER BY "occurredAt" DESC LIMIT 100`));
    measurements.push(await measure(client, 'receptionist-events', `SELECT id,outcome,"createdAt" FROM "ReceptionistCallLog" ORDER BY "createdAt" DESC LIMIT 100`));
    measurements.push(await measure(client, 'document-list', `SELECT id,"documentType",status FROM "PatientIntakeDocument" ORDER BY "createdAt" DESC LIMIT 100`));
    measurements.push(await measure(client, 'notification-list', `SELECT id,status,channel FROM "NotificationEvent" ORDER BY "createdAt" DESC LIMIT 100`));
    measurements.push(await measure(client, 'bounded-pagination', `SELECT id FROM "Patient" ORDER BY id OFFSET 400 LIMIT 100`));
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }

  const platformIdentity = await owner.query<{ id: string; role: string }>(`SELECT id::text, role FROM "PlatformUser" WHERE status='active' AND role='PLATFORM_OWNER' LIMIT 1`);
  const platformActor = platformIdentity.rows[0];
  if (!platformActor) throw new Error('Synthetic platform actor missing');
  const platformClient = await platform.connect();
  try {
    await platformClient.query('BEGIN');
    await platformClient.query(`SELECT set_config('app.current_platform_actor_id', $1, true), set_config('app.current_platform_actor_role', $2, true)`, [platformActor.id, platformActor.role]);
    measurements.push(await measure(platformClient, 'platform-overview', 'SELECT * FROM app_platform_overview()'));
    let phiDenied = false;
    try { await platformClient.query('SELECT id FROM "Patient" LIMIT 1'); } catch (error) { phiDenied = (error as { code?: string }).code === '42501'; }
    if (!phiDenied) throw new Error('app_platform unexpectedly accessed Patient');
    await platformClient.query('ROLLBACK');
  } finally {
    platformClient.release();
  }

  const output = {
    dataset: totals.rows[0],
    environment: { node: process.version, cpu: cpus()[0]?.model ?? 'unknown', logicalCpus: cpus().length, memoryGiB: Number((totalmem() / 1024 ** 3).toFixed(1)) },
    measurements,
    statement: 'Local regression evidence only; not a customer-capacity claim.',
  };
  console.log(JSON.stringify(output, null, 2));
}

main()
  .finally(async () => Promise.all([owner.end(), runtime.end(), platform.end()]))
  .catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
