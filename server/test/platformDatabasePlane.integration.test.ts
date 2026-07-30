import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
    const actor = await fixtureDb.platformUser.findFirstOrThrow({ where: { status: 'active' }, select: { id: true, role: true } });
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
  });

  it('preserves the SQL-owned tenant-integrity manifest', async () => {
    expect(TENANT_INTEGRITY_MANIFEST.compositeForeignKeys).toBe(121);
    expect(TENANT_INTEGRITY_MANIFEST.totalManagedIndexes).toBe(150);
    await expect(inspectTenantIntegrityManifest(fixtureDb)).resolves.toEqual([]);
  });

  it('rejects generated migrations that drop manifest-owned constraints or indexes', () => {
    const migrationsRoot = new URL('../../prisma/migrations', import.meta.url).pathname;
    const destructive: string[] = [];
    for (const directory of readdirSync(migrationsRoot).filter(name => /^\d{14}_/.test(name) && name > '20260730120000_complete_rls_isolation').sort()) {
      const sql = readFileSync(join(migrationsRoot, directory, 'migration.sql'), 'utf8');
      if (/DROP\s+(?:CONSTRAINT|INDEX)[^;]*(?:rls_fk_|rls_ix_|rls_uq_)/i.test(sql)) destructive.push(directory);
    }
    expect(destructive, 'Prisma migration attempts to drop SQL-owned tenant-integrity objects').toEqual([]);
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
