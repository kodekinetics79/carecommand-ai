import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
const { runWithTenantContext } = await import('../lib/tenantContext');

let app: FastifyInstance;
const tenantIds: string[] = [];

async function makeTenant() {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `revenue-auth-${id.slice(0, 6)}`, slug: `revenue-auth-${id.slice(0, 8)}` } });
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id, db);
  const [branchA, branchB] = await Promise.all([
    db.branch.create({ data: { tenantId: id, name: 'Allowed branch', location: 'A' } }),
    db.branch.create({ data: { tenantId: id, name: 'Restricted branch', location: 'B' } }),
  ]);
  const [provider, billing] = await Promise.all([
    db.user.create({ data: { tenantId: id, role: 'PROVIDER', active: true, email: `provider-${id.slice(0, 8)}@revenue.test`, displayName: 'Provider' } }),
    db.user.create({ data: { tenantId: id, branchId: branchA.id, role: 'BILLING', active: true, email: `billing-${id.slice(0, 8)}@revenue.test`, displayName: 'Billing' } }),
  ]);
  const [paymentA, paymentB] = await Promise.all([
    db.paymentRequest.create({ data: { tenantId: id, branchId: branchA.id, amount: 25, currency: 'USD', status: 'pending', reason: 'Allowed', mode: 'mock', paymentUrl: 'https://pay.example.test/allowed' } }),
    db.paymentRequest.create({ data: { tenantId: id, branchId: branchB.id, amount: 75, currency: 'USD', status: 'pending', reason: 'Restricted', mode: 'mock', paymentUrl: 'https://pay.example.test/restricted' } }),
  ]);
  return { id, branchA, branchB, provider, billing, paymentA, paymentB };
}

function headers(tenantId: string, userId: string) {
  return { authorization: `Bearer ${app.jwt.sign({ tenantId, userId, role: 'OWNER', type: 'access' })}` };
}

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const tenantId of tenantIds) await db.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('revenue-protection authorization and access accounting', () => {
  it('denies a role without billing:read, then honors a tenant permission override and audits the read', async () => {
    const t = await makeTenant();
    const denied = await app.inject({ method: 'GET', url: '/v1/revenue-protection/overview', headers: headers(t.id, t.provider.id) });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: 'insufficient_permission', permission: 'billing:read' });

    await db.roleDefinition.create({
      data: { tenantId: t.id, name: 'Provider', description: 'Scoped billing reader', permissions: ['billing:read'] },
    });
    const allowed = await app.inject({ method: 'GET', url: '/v1/revenue-protection/overview', headers: headers(t.id, t.provider.id) });
    expect(allowed.statusCode).toBe(200);

    const event = await db.auditEvent.findFirst({
      where: { tenantId: t.id, actorUserId: t.provider.id, action: 'revenueProtection.overview.read' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(event).not.toBeNull();
    expect(JSON.stringify(event?.metadata ?? {})).not.toContain('pay.example.test');
  });

  it('limits branch-bound payment lists and rejects an explicit cross-branch query', async () => {
    const t = await makeTenant();
    const scoped = await app.inject({ method: 'GET', url: '/v1/revenue-protection/payments', headers: headers(t.id, t.billing.id) });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json().paymentRequests.map((row: { id: string }) => row.id)).toEqual([t.paymentA.id]);
    expect(JSON.stringify(scoped.json())).not.toContain(t.paymentB.paymentUrl!);
    const paymentReadAudit = await db.auditEvent.findFirst({
      where: { tenantId: t.id, actorUserId: t.billing.id, action: 'payment.list' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(paymentReadAudit).not.toBeNull();
    expect(JSON.stringify(paymentReadAudit?.metadata ?? {})).not.toContain('pay.example.test');

    const denied = await app.inject({ method: 'GET', url: `/v1/revenue-protection/payments?branchId=${t.branchB.id}`, headers: headers(t.id, t.billing.id) });
    expect(denied.statusCode).toBe(403);
  });

  it('allows BILLING mutations with billing:write but denies a cross-branch UUID object', async () => {
    const t = await makeTenant();
    const allowed = await app.inject({
      method: 'PATCH',
      url: `/v1/revenue-protection/payment/${t.paymentA.id}/status`,
      headers: { ...headers(t.id, t.billing.id), 'content-type': 'application/json' },
      payload: { status: 'cancelled' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().status).toBe('cancelled');

    const denied = await app.inject({
      method: 'PATCH',
      url: `/v1/revenue-protection/payment/${t.paymentB.id}/status`,
      headers: { ...headers(t.id, t.billing.id), 'content-type': 'application/json' },
      payload: { status: 'cancelled' },
    });
    expect(denied.statusCode).toBe(403);
    expect((await db.paymentRequest.findUnique({ where: { id: t.paymentB.id } }))?.status).toBe('pending');

    const foreignPatient = await db.patient.create({
      data: { tenantId: t.id, branchId: t.branchB.id, firstName: 'Other', lastName: 'Branch' },
    });
    const patientDenied = await app.inject({
      method: 'POST',
      url: '/v1/revenue-protection/payment/request',
      headers: { ...headers(t.id, t.billing.id), 'content-type': 'application/json' },
      payload: { patientId: foreignPatient.id, amount: 10, reason: 'Cross branch attempt' },
    });
    expect(patientDenied.statusCode).toBe(403);

    const localPatient = await db.patient.create({
      data: { tenantId: t.id, branchId: t.branchA.id, firstName: 'Allowed', lastName: 'Patient' },
    });
    const foreignRule = await runWithTenantContext(t.id, tx => tx.depositRule.create({
      data: {
        tenantId: t.id,
        branchId: t.branchB.id,
        name: 'Other branch rule',
        ruleType: 'fixed',
        description: 'Restricted to another branch',
        depositRequired: true,
        amountType: 'fixed',
        amountValue: 10,
      },
    }), { id: t.billing.id, role: 'BILLING' });
    const ruleDenied = await app.inject({
      method: 'POST',
      url: '/v1/revenue-protection/payment/request',
      headers: { ...headers(t.id, t.billing.id), 'content-type': 'application/json' },
      payload: { patientId: localPatient.id, depositRuleId: foreignRule.id, amount: 10, reason: 'Cross branch rule' },
    });
    expect(ruleDenied.statusCode).toBe(403);
  });
});
