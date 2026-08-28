import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/client';
import { db } from '../lib/db';
import { runWithTenantContext } from '../lib/tenantContext';

const ownerDb = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL }),
});

const tenantA = randomUUID();
const tenantB = randomUUID();
const actorA = randomUUID();
const actorB = randomUUID();
const ruleA = `pool-a-${randomUUID()}`;
const ruleB = `pool-b-${randomUUID()}`;

beforeAll(async () => {
  await ownerDb.tenant.createMany({ data: [
    { id: tenantA, name: 'RLS pool tenant A', slug: `rls-pool-a-${tenantA.slice(0, 8)}` },
    { id: tenantB, name: 'RLS pool tenant B', slug: `rls-pool-b-${tenantB.slice(0, 8)}` },
  ] });
  await ownerDb.aiGuardrail.createMany({ data: [
    { tenantId: tenantA, rule: ruleA },
    { tenantId: tenantB, rule: ruleB },
  ] });
  await ownerDb.user.createMany({ data: [
    { id: actorA, tenantId: tenantA, email: `${actorA}@rls.test`, displayName: 'RLS actor A', role: 'OWNER' },
    { id: actorB, tenantId: tenantB, email: `${actorB}@rls.test`, displayName: 'RLS actor B', role: 'OWNER' },
  ] });
});

afterAll(async () => {
  await ownerDb.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } }).catch(() => {});
  await Promise.all([ownerDb.$disconnect(), db.$disconnect()]);
});

async function visibleRules(tenantId: string): Promise<string[]> {
  return runWithTenantContext(tenantId, tx => tx.aiGuardrail.findMany({
    orderBy: { rule: 'asc' },
    select: { rule: true },
  }), { id: tenantId === tenantA ? actorA : actorB, role: 'OWNER' }).then(rows => rows.map(row => row.rule));
}

describe('RLS pooled-connection isolation', () => {
  it('does not bleed row visibility while alternating tenants across pooled transactions', async () => {
    for (let iteration = 0; iteration < 12; iteration += 1) {
      const tenantId = iteration % 2 === 0 ? tenantA : tenantB;
      const ownRule = tenantId === tenantA ? ruleA : ruleB;
      const foreignRule = tenantId === tenantA ? ruleB : ruleA;
      const rules = await visibleRules(tenantId);
      expect(rules).toContain(ownRule);
      expect(rules).not.toContain(foreignRule);
    }
  });

  it('does not bleed row visibility between concurrent tenant transactions', async () => {
    const [a, b] = await Promise.all([visibleRules(tenantA), visibleRules(tenantB)]);
    expect(a).toContain(ruleA);
    expect(a).not.toContain(ruleB);
    expect(b).toContain(ruleB);
    expect(b).not.toContain(ruleA);
  });

  it('clears transaction-local security GUCs before the connection returns to the pool', async () => {
    await visibleRules(tenantA);
    const rows = await db.$queryRaw<Array<{ tenant: string | null; actor: string | null; source: string | null }>>`
      SELECT NULLIF(current_setting('app.current_tenant_id', true), '') AS tenant,
             NULLIF(current_setting('app.current_actor_id', true), '') AS actor,
             NULLIF(current_setting('app.current_context_source', true), '') AS source
    `;
    expect(rows[0]).toEqual({ tenant: null, actor: null, source: null });
  });
});
