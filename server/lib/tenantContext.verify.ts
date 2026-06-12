/**
 * Phase A verification for tenant-context plumbing. Run with:
 *   npx tsx server/lib/tenantContext.verify.ts
 *
 * Requires a reachable Postgres (the dev DATABASE_URL). It does NOT enable RLS
 * and does not depend on any seeded rows — it only exercises the GUC + ALS
 * behaviour. Exits non-zero on the first failed assertion.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import {
  runWithTenantContext,
  runWithJobTenantContext,
  runWithWebhookTenantContext,
  getCurrentTenantId,
  requireTenantId,
  readTenantGuc,
} from './tenantContext';
import { db } from './db';

let failures = 0;
function check(label: string, condition: boolean) {
  console.log(`${condition ? '✓' : '✗'} ${label}`);
  if (!condition) failures += 1;
}

async function expectThrow(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(`${label} (expected throw)`, false);
  } catch {
    check(label, true);
  }
}

async function main() {
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  // 1) Context is set ONLY inside the transaction (GUC visible + ALS visible).
  await runWithTenantContext(tenantA, async tx => {
    const guc = await readTenantGuc(tx);
    check('GUC is set to tenantA inside the transaction', guc === tenantA);
    check('ALS reports tenantA inside the transaction', getCurrentTenantId() === tenantA);
  });

  // 2) Context is NOT available after the transaction returns (no ALS leak).
  check('ALS is empty after the transaction', getCurrentTenantId() === undefined);

  // And the GUC does not survive onto a fresh pooled checkout (is_local=true).
  const leaked = await db.$queryRaw<Array<{ tenant: string | null }>>`SELECT current_setting('app.current_tenant_id', true) AS tenant`;
  check('GUC does not leak to a new connection/checkout', !leaked[0]?.tenant);

  // 3) Concurrent tenant contexts do not leak into each other. Each transaction
  //    sets its GUC, waits (interleaving the two), then re-reads its own GUC.
  const [resA, resB] = await Promise.all([
    runWithTenantContext(tenantA, async tx => {
      await tx.$executeRaw`SELECT pg_sleep(0.2)`;
      return { guc: await readTenantGuc(tx), als: getCurrentTenantId() };
    }),
    runWithJobTenantContext(tenantB, async tx => {
      await tx.$executeRaw`SELECT pg_sleep(0.2)`;
      return { guc: await readTenantGuc(tx), als: getCurrentTenantId() };
    }),
  ]);
  check('concurrent A keeps its own GUC', resA.guc === tenantA);
  check('concurrent A keeps its own ALS', resA.als === tenantA);
  check('concurrent B keeps its own GUC', resB.guc === tenantB);
  check('concurrent B keeps its own ALS', resB.als === tenantB);
  check('A and B never observed the same tenant', resA.guc !== resB.guc);

  // 4) Missing/invalid tenant context fails closed.
  await expectThrow('runWithTenantContext("") fails closed', () => runWithTenantContext('', async () => null));
  await expectThrow('runWithTenantContext("not-a-uuid") fails closed', () => runWithTenantContext('not-a-uuid', async () => null));
  await expectThrow('runWithJobTenantContext(undefined) fails closed', () => runWithJobTenantContext(undefined as unknown as string, async () => null));
  await expectThrow('requireTenantId() throws outside a context', async () => requireTenantId());

  // Webhook helper is the same primitive once a tenant has been resolved.
  await runWithWebhookTenantContext(tenantA, async tx => {
    check('webhook context sets the GUC', (await readTenantGuc(tx)) === tenantA);
  });

  await db.$disconnect();
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
