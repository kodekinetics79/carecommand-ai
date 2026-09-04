import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
const { generateTotp } = await import('../lib/totp');

let app: FastifyInstance;
const cleanup: Array<() => Promise<void>> = [];

async function installAuditFault(tenantId: string, action: string) {
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `test_security_audit_fault_fn_${suffix}`;
  const triggerName = `test_security_audit_fault_trg_${suffix}`;
  await db.$executeRawUnsafe(`
    CREATE FUNCTION public."${functionName}"() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW."tenantId" = '${tenantId}'::uuid AND NEW.action = '${action}' THEN
        RAISE EXCEPTION 'injected mandatory security audit failure';
      END IF;
      RETURN NEW;
    END
    $fn$
  `);
  await db.$executeRawUnsafe(`
    CREATE TRIGGER "${triggerName}" BEFORE INSERT ON public."AuditEvent"
    FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()
  `);
  let active = true;
  const remove = async () => {
    if (!active) return;
    active = false;
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."AuditEvent"`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
  };
  cleanup.push(remove);
  return remove;
}

beforeAll(async () => { app = await buildApp(); }, 60_000);

afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
  await app?.close();
  await db.$disconnect();
});

describe('security mutation audit atomicity', () => {
  it('atomically binds login state, reset completion, MFA state, RBAC changes, and session revocation to audit evidence', async () => {
    const tenantId = randomUUID();
    const password = 'Atomic-security-password-2026!';
    const initialHash = await generatePasswordHash(password);
    await db.tenant.create({ data: { id: tenantId, name: 'Security atomicity', slug: `security-atomic-${tenantId.slice(0, 8)}` } });
    const owner = await db.user.create({ data: {
      tenantId,
      email: `owner-${tenantId.slice(0, 8)}@security.test`,
      displayName: 'Security Owner',
      role: 'OWNER',
      passwordHash: initialHash,
      passwordChangedAt: new Date(),
    } });
    const target = await db.user.create({ data: {
      tenantId,
      email: `target-${tenantId.slice(0, 8)}@security.test`,
      displayName: 'Session Target',
      role: 'FRONT_DESK',
      refreshTokenHash: 'a'.repeat(64),
      refreshTokenExpiresAt: new Date(Date.now() + 60_000),
    } });
    cleanup.push(async () => { await db.tenant.delete({ where: { id: tenantId } }); });
    const authorization = `Bearer ${app.jwt.sign({ userId: owner.id, tenantId, role: 'OWNER', type: 'access' })}`;

    // Successful login must not leave a refresh credential/lastLogin without
    // its mandatory success evidence.
    let removeFault = await installAuditFault(tenantId, 'auth.login.success');
    const failedLogin = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: owner.email, password } });
    expect(failedLogin.statusCode).toBe(500);
    expect(await db.user.findUnique({ where: { id: owner.id }, select: { lastLoginAt: true, refreshTokenHash: true } })).toEqual({ lastLoginAt: null, refreshTokenHash: null });
    await removeFault();

    // Rejected login state/evidence commits before the 401 is raised, while an
    // audit-storage fault rolls the counter update back rather than orphaning it.
    removeFault = await installAuditFault(tenantId, 'auth.login.failed');
    expect((await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: owner.email, password: 'wrong-password' } })).statusCode).toBe(500);
    expect((await db.user.findUniqueOrThrow({ where: { id: owner.id } })).failedLoginCount).toBe(0);
    await removeFault();
    expect((await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: owner.email, password: 'wrong-password' } })).statusCode).toBe(401);
    expect((await db.user.findUniqueOrThrow({ where: { id: owner.id } })).failedLoginCount).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId, action: 'auth.login.failed', actorUserId: owner.id } })).toBe(1);

    // Reset completion is all-or-nothing across password, token consumption,
    // session revocation and evidence.
    const resetRequest = await app.inject({ method: 'POST', url: '/v1/auth/password-reset/request', payload: { email: owner.email } });
    const resetToken = resetRequest.json().devToken as string;
    expect(resetToken).toBeTruthy();
    removeFault = await installAuditFault(tenantId, 'auth.password.reset.completed');
    expect((await app.inject({ method: 'POST', url: '/v1/auth/password-reset/confirm', payload: { token: resetToken, newPassword: 'Replacement-password-2026!' } })).statusCode).toBe(500);
    expect((await db.user.findUniqueOrThrow({ where: { id: owner.id } })).passwordHash).toBe(initialHash);
    expect((await db.passwordResetToken.findFirstOrThrow({ where: { userId: owner.id }, orderBy: { createdAt: 'desc' } })).usedAt).toBeNull();
    await removeFault();

    // MFA setup, enable and disable each roll back when evidence cannot append.
    removeFault = await installAuditFault(tenantId, 'auth.mfa.setup');
    expect((await app.inject({ method: 'POST', url: '/v1/auth/mfa/setup', headers: { authorization } })).statusCode).toBe(500);
    expect((await db.user.findUniqueOrThrow({ where: { id: owner.id } })).mfaSecretEnc).toBeNull();
    await removeFault();
    const setup = await app.inject({ method: 'POST', url: '/v1/auth/mfa/setup', headers: { authorization } });
    const secret = setup.json().secret as string;
    expect(secret).toBeTruthy();
    removeFault = await installAuditFault(tenantId, 'auth.mfa.enabled');
    expect((await app.inject({ method: 'POST', url: '/v1/auth/mfa/verify', headers: { authorization }, payload: { code: generateTotp(secret) } })).statusCode).toBe(500);
    expect((await db.user.findUniqueOrThrow({ where: { id: owner.id } })).mfaEnabled).toBe(false);
    await removeFault();
    expect((await app.inject({ method: 'POST', url: '/v1/auth/mfa/verify', headers: { authorization }, payload: { code: generateTotp(secret) } })).statusCode).toBe(200);
    removeFault = await installAuditFault(tenantId, 'auth.mfa.disabled');
    expect((await app.inject({ method: 'POST', url: '/v1/auth/mfa/disable', headers: { authorization }, payload: { password } })).statusCode).toBe(500);
    expect((await db.user.findUniqueOrThrow({ where: { id: owner.id } })).mfaEnabled).toBe(true);
    await removeFault();

    // RoleDefinition now only overrides the nine assignable built-in roles.
    // Use the supported Analyst override here so this test still reaches the
    // transaction/audit boundary instead of being rejected at name validation.
    removeFault = await installAuditFault(tenantId, 'role.created');
    expect((await app.inject({ method: 'POST', url: '/v1/settings/roles', headers: { authorization }, payload: { name: 'Analyst', description: 'Must roll back', permissions: [] } })).statusCode).toBe(500);
    expect(await db.roleDefinition.count({ where: { tenantId, name: 'Analyst' } })).toBe(0);
    await removeFault();
    const roleCreated = await app.inject({ method: 'POST', url: '/v1/settings/roles', headers: { authorization }, payload: { name: 'Analyst', description: 'Original description', permissions: [] } });
    expect(roleCreated.statusCode).toBe(201);
    const roleId = roleCreated.json().id as string;

    removeFault = await installAuditFault(tenantId, 'role.updated');
    expect((await app.inject({ method: 'PATCH', url: `/v1/settings/roles/${roleId}`, headers: { authorization }, payload: { description: 'Must roll back' } })).statusCode).toBe(500);
    expect((await db.roleDefinition.findUniqueOrThrow({ where: { id: roleId } })).description).toBe('Original description');
    await removeFault();

    removeFault = await installAuditFault(tenantId, 'role.deleted');
    expect((await app.inject({ method: 'DELETE', url: `/v1/settings/roles/${roleId}`, headers: { authorization } })).statusCode).toBe(500);
    expect(await db.roleDefinition.count({ where: { id: roleId } })).toBe(1);
    await removeFault();

    removeFault = await installAuditFault(tenantId, 'auth.session.revoked');
    expect((await app.inject({ method: 'POST', url: `/v1/security/sessions/${target.id}/revoke`, headers: { authorization } })).statusCode).toBe(500);
    expect((await db.user.findUniqueOrThrow({ where: { id: target.id } })).refreshTokenHash).toBe('a'.repeat(64));
    await removeFault();
  }, 60_000);
});
