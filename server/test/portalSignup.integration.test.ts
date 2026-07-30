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
const { db: appDb } = await import('../lib/db');
const { env } = await import('../config/env');
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
  await recomputeEntitlements(id, db);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'b', location: 'x' } });
  const email = `match-${id.slice(0, 8)}@patient.test`;
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Maya', lastName: 'Singh', email, dateOfBirth: new Date('1990-01-01T00:00:00.000Z'), lifecycleStage: 'NEW' } });
  const admin = await db.user.create({ data: { tenantId: id, role: 'OWNER', active: true, email: `owner-${id.slice(0, 8)}@clinic.test`, displayName: 'Owner' } });
  return { id, slug, branchId: branch.id, patientId: patient.id, patientEmail: email, adminId: admin.id };
}
const staff = (tenantId: string, userId: string, role = 'OWNER') => ({ authorization: `Bearer ${app.jwt.sign({ userId, tenantId, role, type: 'access' })}`, 'x-forwarded-for': '203.0.113.20' });
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
    expect(vBody.expiresInMinutes).toBe(30);
    const after = await db.patientPortalAccount.findFirst({ where: { tenantId: c.id, patientId: c.patientId } });
    expect(after?.status).toBe('active'); // first sign-in activates

    const auth = { authorization: `Bearer ${vBody.token}` };
    expect((await app.inject({ method: 'GET', url: '/v1/portal/auth/me', headers: auth })).statusCode).toBe(200);
    const session = await db.patientPortalToken.findFirst({ where: { tenantId: c.id, accountId: acct!.id, type: 'session' } });
    expect(session?.usedAt).toBeNull();
    const logout = await app.inject({ method: 'POST', url: '/v1/portal/auth/logout', headers: auth });
    expect(logout.statusCode).toBe(200);
    expect((await db.patientPortalToken.findUnique({ where: { id: session!.id } }))?.usedAt).not.toBeNull();
    expect(await db.auditEvent.count({ where: { tenantId: c.id, action: 'portal.logout', resourceId: acct!.id } })).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/v1/portal/auth/me', headers: auth })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/portal/auth/logout', headers: auth })).statusCode).toBe(401);
  });

  it('magic token is strictly single-use under concurrency: two parallel verifies yield exactly one session', async () => {
    const c = await makeClinic();
    const signup = await app.inject({ method: 'POST', url: '/v1/portal/auth/signup', payload: { clinicSlug: c.slug, email: c.patientEmail } });
    const devToken = json(signup).devToken;
    expect(devToken).toBeTruthy();

    // Fire both verifies in the same tick — before the fix, both passed the
    // usedAt read and both got sessions. The atomic conditional consume lets
    // exactly one win.
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/portal/auth/verify', payload: { token: devToken } }),
      app.inject({ method: 'POST', url: '/v1/portal/auth/verify', payload: { token: devToken } }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 401]);
    const winner = a.statusCode === 200 ? a : b;
    const loser = a.statusCode === 200 ? b : a;
    expect(json(winner).token).toBeTruthy();
    expect(json(loser).error).toBe('token_used');

    // The token row was consumed exactly once and a third attempt also fails.
    const third = await app.inject({ method: 'POST', url: '/v1/portal/auth/verify', payload: { token: devToken } });
    expect(third.statusCode).toBe(401);
    // Already-consumed credentials are no longer exposed by the public
    // resolver and are indistinguishable from unknown credentials.
    expect(json(third).error).toBe('invalid_token');
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
    const approve = await app.inject({ method: 'POST', url: `/v1/portal-admin/access-requests/${queue[0].id}/approve`, headers: staff(c.id, c.adminId), payload: { patientId: c.patientId, authority: 'self', authorityConfirmed: true } });
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

  it('queues a uniquely matched minor for guardian-authority review and never mints a credential', async () => {
    const c = await makeClinic();
    const minorEmail = `minor-${c.id.slice(0, 8)}@patient.test`;
    const minor = await db.patient.create({ data: { tenantId: c.id, branchId: c.branchId, firstName: 'Minor', lastName: 'Patient', email: minorEmail, dateOfBirth: new Date('2015-01-01T00:00:00.000Z'), lifecycleStage: 'NEW' } });

    const signup = await app.inject({ method: 'POST', url: '/v1/portal/auth/signup', payload: { clinicSlug: c.slug, email: minorEmail } });
    expect(signup.statusCode).toBe(200);
    expect(json(signup).devToken).toBeUndefined();
    expect(await db.patientPortalAccount.count({ where: { tenantId: c.id, patientId: minor.id } })).toBe(0);
    const queued = await db.portalAccessRequest.findFirst({ where: { tenantId: c.id, email: minorEmail, status: 'pending' } });
    expect(queued?.matchCount).toBe(1);

    const unverified = await app.inject({ method: 'POST', url: `/v1/portal-admin/access-requests/${queued!.id}/approve`, headers: staff(c.id, c.adminId), payload: { patientId: minor.id, authority: 'self', authorityConfirmed: true } });
    expect(unverified.statusCode).toBe(409);
    expect(json(unverified)).toMatchObject({ error: 'proxy_access_not_supported', requestStatus: 'pending' });
    expect(await db.patientPortalToken.count({ where: { tenantId: c.id } })).toBe(0);

    const reviewed = await app.inject({ method: 'POST', url: `/v1/portal-admin/access-requests/${queued!.id}/approve`, headers: staff(c.id, c.adminId), payload: { patientId: minor.id, authority: 'guardian', authorityConfirmed: true } });
    expect(reviewed.statusCode).toBe(409);
    expect(json(reviewed)).toMatchObject({ error: 'proxy_access_not_supported', requestStatus: 'pending' });
    expect(await db.patientPortalAccount.count({ where: { tenantId: c.id, patientId: minor.id } })).toBe(0);
    expect(await db.patientPortalToken.count({ where: { tenantId: c.id } })).toBe(0);
    expect((await db.portalAccessRequest.findUnique({ where: { id: queued!.id } }))?.status).toBe('pending');
    expect(await db.auditEvent.count({ where: { tenantId: c.id, action: 'portal.access_request.proxy_blocked', resourceId: queued!.id } })).toBe(2);
  });

  it('fails token delivery closed: no usable or pending credential survives a sink failure', async () => {
    const c = await makeClinic();
    const priorOutbox = env.PORTAL_TOKEN_OUTBOX_PATH;
    Object.assign(env, { PORTAL_TOKEN_OUTBOX_PATH: `/missing-${randomUUID()}/portal-outbox.jsonl` });
    try {
      const signup = await app.inject({ method: 'POST', url: '/v1/portal/auth/signup', payload: { clinicSlug: c.slug, email: c.patientEmail } });
      expect(signup.statusCode).toBe(200); // anti-enumeration response remains generic
      expect(json(signup).devToken).toBeUndefined();
      const account = await db.patientPortalAccount.findFirst({ where: { tenantId: c.id, patientId: c.patientId } });
      expect(account?.status).toBe('invited');
      expect(await db.patientPortalToken.count({ where: { tenantId: c.id, accountId: account!.id } })).toBe(0);
      expect(await db.auditEvent.findFirst({ where: { tenantId: c.id, action: 'portal.signup.delivery_failed', resourceId: account!.id } })).not.toBeNull();
    } finally {
      Object.assign(env, { PORTAL_TOKEN_OUTBOX_PATH: priorOutbox });
    }
  });

  it('rolls token consumption and account activation back when the critical success audit fails', async () => {
    const c = await makeClinic();
    const signup = await app.inject({ method: 'POST', url: '/v1/portal/auth/signup', payload: { clinicSlug: c.slug, email: c.patientEmail } });
    const devToken = json(signup).devToken as string;
    const originalTransaction = appDb.$transaction.bind(appDb);
    const transactionSpy = vi.spyOn(appDb, '$transaction').mockImplementation((async (callback: (tx: unknown) => unknown, options?: unknown) =>
      originalTransaction(async realTx => {
        const auditDelegate = new Proxy(realTx.auditEvent, {
          get(target, property, receiver) {
            if (property === 'create') return async (args: { data?: { action?: string } }) => {
              if (args.data?.action === 'portal.login.success') throw new Error('injected portal audit fault');
              return target.create(args as never);
            };
            return Reflect.get(target, property, receiver);
          },
        });
        const txProxy = new Proxy(realTx, {
          get(target, property, receiver) {
            if (property === 'auditEvent') return auditDelegate;
            return Reflect.get(target, property, receiver);
          },
        });
        return callback(txProxy);
      }, options as never)) as typeof appDb.$transaction);
    try {
      const failed = await app.inject({ method: 'POST', url: '/v1/portal/auth/verify', payload: { token: devToken } });
      expect(failed.statusCode).toBe(500);
    } finally {
      transactionSpy.mockRestore();
    }

    const account = await db.patientPortalAccount.findFirst({ where: { tenantId: c.id, patientId: c.patientId } });
    const tokenRow = await db.patientPortalToken.findFirst({ where: { accountId: account!.id } });
    expect(account?.status).toBe('invited');
    expect(tokenRow?.usedAt).toBeNull();
    const retry = await app.inject({ method: 'POST', url: '/v1/portal/auth/verify', payload: { token: devToken } });
    expect(retry.statusCode).toBe(200);
  });

  it('restricts portal review to tenant-wide OWNER/ADMIN identities and prevents cross-tenant approval', async () => {
    const c1 = await makeClinic();
    const c2 = await makeClinic();
    await app.inject({ method: 'POST', url: '/v1/portal/auth/signup', payload: { clinicSlug: c2.slug, email: 'review-c2@nobody.test' } });
    const request = await db.portalAccessRequest.findFirstOrThrow({ where: { tenantId: c2.id, email: 'review-c2@nobody.test' } });

    const frontDesk = await db.user.create({ data: { tenantId: c1.id, role: 'FRONT_DESK', branchId: c1.branchId, active: true, email: `fd-${c1.id.slice(0, 8)}@test.example`, displayName: 'Front Desk' } });
    const branchAdmin = await db.user.create({ data: { tenantId: c1.id, role: 'ADMIN', branchId: c1.branchId, active: true, email: `admin-${c1.id.slice(0, 8)}@test.example`, displayName: 'Branch Admin' } });
    expect((await app.inject({ method: 'GET', url: '/v1/portal-admin/access-requests', headers: staff(c1.id, frontDesk.id, 'FRONT_DESK') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/portal-admin/access-requests', headers: staff(c1.id, branchAdmin.id, 'ADMIN') })).statusCode).toBe(403);

    const crossTenant = await app.inject({ method: 'POST', url: `/v1/portal-admin/access-requests/${request.id}/approve`, headers: staff(c1.id, c1.adminId), payload: { patientId: c1.patientId, authority: 'self', authorityConfirmed: true } });
    expect(crossTenant.statusCode).toBe(404);
    expect((await db.portalAccessRequest.findUnique({ where: { id: request.id } }))?.status).toBe('pending');
  });
});
