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
const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { recomputeEntitlements } = await import('../lib/entitlements');
const { issuePortalSession } = await import('../lib/portalAuth');

let app: FastifyInstance;
const createdTenantIds: string[] = [];

async function makeTenant() {
  const tenantId = randomUUID();
  await db.tenant.create({ data: { id: tenantId, name: `pi-${tenantId.slice(0, 6)}`, slug: `pi-${tenantId.slice(0, 8)}` } });
  createdTenantIds.push(tenantId);
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(tenantId, db);

  const branch = await db.branch.create({ data: { tenantId, name: 'Main', location: 'City', timezone: 'UTC' } });
  const patient = await db.patient.create({ data: { tenantId, branchId: branch.id, firstName: 'Insurance', lastName: 'Pilot', lifecycleStage: 'ACTIVE' } });
  const account = await db.patientPortalAccount.create({ data: { tenantId, patientId: patient.id, status: 'active', email: `ins-${tenantId.slice(0, 8)}@pilot.test` } });
  const portalToken = await issuePortalSession(app, account, db);
  return { tenantId, branchId: branch.id, patientId: patient.id, portalToken };
}

const hdr = (tenant: { portalToken: string }) => ({ authorization: `Bearer ${tenant.portalToken}` });

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const tenantId of createdTenantIds) await db.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('portal insurance flow handles overlapping coverage safely', () => {
  it('updates existing policy on matching memberId and creates a new coverage order for a different member', async () => {
    const t = await makeTenant();

    const primary = await db.patientInsurancePolicy.create({
      data: {
        tenantId: t.tenantId,
        branchId: t.branchId,
        patientId: t.patientId,
        planName: 'Aetna PPO',
        memberId: 'MEM-OLD-001',
        coverageOrder: 1,
        verificationStatus: 'verified',
        active: true,
      },
    });

    const dedup = await app.inject({
      method: 'POST',
      url: '/v1/portal/insurance',
      headers: hdr(t),
      payload: { planName: 'Aetna PPO', memberId: primary.memberId, groupNumber: 'G-01', subscriberName: 'Existing Member' },
    });
    expect(dedup.statusCode).toBe(200);
    expect(dedup.json()).toMatchObject({ id: primary.id, deduped: true });

    const createSecondary = await app.inject({
      method: 'POST',
      url: '/v1/portal/insurance',
      headers: hdr(t),
      payload: { planName: 'Blue Shield HMO', memberId: 'MEM-NEW-999', groupNumber: 'G-02', subscriberName: 'New Member' },
    });
    expect(createSecondary.statusCode).toBe(201);
    expect(createSecondary.json()).toMatchObject({ deduped: false });

    const created = await db.patientInsurancePolicy.findUnique({
      where: { id: createSecondary.json().id },
      select: { coverageOrder: true },
    });
    expect(created?.coverageOrder).toBe(2);
    const totalActive = await db.patientInsurancePolicy.count({ where: { tenantId: t.tenantId, patientId: t.patientId, active: true } });
    expect(totalActive).toBe(2);
  });

  it('returns a client-safe conflict when every coverage order is occupied', async () => {
    const t = await makeTenant();

    await Promise.all(Array.from({ length: 9 }, (_, i) =>
      db.patientInsurancePolicy.create({
        data: {
          tenantId: t.tenantId,
          branchId: t.branchId,
          patientId: t.patientId,
          planName: `Payer ${i + 1}`,
          memberId: `MEM-${i + 1}`,
          coverageOrder: i + 1,
          effectiveFrom: new Date(),
          verificationStatus: 'pending',
          active: true,
        },
      }),
    ));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/portal/insurance',
      headers: hdr(t),
      payload: { planName: 'Aetna PPO', memberId: 'MEM-OVERFLOW', groupNumber: 'G-9X', subscriberName: 'Overflow' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('insurance_policy_conflict');
  });
});

