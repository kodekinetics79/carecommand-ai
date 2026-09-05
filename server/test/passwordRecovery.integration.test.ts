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
const { generatePasswordHash, hashResetToken } = await import('../lib/security');
const { env } = await import('../config/env');
const { __setProviderSnapshotForTests } = await import('../lib/providerCredentials');

let app: FastifyInstance;
const createdTenantIds: string[] = [];

const ADMIN_PASSWORD = 'Recovery-Owner-Pw-2026!';
const STAFF_PASSWORD = 'Recovery-Staff-Pw-2026!';
const REPLACEMENT_PASSWORD = 'Recovery-Replacement-2026!';

async function makeTenantWithUsers() {
  const tenantId = randomUUID();
  const tag = tenantId.slice(0, 8);
  await db.tenant.create({ data: { id: tenantId, name: `Recovery ${tag}`, slug: `recovery-${tag}` } });
  createdTenantIds.push(tenantId);
  await db.branch.create({ data: { tenantId, name: 'Recovery test clinic', location: 'Synthetic' } });
  const admin = await db.user.create({
    data: {
      tenantId,
      email: `owner-${tag}@recovery.test`,
      displayName: 'Recovery Owner',
      role: 'OWNER',
      passwordHash: await generatePasswordHash(ADMIN_PASSWORD),
      passwordChangedAt: new Date(),
    },
  });
  const staff = await db.user.create({
    data: {
      tenantId,
      email: `staff-${tag}@recovery.test`,
      displayName: 'Recovery Staff',
      role: 'FRONT_DESK',
      passwordHash: await generatePasswordHash(STAFF_PASSWORD),
      passwordChangedAt: new Date(),
    },
  });
  return { tenantId, admin, staff };
}

function login(email: string, password: string) {
  return app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });
}

async function accessToken(email: string, password: string) {
  const response = await login(email, password);
  expect(response.statusCode).toBe(200);
  return `Bearer ${response.json().accessToken as string}`;
}

function resetPassword(authorization: string, userId: string, password: string) {
  return app.inject({
    method: 'POST',
    url: `/v1/control-plane/users/${userId}/password-reset`,
    headers: { authorization },
    payload: { password },
  });
}

function outstandingResetToken(tenantId: string, userId: string) {
  return db.passwordResetToken.create({
    data: { tenantId, userId, tokenHash: `outstanding-${randomUUID()}`, activatedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) },
  });
}

beforeAll(async () => {
  app = await buildApp();
}, 60_000);

afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('administrator-initiated password recovery', () => {
  it('restores access for a locked-out user without exposing the new password anywhere', async () => {
    const { tenantId, admin, staff } = await makeTenantWithUsers();
    await db.user.update({ where: { id: staff.id }, data: { lockedUntil: new Date(Date.now() + 3_600_000), failedLoginCount: 4 } });
    await outstandingResetToken(tenantId, staff.id);
    expect((await login(staff.email, STAFF_PASSWORD)).statusCode).toBe(401);

    const authorization = await accessToken(admin.email, ADMIN_PASSWORD);
    const reset = await resetPassword(authorization, staff.id, REPLACEMENT_PASSWORD);
    expect(reset.statusCode).toBe(200);
    expect(reset.body).not.toContain(REPLACEMENT_PASSWORD);

    expect((await login(staff.email, REPLACEMENT_PASSWORD)).statusCode).toBe(200);
    expect((await login(staff.email, STAFF_PASSWORD)).statusCode).toBe(401);

    const stored = await db.user.findUniqueOrThrow({ where: { id: staff.id } });
    expect(stored.lockedUntil).toBeNull();
    expect(stored.passwordChangedAt?.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(await db.passwordResetToken.count({ where: { userId: staff.id, usedAt: null } })).toBe(0);
    expect(await db.auditEvent.count({ where: { tenantId, action: 'controlPlane.user.passwordReset', resourceId: staff.id } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId, action: 'controlPlane.session.revoked', resource: 'session', resourceId: staff.id } })).toBe(1);

    const listing = await app.inject({ method: 'GET', url: '/v1/control-plane/users', headers: { authorization } });
    expect(listing.statusCode).toBe(200);
    expect(listing.body).not.toContain(REPLACEMENT_PASSWORD);
    expect(listing.body).not.toContain('passwordHash');
  });

  it('invalidates the target’s issued access token and refresh token', async () => {
    const { admin, staff } = await makeTenantWithUsers();
    const staffAuthorization = await accessToken(staff.email, STAFF_PASSWORD);
    expect((await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: staffAuthorization } })).statusCode).toBe(200);

    const reset = await resetPassword(await accessToken(admin.email, ADMIN_PASSWORD), staff.id, REPLACEMENT_PASSWORD);
    expect(reset.statusCode).toBe(200);

    expect((await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: staffAuthorization } })).statusCode).toBe(401);
    const stored = await db.user.findUniqueOrThrow({ where: { id: staff.id } });
    expect(stored.refreshTokenHash).toBeNull();
    expect(stored.refreshTokenExpiresAt).toBeNull();
  });

  it('never resets a user in another tenant', async () => {
    const home = await makeTenantWithUsers();
    const other = await makeTenantWithUsers();
    const authorization = await accessToken(home.admin.email, ADMIN_PASSWORD);

    const reset = await resetPassword(authorization, other.staff.id, REPLACEMENT_PASSWORD);
    expect(reset.statusCode).toBe(404);
    expect((await login(other.staff.email, STAFF_PASSWORD)).statusCode).toBe(200);
    expect((await login(other.staff.email, REPLACEMENT_PASSWORD)).statusCode).toBe(401);
    expect(await db.auditEvent.count({ where: { action: 'controlPlane.user.passwordReset', resourceId: other.staff.id } })).toBe(0);
  });

  it('refuses a role that does not administer users', async () => {
    const { staff, admin } = await makeTenantWithUsers();
    const reset = await resetPassword(await accessToken(staff.email, STAFF_PASSWORD), admin.id, REPLACEMENT_PASSWORD);
    expect(reset.statusCode).toBe(403);
    expect((await login(admin.email, ADMIN_PASSWORD)).statusCode).toBe(200);
  });

  it('refuses the caller’s own account and records the block', async () => {
    const { tenantId, admin } = await makeTenantWithUsers();
    const reset = await resetPassword(await accessToken(admin.email, ADMIN_PASSWORD), admin.id, REPLACEMENT_PASSWORD);
    expect(reset.statusCode).toBe(409);
    expect((await login(admin.email, ADMIN_PASSWORD)).statusCode).toBe(200);
    expect(await db.auditEvent.count({ where: { tenantId, action: 'admin.user.passwordResetBlocked', resourceId: admin.id } })).toBe(1);
  });

  it('rejects a password below the configured policy', async () => {
    const { admin, staff } = await makeTenantWithUsers();
    const reset = await resetPassword(await accessToken(admin.email, ADMIN_PASSWORD), staff.id, 'short');
    expect(reset.statusCode).toBe(400);
    expect((await login(staff.email, STAFF_PASSWORD)).statusCode).toBe(200);
  });
});

