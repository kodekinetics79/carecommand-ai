/**
 * One-shot production repair for the failed deploy chain (2026-08-29).
 *
 *  1. Shows, then deletes, the single demo AppointmentRequest row that trips
 *     guard 3 of 20260730210000_receptionist_call_booking_atomicity.
 *  2. Re-checks every data guard that migration enforces; commits only if ALL
 *     pass, otherwise rolls back and changes nothing.
 *  3. Marks the failed migration record rolled back (what
 *     `prisma migrate resolve --rolled-back` does) so the next deploy's
 *     `prisma migrate deploy` retries it from a clean state.
 *
 * Run with the DIRECT Neon endpoint (no -pooler) as neondb_owner:
 *   FIX_DB_URL='postgresql://neondb_owner:...@ep-...aws.neon.tech/neondb?sslmode=require' \
 *     npx tsx scripts/fix-prod-migration.ts
 */
import pg from 'pg';

const MIG = '20260730210000_receptionist_call_booking_atomicity';
const url = process.env.FIX_DB_URL;
if (!url) { console.error('FIX_DB_URL not set'); process.exit(1); }
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

const guards: Array<[string, string]> = [
  ['g1_dupe_calllog', `SELECT count(*)::int n FROM (SELECT 1 FROM "AppointmentRequest" WHERE "callLogId" IS NOT NULL GROUP BY "tenantId","callLogId" HAVING count(*)>1) x`],
  ['g2_booked_no_appt', `SELECT count(*)::int n FROM "AppointmentRequest" WHERE "status"='BOOKED' AND "bookedAppointmentId" IS NULL`],
  ['g3_ai_no_calllog', `SELECT count(*)::int n FROM "AppointmentRequest" WHERE "status"='BOOKED' AND "source"='ai_receptionist' AND "callLogId" IS NULL`],
  ['g4_dupe_retell', `SELECT count(*)::int n FROM (SELECT 1 FROM "ReceptionistCallLog" WHERE "retellCallId" IS NOT NULL GROUP BY "retellCallId" HAVING count(*)>1) x`],
  ['g5_dupe_appt', `SELECT count(*)::int n FROM (SELECT 1 FROM "AppointmentRequest" WHERE "bookedAppointmentId" IS NOT NULL GROUP BY "tenantId","bookedAppointmentId" HAVING count(*)>1) x`],
  ['g6_orphan_calllog', `SELECT count(*)::int n FROM "AppointmentRequest" r LEFT JOIN "ReceptionistCallLog" cl ON cl."tenantId"=r."tenantId" AND cl.id=r."callLogId" WHERE r."callLogId" IS NOT NULL AND cl.id IS NULL`],
  ['g7_orphan_appt', `SELECT count(*)::int n FROM "AppointmentRequest" r LEFT JOIN "Appointment" a ON a."tenantId"=r."tenantId" AND a.id=r."bookedAppointmentId" WHERE r."bookedAppointmentId" IS NOT NULL AND a.id IS NULL`],
  ['g8_booked_call_no_provider', `SELECT count(*)::int n FROM "AppointmentRequest" r JOIN "Appointment" a ON a."tenantId"=r."tenantId" AND a.id=r."bookedAppointmentId" WHERE r."status"='BOOKED' AND r."callLogId" IS NOT NULL AND a."providerProfileId" IS NULL`],
];

async function main() {
  await c.connect();
  const who = await c.query('select current_user, current_database()');
  console.log('connected:', JSON.stringify(who.rows[0]));

  console.log('\n--- the offending row(s) ---');
  const rows = await c.query(`SELECT r.id, r."tenantId", t.slug AS tenant_slug, r."status", r."source",
      r."callLogId", r."bookedAppointmentId", r."createdAt"
    FROM "AppointmentRequest" r LEFT JOIN "Tenant" t ON t.id=r."tenantId"
    WHERE r."status"='BOOKED' AND r."source"='ai_receptionist' AND r."callLogId" IS NULL`);
  console.log(JSON.stringify(rows.rows, null, 2));
  if (rows.rows.length !== 1) {
    console.error(`expected exactly 1 row, found ${rows.rows.length} - aborting, nothing changed`);
    process.exit(1);
  }

  await c.query('BEGIN');
  try {
    const del = await c.query(`DELETE FROM "AppointmentRequest"
      WHERE "status"='BOOKED' AND "source"='ai_receptionist' AND "callLogId" IS NULL RETURNING id`);
    console.log(`\ndeleted ${del.rowCount} AppointmentRequest row: ${del.rows.map(r => r.id).join(',')}`);
    if (del.rowCount !== 1) throw new Error(`expected to delete exactly 1, deleted ${del.rowCount}`);

    console.log('\n--- guard re-check (all must be 0) ---');
    let bad = 0;
    for (const [name, sql] of guards) {
      const n = (await c.query(sql)).rows[0].n;
      console.log(`  ${name} = ${n}`);
      if (n !== 0) bad++;
    }
    if (bad) throw new Error(`${bad} guard(s) still failing - rolling back`);

    const mig = await c.query(
      `UPDATE _prisma_migrations SET rolled_back_at = now()
        WHERE migration_name=$1 AND finished_at IS NULL AND rolled_back_at IS NULL
        RETURNING migration_name, started_at`, [MIG]);
    console.log(`\nmarked rolled back: ${mig.rowCount} row -> ${JSON.stringify(mig.rows)}`);
    if (mig.rowCount !== 1) throw new Error(`expected 1 failed migration record, found ${mig.rowCount}`);

    await c.query('COMMIT');
    console.log('\nCOMMITTED. The next deploy\'s migrate deploy retries from a clean state.');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('ROLLED BACK:', (e as Error).message);
    process.exit(1);
  }
  await c.end();
}
await main();
