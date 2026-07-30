import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const retryQueue = vi.hoisted(() => ({ failed: [] as Array<{ id: string; retry: () => Promise<void> }> }));

vi.mock('../workers/queues', () => ({
  redisConnection: {},
  autopilotQueue: {
    client: Promise.resolve(undefined),
    add: async () => undefined,
    getFailed: async () => [...retryQueue.failed],
    getFailedCount: async () => retryQueue.failed.length,
  },
  enqueueAutopilotExecution: async () => undefined,
  complianceQueue: { add: async () => undefined },
  registerComplianceSchedules: async () => undefined,
  campaignQueue: { add: async () => undefined },
  registerCampaignSchedules: async () => undefined,
}));

const { buildApp } = await import('../app');
const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { ensurePlatformOwnerSeed, hashV, signPlatformToken } = await import('../lib/platformAuth');
const { encryptSecret, generatePasswordHash } = await import('../lib/security');
const { generateTotp, generateTotpSecret } = await import('../lib/totp');
const { env } = await import('../config/env');

let app: FastifyInstance;
const cleanup: Array<() => Promise<void>> = [];

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn().catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('platform privileged audit durability', () => {
  it('rolls back a tenant mutation when its mandatory platform audit fails, then succeeds on retry', async () => {
    const tenantId = randomUUID();
    const actorId = randomUUID();
    await db.tenant.create({ data: { id: tenantId, name: 'Before audit fault', slug: `audit-${tenantId.slice(0, 8)}` } });
    await db.platformUser.create({
      data: {
        id: actorId,
        email: `audit-${actorId.slice(0, 8)}@carecommand.test`,
        name: 'Audit Test Operator',
        passwordHash: await generatePasswordHash('Audit-test-password-2026!'),
        role: 'PLATFORM_ADMIN',
        status: 'active',
      },
    });
    cleanup.push(async () => { await db.platformAuditEvent.deleteMany({ where: { tenantId } }); });
    cleanup.push(async () => { await db.tenant.delete({ where: { id: tenantId } }); });
    cleanup.push(async () => { await db.platformUser.delete({ where: { id: actorId } }); });

    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `test_platform_audit_fail_fn_${suffix}`;
    const triggerName = `test_platform_audit_fail_trg_${suffix}`;
    await db.$executeRawUnsafe(`
      CREATE FUNCTION public."${functionName}"() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.action = 'tenant.updated' AND NEW."targetId" = '${tenantId}'::uuid::text THEN
          RAISE EXCEPTION 'injected mandatory platform audit failure';
        END IF;
        RETURN NEW;
      END
      $fn$
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT ON public."PlatformAuditEvent"
      FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()
    `);
    const removeFault = async () => {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."PlatformAuditEvent"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
    };
    cleanup.push(removeFault);

    const headers = { authorization: `Bearer ${signPlatformToken(app, { id: actorId, role: 'PLATFORM_ADMIN' })}` };
    const failed = await app.inject({ method: 'PATCH', url: `/v1/platform/tenants/${tenantId}`, headers, payload: { name: 'Must roll back' } });
    expect(failed.statusCode).toBe(500);
    expect((await db.tenant.findUniqueOrThrow({ where: { id: tenantId } })).name).toBe('Before audit fault');
    expect(await db.platformAuditEvent.count({ where: { tenantId, action: 'tenant.updated' } })).toBe(0);

    await removeFault();
    cleanup.pop();
    const retry = await app.inject({ method: 'PATCH', url: `/v1/platform/tenants/${tenantId}`, headers, payload: { name: 'After durable retry' } });
    expect(retry.statusCode).toBe(200);
    expect((await db.tenant.findUniqueOrThrow({ where: { id: tenantId } })).name).toBe('After durable retry');
    expect(await db.platformAuditEvent.count({ where: { tenantId, action: 'tenant.updated', platformUserId: actorId } })).toBe(1);
  });

  it('rolls back a failed-login counter update when its mandatory audit fails', async () => {
    const actorId = randomUUID();
    const email = `login-audit-${actorId.slice(0, 8)}@carecommand.test`;
    await db.platformUser.create({
      data: {
        id: actorId,
        email,
        name: 'Login Audit Test Operator',
        passwordHash: await generatePasswordHash('Correct-login-password-2026!'),
        role: 'PLATFORM_ADMIN',
        status: 'active',
      },
    });
    cleanup.push(async () => {
      await db.platformAuditEvent.deleteMany({ where: { platformUserId: actorId } });
      await db.platformUser.delete({ where: { id: actorId } });
    });

    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `test_platform_login_audit_fail_fn_${suffix}`;
    const triggerName = `test_platform_login_audit_fail_trg_${suffix}`;
    await db.$executeRawUnsafe(`
      CREATE FUNCTION public."${functionName}"() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.action = 'platform.login.failed' AND NEW."targetId" = '${actorId}'::uuid::text THEN
          RAISE EXCEPTION 'injected mandatory platform login audit failure';
        END IF;
        RETURN NEW;
      END
      $fn$
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT ON public."PlatformAuditEvent"
      FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()
    `);
    const removeFault = async () => {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."PlatformAuditEvent"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
    };
    cleanup.push(removeFault);

    const request = {
      method: 'POST' as const,
      url: '/v1/platform/auth/login',
      headers: { 'x-forwarded-for': '203.0.113.121', 'user-agent': `platform-login-rollback-${suffix}` },
      payload: { email, password: 'Incorrect-login-password-2026!' },
    };
    const failed = await app.inject(request);
    expect(failed.statusCode).toBe(500);
    expect((await db.platformUser.findUniqueOrThrow({ where: { id: actorId } })).failedLoginCount).toBe(0);
    expect(await db.platformAuditEvent.count({ where: { platformUserId: actorId, action: 'platform.login.failed' } })).toBe(0);

    await removeFault();
    cleanup.pop();
    const retry = await app.inject(request);
    expect(retry.statusCode).toBe(401);
    expect((await db.platformUser.findUniqueOrThrow({ where: { id: actorId } })).failedLoginCount).toBe(1);
    const event = await db.platformAuditEvent.findFirstOrThrow({
      where: { platformUserId: actorId, action: 'platform.login.failed', targetId: actorId },
    });
    expect(event).toMatchObject({
      ipHash: hashV('203.0.113.121'),
      userAgentHash: hashV(`platform-login-rollback-${suffix}`),
      metadata: { reason: 'bad_password', locked: false },
    });
  });

  it('does not mark an MFA login successful unless state reset and success audit commit together', async () => {
    const actorId = randomUUID();
    const suffix = randomUUID().replaceAll('-', '');
    const email = `mfa-success-audit-${suffix}@carecommand.test`;
    const secret = generateTotpSecret();
    const expiredLock = new Date(Date.now() - 60_000);
    await db.platformUser.create({
      data: {
        id: actorId,
        email,
        name: 'MFA Success Audit Test Operator',
        passwordHash: await generatePasswordHash('Correct-MFA-audit-password-2026!'),
        role: 'PLATFORM_ADMIN',
        status: 'active',
        mfaEnabled: true,
        mfaSecretEnc: encryptSecret(secret),
        failedLoginCount: 3,
        lockedUntil: expiredLock,
      },
    });
    cleanup.push(async () => {
      await db.platformAuditEvent.deleteMany({ where: { platformUserId: actorId } });
      await db.platformUser.delete({ where: { id: actorId } });
    });

    const functionName = `test_platform_mfa_success_audit_fail_fn_${suffix}`;
    const triggerName = `test_platform_mfa_success_audit_fail_trg_${suffix}`;
    await db.$executeRawUnsafe(`
      CREATE FUNCTION public."${functionName}"() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.action = 'platform.login.success' AND NEW."targetId" = '${actorId}'::uuid::text THEN
          RAISE EXCEPTION 'injected mandatory platform MFA success audit failure';
        END IF;
        RETURN NEW;
      END
      $fn$
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT ON public."PlatformAuditEvent"
      FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()
    `);
    const removeFault = async () => {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."PlatformAuditEvent"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
    };
    cleanup.push(removeFault);

    const passwordResponse = await app.inject({
      method: 'POST',
      url: '/v1/platform/auth/login',
      headers: { 'x-forwarded-for': '203.0.113.131', 'user-agent': `platform-mfa-password-rollback-${suffix}` },
      payload: { email, password: 'Correct-MFA-audit-password-2026!' },
    });
    expect(passwordResponse.statusCode).toBe(200);
    const mfaToken = passwordResponse.json().mfaToken as string;
    const afterPassword = await db.platformUser.findUniqueOrThrow({ where: { id: actorId } });
    expect(afterPassword.failedLoginCount).toBe(3);
    expect(afterPassword.lockedUntil?.toISOString()).toBe(expiredLock.toISOString());
    expect(afterPassword.lastLoginAt).toBeNull();

    const request = {
      method: 'POST' as const,
      url: '/v1/platform/auth/mfa/verify',
      headers: { authorization: `Bearer ${mfaToken}`, 'x-forwarded-for': '203.0.113.132', 'user-agent': `platform-mfa-success-rollback-${suffix}` },
      payload: { code: generateTotp(secret) },
    };
    const failed = await app.inject(request);
    expect(failed.statusCode).toBe(500);
    const afterAuditFailure = await db.platformUser.findUniqueOrThrow({ where: { id: actorId } });
    expect(afterAuditFailure.failedLoginCount).toBe(3);
    expect(afterAuditFailure.lockedUntil?.toISOString()).toBe(expiredLock.toISOString());
    expect(afterAuditFailure.lastLoginAt).toBeNull();
    expect(await db.platformAuditEvent.count({ where: { platformUserId: actorId, action: 'platform.login.success' } })).toBe(0);

    await removeFault();
    cleanup.pop();
    const retry = await app.inject(request);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().user.lastLoginAt).toEqual(expect.any(String));
    const afterSuccess = await db.platformUser.findUniqueOrThrow({ where: { id: actorId } });
    expect(afterSuccess.failedLoginCount).toBe(0);
    expect(afterSuccess.lockedUntil).toBeNull();
    expect(afterSuccess.lastLoginAt).not.toBeNull();
    const event = await db.platformAuditEvent.findFirstOrThrow({
      where: { platformUserId: actorId, action: 'platform.login.success', targetId: actorId },
    });
    expect(event).toMatchObject({
      ipHash: hashV('203.0.113.132'),
      userAgentHash: hashV(`platform-mfa-success-rollback-${suffix}`),
      metadata: { mfa: true },
    });
  });

  it('serializes concurrent demotions so one active PLATFORM_OWNER always remains', async () => {
    const preexisting = await db.platformUser.findMany({ where: { role: 'PLATFORM_OWNER', status: 'active' }, select: { id: true } });
    await db.platformUser.updateMany({ where: { id: { in: preexisting.map(owner => owner.id) } }, data: { status: 'disabled' } });
    cleanup.push(async () => { await db.platformUser.updateMany({ where: { id: { in: preexisting.map(owner => owner.id) } }, data: { status: 'active' } }); });
    const ownerIds = [randomUUID(), randomUUID()];
    for (const [index, id] of ownerIds.entries()) {
      await db.platformUser.create({
        data: {
          id,
          email: `concurrent-owner-${index}-${id.slice(0, 8)}@carecommand.test`,
          name: `Concurrent Owner ${index}`,
          passwordHash: await generatePasswordHash(`Concurrent-owner-password-${index}-2026!`),
          role: 'PLATFORM_OWNER',
          status: 'active',
        },
      });
    }
    cleanup.push(async () => {
      await db.platformAuditEvent.deleteMany({ where: { targetId: { in: ownerIds } } });
      await db.platformUser.deleteMany({ where: { id: { in: ownerIds } } });
    });

    const requests = ownerIds.map((id, index) => app.inject({
      method: 'PATCH',
      url: `/v1/platform/users/${id}`,
      headers: { authorization: `Bearer ${signPlatformToken(app, { id, role: 'PLATFORM_OWNER' })}`, 'x-forwarded-for': `203.0.113.${141 + index}` },
      payload: { status: 'disabled' },
    }));
    const responses = await Promise.all(requests);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
    expect(await db.platformUser.count({ where: { id: { in: ownerIds }, role: 'PLATFORM_OWNER', status: 'active' } })).toBe(1);
    expect(await db.platformAuditEvent.count({ where: { targetId: { in: ownerIds }, action: 'platform.user.disabled' } })).toBe(1);
  });

  it('atomically claims a pending subscription request under opposing concurrent decisions', async () => {
    const plans = await db.subscriptionPlan.findMany({ orderBy: { key: 'asc' }, take: 2 });
    expect(plans.length).toBeGreaterThanOrEqual(2);
    const actorId = randomUUID();
    const tenantId = randomUUID();
    const requestId = randomUUID();
    await db.platformUser.create({
      data: { id: actorId, email: `subscription-race-${actorId.slice(0, 8)}@carecommand.test`, name: 'Subscription Race Operator', passwordHash: await generatePasswordHash('Subscription-race-password-2026!'), role: 'PLATFORM_ADMIN', status: 'active' },
    });
    await db.tenant.create({ data: { id: tenantId, name: 'Subscription Race Clinic', slug: `subscription-race-${tenantId.slice(0, 8)}` } });
    await db.tenantSubscription.create({ data: { tenantId, planId: plans[0]!.id, status: 'ACTIVE', startedAt: new Date() } });
    await db.tenantSubscriptionRequest.create({ data: { id: requestId, tenantId, requestedPlanId: plans[1]!.id, requestType: 'UPGRADE', requestedAddonKeys: [], status: 'PENDING' } });
    cleanup.push(async () => {
      await db.platformAuditEvent.deleteMany({ where: { tenantId } });
      await db.tenant.delete({ where: { id: tenantId } });
      await db.platformUser.delete({ where: { id: actorId } });
    });
    const headers = { authorization: `Bearer ${signPlatformToken(app, { id: actorId, role: 'PLATFORM_ADMIN' })}` };
    const [approve, reject] = await Promise.all([
      app.inject({ method: 'POST', url: `/v1/platform/subscription-requests/${requestId}/approve`, headers, payload: { reviewerNote: 'approve race' } }),
      app.inject({ method: 'POST', url: `/v1/platform/subscription-requests/${requestId}/reject`, headers, payload: { reviewerNote: 'reject race' } }),
    ]);
    expect([approve.statusCode, reject.statusCode].sort()).toEqual([200, 409]);
    const reviewed = await db.tenantSubscriptionRequest.findUniqueOrThrow({ where: { id: requestId } });
    const subscription = await db.tenantSubscription.findUniqueOrThrow({ where: { tenantId } });
    const audits = await db.platformAuditEvent.findMany({ where: { tenantId, targetId: requestId, action: { in: ['subscription.request.approved', 'subscription.request.rejected'] } } });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe(reviewed.status === 'APPROVED' ? 'subscription.request.approved' : 'subscription.request.rejected');
    expect(subscription.planId).toBe(reviewed.status === 'APPROVED' ? plans[1]!.id : plans[0]!.id);
  });

  it('persists retry intent before queue effects and reports successful retry truthfully', async () => {
    const actorId = randomUUID();
    await db.platformUser.create({
      data: { id: actorId, email: `retry-audit-${actorId.slice(0, 8)}@carecommand.test`, name: 'Retry Audit Operator', passwordHash: await generatePasswordHash('Retry-audit-password-2026!'), role: 'PLATFORM_ADMIN', status: 'active' },
    });
    cleanup.push(async () => {
      retryQueue.failed = [];
      await db.platformAuditEvent.deleteMany({ where: { platformUserId: actorId } });
      await db.platformUser.delete({ where: { id: actorId } });
    });
    const retry = vi.fn(async () => { retryQueue.failed = []; });
    retryQueue.failed = [{ id: 'failed-job-1', retry }];
    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `test_retry_intent_fail_fn_${suffix}`;
    const triggerName = `test_retry_intent_fail_trg_${suffix}`;
    await db.$executeRawUnsafe(`CREATE FUNCTION public."${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN IF NEW.action = 'health.jobs.retry.requested' AND NEW."platformUserId" = '${actorId}'::uuid THEN RAISE EXCEPTION 'injected retry intent audit failure'; END IF; RETURN NEW; END $fn$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON public."PlatformAuditEvent" FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()`);
    const removeFault = async () => {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."PlatformAuditEvent"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
    };
    cleanup.push(removeFault);
    const request = { method: 'POST' as const, url: '/v1/platform/health/retry-jobs', headers: { authorization: `Bearer ${signPlatformToken(app, { id: actorId, role: 'PLATFORM_ADMIN' })}` }, payload: { queue: 'autopilot' } };
    const failed = await app.inject(request);
    expect(failed.statusCode).toBe(500);
    expect(retry).not.toHaveBeenCalled();

    await removeFault();
    cleanup.pop();
    const response = await app.inject(request);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ queue: 'autopilot', selected: 1, retried: 1, failed: 0 });
    expect(retry).toHaveBeenCalledOnce();
    expect(await db.platformAuditEvent.count({ where: { platformUserId: actorId, action: 'health.jobs.retry.requested' } })).toBe(1);
    expect(await db.platformAuditEvent.count({ where: { platformUserId: actorId, action: 'health.jobs.retried' } })).toBe(1);

    const secondRetry = vi.fn(async () => { retryQueue.failed = []; });
    retryQueue.failed = [{ id: 'failed-job-2', retry: secondRetry }];
    const completionFunction = `test_retry_completion_fail_fn_${suffix}`;
    const completionTrigger = `test_retry_completion_fail_trg_${suffix}`;
    await db.$executeRawUnsafe(`CREATE FUNCTION public."${completionFunction}"() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN IF NEW.action = 'health.jobs.retried' AND NEW."platformUserId" = '${actorId}'::uuid THEN RAISE EXCEPTION 'injected retry completion audit failure'; END IF; RETURN NEW; END $fn$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER "${completionTrigger}" BEFORE INSERT ON public."PlatformAuditEvent" FOR EACH ROW EXECUTE FUNCTION public."${completionFunction}"()`);
    const removeCompletionFault = async () => {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${completionTrigger}" ON public."PlatformAuditEvent"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${completionFunction}"()`);
    };
    cleanup.push(removeCompletionFault);
    const completionFailed = await app.inject(request);
    expect(completionFailed.statusCode).toBe(500);
    expect(secondRetry).toHaveBeenCalledOnce();
    expect(await db.platformAuditEvent.count({ where: { platformUserId: actorId, action: 'health.jobs.retry.requested' } })).toBe(2);
    expect(await db.platformAuditEvent.count({ where: { platformUserId: actorId, action: 'health.jobs.retried' } })).toBe(1);

    await removeCompletionFault();
    cleanup.pop();
    const afterLostCompletion = await app.inject(request);
    expect(afterLostCompletion.statusCode).toBe(200);
    expect(afterLostCompletion.json()).toEqual({ queue: 'autopilot', selected: 0, retried: 0, failed: 0 });
    expect(secondRetry).toHaveBeenCalledOnce();

    retryQueue.failed = [{ id: 'failed-job-3', retry: async () => { throw new Error('synthetic retry failure'); } }];
    const partialFailure = await app.inject(request);
    expect(partialFailure.statusCode).toBe(502);
    expect(partialFailure.json()).toEqual({ queue: 'autopilot', selected: 1, retried: 0, failed: 1 });
    const partialAudit = await db.platformAuditEvent.findFirstOrThrow({
      where: { platformUserId: actorId, action: 'health.jobs.retried', metadata: { path: ['failed'], equals: 1 } },
      orderBy: { createdAt: 'desc' },
    });
    expect(partialAudit.metadata).toMatchObject({ selected: 1, retried: 0, failed: 1 });
  });

  it('creates the first platform owner and its seed evidence atomically', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const email = `seed-audit-${suffix}@carecommand.test`;
    const originalEnv = {
      email: env.PLATFORM_OWNER_EMAIL,
      password: env.PLATFORM_OWNER_PASSWORD,
      name: env.PLATFORM_OWNER_NAME,
    };
    env.PLATFORM_OWNER_EMAIL = email;
    env.PLATFORM_OWNER_PASSWORD = 'Seed-audit-password-2026!';
    env.PLATFORM_OWNER_NAME = 'Atomic Seed Audit Owner';

    const functionName = `test_platform_seed_audit_fail_fn_${suffix}`;
    const triggerName = `test_platform_seed_audit_fail_trg_${suffix}`;
    await db.$executeRawUnsafe(`
      CREATE FUNCTION public."${functionName}"() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.action = 'platform.owner.seeded' THEN
          RAISE EXCEPTION 'injected mandatory platform seed audit failure';
        END IF;
        RETURN NEW;
      END
      $fn$
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT ON public."PlatformAuditEvent"
      FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()
    `);
    const removeFault = async () => {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."PlatformAuditEvent"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
    };
    let faultActive = true;
    const seedAuditCountBefore = await db.platformAuditEvent.count({ where: { action: 'platform.owner.seeded' } });

    try {
      await expect(ensurePlatformOwnerSeed()).rejects.toThrow('injected mandatory platform seed audit failure');
      expect(await db.platformUser.count({ where: { email } })).toBe(0);
      expect(await db.platformAuditEvent.count({ where: { action: 'platform.owner.seeded' } })).toBe(seedAuditCountBefore);

      await removeFault();
      faultActive = false;
      await expect(ensurePlatformOwnerSeed()).resolves.toEqual({ seeded: true, reason: 'created' });
      const owner = await db.platformUser.findUniqueOrThrow({ where: { email } });
      cleanup.push(async () => {
        await db.platformAuditEvent.deleteMany({ where: { platformUserId: owner.id } });
        await db.platformUser.delete({ where: { id: owner.id } });
      });
      expect(owner).toMatchObject({ name: 'Atomic Seed Audit Owner', role: 'PLATFORM_OWNER', status: 'active' });
      const event = await db.platformAuditEvent.findFirstOrThrow({
        where: { action: 'platform.owner.seeded', platformUserId: owner.id, targetId: owner.id },
      });
      expect(event).toMatchObject({
        targetType: 'platformUser',
        ipHash: null,
        userAgentHash: null,
        metadata: { source: 'environment' },
      });
    } finally {
      env.PLATFORM_OWNER_EMAIL = originalEnv.email;
      env.PLATFORM_OWNER_PASSWORD = originalEnv.password;
      env.PLATFORM_OWNER_NAME = originalEnv.name;
      if (faultActive) await removeFault();
    }
  });
});