describe('self-service password change', () => {
  function changePassword(authorization: string | undefined, currentPassword: string, newPassword: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/auth/password-change',
      headers: authorization ? { authorization } : {},
      payload: { currentPassword, newPassword },
    });
  }

  it('replaces the password, ends the session, and consumes outstanding reset tokens', async () => {
    const { tenantId, staff } = await makeTenantWithUsers();
    await outstandingResetToken(tenantId, staff.id);
    const authorization = await accessToken(staff.email, STAFF_PASSWORD);

    const changed = await changePassword(authorization, STAFF_PASSWORD, REPLACEMENT_PASSWORD);
    expect(changed.statusCode).toBe(200);

    expect((await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization } })).statusCode).toBe(401);
    expect((await login(staff.email, REPLACEMENT_PASSWORD)).statusCode).toBe(200);
    expect((await login(staff.email, STAFF_PASSWORD)).statusCode).toBe(401);
    expect(await db.passwordResetToken.count({ where: { userId: staff.id, usedAt: null } })).toBe(0);
    expect(await db.auditEvent.count({ where: { tenantId, action: 'auth.password.changed', resourceId: staff.id } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId, action: 'auth.session.revoked', resourceId: staff.id } })).toBe(1);
  });

  it('refuses a wrong current password, records the attempt, and changes nothing', async () => {
    const { tenantId, staff } = await makeTenantWithUsers();
    const authorization = await accessToken(staff.email, STAFF_PASSWORD);

    const refused = await changePassword(authorization, 'Not-The-Current-Password-2026!', REPLACEMENT_PASSWORD);
    expect(refused.statusCode).toBe(400);
    expect((await login(staff.email, STAFF_PASSWORD)).statusCode).toBe(200);
    expect((await login(staff.email, REPLACEMENT_PASSWORD)).statusCode).toBe(401);
    expect(await db.auditEvent.count({ where: { tenantId, action: 'auth.password.change.failed', resourceId: staff.id } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId, action: 'auth.password.changed', resourceId: staff.id } })).toBe(0);
  });

  it('rejects a replacement below the configured policy and an unauthenticated caller', async () => {
    const { staff } = await makeTenantWithUsers();
    const authorization = await accessToken(staff.email, STAFF_PASSWORD);

    expect((await changePassword(authorization, STAFF_PASSWORD, 'short')).statusCode).toBe(400);
    expect((await changePassword(undefined, STAFF_PASSWORD, REPLACEMENT_PASSWORD)).statusCode).toBe(401);
    expect((await login(staff.email, STAFF_PASSWORD)).statusCode).toBe(200);
  });
});

