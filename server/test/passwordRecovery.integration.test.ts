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
const { generatePasswordHash } = await import('../lib/security');

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
    data: { tenantId, userId, tokenHash: `outstanding-${randomUUID()}`, expiresAt: new Date(Date.now() + 3_600_000) },
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
