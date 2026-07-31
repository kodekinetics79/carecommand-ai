import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';

export type RlsBehaviorMode = 'MUTABLE' | 'APPEND_ONLY' | 'READ_ONLY';

export type RlsTableAdapter = {
  table: string;
  ownershipColumn: 'id' | 'tenantId';
  mode: RlsBehaviorMode;
};

type Column = {
  table: string;
  name: string;
  typeName: string;
  typeKind: string;
  notNull: boolean;
  hasDefault: boolean;
  generated: boolean;
  enumValue: string | null;
};

type ForeignKey = {
  childTable: string;
  parentTable: string;
  childColumns: string[];
  parentColumns: string[];
};

type PrimaryKey = { table: string; columns: string[] };

export type FixtureRecord = {
  row: Record<string, unknown>;
  primaryKey: Record<string, unknown>;
};

export type OperationResult = { count: number; errorCode?: string; changed?: boolean };

export type QuerySurfaceResult = {
  list: number;
  search: number;
  aggregate: number;
  exported: number;
};

export type MutationEvidence = {
  update: OperationResult;
  delete: OperationResult;
  upsert: OperationResult;
  bulkUpdate: OperationResult;
  bulkDelete: OperationResult;
  tenantReassignmentError?: string;
};

const APPEND_ONLY = new Set([
  'AuditEvent',
  'ConsentEvent',
  'ReceptionistArtifactLifecycleEvent',
  'ReceptionistRecordingConsentEvent',
  'NotificationDeliveryAttempt',
]);

