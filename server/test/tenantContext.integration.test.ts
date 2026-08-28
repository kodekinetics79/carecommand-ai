import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../lib/db';
import { fixtureDb } from './helpers/fixtureDb';
import {
  getCurrentTenantId,
  getTenantContext,
  readTenantGuc,
  requireTenantId,
  runWithJobTenantContext,
  runWithTenantContext,
  runWithWebhookTenantContext,
} from '../lib/tenantContext';

const requestTenant = randomUUID();
const workerTenant = randomUUID();
const requestActor = randomUUID();

beforeAll(async () => {
  await fixtureDb.tenant.createMany({ data: [
    { id: requestTenant, name: 'Context request tenant', slug: `ctx-request-${requestTenant.slice(0, 8)}` },
    { id: workerTenant, name: 'Context worker tenant', slug: `ctx-worker-${workerTenant.slice(0, 8)}` },
  ] });
  await fixtureDb.user.create({
    data: { id: requestActor, tenantId: requestTenant, email: `${requestActor}@context.test`, displayName: 'Context actor', role: 'OWNER' },
  });
});

afterAll(async () => {
  await fixtureDb.tenant.deleteMany({ where: { id: { in: [requestTenant, workerTenant] } } }).catch(() => {});
  await Promise.all([db.$disconnect(), fixtureDb.$disconnect()]);
});

describe('tenant context runtime foundation', () => {
  it('binds a verified request actor and tenant GUC to the same transaction', async () => {
    const observed = await runWithTenantContext(requestTenant, async tx => ({
      context: getTenantContext(),
      requiredTenantId: requireTenantId(),
      guc: await readTenantGuc(tx),
    }), { id: requestActor, role: 'OWNER' });

    expect(observed.context).toMatchObject({ tenantId: requestTenant, actorId: requestActor, actorRole: 'OWNER', source: 'request' });
    expect(observed.requiredTenantId).toBe(requestTenant);
    expect(observed.guc).toBe(requestTenant);
    expect(getTenantContext()).toBeUndefined();
    expect(getCurrentTenantId()).toBeUndefined();
  });

  it.each([
    ['worker', runWithJobTenantContext],
    ['webhook', runWithWebhookTenantContext],
  ] as const)('binds the %s source and tenant GUC to the same transaction', async (source, run) => {
    const observed = await run(workerTenant, async tx => ({ context: getTenantContext(), guc: await readTenantGuc(tx) }));
    expect(observed.context).toMatchObject({ tenantId: workerTenant, source });
    expect(observed.guc).toBe(workerTenant);
  });

  it('does not leak ALS or the transaction-local GUC after success or rollback', async () => {
    await runWithTenantContext(requestTenant, async tx => {
      expect(await readTenantGuc(tx)).toBe(requestTenant);
    }, { id: requestActor, role: 'OWNER' });
    expect(getTenantContext()).toBeUndefined();

    await expect(runWithJobTenantContext(workerTenant, async tx => {
      expect(await readTenantGuc(tx)).toBe(workerTenant);
      throw new Error('force rollback');
    })).rejects.toThrow('force rollback');
    expect(getTenantContext()).toBeUndefined();

    const rows = await db.$queryRaw<Array<{ tenant: string | null }>>`
      SELECT current_setting('app.current_tenant_id', true) AS tenant
    `;
    expect(rows[0]?.tenant || null).toBeNull();
  });

  it('keeps concurrent request and worker contexts isolated', async () => {
    const [requestObserved, workerObserved] = await Promise.all([
      runWithTenantContext(requestTenant, async tx => {
        await tx.$executeRaw`SELECT pg_sleep(0.05)`;
        return { context: getTenantContext(), guc: await readTenantGuc(tx) };
      }, { id: requestActor, role: 'OWNER' }),
      runWithJobTenantContext(workerTenant, async tx => {
        await tx.$executeRaw`SELECT pg_sleep(0.05)`;
        return { context: getTenantContext(), guc: await readTenantGuc(tx) };
      }),
    ]);

    expect(requestObserved.context).toMatchObject({ tenantId: requestTenant, actorId: requestActor, source: 'request' });
    expect(requestObserved.guc).toBe(requestTenant);
    expect(workerObserved.context).toMatchObject({ tenantId: workerTenant, source: 'worker' });
    expect(workerObserved.guc).toBe(workerTenant);
    expect(getTenantContext()).toBeUndefined();
  });

  it('fails before opening database work for missing or malformed tenant ids', async () => {
    let invoked = false;
    await expect(runWithTenantContext('', async () => { invoked = true; }, { id: requestActor, role: 'OWNER' })).rejects.toThrow('valid tenantId');
    await expect(runWithWebhookTenantContext('not-a-uuid', async () => { invoked = true; })).rejects.toThrow('valid tenantId');
    expect(invoked).toBe(false);
    expect(() => requireTenantId()).toThrow('no active tenant context');
  });
});