describe('tenant forgot-password recovery', () => {
  it('uses the workspace selector to disambiguate one email across tenants', async () => {
    const first = await makeTenantWithUsers();
    const second = await makeTenantWithUsers();
    await db.user.update({ where: { id: second.staff.id }, data: { email: first.staff.email } });

    const ambiguous = await app.inject({ method: 'POST', url: '/v1/auth/password-reset/request', payload: { email: first.staff.email } });
    expect(ambiguous.statusCode).toBe(200);
    expect(ambiguous.json().devToken).toBeUndefined();

    const scoped = await app.inject({ method: 'POST', url: '/v1/auth/password-reset/request', payload: { email: first.staff.email, tenantSlug: second.tenantId ? `recovery-${second.tenantId.slice(0, 8)}` : '' } });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json().devToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await db.passwordResetToken.count({ where: { userId: first.staff.id } })).toBe(0);
    expect(await db.passwordResetToken.count({ where: { userId: second.staff.id, activatedAt: { not: null }, usedAt: null } })).toBe(1);
  });

  it('serializes concurrent requests so at most one usable credential is issued', async () => {
    const { tenantId, staff } = await makeTenantWithUsers();
    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/auth/password-reset/request', payload: { email: staff.email } }),
      app.inject({ method: 'POST', url: '/v1/auth/password-reset/request', payload: { email: staff.email } }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect([first.json().devToken, second.json().devToken].filter(Boolean)).toHaveLength(1);
    expect(await db.passwordResetToken.count({ where: { tenantId, userId: staff.id, activatedAt: { not: null }, usedAt: null } })).toBe(1);
  });

  it('does not revive a reset link after deactivation and reactivation', async () => {
    const { admin, staff } = await makeTenantWithUsers();
    const requested = await app.inject({ method: 'POST', url: '/v1/auth/password-reset/request', payload: { email: staff.email } });
    const token = requested.json().devToken as string;
    expect(token).toBeTruthy();
    const authorization = await accessToken(admin.email, ADMIN_PASSWORD);

    expect((await app.inject({ method: 'PATCH', url: `/v1/control-plane/users/${staff.id}/status`, headers: { authorization }, payload: { active: false } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: `/v1/control-plane/users/${staff.id}/status`, headers: { authorization }, payload: { active: true } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/password-reset/confirm', payload: { token, newPassword: REPLACEMENT_PASSWORD } })).statusCode).toBe(400);
  });

  it('activates only a provider-accepted production link and keeps the public response generic', async () => {
    const { staff } = await makeTenantWithUsers();
    const originalEnv = { NODE_ENV: env.NODE_ENV, PUBLIC_APP_URL: env.PUBLIC_APP_URL };
    let deliveredToken = '';
    try {
      Object.assign(env, { NODE_ENV: 'production', PUBLIC_APP_URL: 'https://carecommand.example.com' });
      __setProviderSnapshotForTests({
        email: { provider: 'generic', apiUrl: 'https://mail.example.test/send', apiKey: 'test-key', fromAddress: 'security@carecommand.example.com' },
      });
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => {
        const payload = JSON.parse(String(init?.body)) as { text: string };
        deliveredToken = /#reset=([A-Za-z0-9_-]{43})/.exec(payload.text)?.[1] ?? '';
        return new Response(JSON.stringify({ id: 'provider-message-1' }), { status: 202, headers: { 'content-type': 'application/json' } });
      }));

      const known = await app.inject({ method: 'POST', url: '/v1/auth/password-reset/request', payload: { email: staff.email } });
      const unknown = await app.inject({ method: 'POST', url: '/v1/auth/password-reset/request', payload: { email: `unknown-${randomUUID()}@recovery.test` } });
      expect(known.statusCode).toBe(200);
      expect(known.json()).toEqual(unknown.json());
      expect(known.body).not.toContain('devToken');
      expect(known.body).not.toContain(deliveredToken);
      expect(deliveredToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((await app.inject({ method: 'POST', url: '/v1/auth/password-reset/confirm', payload: { token: deliveredToken, newPassword: REPLACEMENT_PASSWORD } })).statusCode).toBe(200);
    } finally {
      Object.assign(env, originalEnv);
      __setProviderSnapshotForTests({});
      vi.unstubAllGlobals();
    }
  }, 15_000);

  it('keeps an older delivered link usable when replacement delivery fails', async () => {
    const { tenantId, staff } = await makeTenantWithUsers();
    const oldRawToken = 'z'.repeat(43);
    await db.passwordResetToken.create({ data: {
      tenantId, userId: staff.id, tokenHash: hashResetToken(oldRawToken), activatedAt: new Date(Date.now() - 300_000),
      createdAt: new Date(Date.now() - 300_000), expiresAt: new Date(Date.now() + 600_000),
    } });
    const originalEnv = { NODE_ENV: env.NODE_ENV, PUBLIC_APP_URL: env.PUBLIC_APP_URL };
    try {
      Object.assign(env, { NODE_ENV: 'production', PUBLIC_APP_URL: 'https://carecommand.example.com' });
      __setProviderSnapshotForTests({
        email: { provider: 'generic', apiUrl: 'https://mail.example.test/send', apiKey: 'test-key', fromAddress: 'security@carecommand.example.com' },
      });
      vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ message: 'synthetic outage' }), { status: 503, headers: { 'content-type': 'application/json' } })));

      const response = await app.inject({ method: 'POST', url: '/v1/auth/password-reset/request', payload: { email: staff.email } });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('devToken');
      expect(await db.passwordResetToken.count({ where: { userId: staff.id, activatedAt: null } })).toBe(0);
      expect((await app.inject({ method: 'POST', url: '/v1/auth/password-reset/confirm', payload: { token: oldRawToken, newPassword: REPLACEMENT_PASSWORD } })).statusCode).toBe(200);
    } finally {
      Object.assign(env, originalEnv);
      __setProviderSnapshotForTests({});
      vi.unstubAllGlobals();
    }
  }, 10_000);
});
