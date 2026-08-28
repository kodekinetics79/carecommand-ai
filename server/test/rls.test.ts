import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '../lib/db';
import type { Prisma } from '../generated/prisma/client';

// Proves DB-level tenant isolation (Row-Level Security) on an enrolled table,
// independent of the connecting role: every test transaction drops to the
// non-bypass runtime role `app_rls` and sets the tenant GUC exactly as the app
// does at runtime (set_config('app.current_tenant_id', …, is_local=true)).
//
// This passes both locally (DATABASE_URL = app_rls) and in CI (DATABASE_URL =
// the postgres superuser) because SET LOCAL ROLE app_rls strips any bypass for
// the duration of the transaction. AiGuardrail is one of the RLS-enrolled
// tables; it cascades from Tenant, so teardown is a single tenant delete.

const RLS_TABLE = 'AiGuardrail';

async function asRls<T>(tenantId: string | null, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE app_rls');
    if (tenantId) await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

const tenants: string[] = [];
async function makeTenant(): Promise<string> {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `rls-${id.slice(0, 6)}`, slug: `rls-${id.slice(0, 8)}` } });
  tenants.push(id);
  return id;
}

let tenantA = '';
let tenantB = '';
let ruleA = '';
let ruleB = '';
let idB = '';

beforeAll(async () => {
  tenantA = await makeTenant();
  tenantB = await makeTenant();
  ruleA = `A-${randomUUID()}`;
  ruleB = `B-${randomUUID()}`;
  await asRls(tenantA, tx => tx.aiGuardrail.create({ data: { tenantId: tenantA, rule: ruleA } }));
  const b = await asRls(tenantB, tx => tx.aiGuardrail.create({ data: { tenantId: tenantB, rule: ruleB }, select: { id: true } }));
  idB = b.id;
});

afterAll(async () => {
  for (const id of tenants) await db.tenant.delete({ where: { id } }).catch(() => {});
  await db.$disconnect();
});

describe('RLS — DB-level tenant isolation', () => {
  it('guard: the enrolled table actually has row-level security enabled', async () => {
    const rows = await db.$queryRawUnsafe<Array<{ relrowsecurity: boolean }>>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = '${RLS_TABLE}'`,
    );
    expect(rows[0]?.relrowsecurity).toBe(true);
  });

  it('guard: the runtime role app_rls cannot bypass RLS', async () => {
    const rows = await db.$queryRawUnsafe<Array<{ rolbypassrls: boolean; rolsuper: boolean }>>(
      `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'app_rls'`,
    );
    expect(rows[0]?.rolbypassrls).toBe(false);
    expect(rows[0]?.rolsuper).toBe(false);
  });

  it('tenant A sees only its own rows, never tenant B', async () => {
    const rows = await asRls(tenantA, tx => tx.aiGuardrail.findMany({ select: { rule: true, tenantId: true } }));
    expect(rows.some(r => r.rule === ruleA)).toBe(true);
    expect(rows.some(r => r.rule === ruleB)).toBe(false);
    expect(rows.every(r => r.tenantId === tenantA)).toBe(true);
  });

  it('tenant A cannot read a tenant B row by id', async () => {
    const row = await asRls(tenantA, tx => tx.aiGuardrail.findUnique({ where: { id: idB } }));
    expect(row).toBeNull();
  });

  it('tenant A cannot update a tenant B row (USING denies the row)', async () => {
    const res = await asRls(tenantA, tx => tx.aiGuardrail.updateMany({ where: { id: idB }, data: { rule: 'tampered' } }));
    expect(res.count).toBe(0);
    const b = await asRls(tenantB, tx => tx.aiGuardrail.findUnique({ where: { id: idB }, select: { rule: true } }));
    expect(b?.rule).toBe(ruleB);
  });

  it('tenant A cannot delete a tenant B row', async () => {
    const res = await asRls(tenantA, tx => tx.aiGuardrail.deleteMany({ where: { id: idB } }));
    expect(res.count).toBe(0);
  });

  it('WITH CHECK blocks writing a row stamped for another tenant', async () => {
    await expect(
      asRls(tenantA, tx => tx.aiGuardrail.create({ data: { tenantId: tenantB, rule: 'cross-tenant-write' } })),
    ).rejects.toThrow();
  });

  it('fails closed: with no tenant GUC set, zero rows are visible', async () => {
    const rows = await asRls(null, tx => tx.aiGuardrail.findMany());
    expect(rows.length).toBe(0);
  });
});
