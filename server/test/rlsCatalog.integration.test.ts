import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../lib/db';

type CatalogRow = {
  tableName: string;
  rlsEnabled: boolean;
  rlsForced: boolean;
};

type PolicyRow = {
  tableName: string;
  command: string;
  roles: string[];
};

// PlatformAuditEvent has an optional tenantId that identifies a target rather
// than row ownership. It is the only explicit tenant-column RLS exemption.
const TENANT_COLUMN_EXEMPTIONS = new Set(['PlatformAuditEvent']);
const APPEND_ONLY_TABLES = new Set([
  'AuditEvent', 'NotificationDeliveryAttempt',
  'ReceptionistVoiceConsentEvent', 'ReceptionistOutboundProviderIntent',
]);

function schemaTenantTables(): string[] {
  // Prisma 7's generated namespace no longer exposes DMMF at runtime. Read the
  // authoritative schema directly so this guard also detects a model added
  // before its migration reaches the test database.
  const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
  const tables: string[] = [];
  for (const match of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const [, modelName, body] = match;
    const tenantField = body.match(/^\s*tenantId\s+(\w+)(\?)?/m);
    if (!tenantField || tenantField[2]) continue;
    const mappedName = body.match(/^\s*@@map\("([^"]+)"\)/m)?.[1];
    const table = mappedName ?? modelName;
    if (!TENANT_COLUMN_EXEMPTIONS.has(table)) tables.push(table);
  }
  return tables.sort();
}

afterAll(async () => {
  await db.$disconnect();
});

describe('RLS catalog guard — every tenant-owned model is deny-by-default', () => {
  it('keeps the deployed catalog synchronized with tenant ownership in the Prisma schema', async () => {
    const expected = schemaTenantTables();
    const rows = await db.$queryRaw<Array<{ tableName: string }>>`
      SELECT c.relname AS "tableName"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
    `;
    const deployed = new Set(rows.map(row => row.tableName));

    expect(expected.filter(table => !deployed.has(table)), 'tenant-owned schema tables missing from the deployed catalog').toEqual([]);
  });

  it('enables and forces RLS on every required tenant table and the Tenant root', async () => {
    const required = new Set([...schemaTenantTables(), 'Tenant']);
    const rows = await db.$queryRaw<CatalogRow[]>`
      SELECT c.relname AS "tableName",
             c.relrowsecurity AS "rlsEnabled",
             c.relforcerowsecurity AS "rlsForced"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
    `;
    const catalog = new Map(rows.map(row => [row.tableName, row]));
    const insecure = [...required]
      .filter(table => !catalog.get(table)?.rlsEnabled || !catalog.get(table)?.rlsForced)
      .sort();

    expect(insecure, 'tenant-owned tables without ENABLE + FORCE ROW LEVEL SECURITY').toEqual([]);
  });

  it('has explicit per-command app_rls policies and no PUBLIC tenant policy', async () => {
    const expectedTables = schemaTenantTables();
    const rows = await db.$queryRaw<PolicyRow[]>`
      SELECT tablename AS "tableName", cmd AS command, roles::text[] AS roles
      FROM pg_policies
      WHERE schemaname = 'public'
    `;
    const appRows = rows.filter(row => row.roles.includes('app_rls'));
    const byTable = new Map<string, PolicyRow[]>();
    for (const row of appRows) byTable.set(row.tableName, [...(byTable.get(row.tableName) ?? []), row]);

    const defects: string[] = [];
    for (const table of expectedTables) {
      const policies = byTable.get(table) ?? [];
      const expectedCommands = APPEND_ONLY_TABLES.has(table)
        ? ['INSERT', 'SELECT']
        : ['DELETE', 'INSERT', 'SELECT', 'UPDATE'];
      const commands = policies.map(policy => policy.command).sort();
      if (JSON.stringify(commands) !== JSON.stringify(expectedCommands)) {
        defects.push(`${table}: commands=${commands.join(',') || 'none'}`);
      }
      if (policies.some(policy => policy.roles.some(role => role !== 'app_rls'))) {
        defects.push(`${table}: policy role is not exclusively scoped to app_rls`);
      }
      if (rows.some(policy => policy.tableName === table && policy.roles.includes('public'))) {
        defects.push(`${table}: PUBLIC policy is forbidden`);
      }
    }

    const tenantCommands = (byTable.get('Tenant') ?? []).map(policy => policy.command).sort();
    if (JSON.stringify(tenantCommands) !== JSON.stringify(['SELECT'])) {
      defects.push(`Tenant: commands=${tenantCommands.join(',') || 'none'}`);
    }

    expect(defects, 'incomplete or over-broad tenant RLS policies').toEqual([]);
  });

  it('returns zero tenant-owned rows when no transaction-local context is present', async () => {
    const visible: string[] = [];
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE app_rls');
      for (const table of schemaTenantTables()) {
        // Table identifiers originate only from the generated Prisma DMMF.
        const quoted = `"${table.replaceAll('"', '""')}"`;
        const rows = await tx.$queryRawUnsafe<Array<{ visible: bigint }>>(`SELECT count(*) AS visible FROM ${quoted}`);
        if (Number(rows[0]?.visible ?? 0) !== 0) visible.push(table);
      }
    });

    expect(visible, 'tenant tables visible without app.current_tenant_id/actor/source context').toEqual([]);
  });
});
