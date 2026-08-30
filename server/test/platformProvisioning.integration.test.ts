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

/**
 * The price book.
 *
 * SubscriptionPlan.monthlyPrice was never written by anything: the catalog
 * migration deliberately refuses to own commercial terms, and no route set it.
 * So every plan rendered $0/mo and every tenant's MRR and ARR were structurally
 * zero across the whole book of business.
 */
describe('platform price book', () => {
  let app: FastifyInstance;
  const adminId = randomUUID();
  const billingId = randomUUID();
  const supportId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const created: string[] = [];
  let originalPrice: number | null = null;

  const auth = (id: string, role: string) => ({
    authorization: `Bearer ${signPlatformToken(app, { id, role })}`,
    'content-type': 'application/json',
  });

  beforeAll(async () => {
    app = await buildApp();
    const hash = await generatePasswordHash('Price-book-password-2026!');
    for (const [id, role] of [[adminId, 'PLATFORM_ADMIN'], [billingId, 'PLATFORM_BILLING'], [supportId, 'PLATFORM_SUPPORT']] as const) {
      await db.platformUser.create({ data: { id, email: `price-${id.slice(0, 8)}@carecommand.test`, name: `Price ${role}`, passwordHash: hash, role, status: 'active' } });
    }
    originalPrice = (await db.subscriptionPlan.findUniqueOrThrow({ where: { key: 'starter' } })).monthlyPrice === null
      ? null
      : Number((await db.subscriptionPlan.findUniqueOrThrow({ where: { key: 'starter' } })).monthlyPrice);
  }, 90_000);

  afterAll(async () => {
    await db.subscriptionPlan.updateMany({ where: { key: 'starter' }, data: { monthlyPrice: originalPrice } });
    for (const tenantId of created) {
      await db.tenant.updateMany({ where: { id: tenantId }, data: { status: 'cancelled', name: 'ZZ test fixture (price book)' } });
    }
    await db.platformAuditEvent.deleteMany({ where: { platformUserId: { in: [adminId, billingId, supportId] } } });
    await db.platformUser.deleteMany({ where: { id: { in: [adminId, billingId, supportId] } } });
    await app.close();
  });

  it('refuses a price change from a read-only role, and demands a reason', async () => {
    const readOnly = await app.inject({
      method: 'PATCH', url: '/v1/platform/subscriptions/plans/starter',
      headers: auth(supportId, 'PLATFORM_SUPPORT'), payload: { monthlyPrice: 199, reason: 'Attempted by support' },
    });
    expect(readOnly.statusCode).toBe(403);

    const noReason = await app.inject({
      method: 'PATCH', url: '/v1/platform/subscriptions/plans/starter',
      headers: auth(billingId, 'PLATFORM_BILLING'), payload: { monthlyPrice: 199 },
    });
    expect(noReason.statusCode).toBe(400);
  });

  it('404s for a plan that does not exist', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/v1/platform/subscriptions/plans/not-a-plan',
      headers: auth(adminId, 'PLATFORM_ADMIN'), payload: { monthlyPrice: 10, reason: 'Testing an unknown plan' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('sets a price and moves the MRR of every tenant already on that plan', async () => {
    const create = await app.inject({
      method: 'POST', url: '/v1/platform/tenants', headers: auth(adminId, 'PLATFORM_ADMIN'),
      payload: {
        name: 'Priced Clinic', slug: `priced-${suffix}`,
        ownerName: 'Dr Price', ownerEmail: `owner-price-${suffix}@clinic.test`,
        ownerPassword: 'Price-book-password-2026!', planKey: 'starter',
      },
    });
    expect(create.statusCode).toBe(201);
    const tenantId = create.json().tenant.id as string;
    created.push(tenantId);

    // Materialise the billing row the way the console does.
    const before = await app.inject({ method: 'GET', url: `/v1/platform/tenants/${tenantId}/billing`, headers: auth(adminId, 'PLATFORM_ADMIN') });
    expect(before.statusCode).toBe(200);

    const priced = await app.inject({
      method: 'PATCH', url: '/v1/platform/subscriptions/plans/starter',
      headers: auth(billingId, 'PLATFORM_BILLING'), payload: { monthlyPrice: 249, reason: 'Setting the published Starter price' },
    });
    expect(priced.statusCode).toBe(200);
    expect(priced.json().monthlyPrice).toBe(249);
    expect(priced.json().tenantsRepriced).toBeGreaterThan(0);

    const after = await app.inject({ method: 'GET', url: `/v1/platform/tenants/${tenantId}/billing`, headers: auth(adminId, 'PLATFORM_ADMIN') });
    expect(after.json().mrr).toBe(249);
    expect(after.json().arr).toBe(249 * 12);
  }, 60_000);

  it('records who repriced it and why, without needing the console to remember', async () => {
    const events = await db.platformAuditEvent.findMany({ where: { action: 'plan.price.changed', platformUserId: billingId } });
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events[0].metadata)).toMatch(/Starter price/i);
  });
});

