import 'dotenv/config';
// A placeholder provider (square/paypal/clover/authorize_net) is backed by a mock
// implementation. Set it BEFORE app/env import (vitest isolates modules per file)
// so the money routes see a provider whose real integration is NOT wired.
process.env.PAYMENT_PROVIDER = 'square';

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Proves the manual money routes (/payment/request, /payment-link) refuse to issue
// a "real" payment request from a placeholder/unconfigured provider — matching the
// checkout.ts gate — instead of silently returning a mock link presented as real.
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
const createdTenantIds: string[] = [];

async function makeTenant() {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `pg-${id.slice(0, 6)}`, slug: `pg-${id.slice(0, 8)}` } });
  createdTenantIds.push(id);
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'b', location: 'x' } });
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Pat', lastName: 'Roe' } });
  const admin = await db.user.create({ data: { tenantId: id, role: 'ADMIN', active: true, email: `ad-${id.slice(0, 8)}@pg.test`, displayName: 'Admin' } });
  return { id, branchId: branch.id, patientId: patient.id, adminId: admin.id };
}

const auth = (t: { id: string }, userId: string) => ({ authorization: `Bearer ${app.jwt.sign({ userId, tenantId: t.id, type: 'access' })}`, 'content-type': 'application/json' });

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('#4 placeholder payment provider cannot issue a real payment request', () => {
  it('POST /payment/request returns setup_required and persists nothing', async () => {
    const t = await makeTenant();
    const res = await app.inject({
      method: 'POST', url: '/v1/revenue-protection/payment/request', headers: auth(t, t.adminId),
      payload: JSON.stringify({ patientId: t.patientId, amount: 75, reason: 'Copay' }),
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.status).toBe('setup_required');
    expect(json.setupRequired).toBe(true);
    expect(await db.paymentRequest.count({ where: { tenantId: t.id } })).toBe(0);
  });

  it('POST /payment-link returns setup_required and persists nothing', async () => {
    const t = await makeTenant();
    const res = await app.inject({
      method: 'POST', url: '/v1/revenue-protection/payment-link', headers: auth(t, t.adminId),
      payload: JSON.stringify({ patientId: t.patientId, amount: 75, reason: 'Deposit' }),
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.status).toBe('setup_required');
    expect(json.setupRequired).toBe(true);
    expect(await db.paymentRequest.count({ where: { tenantId: t.id } })).toBe(0);
  });
});
