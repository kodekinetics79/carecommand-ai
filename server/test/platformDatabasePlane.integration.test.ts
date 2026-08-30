import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { fixtureDb } from './helpers/fixtureDb';
import { inspectTenantIntegrityManifest, TENANT_INTEGRITY_MANIFEST } from '../modules/platform/prismaDriftGuard';

afterAll(async () => fixtureDb.$disconnect());

describe('dedicated platform database plane', () => {
  it('keeps app_platform non-bypass, non-owner, and unable to read PHI tables', async () => {
    const posture = await fixtureDb.$queryRaw<Array<{
      rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolinherit: boolean; owned: bigint;
    }>>`
      SELECT r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolinherit,
             (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
               WHERE n.nspname='public' AND c.relkind='r' AND c.relowner=r.oid) AS owned
      FROM pg_roles r WHERE r.rolname='app_platform'
    `;
    expect(posture).toEqual([{ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, owned: 0n }]);
    const grants = await fixtureDb.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.role_table_grants
      WHERE grantee='app_platform' AND table_name IN ('Patient','Appointment','Conversation','ReceptionistCallLog','PaymentTransaction')
    `;
    expect(grants).toEqual([]);
    await expect(fixtureDb.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE app_platform');
      await tx.$queryRawUnsafe('SELECT count(*) FROM "Patient"');
    })).rejects.toThrow(/permission denied/i);
  });

  it('removes the platform identity/config/secret/audit grants from app_rls', async () => {
    const rows = await fixtureDb.$queryRaw<Array<{ table_name: string; privilege_type: string }>>`
      SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee='app_rls' AND table_name IN ('PlatformUser','PlatformConfig','PlatformIntegration','PlatformAuditEvent')
    `;
    expect(rows).toEqual([]);
  });

  it('returns exact cross-tenant analytics only with an active platform actor', async () => {
    const expected = await fixtureDb.$queryRaw<Array<{ tenants: bigint; active: bigint }>>`
      SELECT count(*) AS tenants, count(*) FILTER (WHERE status='active') AS active FROM "Tenant"
    `;
    const actor = await fixtureDb.platformUser.create({
      data: {
        id: randomUUID(),
        email: `database-plane-${randomUUID()}@platform.test`,
        name: 'Database Plane Test Operator',
        passwordHash: 'test-only-not-an-authentication-credential',
        role: 'PLATFORM_AUDITOR',
        status: 'active',
      },
      select: { id: true, role: true },
    });
    try {
      const actual = await fixtureDb.$transaction(async tx => {
        await tx.$executeRaw`SELECT set_config('app.current_platform_actor_id', ${actor.id}, true), set_config('app.current_platform_actor_role', ${actor.role}, true)`;
        await tx.$executeRawUnsafe('SET LOCAL ROLE app_platform');
        return tx.$queryRaw<Array<{ tenants: bigint; active_tenants: bigint }>>`SELECT tenants, active_tenants FROM app_platform_overview()`;
      });
      expect(actual[0]?.tenants).toBe(expected[0]?.tenants);
      expect(actual[0]?.active_tenants).toBe(expected[0]?.active);
      await expect(fixtureDb.$transaction(async tx => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE app_platform');
        await tx.$queryRawUnsafe('SELECT * FROM app_platform_overview()');
      })).rejects.toThrow(/platform_actor_required|permission denied/i);
    } finally {
      await fixtureDb.platformUser.delete({ where: { id: actor.id } });
    }
  });

  it('preserves the SQL-owned tenant-integrity manifest', async () => {
    expect(TENANT_INTEGRITY_MANIFEST.compositeForeignKeys).toBe(121);
    expect(TENANT_INTEGRITY_MANIFEST.totalManagedIndexes).toBe(152);
    await expect(inspectTenantIntegrityManifest(fixtureDb)).resolves.toEqual([]);
  });

  /**
   * Post-baseline migrations that are ALLOWED to remove a table or a column,
   * and why. PostgreSQL drops a table's constraints and indexes with it, and a
   * column's indexes with it, so both remove manifest-owned objects without
   * ever naming them - the reason a name-matching check alone is not enough.
   *
   * The acknowledgement lives here rather than as a marker inside the migration
   * because an applied migration must not be edited to satisfy a guard: doing
   * that changes its checksum and breaks every database that already ran it.
   * Reviewing this list is reviewing the guard.
   *
   * An entry is written by whoever removed the object, not by whoever hits the
   * failure. A reason invented after the fact by someone reading unfamiliar SQL
   * is a guess wearing the costume of a review, and this list is only worth
   * anything if each line means "someone who knew why signed for it".
   */
  const ACKNOWLEDGED_OBJECT_REMOVALS: Record<string, string> = {
    '20260830130000_front_desk_loop':
      'drops ReceptionistAppointmentRequest, a dead model superseded by the front-desk loop; its four manifest objects are accounted for in the pinned counts',
    '20260830110000_receptionist_knowledge_hours_locale':
      'drops ReceptionistLocation.timezone, which carries no manifest-owned index; timezone moved to the clinic hours engine',
  };

  function postBaselineMigrations(): Array<{ directory: string; sql: string }> {
    const migrationsRoot = new URL('../../prisma/migrations', import.meta.url).pathname;
    return readdirSync(migrationsRoot)
      .filter(name => /^\d{14}_/.test(name) && name > '20260730120000_complete_rls_isolation')
      .sort()
      .map(directory => ({ directory, sql: readFileSync(join(migrationsRoot, directory, 'migration.sql'), 'utf8') }));
  }

  it('rejects generated migrations that drop manifest-owned constraints or indexes', () => {
    const destructive = postBaselineMigrations()
      .filter(({ sql }) => /DROP\s+(?:CONSTRAINT|INDEX)[^;]*(?:rls_fk_|rls_ix_|rls_uq_)/i.test(sql))
      .map(({ directory }) => directory);
    expect(destructive, 'Prisma migration attempts to drop SQL-owned tenant-integrity objects').toEqual([]);
  });

  /**
   * The check above matches on object NAMES, so it only sees a removal that
   * spells one out. `DROP TABLE` and `DROP COLUMN` take the same objects with
   * them silently and slipped straight past it - caught, when it happened, only
   * because the pinned manifest counts moved. A count pin tells you something
   * changed; it does not tell you what, or that anyone meant it.
   */
  it('rejects a table or column removal that silently takes manifest-owned objects with it', () => {
    const unacknowledged = postBaselineMigrations()
      .filter(({ directory, sql }) => {
        if (directory in ACKNOWLEDGED_OBJECT_REMOVALS) return false;
        // Comments describe removals without performing them, so read only the
        // statements: strip line comments before matching.
        const statements = sql.replace(/^\s*--.*$/gm, '');
        return /DROP\s+TABLE/i.test(statements) || /DROP\s+COLUMN/i.test(statements);
      })
      .map(({ directory }) => directory);
    expect(
      unacknowledged,
      'A migration removes a table or column after the RLS baseline without an entry in ACKNOWLEDGED_OBJECT_REMOVALS. '
      + 'Dropping either takes its policies, constraints and indexes with it. Add the migration and the reason to that map.',
    ).toEqual([]);
  });

  it('keeps the acknowledgement list honest: every entry names a migration that actually removes something', () => {
    // An entry that no longer matches a real removal is a standing permission
    // nobody is checking - the next drop in that migration would pass unread.
    const stale = Object.keys(ACKNOWLEDGED_OBJECT_REMOVALS).filter(directory => {
      const found = postBaselineMigrations().find(m => m.directory === directory);
      if (!found) return true;
      const statements = found.sql.replace(/^\s*--.*$/gm, '');
      return !/DROP\s+TABLE/i.test(statements) && !/DROP\s+COLUMN/i.test(statements);
    });
    expect(stale, 'ACKNOWLEDGED_OBJECT_REMOVALS names a migration that no longer removes a table or column').toEqual([]);
  });

  it('keeps Retell destination lookup indexed and unique-match fail-closed', async () => {
    const rows = await fixtureDb.$queryRaw<Array<{ has_branch: boolean; has_index: boolean }>>`
      SELECT
        pg_get_functiondef('app_resolve_ingress_tenant(text,text)'::regprocedure) LIKE '%retell_destination_phone%' AS has_branch,
        to_regclass('public."ReceptionistClinic_active_phone_unique"') IS NOT NULL AS has_index
    `;
    expect(rows).toEqual([{ has_branch: true, has_index: true }]);
  });
});
