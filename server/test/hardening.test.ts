import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Proves resource-exhaustion / large-dataset hardening: oversized request bodies
// are rejected before processing, and list pagination is bounded (rejects an
// out-of-range limit) and walks a large dataset in stable, non-overlapping pages.
vi.mock('../workers/queues', () => ({
  redisConnection: {},
  autopilotQueue: { client: Promise.resolve(undefined), add: async () => undefined },
  enqueueAutopilotExecution: async () => undefined,
  complianceQueue: { add: async () => undefined },
  registerComplianceSchedules: async () => undefined,
  campaignQueue: { add: async () => undefined },
  registerCampaignSchedules: async () => undefined,
}));

const { buildApp } = await import('../app');
const { db } = await import('../lib/db');

let app: FastifyInstance;
const createdTenantIds: string[] = [];

beforeAll(async () => { app = await buildApp(); }, 60_000);

afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('hardening — request body size limit', () => {
  it('rejects an oversized request body (413) before processing', async () => {
    // ~2 MiB payload, over the 1 MiB bodyLimit.
    const huge = JSON.stringify({ blob: 'x'.repeat(2 * 1024 * 1024) });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/revenue-protection/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: huge,
    });
    expect(res.statusCode).toBe(413);
  });
});

describe('hardening — large-dataset pagination is bounded and stable', () => {
  it('rejects an out-of-range limit and walks all pages without overlap', async () => {
    const tenantId = randomUUID();
    await db.tenant.create({ data: { id: tenantId, name: `pg-${tenantId.slice(0, 6)}`, slug: `pg-${tenantId.slice(0, 8)}` } });
    createdTenantIds.push(tenantId);
    const branch = await db.branch.create({ data: { tenantId, name: 'b', location: 'x' } });
    const admin = await db.user.create({ data: { tenantId, role: 'ADMIN', active: true, email: `ad-${tenantId.slice(0, 8)}@pg.test`, displayName: 'Admin' } });
    const TOTAL = 30;
    await db.patient.createMany({
      data: Array.from({ length: TOTAL }, (_, i) => ({ tenantId, branchId: branch.id, firstName: `P${i}`, lastName: 'Test', lifecycleStage: 'NEW' as const })),
    });
    const token = app.jwt.sign({ userId: admin.id, tenantId, type: 'access' });
    const auth = { authorization: `Bearer ${token}` };

    // Out-of-range limit is rejected (schema max is 100) — no unbounded scan.
    const tooBig = await app.inject({ method: 'GET', url: '/v1/patients?limit=99999', headers: auth });
    expect(tooBig.statusCode).toBe(400);

    // Walk every page with a small limit; assert full, non-overlapping coverage.
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const url = `/v1/patients?limit=10${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await app.inject({ method: 'GET', url, headers: auth });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { data: Array<{ id: string }>; nextCursor?: string };
      expect(body.data.length).toBeLessThanOrEqual(10);
      for (const row of body.data) {
        expect(seen.has(row.id)).toBe(false); // no overlap across pages
        seen.add(row.id);
      }
      pages++;
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
      if (pages > 10) throw new Error('pagination did not terminate');
    }
    expect(seen.size).toBe(TOTAL); // every row returned exactly once
  });
});
