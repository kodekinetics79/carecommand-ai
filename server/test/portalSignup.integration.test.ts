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
const tenants: string[] = [];

async function makeClinic() {
  const id = randomUUID();
  const slug = `sgn-${id.slice(0, 8)}`;
  await db.tenant.create({ data: { id, name: 'Signup Clinic', slug, status: 'active' } });
  tenants.push(id);
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'b', location: 'x' } });
  const email = `match-${id.slice(0, 8)}@patient.test`;
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Maya', lastName: 'Singh', email, lifecycleStage: 'NEW' } });
  const admin = await db.user.create({ data: { tenantId: id, role: 'FRONT_DESK', active: true, email: `fd-${id.slice(0, 8)}@clinic.test`, displayName: 'Front Desk' } });
  return { id, slug, patientId: patient.id, patientEmail: email, adminId: admin.id };
}
const staff = (tenantId: string, userId: string) => ({ authorization: `Bearer ${app.jwt.sign({ userId, tenantId, type: 'access' })}`, 'x-forwarded-for': '203.0.113.20' });
const json = (r: { body: string }) => JSON.parse(r.body);

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of tenants) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('patient portal self-signup (mobile, Option A)', () => {
  it('matches a patient by email → invites + OTP → verify issues a portal session', async () => {
    const c = await makeClinic();
    const signup = await app.inject({ method: 'POST', url: '/v1/portal/auth/signup', payload: { clinicSlug: c.slug, email: c.patientEmail } });
    expect(signup.statusCode).toBe(200);
    const sBody = json(signup);
    expect(sBody.devToken).toBeTruthy(); // dev-only OTP

    // An invited account now exists, bound to the real patient.
    const acct = await db.patientPortalAccount.findFirst({ where: { tenantId: c.id, patientId: c.patientId } });
    expect(acct?.status).toBe('invited');

    const verify = await app.inject({ method: 'POST', url: '/v1/portal/auth/verify', payload: { token: sBody.devToken } });
    expect(verify.statusCode).toBe(200);
    const vBody = json(verify);
    expect(vBody.token).toBeTruthy();
    expect(vBody.displayName).toBe('Maya');
    const after = await db.patientPortalAccount.findFirst({ where: { tenantId: c.id, patientId: c.patientId } });
    expect(after?.status).toBe('active'); // first sign-in activates
  });

  it('queues a staff review when no patient matches (never auto-grants access)', async () => {
    const c = await makeClinic();
    const res = await app.inject({ method: 'POST', url: '/v1/portal/auth/signup', payload: { clinicSlug: c.slug, email: 'stranger@nobody.test' } });
    expect(res.statusCode).toBe(200);
    expect(json(res).devToken).toBeUndefined(); // no account, no OTP

    const accounts = await db.patientPortalAccount.count({ where: { tenantId: c.id } });
    expect(accounts).toBe(0);

    // Staff sees the pending request and can approve it against a real patient.
    const queue = json(await app.inject({ method: 'GET', url: '/v1/portal-admin/access-requests', headers: staff(c.id, c.adminId) }));
    expect(queue.length).toBe(1);
    const approve = await app.inject({ method: 'POST', url: `/v1/portal-admin/access-requests/${queue[0].id}/approve`, headers: staff(c.id, c.adminId), payload: { patientId: c.patientId } });
    expect(approve.statusCode).toBe(200);
    expect(json(approve).devToken).toBeTruthy();
    expect(await db.patientPortalAccount.count({ where: { tenantId: c.id } })).toBe(1);
  });

  it('is anti-enumeration: identical message whether or not the email matched', async () => {
    const c = await makeClinic();
    const hit = json(await app.inject({ method: 'POST', url: '/v1/portal/auth/signup', payload: { clinicSlug: c.slug, email: c.patientEmail } }));
    const miss = json(await app.inject({ method: 'POST', url: '/v1/portal/auth/signup', payload: { clinicSlug: c.slug, email: 'nope@x.test' } }));
    expect(hit.message).toBe(miss.message);
  });

  it('rejects signup for an unknown clinic with the same generic message', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/portal/auth/signup', payload: { clinicSlug: 'no-such-clinic', email: 'a@b.test' } });
    expect(res.statusCode).toBe(200);
    expect(json(res).status).toBe('ok');
  });
});
