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
const { signPlatformToken } = await import('../lib/platformAuth');
const { generatePasswordHash } = await import('../lib/security');

/**
 * Provisioning a client company from the Control Tower.
 *
 * This is the highest-value path in the platform console and had no automated
 * coverage at all. The tests below pin the three things that actually broke an
 * operator: the slug contract must be rejected on the field rather than deep
 * inside a database function, Platform Settings must genuinely reach the tenant
 * that gets created, and a platform entitlement override must survive the next
 * commercial action.
 */
describe('platform tenant provisioning', () => {
  let app: FastifyInstance;
  const adminId = randomUUID();
  const supportId = randomUUID();
  const created: string[] = [];
  const suffix = randomUUID().slice(0, 8);

  const auth = (role: 'PLATFORM_ADMIN' | 'PLATFORM_SUPPORT' = 'PLATFORM_ADMIN') => ({
    authorization: `Bearer ${signPlatformToken(app, { id: role === 'PLATFORM_ADMIN' ? adminId : supportId, role })}`,
    'content-type': 'application/json',
  });

  const newCompany = (over: Record<string, unknown> = {}) => ({
    name: 'Sunrise Dental Group',
    slug: `sunrise-${suffix}`,
    ownerName: 'Dr Jane Doe',
    ownerEmail: `owner-${randomUUID().slice(0, 8)}@sunrise.test`,
    ownerPassword: 'Provision-test-password-2026!',
    ...over,
  });

  async function create(body: Record<string, unknown>, role: 'PLATFORM_ADMIN' | 'PLATFORM_SUPPORT' = 'PLATFORM_ADMIN') {
    const res = await app.inject({ method: 'POST', url: '/v1/platform/tenants', headers: auth(role), payload: body });
    if (res.statusCode === 201) created.push(res.json().tenant.id);
    return res;
  }

  beforeAll(async () => {
    app = await buildApp();
    const hash = await generatePasswordHash('Provision-test-password-2026!');
    await db.platformUser.create({ data: { id: adminId, email: `prov-admin-${adminId.slice(0, 8)}@carecommand.test`, name: 'Provisioning Admin', passwordHash: hash, role: 'PLATFORM_ADMIN', status: 'active' } });
    await db.platformUser.create({ data: { id: supportId, email: `prov-support-${supportId.slice(0, 8)}@carecommand.test`, name: 'Provisioning Support', passwordHash: hash, role: 'PLATFORM_SUPPORT', status: 'active' } });
  }, 90_000);

  afterAll(async () => {
    // Provisioned tenants are NOT deleted. Provisioning writes tenant AuditEvent
    // rows, and AuditEvent is append-only for every database role by trigger, so
    // a cascading tenant delete raises P0001 - correctly. Cancel them instead;
    // every assertion above is scoped to its own tenant id, so leftovers cannot
    // affect a later run.
    for (const tenantId of created) {
      await db.tenant.updateMany({ where: { id: tenantId }, data: { status: 'cancelled', name: 'ZZ test fixture (provisioning suite)' } });
    }
    await db.platformAuditEvent.deleteMany({ where: { platformUserId: { in: [adminId, supportId] } } });
    await db.platformUser.deleteMany({ where: { id: { in: [adminId, supportId] } } });
    await app.close();
  });

  describe('the slug contract is enforced where the operator can see it', () => {
    it('refuses a slug shorter than the database will accept, and creates nothing', async () => {
      const res = await create(newCompany({ slug: 'ab' }));
      expect(res.statusCode).toBe(400);
      expect(await db.tenant.count({ where: { slug: 'ab' } })).toBe(0);
    });

    it('refuses a slug the database function would reject for shape', async () => {
      const res = await create(newCompany({ slug: 'Sunrise Dental!' }));
      expect(res.statusCode).toBe(400);
    });

    it('refuses a slug longer than 40 characters instead of failing after submit', async () => {
      const res = await create(newCompany({ slug: `sunrise-dental-group-of-greater-northern-california-${suffix}` }));
      expect(res.statusCode).toBe(400);
    });
  });

  describe('platform settings reach the company that gets created', () => {
    it('applies the stored defaults when the request omits them', async () => {
      const settings = await app.inject({
        method: 'PATCH', url: '/v1/platform/settings', headers: auth(),
        payload: { defaultTimezone: 'Europe/London', defaultCountry: 'GB', defaultBranchName: 'Reception', defaultVoiceMinutes: 275, requireMfaFloor: true, sessionTimeoutMaxMinutes: 240, defaultTrialDays: 21, defaultPlanKey: 'starter' },
      });
      expect(settings.statusCode).toBe(200);
      expect(settings.json()).toMatchObject({ defaultTimezone: 'Europe/London', defaultCountry: 'GB', defaultBranchName: 'Reception', defaultVoiceMinutes: 275, requireMfaFloor: true });

      const res = await create(newCompany({ slug: `defaults-${suffix}` }));
      expect(res.statusCode).toBe(201);
      const tenantId = res.json().tenant.id as string;

      const branches = await db.branch.findMany({ where: { tenantId } });
      expect(branches.map(b => b.name)).toContain('Reception');
      expect(branches[0].timezone).toBe('Europe/London');

      const quota = await db.tenantUsageLimit.findUnique({ where: { tenantId_key: { tenantId, key: 'voice_minutes' } } });
      expect(quota?.limitValue).toBe(275);

      // The floor only tightens: MFA is raised to required, and the session
      // ceiling is applied only where the compliance baseline is looser.
      const policy = await db.tenantSecurityPolicy.findUnique({ where: { tenantId } });
      expect(policy?.requireMfa).toBe(true);
      expect(policy?.sessionTimeoutMinutes ?? Number.MAX_SAFE_INTEGER).toBeLessThanOrEqual(240);

      const subscription = await db.tenantSubscription.findUnique({ where: { tenantId }, include: { plan: true } });
      expect(subscription?.plan.key).toBe('starter');
    }, 60_000);

    it('serves preset starting points that name the values they fill', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/platform/settings/presets', headers: auth() });
      expect(res.statusCode).toBe(200);
      const presets = res.json().presets as Array<{ key: string; label: string; values: Record<string, unknown> }>;
      expect(presets.length).toBeGreaterThan(1);
      for (const preset of presets) {
        expect(preset.label).toBeTruthy();
        expect(Object.keys(preset.values).length).toBeGreaterThan(0);
      }
    });

    it('refuses a preset key it does not publish', async () => {
      const res = await app.inject({ method: 'PATCH', url: '/v1/platform/settings', headers: auth(), payload: { presetKey: 'not-a-preset' } });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('provisioning itself', () => {
    it('creates the company, and refuses the same slug twice', async () => {
      const body = newCompany({ slug: `dupe-${suffix}` });
      const first = await create(body);
      expect(first.statusCode).toBe(201);
      const second = await create({ ...body, ownerEmail: `other-${randomUUID().slice(0, 8)}@sunrise.test` });
      expect(second.statusCode).toBe(409);
    }, 60_000);

    it('refuses a read-only platform role', async () => {
      const res = await create(newCompany({ slug: `readonly-${suffix}` }), 'PLATFORM_SUPPORT');
      expect(res.statusCode).toBe(403);
    });

    it('refuses a password the server policy rejects, and says so', async () => {
      const res = await create(newCompany({ slug: `weak-${suffix}`, ownerPassword: 'short' }));
      expect(res.statusCode).toBe(400);
      expect(String(res.json().message)).toMatch(/password/i);
    });
  });

  describe('a platform entitlement override survives the next commercial action', () => {
    it('keeps an operator-granted feature through a plan change', async () => {
      const res = await create(newCompany({ slug: `override-${suffix}`, planKey: 'starter' }));
      expect(res.statusCode).toBe(201);
      const tenantId = res.json().tenant.id as string;

      const locked = await db.tenantFeatureEntitlement.findFirst({ where: { tenantId, enabled: false } });
      expect(locked, 'starter should leave at least one feature locked').toBeTruthy();
      const featureKey = locked!.featureKey;

      const grant = await app.inject({
        method: 'PATCH', url: `/v1/platform/tenants/${tenantId}/entitlements/${featureKey}`,
        headers: auth(), payload: { enabled: true },
      });
      expect(grant.statusCode).toBe(200);

      const change = await app.inject({
        method: 'POST', url: `/v1/platform/tenants/${tenantId}/subscription/change-plan`,
        headers: auth(), payload: { planKey: 'starter', reason: 'Re-applying the same plan to force a recompute' },
      });
      expect([200, 201]).toContain(change.statusCode);

      const after = await db.tenantFeatureEntitlement.findUnique({ where: { tenantId_featureKey: { tenantId, featureKey } } });
      expect(after?.enabled, 'the granted feature must not be silently revoked').toBe(true);
      expect(after?.overrideEnabled).toBe(true);
    }, 60_000);
  });
});
