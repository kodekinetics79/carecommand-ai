import 'dotenv/config';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

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
const { recomputeEntitlements } = await import('../lib/entitlements');

let app: FastifyInstance;
const tenantIds: string[] = [];

async function makeTenant() {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `rcp-${id.slice(0, 6)}`, slug: `rcp-${id.slice(0, 8)}` } });
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id);
  const user = await db.user.create({ data: { tenantId: id, role: 'OWNER', active: true, email: `owner-${id.slice(0, 8)}@rcp.test`, displayName: 'Owner' } });
  const clinic = await db.receptionistClinic.create({ data: { tenantId: id, name: 'Main clinic', phone: '+1 555 000 0000' } });
  return { id, userId: user.id, clinicId: clinic.id };
}

function auth(t: { id: string }, userId: string) {
  return { authorization: `Bearer ${app.jwt.sign({ userId, tenantId: t.id, role: 'OWNER', type: 'access' })}` };
}

beforeAll(async () => {
  app = await buildApp();
}, 60_000);

afterAll(async () => {
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('AI receptionist outbound targets', () => {
  it('adds, lists, and deletes outbound call targets for a campaign', async () => {
    const tenant = await makeTenant();
    const headers = auth(tenant, tenant.userId);

    const campaignRes = await app.inject({
      method: 'POST',
      url: '/v1/receptionist/outbound-campaigns',
      headers,
      payload: {
        clinicId: tenant.clinicId,
        name: 'Pilot cleanup queue',
        script: 'Call the patient.',
        requiredFields: ['firstName', 'lastName', 'phone'],
      },
    });
    expect(campaignRes.statusCode).toBe(201);
    const campaign = campaignRes.json() as { id: string };

    const addRes = await app.inject({
      method: 'POST',
      url: `/v1/receptionist/outbound-campaigns/${campaign.id}/targets`,
      headers,
      payload: {
        targets: [{ phone: '+1 555 101 0101', firstName: 'Test', lastName: 'Target' }],
      },
    });
    expect(addRes.statusCode).toBe(201);
    expect(addRes.json()).toEqual({ added: 1 });

    const listed = await db.receptionistCallTarget.findMany({ where: { tenantId: tenant.id, campaignId: campaign.id } });
    expect(listed).toHaveLength(1);

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/v1/receptionist/outbound-campaigns/${campaign.id}/targets/${listed[0].id}`,
      headers,
    });
    expect(delRes.statusCode).toBe(204);
    expect(await db.receptionistCallTarget.count({ where: { tenantId: tenant.id, campaignId: campaign.id } })).toBe(0);
  });
});