/**
 * Entitlement overrides that end.
 *
 * A grant given "for the pilot" and never revisited becomes a permanent free
 * feature - a pricing decision made by forgetting rather than by anyone
 * deciding. An override may still be open-ended, but that has to be a choice.
 */
describe('entitlement override expiry', () => {
  let app: FastifyInstance;
  const adminId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const created: string[] = [];
  let tenantId = '';
  let lockedFeature = '';

  const auth = () => ({
    authorization: `Bearer ${signPlatformToken(app, { id: adminId, role: 'PLATFORM_ADMIN' })}`,
    'content-type': 'application/json',
  });

  beforeAll(async () => {
    app = await buildApp();
    await db.platformUser.create({
      data: {
        id: adminId, email: `expiry-${adminId.slice(0, 8)}@carecommand.test`, name: 'Expiry Admin',
        passwordHash: await generatePasswordHash('Override-expiry-password-2026!'), role: 'PLATFORM_ADMIN', status: 'active',
      },
    });
    const res = await app.inject({
      method: 'POST', url: '/v1/platform/tenants', headers: auth(),
      payload: {
        name: 'Comped Clinic', slug: `comped-${suffix}`, ownerName: 'Dr Comp',
        ownerEmail: `owner-comp-${suffix}@clinic.test`, ownerPassword: 'Override-expiry-password-2026!', planKey: 'starter',
      },
    });
    expect(res.statusCode).toBe(201);
    tenantId = res.json().tenant.id;
    created.push(tenantId);
    lockedFeature = (await db.tenantFeatureEntitlement.findFirstOrThrow({ where: { tenantId, enabled: false } })).featureKey;
  }, 90_000);

  afterAll(async () => {
    for (const id of created) await db.tenant.updateMany({ where: { id }, data: { status: 'cancelled', name: 'ZZ test fixture (override expiry)' } });
    await db.platformAuditEvent.deleteMany({ where: { platformUserId: adminId } });
    await db.platformUser.deleteMany({ where: { id: adminId } });
    await app.close();
  });

  it('refuses an end date that has already passed, because it would grant nothing', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/v1/platform/tenants/${tenantId}/entitlements/${lockedFeature}`, headers: auth(),
      payload: { enabled: true, expiresAt: '2020-01-01', reason: 'Backdated by mistake' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('grants until a date, and records why', async () => {
    const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const res = await app.inject({
      method: 'PATCH', url: `/v1/platform/tenants/${tenantId}/entitlements/${lockedFeature}`, headers: auth(),
      payload: { enabled: true, expiresAt: future, reason: 'Comped for the two-week pilot' },
    });
    expect(res.statusCode).toBe(200);

    const row = await db.tenantFeatureEntitlement.findUniqueOrThrow({ where: { tenantId_featureKey: { tenantId, featureKey: lockedFeature } } });
    expect(row).toMatchObject({ enabled: true, overrideEnabled: true, overrideReason: 'Comped for the two-week pilot' });
    expect(row.overrideExpiresAt).toBeTruthy();

    const detail = await app.inject({ method: 'GET', url: `/v1/platform/tenants/${tenantId}`, headers: auth() });
    const shown = (detail.json().entitlements as Array<{ featureKey: string; overrideExpiresAt: string | null; overrideReason: string | null }>)
      .find(e => e.featureKey === lockedFeature);
    // An operator reviewing the account must be able to see which grants lapse.
    expect(shown?.overrideExpiresAt).toBeTruthy();
    expect(shown?.overrideReason).toBe('Comped for the two-week pilot');
  }, 30_000);

  it('stops honouring the grant once it lapses, without waiting for a plan change', async () => {
    const { isFeatureEnabled } = await import('../lib/entitlements');
    expect(await isFeatureEnabled(tenantId, lockedFeature, db)).toBe(true);

    // Backdate it the way time would, then ask the guard the same question.
    await db.tenantFeatureEntitlement.update({
      where: { tenantId_featureKey: { tenantId, featureKey: lockedFeature } },
      data: { overrideExpiresAt: new Date(Date.now() - 60_000) },
    });

    expect(await isFeatureEnabled(tenantId, lockedFeature, db)).toBe(false);

    // And the lapsed override is cleared rather than left claiming a decision
    // nobody stands behind.
    const row = await db.tenantFeatureEntitlement.findUniqueOrThrow({ where: { tenantId_featureKey: { tenantId, featureKey: lockedFeature } } });
    expect(row.overrideEnabled).toBeNull();
    expect(row.overrideExpiresAt).toBeNull();
  }, 30_000);

  it('leaves an open-ended override standing, because that is still a legitimate choice', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/v1/platform/tenants/${tenantId}/entitlements/${lockedFeature}`, headers: auth(),
      payload: { enabled: true, reason: 'Permanent goodwill grant' },
    });
    expect(res.statusCode).toBe(200);

    const { recomputeEntitlements, isFeatureEnabled } = await import('../lib/entitlements');
    await recomputeEntitlements(tenantId, db);
    expect(await isFeatureEnabled(tenantId, lockedFeature, db)).toBe(true);
  }, 30_000);
});