function schemaProtectedTables(): string[] {
  const schema = readFileSync(new URL('../../../prisma/schema.prisma', import.meta.url), 'utf8');
  const tables = ['Tenant'];
  for (const match of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const [, modelName, body] = match;
    const tenantField = body.match(/^\s*tenantId\s+String(\?)?\s+[^\n]*@db\.Uuid/m);
    if (!tenantField) continue;
    if (tenantField[1] && modelName !== 'IdempotencyKey') continue;
    if (modelName === 'PlatformAuditEvent') continue;
    tables.push(body.match(/^\s*@@map\("([^"]+)"\)/m)?.[1] ?? modelName);
  }
  return [...new Set(tables)].sort();
}

export const RLS_TABLE_ADAPTERS: readonly RlsTableAdapter[] = schemaProtectedTables().map(table => ({
  table,
  ownershipColumn: table === 'Tenant' ? 'id' : 'tenantId',
  mode: table === 'Tenant' ? 'READ_ONLY' : APPEND_ONLY.has(table) ? 'APPEND_ONLY' : 'MUTABLE',
}));

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function key(table: string, tenantId?: string): string {
  return `${table}:${tenantId ?? 'GLOBAL'}`;
}

function syntheticE164Phone(seed: string): string {
  const digits = BigInt(`0x${createHash('sha256').update(seed).digest('hex').slice(0, 14)}`) % 10_000_000_000n;
  return `+1${digits.toString().padStart(10, '0')}`;
}

function syntheticScalar(column: Column, suffix: string): unknown {
  const name = column.name.toLowerCase();
  if (column.enumValue !== null) return column.enumValue;
  if (column.typeKind === 'e') return column.enumValue;
  if (column.typeName.endsWith('[]')) return [];
  if (column.typeName === 'uuid') return randomUUID();
  if (column.typeName === 'boolean') return false;
  if (column.typeName === 'json' || column.typeName === 'jsonb') return {};
  if (column.typeName === 'bytea') return Buffer.from(`rls-${suffix}`);
  if (column.typeName.includes('timestamp')) {
    const future = name.includes('end') || name.includes('expir') || name.includes('until') || name.includes('review');
    return new Date(Date.now() + (future ? 3_600_000 : 0));
  }
  if (column.typeName === 'date') return new Date().toISOString().slice(0, 10);
  if (column.typeName.startsWith('time')) return name.includes('end') ? '10:00:00' : '09:00:00';
  if (['smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision', 'money'].includes(column.typeName)) return 1;
  if (column.typeName === 'inet') return '192.0.2.1';
  if (name.includes('email')) return `rls-${suffix}@example.test`;
  if (name.includes('phone')) return syntheticE164Phone(`${column.table}:${column.name}:${suffix}`);
  if (name.includes('timezone')) return 'UTC';
  if (name.includes('currency')) return 'USD';
  if (name.includes('locale') || name.includes('language')) return 'en';
  if (name.includes('hash')) return createHash('sha256').update(`${column.table}:${column.name}:${suffix}`).digest('hex');
  if (name.includes('url')) return `https://example.test/${suffix}`;
  if (name.includes('ipaddress')) return '192.0.2.1';
  return `rls-${column.table.toLowerCase()}-${column.name.toLowerCase()}-${suffix}`.slice(0, 120);
}

function sqlState(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export class RlsBehaviorHarness {
  readonly tenantA = randomUUID();
  readonly tenantB = randomUUID();
  readonly actorA = randomUUID();
  readonly actorB = randomUUID();
  readonly fixtures = new Map<string, FixtureRecord>();
  private readonly owner: Pool;
  private readonly runtime: Pool;
  private columns = new Map<string, Column[]>();
  private foreignKeys = new Map<string, ForeignKey[]>();
  private primaryKeys = new Map<string, string[]>();
  private uniqueColumns = new Map<string, Set<string>>();
  private readonly restrictedInsertEvidence = new Set<string>();
  private readonly mutationEvidence = new Map<string, MutationEvidence>();

  constructor() {
    const ownerUrl = process.env.DATABASE_MIGRATION_URL;
    const runtimeUrl = process.env.DATABASE_URL;
    if (!ownerUrl || !runtimeUrl) throw new Error('RLS behavioral harness requires DATABASE_MIGRATION_URL and DATABASE_URL');
    this.owner = new Pool({ connectionString: ownerUrl, max: 2 });
    this.runtime = new Pool({ connectionString: runtimeUrl, max: 1 });
  }

  async provision(adapters: readonly RlsTableAdapter[]): Promise<void> {
    const database = await this.owner.query<{ database: string; server: string }>(
      `SELECT current_database() AS database, inet_server_addr()::text AS server`,
    );
    const databaseName = database.rows[0]?.database ?? '';
    if (process.env.RLS_DISPOSABLE_DB !== databaseName || !/^carecommand_rls_behavior_[a-z0-9_]+$/.test(databaseName)) {
      throw new Error(`RLS behavioral harness refuses non-disposable database "${databaseName}"`);
    }

    await this.loadCatalog();
    const deployed = new Set(this.columns.keys());
    const expected = new Set(adapters.map(adapter => adapter.table));
    const missing = [...expected].filter(table => !deployed.has(table));
    const catalogProtected = await this.owner.query<{ table: string }>(`
      SELECT c.relname AS table
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
      ORDER BY c.relname
    `);
    const unexpected = catalogProtected.rows.map(row => row.table).filter(table => !expected.has(table));
    if (missing.length || unexpected.length) {
      throw new Error(`RLS adapter/catalog mismatch missing=[${missing.join(',')}] unexpected=[${unexpected.join(',')}]`);
    }

    await this.insertExplicitTenant(this.tenantA, 'A');
    await this.insertExplicitTenant(this.tenantB, 'B');
    await this.insertExplicitActor(this.tenantA, this.actorA, 'A');
    await this.insertExplicitActor(this.tenantB, this.actorB, 'B');
    await this.captureMutationEvidence('Tenant');

    await this.provisionUserFixture(this.tenantA);
    await this.provisionUserFixture(this.tenantB);

    await this.provisionTenantFixtures(adapters, this.tenantA);
    await this.provisionTenantFixtures(adapters, this.tenantB);
    await this.preparePublicIngressFixtures();
  }

  async close(): Promise<void> {
    await Promise.all([this.owner.end(), this.runtime.end()]);
  }

  fixture(table: string): FixtureRecord {
    const fixture = this.fixtures.get(key(table, this.tenantA));
    if (!fixture) throw new Error(`Missing RLS fixture for ${table}`);
    return fixture;
  }

  authorizedInsertWasExecuted(table: string): boolean {
    return this.restrictedInsertEvidence.has(key(table, this.tenantA));
  }

  provisionedMutationEvidence(table: string): MutationEvidence {
    const evidence = this.mutationEvidence.get(table);
    if (!evidence) throw new Error(`Missing restricted-role mutation evidence for ${table}`);
    return evidence;
  }

  async visibility(table: string, context: 'A' | 'B' | 'NONE'): Promise<number> {
    const fixture = this.fixture(table);
    return this.runtimeTransaction(context, async client => {
      const { clause, values } = this.primaryKeyWhere(table, fixture.primaryKey);
      const result = await client.query(`SELECT count(*)::int AS count FROM ${quoteIdentifier(table)} WHERE ${clause}`, values);
      return Number(result.rows[0]?.count ?? 0);
    });
  }

  async aggregateVisibility(table: string, context: 'A' | 'B' | 'NONE'): Promise<{ count: number; exported: number }> {
    const ownership = table === 'Tenant' ? 'id' : 'tenantId';
    return this.runtimeTransaction(context, async client => {
      const result = await client.query<{ count: number; exported: unknown[] }>(
        `SELECT count(*)::int AS count, COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS exported
         FROM ${quoteIdentifier(table)} t WHERE ${quoteIdentifier(ownership)} = $1::uuid`,
        [this.tenantA],
      );
      return { count: Number(result.rows[0]?.count ?? 0), exported: result.rows[0]?.exported.length ?? 0 };
    });
  }

  async querySurfaces(table: string, context: 'A' | 'B' | 'NONE'): Promise<QuerySurfaceResult> {
    const fixture = this.fixture(table);
    const ownership = table === 'Tenant' ? 'id' : 'tenantId';
    const primaryKeyValue = String(Object.values(fixture.primaryKey)[0]);
    return this.runtimeTransaction(context, async client => {
      const result = await client.query<{
        list: number;
        search: number;
        aggregate: number;
        exported: unknown[];
      }>(
        `SELECT
           (SELECT count(*)::int FROM (SELECT 1 FROM ${quoteIdentifier(table)} t WHERE t.${quoteIdentifier(ownership)} = $1::uuid LIMIT 100) listed) AS list,
           (SELECT count(*)::int FROM ${quoteIdentifier(table)} t WHERE t.${quoteIdentifier(ownership)} = $1::uuid AND to_jsonb(t)::text LIKE ('%' || $2 || '%')) AS search,
           (SELECT count(*)::int FROM ${quoteIdentifier(table)} t WHERE t.${quoteIdentifier(ownership)} = $1::uuid) AS aggregate,
           (SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM ${quoteIdentifier(table)} t WHERE t.${quoteIdentifier(ownership)} = $1::uuid) AS exported`,
        [this.tenantA, primaryKeyValue],
      );
      const row = result.rows[0]!;
      return {
        list: Number(row.list),
        search: Number(row.search),
        aggregate: Number(row.aggregate),
        exported: row.exported.length,
      };
    });
  }

  async insertClone(table: string, row: Record<string, unknown>, context: 'A' | 'B' | 'NONE', rowTenant: 'A' | 'B'): Promise<number> {
    const clone = this.nonConflictingClone(table, row);
    const ownership = table === 'Tenant' ? 'id' : 'tenantId';
    clone[ownership] = rowTenant === 'A' ? this.tenantA : this.tenantB;
    return this.runtimeTransaction(context, async client => {
      const result = await client.query(
        `INSERT INTO ${quoteIdentifier(table)} SELECT (jsonb_populate_record(NULL::${quoteIdentifier(table)}, $1::jsonb)).*`,
        [JSON.stringify(clone)],
      );
      return result.rowCount ?? 0;
    });
  }

  async insertExistingFixture(table: string, context: 'A' | 'B' | 'NONE'): Promise<number> {
    const fixture = this.fixture(table);
    return this.runtimeTransaction(context, async client => {
      const result = await client.query(
        `INSERT INTO ${quoteIdentifier(table)} SELECT (jsonb_populate_record(NULL::${quoteIdentifier(table)}, $1::jsonb)).*`,
        [JSON.stringify(fixture.row)],
      );
      return result.rowCount ?? 0;
    });
  }

  async upsertFixture(table: string, context: 'A' | 'B' | 'NONE'): Promise<{ count: number; errorCode?: string }> {
    const fixture = this.fixture(table);
    const ownership = table === 'Tenant' ? 'id' : 'tenantId';
    const pk = this.primaryKeys.get(table) ?? [];
    try {
      const count = await this.runtimeTransaction(context, async client => {
        const result = await client.query(
          `INSERT INTO ${quoteIdentifier(table)} SELECT (jsonb_populate_record(NULL::${quoteIdentifier(table)}, $1::jsonb)).*
           ON CONFLICT (${pk.map(quoteIdentifier).join(',')}) DO UPDATE SET ${quoteIdentifier(ownership)} = EXCLUDED.${quoteIdentifier(ownership)}`,
          [JSON.stringify(fixture.row)],
        );
        return result.rowCount ?? 0;
      });
      return { count };
    } catch (error) {
      return { count: 0, errorCode: sqlState(error) };
    }
  }

  async selfUpdate(table: string, context: 'A' | 'B' | 'NONE'): Promise<OperationResult> {
    const fixture = this.fixture(table);
    try {
      return await this.runtimeTransaction(context, async client => {
        const { clause, values } = this.primaryKeyWhere(table, fixture.primaryKey);
        const mutation = this.meaningfulMutation(table, fixture.row);
        if (!mutation) throw new Error(`No safe meaningful UPDATE adapter for ${table}`);
        const result = await client.query<Record<string, unknown>>(
          `UPDATE ${quoteIdentifier(table)} SET ${quoteIdentifier(mutation.column)} = ${mutation.expression}
           WHERE ${clause} RETURNING ${quoteIdentifier(mutation.column)} AS value`,
          values,
        );
        return {
          count: result.rowCount ?? 0,
          changed: result.rowCount === 1 && String(result.rows[0]?.value) !== String(fixture.row[mutation.column]),
        };
      });
    } catch (error) {
      return { count: 0, errorCode: sqlState(error) };
    }
  }

  async moveToOtherTenant(table: string): Promise<string | undefined> {
    const fixture = this.fixture(table);
    try {
      await this.runtimeTransaction('A', async client => {
        const { clause, values } = this.primaryKeyWhere(table, fixture.primaryKey);
        const ownership = table === 'Tenant' ? 'id' : 'tenantId';
        await client.query(
          `UPDATE ${quoteIdentifier(table)} SET ${quoteIdentifier(ownership)} = $${values.length + 1} WHERE ${clause}`,
          [...values, this.tenantB],
        );
      });
      return undefined;
    } catch (error) {
      return sqlState(error);
    }
  }

  async deleteFixture(table: string, context: 'A' | 'B' | 'NONE'): Promise<OperationResult> {
    const fixture = this.fixture(table);
    try {
      const count = await this.runtimeTransaction(context, async client => {
        const { clause, values } = this.primaryKeyWhere(table, fixture.primaryKey);
        const result = await client.query(`DELETE FROM ${quoteIdentifier(table)} WHERE ${clause}`, values);
        return result.rowCount ?? 0;
      });
      return { count };
    } catch (error) {
      return { count: 0, errorCode: sqlState(error) };
    }
  }

  async bulkUpdate(table: string, context: 'A' | 'B' | 'NONE'): Promise<OperationResult> {
    const fixture = this.fixture(table);
    try {
      return await this.runtimeTransaction(context, async client => {
        const ownership = table === 'Tenant' ? 'id' : 'tenantId';
        const mutation = this.meaningfulMutation(table, fixture.row);
        if (!mutation) throw new Error(`No safe meaningful bulk UPDATE adapter for ${table}`);
        const result = await client.query(
          `UPDATE ${quoteIdentifier(table)} SET ${quoteIdentifier(mutation.column)} = ${mutation.expression}
           WHERE ${quoteIdentifier(ownership)} = $1::uuid`,
          [this.tenantA],
        );
        return { count: result.rowCount ?? 0, changed: (result.rowCount ?? 0) > 0 };
      });
    } catch (error) {
      return { count: 0, errorCode: sqlState(error) };
    }
  }

  async bulkDelete(table: string, context: 'A' | 'B' | 'NONE'): Promise<{ count: number; errorCode?: string }> {
    const ownership = table === 'Tenant' ? 'id' : 'tenantId';
    try {
      const count = await this.runtimeTransaction(context, async client => {
        const result = await client.query(`DELETE FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(ownership)} = $1::uuid`, [this.tenantA]);
        return result.rowCount ?? 0;
      });
      return { count };
    } catch (error) {
      return { count: 0, errorCode: sqlState(error) };
    }
  }

  async crossTenantParentReassignment(table: string): Promise<'NOT_APPLICABLE' | string | undefined> {
    const fixture = this.fixture(table);
    const relationship = (this.foreignKeys.get(table) ?? []).find(fk =>
      RLS_TABLE_ADAPTERS.some(adapter => adapter.table === fk.parentTable) &&
      fk.childColumns.some(column => column !== 'tenantId') &&
      this.fixtures.has(key(fk.parentTable, this.tenantB)),
    );
    if (!relationship) return 'NOT_APPLICABLE';
    const parentB = this.fixtures.get(key(relationship.parentTable, this.tenantB))!;
    const assignments: string[] = [];
    const values: unknown[] = [];
    relationship.childColumns.forEach((child, index) => {
      if (child === 'tenantId') return;
      values.push(parentB.row[relationship.parentColumns[index]!]);
      assignments.push(`${quoteIdentifier(child)} = $${values.length}`);
    });
    const where = this.primaryKeyWhere(table, fixture.primaryKey);
    try {
      await this.runtimeTransaction('A', client => client.query(
        `UPDATE ${quoteIdentifier(table)} SET ${assignments.join(', ')} WHERE ${where.clause.replaceAll(/\$(\d+)/g, (_, number) => `$${Number(number) + values.length}`)}`,
        [...values, ...where.values],
      ));
      return undefined;
    } catch (error) {
      return sqlState(error);
    }
  }

  async publicIngressVisibility(input: {
    table: string;
    actorTable?: 'PatientPortalAccount' | 'PatientIntakePacket' | 'PaymentRequest' | 'PilotStatusShare';
    actorRole: 'PATIENT_PORTAL' | 'PUBLIC_INTAKE' | 'PUBLIC_PAYMENT' | 'PILOT_SHARE' | 'PUBLIC_PORTAL' | 'WEBHOOK';
    actorId?: string;
  }): Promise<{ valid: number; wrongTenant: number; forged: number }> {
    const fixture = this.fixture(input.table);
    const actorId = input.actorId ?? (input.actorTable ? String(this.fixture(input.actorTable).row.id) : 'webhook:retell');
    const source = input.actorRole === 'WEBHOOK' ? 'webhook' : 'portal';
    const probe = async (tenantId: string, actor: string): Promise<number> => this.customContextTransaction(
      { tenantId, actorId: actor, actorRole: input.actorRole, source },
      async client => {
        const where = this.primaryKeyWhere(input.table, fixture.primaryKey);
        const result = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM ${quoteIdentifier(input.table)} WHERE ${where.clause}`,
          where.values,
        );
        return Number(result.rows[0]?.count ?? 0);
      },
    );
    return {
      valid: await probe(this.tenantA, actorId),
      wrongTenant: await probe(this.tenantB, actorId),
      forged: await probe(this.tenantA, input.actorRole === 'WEBHOOK' ? 'webhook:INVALID!' : randomUUID()),
    };
  }

  async poolCleanupProbe(): Promise<{ first: number; residualSetting: string; second: number; sameBackend: boolean }> {
    const fixture = this.fixture('Patient');
    const where = this.primaryKeyWhere('Patient', fixture.primaryKey);
    const firstClient = await this.runtime.connect();
    let first: number;
    let firstBackend: number;
    try {
      await firstClient.query('BEGIN');
      await firstClient.query('SET LOCAL ROLE app_rls');
      await firstClient.query(
        `SELECT set_config('app.current_tenant_id', $1, true),
                set_config('app.current_actor_id', $2, true),
                set_config('app.current_actor_role', 'OWNER', true),
                set_config('app.current_context_source', 'request', true)`,
        [this.tenantA, this.actorA],
      );
      const backend = await firstClient.query<{ pid: number }>('SELECT pg_backend_pid()::int AS pid');
      firstBackend = Number(backend.rows[0]?.pid ?? 0);
      const visible = await firstClient.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM "Patient" WHERE ${where.clause}`,
        where.values,
      );
      first = Number(visible.rows[0]?.count ?? 0);
    } finally {
      await firstClient.query('ROLLBACK').catch(() => {});
      firstClient.release();
    }
    const client = await this.runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_rls');
      const backend = await client.query<{ pid: number }>('SELECT pg_backend_pid()::int AS pid');
      const setting = await client.query<{ tenant: string | null }>(
        `SELECT NULLIF(current_setting('app.current_tenant_id', true), '') AS tenant`,
      );
      const visible = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM "Patient" WHERE ${where.clause}`,
        where.values,
      );
      return {
        first,
        residualSetting: setting.rows[0]?.tenant ?? '',
        second: Number(visible.rows[0]?.count ?? 0),
        sameBackend: Number(backend.rows[0]?.pid ?? 0) === firstBackend,
      };
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }

  private async loadCatalog(): Promise<void> {
    const columns = await this.owner.query<Column>(`
      SELECT c.relname AS table, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS "typeName",
             t.typtype::text AS "typeKind", a.attnotnull AS "notNull",
             (ad.oid IS NOT NULL) AS "hasDefault", (a.attgenerated <> '') AS generated,
             (SELECT e.enumlabel FROM pg_enum e WHERE e.enumtypid = a.atttypid ORDER BY e.enumsortorder LIMIT 1) AS "enumValue"
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      JOIN pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname, a.attnum
    `);
    for (const column of columns.rows) this.columns.set(column.table, [...(this.columns.get(column.table) ?? []), column]);

    const fks = await this.owner.query<ForeignKey>(`
      SELECT child.relname AS "childTable", parent.relname AS "parentTable",
             array_agg(child_col.attname ORDER BY parts.ordinality)::text[] AS "childColumns",
             array_agg(parent_col.attname ORDER BY parts.ordinality)::text[] AS "parentColumns"
      FROM pg_constraint con
      JOIN pg_class child ON child.oid = con.conrelid
      JOIN pg_class parent ON parent.oid = con.confrelid
      JOIN pg_namespace n ON n.oid = child.relnamespace AND n.nspname = 'public'
      JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY parts(child_num, parent_num, ordinality) ON true
      JOIN pg_attribute child_col ON child_col.attrelid = child.oid AND child_col.attnum = parts.child_num
      JOIN pg_attribute parent_col ON parent_col.attrelid = parent.oid AND parent_col.attnum = parts.parent_num
      WHERE con.contype = 'f'
      GROUP BY con.oid, child.relname, parent.relname
    `);
    for (const fk of fks.rows) this.foreignKeys.set(fk.childTable, [...(this.foreignKeys.get(fk.childTable) ?? []), fk]);

    const pks = await this.owner.query<PrimaryKey>(`
      SELECT c.relname AS table, array_agg(a.attname ORDER BY keys.ordinality)::text[] AS columns
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN LATERAL unnest(con.conkey) WITH ORDINALITY keys(attnum, ordinality) ON true
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = keys.attnum
      WHERE con.contype = 'p'
      GROUP BY con.oid, c.relname
    `);
    for (const pk of pks.rows) this.primaryKeys.set(pk.table, pk.columns);

    const uniques = await this.owner.query<{ table: string; column: string }>(`
      SELECT c.relname AS table, a.attname AS column
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN LATERAL unnest(i.indkey) keys(attnum) ON keys.attnum > 0
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = keys.attnum
      WHERE i.indisunique
    `);
    for (const item of uniques.rows) {
      const columns = this.uniqueColumns.get(item.table) ?? new Set<string>();
      columns.add(item.column);
      this.uniqueColumns.set(item.table, columns);
    }
  }

  private async provisionTenantFixtures(adapters: readonly RlsTableAdapter[], tenantId: string): Promise<void> {
    const pending = new Set(adapters.map(adapter => adapter.table).filter(table => !['Tenant', 'User'].includes(table)));
    while (pending.size) {
      let progressed = false;
      for (const table of [...pending]) {
        const record = await this.tryInsertFixture(table, tenantId);
        if (!record) continue;
        this.fixtures.set(key(table, tenantId), record);
        if (tenantId === this.tenantA) await this.captureMutationEvidence(table);
        pending.delete(table);
        progressed = true;
      }
      if (!progressed) throw new Error(`Unable to resolve required fixture dependencies for ${tenantId}: ${[...pending].join(', ')}`);
    }
  }

  private async provisionUserFixture(tenantId: string): Promise<void> {
    const record = await this.tryInsertFixture('User', tenantId);
    if (!record) throw new Error(`Unable to provision restricted-role User fixture for ${tenantId}`);
    this.fixtures.set(key('User', tenantId), record);
    if (tenantId === this.tenantA) await this.captureMutationEvidence('User');
  }

  private async captureMutationEvidence(table: string): Promise<void> {
    const update = await this.selfUpdate(table, 'A');
    const deletion = await this.deleteFixture(table, 'A');
    const upsert = await this.upsertFixture(table, 'A');
    const bulkUpdate = await this.bulkUpdate(table, 'A');
    const bulkDelete = await this.bulkDelete(table, 'A');
    const tenantReassignmentError = await this.moveToOtherTenant(table);
    this.mutationEvidence.set(table, {
      update,
      delete: deletion,
      upsert,
      bulkUpdate,
      bulkDelete,
      tenantReassignmentError,
    });
  }

  private async preparePublicIngressFixtures(): Promise<void> {
    await this.owner.query(
      `UPDATE "PatientIntakePacket" SET "publicTokenHash" = $1, "tokenExpiresAt" = statement_timestamp() + interval '1 hour', status = 'draft' WHERE id = $2`,
      [createHash('sha256').update(`intake:${this.tenantA}`).digest('hex'), this.fixture('PatientIntakePacket').row.id],
    );
    await this.owner.query(
      `UPDATE "PaymentRequest" SET "publicToken" = $1, "linkExpiresAt" = statement_timestamp() + interval '1 hour' WHERE id = $2`,
      [randomUUID(), this.fixture('PaymentRequest').row.id],
    );
    await this.owner.query(
      `UPDATE "PilotStatusShare" SET "expiresAt" = statement_timestamp() + interval '1 hour' WHERE id = $1`,
      [this.fixture('PilotStatusShare').row.id],
    );
    await this.owner.query(
      `UPDATE "PatientPortalAccount" SET status = 'active' WHERE id = $1`,
      [this.fixture('PatientPortalAccount').row.id],
    );
  }

  private nonConflictingClone(table: string, row: Record<string, unknown>): Record<string, unknown> {
    const clone = { ...row };
    const columns = this.columns.get(table) ?? [];
    const change = new Set([...(this.primaryKeys.get(table) ?? []), ...(this.uniqueColumns.get(table) ?? [])]);
    change.delete(table === 'Tenant' ? 'id' : 'tenantId');
    // A delivery-attempt clone can remain bound to the same event and status;
    // changing its primary key plus attempt number is sufficient to avoid the
    // composite unique key while preserving its FK and status CHECK contract.
    if (table === 'NotificationDeliveryAttempt') {
      change.delete('notificationEventId');
      change.delete('phase');
      change.delete('status');
    }
    for (const name of change) {
      const column = columns.find(item => item.name === name);
      if (!column || clone[name] == null) continue;
      if (column.typeName === 'uuid') clone[name] = randomUUID();
      else if (['smallint', 'integer', 'bigint', 'numeric'].includes(column.typeName)) clone[name] = Number(clone[name]) + 10_000;
      else if (column.typeName.includes('timestamp')) clone[name] = new Date(Date.now() + 86_400_000).toISOString();
      else if (name.toLowerCase().includes('phone')) clone[name] = syntheticE164Phone(`${table}:${name}:${randomUUID()}`);
      else clone[name] = `${String(clone[name]).slice(0, 80)}-${randomUUID().slice(0, 8)}`;
    }
    return clone;
  }

  private async insertExplicitTenant(tenantId: string, label: string): Promise<void> {
    const result = await this.owner.query<{ row: Record<string, unknown> }>(
      `INSERT INTO "Tenant" (id, name, slug, "updatedAt") VALUES ($1, $2, $3, statement_timestamp()) RETURNING to_jsonb("Tenant".*) AS row`,
      [tenantId, `RLS behavior ${label}`, `rls-behavior-${label.toLowerCase()}-${tenantId.slice(0, 8)}`],
    );
    this.storeFixture('Tenant', tenantId, result.rows[0]!.row);
  }

  private async insertExplicitActor(tenantId: string, actorId: string, label: string): Promise<void> {
    const result = await this.owner.query<{ row: Record<string, unknown> }>(
      `INSERT INTO "User" (id, "tenantId", email, "displayName", role, active, "updatedAt")
       VALUES ($1, $2, $3, $4, 'OWNER', true, statement_timestamp()) RETURNING to_jsonb("User".*) AS row`,
      [actorId, tenantId, `rls-actor-${label.toLowerCase()}-${tenantId.slice(0, 8)}@example.test`, `RLS Actor ${label}`],
    );
    this.storeFixture('User', tenantId, result.rows[0]!.row);
  }

  private storeFixture(table: string, tenantId: string, row: Record<string, unknown>): void {
    const columns = this.primaryKeys.get(table);
    if (!columns?.length) throw new Error(`No primary key metadata for ${table}`);
    this.fixtures.set(key(table, tenantId), {
      row,
      primaryKey: Object.fromEntries(columns.map(column => [column, row[column]])),
    });
  }

  private async tryInsertFixture(table: string, tenantId: string): Promise<FixtureRecord | null> {
    const columns = this.columns.get(table) ?? [];
    const values = new Map<string, unknown>([['tenantId', tenantId]]);
    for (const fk of this.foreignKeys.get(table) ?? []) {
      const nonTenantColumns = fk.childColumns.filter(column => column !== 'tenantId');
      if (!nonTenantColumns.length) continue;
      const relationshipRequired = nonTenantColumns.every(name => columns.find(column => column.name === name)?.notNull);
      if (!relationshipRequired) continue;
      const parentProtected = RLS_TABLE_ADAPTERS.some(adapter => adapter.table === fk.parentTable);
      const parentTenant = parentProtected ? tenantId : undefined;
      let parent: FixtureRecord | null | undefined = this.fixtures.get(key(fk.parentTable, parentTenant));
      if (!parent && !parentProtected) parent = await this.ensureGlobalFixture(fk.parentTable);
      if (!parent) return null;
      fk.childColumns.forEach((child, index) => values.set(child, parent!.row[fk.parentColumns[index]!]));
    }
    for (const column of columns) {
      if (column.generated || values.has(column.name) || !column.notNull || column.hasDefault) continue;
      values.set(column.name, syntheticScalar(column, tenantId.slice(0, 8)));
    }
    // Satisfy the append-only attempt state machine without weakening its DB
    // CHECKs merely for synthetic behavioral evidence.
    if (table === 'NotificationDeliveryAttempt') {
      values.set('phase', 'INTENT');
      values.set('status', 'started');
    }
    // Outbound targets require exactly one durable identity. The patient/lead
    // FKs are nullable individually, so the generic required-FK resolver
    // cannot infer this table-level XOR contract.
    if (table === 'ReceptionistCallTarget') {
      const patient = this.fixtures.get(key('Patient', tenantId));
      if (!patient) return null;
      values.set('patientId', patient.row.id);
      values.delete('leadId');
    }
    const record = await this.insertRecord(table, values, tenantId);
    this.restrictedInsertEvidence.add(key(table, tenantId));
    return record;
  }

  private async ensureGlobalFixture(table: string): Promise<FixtureRecord | null> {
    const cached = this.fixtures.get(key(table));
    if (cached) return cached;
    const existing = await this.owner.query<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(t.*) AS row FROM ${quoteIdentifier(table)} t LIMIT 1`,
    );
    if (existing.rows[0]) {
      const row = existing.rows[0].row;
      const columns = this.primaryKeys.get(table) ?? [];
      const fixture = { row, primaryKey: Object.fromEntries(columns.map(column => [column, row[column]])) };
      this.fixtures.set(key(table), fixture);
      return fixture;
    }
    const columns = this.columns.get(table) ?? [];
    const values = new Map<string, unknown>();
    for (const fk of this.foreignKeys.get(table) ?? []) {
      const required = fk.childColumns.every(name => columns.find(column => column.name === name)?.notNull);
      if (!required) continue;
      const parent = await this.ensureGlobalFixture(fk.parentTable);
      if (!parent) return null;
      fk.childColumns.forEach((child, index) => values.set(child, parent.row[fk.parentColumns[index]!]));
    }
    for (const column of columns) {
      if (column.generated || values.has(column.name) || !column.notNull || column.hasDefault) continue;
      values.set(column.name, syntheticScalar(column, randomUUID().slice(0, 8)));
    }
    const fixture = await this.insertRecord(table, values);
    this.fixtures.set(key(table), fixture);
    return fixture;
  }

  private async insertRecord(table: string, values: Map<string, unknown>, tenantId?: string): Promise<FixtureRecord> {
    const names = [...values.keys()];
    const params = [...values.values()];
    const placeholders = names.map((_, index) => `$${index + 1}`);
    try {
      const execute = (client: PoolClient | Pool) => client.query<{ row: Record<string, unknown> }>(
        `INSERT INTO ${quoteIdentifier(table)} (${names.map(quoteIdentifier).join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING to_jsonb(${quoteIdentifier(table)}.*) AS row`,
        params,
      );
      const result = tenantId
        ? await this.runtimeTransaction(tenantId === this.tenantA ? 'A' : 'B', execute, true)
        : await execute(this.owner);
      const row = result.rows[0]!.row;
      const pkColumns = this.primaryKeys.get(table) ?? [];
      return { row, primaryKey: Object.fromEntries(pkColumns.map(column => [column, row[column]])) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Synthetic fixture insert failed for ${table}: ${message}`, { cause: error });
    }
  }

  private primaryKeyWhere(table: string, primaryKey: Record<string, unknown>): { clause: string; values: unknown[] } {
    const columns = this.primaryKeys.get(table) ?? [];
    return {
      clause: columns.map((column, index) => `${quoteIdentifier(column)} = $${index + 1}`).join(' AND '),
      values: columns.map(column => primaryKey[column]),
    };
  }

  private meaningfulMutation(table: string, row: Record<string, unknown>): { column: string; expression: string } | null {
    const excluded = new Set<string>([
      ...(this.primaryKeys.get(table) ?? []),
      ...(this.foreignKeys.get(table) ?? []).flatMap(fk => fk.childColumns),
      table === 'Tenant' ? 'id' : 'tenantId',
    ]);
    const candidates = (this.columns.get(table) ?? []).filter(column =>
      !column.generated && !excluded.has(column.name) && row[column.name] !== null && row[column.name] !== undefined,
    );
    const column = candidates.find(item => item.name === 'updatedAt')
      ?? candidates.find(item => item.typeName.includes('timestamp'))
      ?? candidates.find(item => item.typeName === 'boolean')
      ?? candidates.find(item => item.typeName === 'jsonb')
      ?? candidates.find(item => item.typeName === 'text' || item.typeName.startsWith('character varying'));
    if (!column) return null;
    const quoted = quoteIdentifier(column.name);
    if (column.typeName.includes('timestamp')) return { column: column.name, expression: `${quoted} + interval '1 millisecond'` };
    if (column.typeName === 'boolean') return { column: column.name, expression: `NOT ${quoted}` };
    if (column.typeName === 'jsonb') return { column: column.name, expression: `COALESCE(${quoted}, '{}'::jsonb) || '{"rlsHarness":true}'::jsonb` };
    return { column: column.name, expression: `${quoted} || '-rls'` };
  }

  private async runtimeTransaction<T>(
    context: 'A' | 'B' | 'NONE',
    operation: (client: PoolClient) => Promise<T>,
    commit = false,
  ): Promise<T> {
    const tenantId = context === 'A' ? this.tenantA : context === 'B' ? this.tenantB : undefined;
    const actorId = context === 'A' ? this.actorA : context === 'B' ? this.actorB : undefined;
    return this.customContextTransaction(
      tenantId && actorId ? { tenantId, actorId, actorRole: 'OWNER', source: 'request' } : null,
      operation,
      commit,
    );
  }

  private async customContextTransaction<T>(
    context: { tenantId: string; actorId: string; actorRole: string; source: string } | null,
    operation: (client: PoolClient) => Promise<T>,
    commit = false,
  ): Promise<T> {
    const client = await this.runtime.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_rls');
      if (context) {
        await client.query(
          `SELECT set_config('app.current_tenant_id', $1, true),
                  set_config('app.current_actor_id', $2, true),
                  set_config('app.current_actor_role', $3, true),
                  set_config('app.current_context_source', $4, true)`,
          [context.tenantId, context.actorId, context.actorRole, context.source],
        );
      }
      const role = await client.query<{ role: string }>('SELECT current_user AS role');
      if (role.rows[0]?.role !== 'app_rls') throw new Error(`Expected app_rls, received ${role.rows[0]?.role ?? 'unknown'}`);
      const result = await operation(client);
      if (commit) {
        await client.query('COMMIT');
        committed = true;
      }
      return result;
    } finally {
      if (!committed) await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }
}

export function isRlsDenial(error: unknown): boolean {
  return sqlState(error) === '42501';
}

export function isIsolationDenial(error: unknown): boolean {
  // 42501 is the RLS/privilege boundary. 23503/23514 and P0001 are the
  // tenant-consistent FK/check/trigger boundaries that intentionally run
  // before WITH CHECK for some relationship-heavy tables.
  return ['42501', '23503', '23514', 'P0001'].includes(sqlState(error) ?? '');
}
