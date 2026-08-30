import type { FastifyPluginAsync } from 'fastify';
import type { Prisma, PrismaClient } from '../../generated/prisma/client';
import { z } from 'zod';
import { platformDb as db, assertPlatformDatabaseRole } from '../../lib/platformDb';
import { recomputeEntitlements } from '../../lib/entitlements';
import { generatePasswordHash, validatePassword } from '../../lib/security';
import { requirePlatformAccess, platformAuditEvent, runPlatformAuditedMutation, PLATFORM_ROLES } from '../../lib/platformAuth';
import { platformProvisionTenant, PlatformProvisionError } from '../../lib/platformTenantProvisioning';
import { autopilotQueue } from '../../workers/queues';
import { env } from '../../config/env';
import { encryptSecret, decryptSecret } from '../../lib/security';
import { runWithPlatformDatabaseRequest } from '../../lib/platformContextStore';
import { validateIanaTimezone } from '../../lib/scheduling';
import { PROVIDER_CATALOG, PROVIDER_KEYS, providerConfig, invalidateProviderCredentials, refreshProviderCredentials, type ProviderDef as SharedProviderDef } from '../../lib/providerCredentials';
import { periodUsageByMetric, usagePeriodKey, USAGE_LIMIT_KEY_BY_METRIC } from '../../lib/usageMetering';
import { TENANT_MODES, TENANT_MODE_DESCRIPTION, modeAllowsLiveCalling } from '../../lib/tenantMode';
import { platformRemediationCatalogue } from '../../lib/receptionist/remediation';
import { platformDeploymentProjection } from '../receptionist/deployment';

const timezoneInput = z.string().trim().min(1).max(80).refine(value => {
  try { validateIanaTimezone(value); return true; } catch { return false; }
}, { message: 'timezone must be a valid IANA timezone identifier' });

// Integration provider catalog. `env` is the fallback config source; UI-saved
// credentials live encrypted in PlatformIntegration and take precedence.
type ProviderDef = SharedProviderDef;
// The catalog lives in lib/providerCredentials so the console and the senders
// cannot disagree about which fields a provider has, or which credential wins.
const PROVIDERS = PROVIDER_CATALOG;

const reasonSchema = z.string().trim().min(3).max(500);
const USAGE_KEYS = ['seats', 'locations', 'storage_gb', 'sms', 'voice_minutes', 'ai_credits', 'devices'] as const;
const USAGE_DEFAULTS: Record<string, { limit: number | null }> = {
  seats: { limit: 25 }, locations: { limit: 5 }, storage_gb: { limit: 50 }, sms: { limit: 1000 },
  voice_minutes: { limit: 500 }, ai_credits: { limit: 1000 }, devices: { limit: 25 },
};

const uuid = z.string().uuid();

// The slug contract is owned by app_platform_provision_tenant (3-40 chars,
// lowercase alphanumeric with inner hyphens). It is restated here - and
// mirrored in the console - so a rejection happens on the field, not after
// submit. Any change must be made in all three places at once.
export const PLATFORM_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const slugInput = z.string().trim().toLowerCase().min(3).max(40).regex(PLATFORM_SLUG_PATTERN, 'Slug must be 3-40 chars: lowercase letters, numbers, and inner hyphens.');

// Provisioning runs ~70 sequential statements (compliance baseline +
// entitlements) inside one transaction. Prisma's 5s default is not a budget
// for that on managed Postgres; a blown budget looked like a bare 500.
const PROVISIONING_BUDGET = { timeout: 30_000, maxWait: 10_000 };

/**
 * Starting points for platform settings. A preset only fills the form - the
 * operator can edit every field before saving, and `presetKey` records which
 * one they started from. Kept deliberately short: these are the shapes we
 * actually sell, not a catalog of everything expressible.
 */
export const PLATFORM_SETTING_PRESETS = [
  {
    key: 'us_pilot',
    label: 'US clinic - pilot',
    description: 'Two-week trial, Eastern time, modest voice allowance, MFA optional while the clinic onboards.',
    values: { defaultTrialDays: 14, defaultPlanKey: 'starter', defaultTimezone: 'America/New_York', defaultCountry: 'US', defaultVoiceMinutes: 300, requireMfaFloor: false, sessionTimeoutMaxMinutes: 480 },
  },
  {
    key: 'us_production',
    label: 'US clinic - production',
    description: 'No trial, Eastern time, full voice allowance, MFA required and an 8-hour session ceiling.',
    values: { defaultTrialDays: 0, defaultPlanKey: 'growth', defaultTimezone: 'America/New_York', defaultCountry: 'US', defaultVoiceMinutes: 1500, requireMfaFloor: true, sessionTimeoutMaxMinutes: 480 },
  },
  {
    key: 'uk_pilot',
    label: 'UK clinic - pilot',
    description: 'Two-week trial, London time, modest voice allowance, MFA optional while the clinic onboards.',
    values: { defaultTrialDays: 14, defaultPlanKey: 'starter', defaultTimezone: 'Europe/London', defaultCountry: 'GB', defaultVoiceMinutes: 300, requireMfaFloor: false, sessionTimeoutMaxMinutes: 480 },
  },
  {
    key: 'uk_production',
    label: 'UK clinic - production',
    description: 'No trial, London time, full voice allowance, MFA required and a 4-hour session ceiling.',
    values: { defaultTrialDays: 0, defaultPlanKey: 'growth', defaultTimezone: 'Europe/London', defaultCountry: 'GB', defaultVoiceMinutes: 1500, requireMfaFloor: true, sessionTimeoutMaxMinutes: 240 },
  },
] as const;

/** Race-free singleton read: two concurrent first-time GETs must not collide. */
async function ensureConfig(client: PrismaClient | Prisma.TransactionClient = db) {
  return client.platformConfig.upsert({ where: { id: 'singleton' }, update: {}, create: { id: 'singleton' } });
}

function settingsView(c: Awaited<ReturnType<typeof ensureConfig>>) {
  return {
    platformName: c.platformName, supportEmail: c.supportEmail,
    defaultTrialDays: c.defaultTrialDays, defaultPlanKey: c.defaultPlanKey,
    defaultTimezone: c.defaultTimezone, defaultCountry: c.defaultCountry,
    defaultBranchName: c.defaultBranchName, defaultVoiceMinutes: c.defaultVoiceMinutes,
    requireMfaFloor: c.requireMfaFloor, sessionTimeoutMaxMinutes: c.sessionTimeoutMaxMinutes,
    requireOperatorMfa: c.requireOperatorMfa,
    presetKey: c.presetKey, updatedAt: c.updatedAt.toISOString(),
  };
}

async function withTimeout<T>(op: Promise<T>, ms: number): Promise<T> {
  return Promise.race([op, new Promise<T>((_r, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

async function tenantActivityCounts(tenantId: string, client: PrismaClient | Prisma.TransactionClient = db): Promise<{ activeUsers: number; branches: number }> {
  const rows = await client.$queryRaw<Array<{ active_users: bigint; branches: bigint }>>`
    SELECT active_users, branches FROM app_platform_tenant_activity(${tenantId}::uuid)
  `;
  return { activeUsers: Number(rows[0]?.active_users ?? 0), branches: Number(rows[0]?.branches ?? 0) };
}

// Company record fields an operator maintains. Every one is optional and stored
// as typed-or-null: an empty string is normalised to null so a blank field reads
// as "not recorded" instead of an empty value the console would render as known.
const COMPANY_FIELDS = [
  'legalName', 'companyNumber', 'addressLine1', 'addressLine2', 'city', 'region',
  'postalCode', 'country', 'mainPhone', 'website', 'primaryContactName',
  'primaryContactEmail', 'primaryContactPhone', 'billingContactName',
  'billingContactEmail', 'accountNotes',
  // Relationship facts. Dates are carried as ISO strings through this record so
  // the whole company tab stays one string-in/string-out shape.
  'contractStartedAt', 'accountManager', 'baaSignedAt',
] as const;

const blankToNull = (max: number) =>
  z.string().trim().max(max).transform(v => (v === '' ? null : v)).nullable().optional();
const dateOrNull = z.string().trim().max(40)
  .transform(v => (v === '' ? null : v))
  .refine(v => v === null || !Number.isNaN(Date.parse(v)), { message: 'must be a date (YYYY-MM-DD)' })
  .nullable().optional();
const emailOrNull = z.string().trim().max(200)
  .transform(v => (v === '' ? null : v))
  .refine(v => v === null || z.string().email().safeParse(v).success, { message: 'must be a valid email address' })
  .nullable().optional();

const companyUpdateSchema = z.object({
  legalName: blankToNull(200), companyNumber: blankToNull(80),
  addressLine1: blankToNull(200), addressLine2: blankToNull(200),
  city: blankToNull(120), region: blankToNull(120),
  postalCode: blankToNull(40), country: blankToNull(120),
  mainPhone: blankToNull(40), website: blankToNull(300),
  primaryContactName: blankToNull(200), primaryContactEmail: emailOrNull,
  primaryContactPhone: blankToNull(40),
  billingContactName: blankToNull(200), billingContactEmail: emailOrNull,
  accountNotes: blankToNull(4000),
  accountManager: blankToNull(200),
  // Dates arrive as YYYY-MM-DD (or blank to clear). Validated here rather than
  // trusted, so a typo cannot land as an Invalid Date in a renewal report.
  contractStartedAt: dateOrNull,
  baaSignedAt: dateOrNull,
  reason: reasonSchema,
});

function companyView(tenant: Record<string, unknown>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const f of COMPANY_FIELDS) {
    const value = tenant[f];
    out[f] = value instanceof Date ? value.toISOString() : ((value as string | null) ?? null);
  }
  return out;
}

// The platform plane holds NO grants on "User" or "Branch" -- these read through
// the narrow SECURITY DEFINER windows added in 20260829040000_tenant_company_record,
// which expose the account owner, aggregate role counts and branch records only.
// There is deliberately no staff-roster read here; that is break-glass only.
async function tenantDirectory(tenantId: string) {
  const [owner, roles, branches] = await Promise.all([
    db.$queryRaw<Array<{ user_id: string; display_name: string; email: string; role: string; active: boolean; mfa_enabled: boolean; last_login_at: Date | null; created_at: Date }>>`
      SELECT user_id, display_name, email, role, active, mfa_enabled, last_login_at, created_at
      FROM app_platform_tenant_account_owner(${tenantId}::uuid)`,
    db.$queryRaw<Array<{ role: string; active_count: bigint; inactive_count: bigint }>>`
      SELECT role, active_count, inactive_count FROM app_platform_tenant_role_breakdown(${tenantId}::uuid)`,
    db.$queryRaw<Array<{ branch_id: string; name: string; location: string; timezone: string; active: boolean; created_at: Date }>>`
      SELECT branch_id, name, location, timezone, active, created_at FROM app_platform_tenant_branches(${tenantId}::uuid)`,
  ]);
  const o = owner[0];
  return {
    accountOwner: o
      ? {
          id: o.user_id, displayName: o.display_name, email: o.email, role: o.role,
          active: o.active, mfaEnabled: o.mfa_enabled,
          lastLoginAt: o.last_login_at?.toISOString() ?? null,
          createdAt: o.created_at.toISOString(),
        }
      : null,
    roleBreakdown: roles.map(r => ({ role: r.role, active: Number(r.active_count), inactive: Number(r.inactive_count) })),
    branches: branches.map(b => ({
      id: b.branch_id, name: b.name, location: b.location, timezone: b.timezone,
      active: b.active, createdAt: b.created_at.toISOString(),
    })),
  };
}

// Role gates (PLATFORM_OWNER always passes — see platformRoleAllowed).
const tenantManage = requirePlatformAccess('PLATFORM_ADMIN');
const subscriptionManage = requirePlatformAccess('PLATFORM_ADMIN', 'PLATFORM_BILLING');
const userManage = requirePlatformAccess('PLATFORM_ADMIN');

// Apply tenant subscription changes (plan/status/addons) and recompute
// entitlements. Shared by direct platform edits and request approval.
async function applySubscriptionChange(
  tenantId: string,
  change: { planKey?: string; status?: string; addonKeys?: string[] },
  client: PrismaClient | Prisma.TransactionClient = db,
) {
  const existing = await client.tenantSubscription.findUnique({ where: { tenantId }, include: { plan: true } });
  let planId = existing?.planId;
  if (change.planKey) {
    const plan = await client.subscriptionPlan.findUnique({ where: { key: change.planKey } });
    if (!plan) throw new Error('unknown_plan');
    planId = plan.id;
  }
  if (!planId) throw new Error('no_plan');
  const subscription = existing
    ? await client.tenantSubscription.update({ where: { tenantId }, data: { planId, ...(change.status ? { status: change.status as never } : {}) } })
    : await client.tenantSubscription.create({ data: { tenantId, planId, status: (change.status as never) ?? 'ACTIVE', startedAt: new Date() } });
  if (change.addonKeys) {
    const addons = await client.subscriptionAddon.findMany({ where: { key: { in: change.addonKeys }, active: true } });
    const wanted = new Set(addons.map(a => a.id));
    await client.tenantSubscriptionAddon.updateMany({ where: { subscriptionId: subscription.id, addonId: { notIn: [...wanted] } }, data: { active: false } });
    for (const addon of addons) {
      await client.tenantSubscriptionAddon.upsert({ where: { subscriptionId_addonId: { subscriptionId: subscription.id, addonId: addon.id } }, update: { active: true }, create: { tenantId, subscriptionId: subscription.id, addonId: addon.id, active: true } });
    }
  }
  await recomputeEntitlements(tenantId, client);
  // Move the money with the plan. The billing row copied a price once, lazily,
  // on first read and was never touched again, so upgrading a tenant from
  // Starter to Enterprise left the console reporting Starter's MRR forever.
  const pricedPlan = await client.subscriptionPlan.findUnique({ where: { id: planId }, select: { monthlyPrice: true } });
  await client.tenantBilling.updateMany({ where: { tenantId }, data: { mrr: Number(pricedPlan?.monthlyPrice ?? 0) } });
  return subscription;
}

async function tenantSummary(tenantId: string) {
  const [tenant, sub, activity, enabledCount] = await Promise.all([
    db.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, slug: true, status: true, mode: true, createdAt: true, updatedAt: true } }),
    db.tenantSubscription.findUnique({ where: { tenantId }, include: { plan: true, addons: { where: { active: true }, include: { addon: true } } } }),
    tenantActivityCounts(tenantId),
    db.tenantFeatureEntitlement.count({ where: { tenantId, enabled: true } }),
  ]);
  return {
    tenant: tenant ? { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status, mode: tenant.mode, modeDescription: TENANT_MODE_DESCRIPTION[tenant.mode as keyof typeof TENANT_MODE_DESCRIPTION] ?? tenant.mode, liveCallingAllowed: modeAllowsLiveCalling(tenant.mode), createdAt: tenant.createdAt.toISOString(), lastActivityAt: tenant.updatedAt.toISOString() } : null,
    subscription: sub ? { planKey: sub.plan.key, planName: sub.plan.name, status: sub.status, trialEndsAt: sub.trialEndsAt?.toISOString() ?? null, addons: sub.addons.map(a => a.addon.key) } : null,
    activeUsers: activity.activeUsers, branches: activity.branches, enabledFeatures: enabledCount,
    setupStatus: sub ? 'configured' : 'setup_required',
    deepLinkTarget: tenant ? `platform/tenants/${tenant.id}` : null,
  };
}

export const platformRoutes: FastifyPluginAsync = async app => {
  if (env.PLATFORM_DATABASE_URL) await assertPlatformDatabaseRole();
  app.addHook('onRequest', (_request, _reply, done) => runWithPlatformDatabaseRequest(done));
  // Any authenticated platform identity may read (legacy token = PLATFORM_OWNER).
  app.addHook('preHandler', requirePlatformAccess());

  // ===== Overview / reads ================================================
  app.get('/overview', async () => {
    const rows = await db.$queryRaw<Array<{ tenants: bigint; active_tenants: bigint; suspended_tenants: bigint; pending_requests: bigint; platform_users: bigint }>>`
      SELECT * FROM app_platform_overview()
    `;
    if (rows.length !== 1) throw new Error('Platform overview failed closed');
    const row = rows[0];
    return { tenants: Number(row.tenants), activeTenants: Number(row.active_tenants), suspendedTenants: Number(row.suspended_tenants), pendingRequests: Number(row.pending_requests), platformUsers: Number(row.platform_users), label: 'Platform operations overview' };
  });

  // ----- System status: API connectivity, DB readiness, Redis, latency -----
  app.get('/health', async () => {
    const startedAt = Date.now();
    let database: string;
    let dbLatencyMs: number | null = null;
    try {
      const t0 = Date.now();
      await withTimeout(db.$queryRaw`SELECT 1`, 2000);
      dbLatencyMs = Date.now() - t0;
      database = 'ok';
    } catch { database = 'down'; }

    let redis: string;
    try {
      const client = (await withTimeout(Promise.resolve(autopilotQueue.client), 1000)) as unknown as { ping(): Promise<string> };
      redis = (await withTimeout(client.ping(), 1000)) === 'PONG' ? 'ok' : 'down';
    } catch { redis = 'down'; }

    return {
      api: 'ok', // reaching this handler means the API is serving requests
      database,
      redis,
      dbLatencyMs,
      responseMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
    };
  });

  app.get('/tenants', async () => {
    const tenants = await db.tenant.findMany({ orderBy: { createdAt: 'desc' }, select: { id: true } });
    return Promise.all(tenants.map(t => tenantSummary(t.id)));
  });

  app.get('/subscriptions/tenants', async () => {
    const subs = await db.tenantSubscription.findMany({ include: { plan: true, tenant: { select: { name: true, slug: true, status: true } } }, orderBy: { updatedAt: 'desc' } });
    return subs.map(s => ({ tenantId: s.tenantId, tenantName: s.tenant.name, slug: s.tenant.slug, tenantStatus: s.tenant.status, planKey: s.plan.key, status: s.status, trialEndsAt: s.trialEndsAt?.toISOString() ?? null }));
  });

  app.get('/subscriptions/plans', async () => {
    const plans = await db.subscriptionPlan.findMany({ orderBy: { monthlyPrice: 'asc' }, include: { features: true } });
    return plans.map(p => ({ key: p.key, name: p.name, monthlyPrice: Number(p.monthlyPrice ?? 0), features: p.features.map(f => f.featureKey) }));
  });

  /**
   * Set a plan's price.
   *
   * The catalog migration deliberately never wrote `monthlyPrice` - reference
   * data should not carry commercial terms - but nothing else wrote it either,
   * so every plan rendered $0/mo and every tenant's MRR and ARR were
   * structurally zero across the whole book of business. This is the missing
   * write: platform-only, audited, and the one place a price is decided.
   */
  app.patch('/subscriptions/plans/:planKey', { preHandler: subscriptionManage }, async (request, reply) => {
    const { planKey } = z.object({ planKey: z.string().min(1).max(40) }).parse(request.params);
    const body = z.object({
      monthlyPrice: z.number().min(0).max(1_000_000).nullable(),
      reason: reasonSchema,
    }).parse(request.body);

    const plan = await db.subscriptionPlan.findUnique({ where: { key: planKey } });
    if (!plan) return reply.code(404).send({ error: 'not_found', message: 'Unknown plan' });

    const updated = await runPlatformAuditedMutation(request, {
      action: 'plan.price.changed',
      target: { type: 'plan', id: planKey },
      metadata: { reason: body.reason, from: Number(plan.monthlyPrice ?? 0), to: body.monthlyPrice },
    }, async tx => {
      const saved = await tx.subscriptionPlan.update({ where: { key: planKey }, data: { monthlyPrice: body.monthlyPrice } });
      // A price is only real once it reaches the tenants on that plan. Billing
      // rows copied the price once, lazily, on first read and were never
      // updated again - so a repriced plan left every existing customer's MRR
      // reporting the old number forever.
      const subscriptions = await tx.tenantSubscription.findMany({ where: { planId: saved.id }, select: { tenantId: true } });
      if (subscriptions.length) {
        await tx.tenantBilling.updateMany({
          where: { tenantId: { in: subscriptions.map(row => row.tenantId) } },
          data: { mrr: body.monthlyPrice ?? 0 },
        });
      }
      return { saved, repriced: subscriptions.length };
    });

    return {
      key: updated.saved.key,
      monthlyPrice: Number(updated.saved.monthlyPrice ?? 0),
      tenantsRepriced: updated.repriced,
    };
  });

  app.get('/subscriptions/addons', async () => {
    const addons = await db.subscriptionAddon.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
    return addons.map(a => ({ key: a.key, name: a.name, featureKey: a.featureKey }));
  });

  app.get('/tenants/:tenantId', async (request, reply) => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const summary = await tenantSummary(tenantId);
    if (!summary.tenant) return reply.code(404).send({ error: 'not_found', message: 'Tenant not found' });
    const rows = await db.tenantFeatureEntitlement.findMany({
      where: { tenantId }, orderBy: { featureKey: 'asc' },
      select: { featureKey: true, enabled: true, source: true, limitValue: true, overrideExpiresAt: true, overrideReason: true },
    });
    const entitlements = rows.map(row => ({
      featureKey: row.featureKey,
      enabled: row.enabled,
      source: row.source,
      limitValue: row.limitValue,
      // An override that ends is worth showing as such: an operator reviewing
      // an account should see which grants lapse and why they were given.
      overrideExpiresAt: row.overrideExpiresAt?.toISOString() ?? null,
      overrideReason: row.overrideReason,
    }));
    return { ...summary, entitlements };
  });

  // Company record + the narrow directory windows. Read is open to any active
  // platform actor (same as tenant read); writes require PLATFORM_ADMIN.
  app.get('/tenants/:tenantId/company', async (request, reply) => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) return reply.code(404).send({ error: 'not_found', message: 'Tenant not found' });
    return {
      tenantId,
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      createdAt: tenant.createdAt.toISOString(),
      company: companyView(tenant as unknown as Record<string, unknown>),
      ...(await tenantDirectory(tenantId)),
    };
  });

  app.patch('/tenants/:tenantId/company', { preHandler: tenantManage }, async (request, reply) => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const body = companyUpdateSchema.parse(request.body);
    const existing = await db.tenant.findUnique({ where: { id: tenantId } });
    if (!existing) return reply.code(404).send({ error: 'not_found', message: 'Tenant not found' });

    // Only fields actually present in the request are written, so a partial
    // edit never blanks a field the operator did not touch.
    const DATE_FIELDS = new Set(['contractStartedAt', 'baaSignedAt']);
    const data: Record<string, string | Date | null> = {};
    const changed: string[] = [];
    for (const f of COMPANY_FIELDS) {
      if (!(f in body)) continue;
      const next = (body as Record<string, string | null | undefined>)[f] ?? null;
      const rawPrev = (existing as unknown as Record<string, unknown>)[f] ?? null;
      if (DATE_FIELDS.has(f)) {
        // Compare on the instant, not the string: '2026-01-05' and the stored
        // ISO form are the same date and must not read as a change.
        const prevIso = rawPrev instanceof Date ? rawPrev.toISOString() : null;
        const nextDate = next === null ? null : new Date(next);
        data[f] = nextDate;
        if ((nextDate?.toISOString() ?? null) !== prevIso) changed.push(f);
        continue;
      }
      const prev = (rawPrev as string | null) ?? null;
      data[f] = next;
      if (next !== prev) changed.push(f);
    }
    if (!changed.length) return { tenantId, company: companyView(existing as unknown as Record<string, unknown>), changed: [] };

    const updated = await runPlatformAuditedMutation(request, {
      action: 'tenant.company.updated',
      target: { type: 'tenant', id: tenantId, tenantId },
      // Field NAMES only: the values can carry a customer's contact details, and
      // the audit log is read far more widely than the record itself.
      metadata: { reason: body.reason, changedFields: changed },
    }, tx => tx.tenant.update({ where: { id: tenantId }, data }));

    return { tenantId, company: companyView(updated as unknown as Record<string, unknown>), changed };
  });

  /**
   * Set how a workspace may behave in the real world.
   *
   * Separate from the company record on purpose: the company record holds
   * FACTS an operator types, while this is a switch that changes what the
   * product will do - a demo workspace is refused at both call-admission gates
   * (server/lib/tenantMode.ts). It carries a reason for the same reason suspend
   * does.
   */
  app.patch('/tenants/:tenantId/mode', { preHandler: tenantManage }, async (request, reply) => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const body = z.object({ mode: z.enum(TENANT_MODES), reason: reasonSchema }).parse(request.body);
    const existing = await db.tenant.findUnique({ where: { id: tenantId }, select: { mode: true } });
    if (!existing) return reply.code(404).send({ error: 'not_found', message: 'Tenant not found' });

    const updated = await runPlatformAuditedMutation(request, {
      action: 'tenant.mode.changed',
      target: { type: 'tenant', id: tenantId, tenantId },
      metadata: { reason: body.reason, from: existing.mode, to: body.mode },
    }, tx => tx.tenant.update({ where: { id: tenantId }, data: { mode: body.mode } }));

    return { tenantId, mode: updated.mode, liveCallingAllowed: modeAllowsLiveCalling(updated.mode) };
  });

  // Break-glass staff roster. Readable only while an unexpired, unended
  // SupportAccessSession exists for the tenant -- the database enforces that,
  // not this handler. Without one the function raises 42501 and this returns 403
  // with the remedy, so an operator is never shown an empty list they could
  // mistake for "this clinic has no staff".
  app.get('/tenants/:tenantId/users', { preHandler: tenantManage }, async (request, reply) => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) return reply.code(404).send({ error: 'not_found', message: 'Tenant not found' });

    const session = await db.supportAccessSession.findFirst({
      where: { tenantId, endedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { startedAt: 'desc' },
    });
    if (!session) {
      return reply.code(403).send({
        error: 'support_session_required',
        message: 'Open a support session for this tenant to view its staff list. The session records your reason and expires on its own.',
      });
    }

    const rows = await db.$queryRaw<Array<{
      user_id: string; display_name: string; email: string; role: string; branch_name: string | null;
      active: boolean; mfa_enabled: boolean; locked_until: Date | null; last_login_at: Date | null; created_at: Date;
    }>>`
      SELECT user_id, display_name, email, role, branch_name, active, mfa_enabled, locked_until, last_login_at, created_at
      FROM app_platform_tenant_user_roster(${tenantId}::uuid)`;

    // Viewing a roster is itself the sensitive act, so it is audited like a
    // mutation -- count only, never the identities that were read.
    await platformAuditEvent(request, 'tenant.roster.viewed', { type: 'tenant', id: tenantId, tenantId }, {
      supportSessionId: session.id, reason: session.reason, userCount: rows.length,
    });

    return {
      tenantId,
      supportSession: { id: session.id, reason: session.reason, expiresAt: session.expiresAt.toISOString(), operatorEmail: session.operatorEmail },
      users: rows.map(r => ({
        id: r.user_id, displayName: r.display_name, email: r.email, role: r.role,
        branchName: r.branch_name, active: r.active, mfaEnabled: r.mfa_enabled,
        lockedUntil: r.locked_until?.toISOString() ?? null,
        lastLoginAt: r.last_login_at?.toISOString() ?? null,
        createdAt: r.created_at.toISOString(),
      })),
    };
  });

  app.get('/tenants/:tenantId/subscription', async (request, reply) => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const sub = await db.tenantSubscription.findUnique({ where: { tenantId }, include: { plan: true, addons: { where: { active: true }, include: { addon: true } } } });
    if (!sub) return reply.code(404).send({ error: 'not_found' });
    return { tenantId, planKey: sub.plan.key, status: sub.status, trialEndsAt: sub.trialEndsAt?.toISOString() ?? null, addons: sub.addons.map(a => a.addon.key) };
  });

  app.get('/subscription-requests', async request => {
    const { status } = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional() }).parse(request.query);
    const rows = await db.tenantSubscriptionRequest.findMany({ where: { ...(status ? { status } : {}) }, orderBy: { createdAt: 'desc' }, take: 200, include: { tenant: { select: { name: true, slug: true } }, requestedPlan: { select: { key: true, name: true } } } });
    return rows.map(r => ({ id: r.id, tenantId: r.tenantId, tenantName: r.tenant.name, slug: r.tenant.slug, requestType: r.requestType, status: r.status, requestedPlanKey: r.requestedPlan?.key ?? null, requestedAddonKeys: r.requestedAddonKeys, notes: r.notes, reviewerNote: r.reviewerNote, createdAt: r.createdAt.toISOString() }));
  });

  app.get('/audit', async request => {
    const q = z.object({ action: z.string().optional(), tenantId: uuid.optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(request.query);
    const rows = await db.platformAuditEvent.findMany({ where: { ...(q.action ? { action: q.action } : {}), ...(q.tenantId ? { tenantId: q.tenantId } : {}) }, orderBy: { createdAt: 'desc' }, take: q.limit });
    return rows.map(r => ({ id: r.id, action: r.action, targetType: r.targetType, targetId: r.targetId, tenantId: r.tenantId, metadata: r.metadata, createdAt: r.createdAt.toISOString() }));
  });

  app.get('/users', async () => {
    const users = await db.platformUser.findMany({ orderBy: { createdAt: 'asc' } });
    return users.map(u => ({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, mfaEnabled: u.mfaEnabled, lastLoginAt: u.lastLoginAt?.toISOString() ?? null }));
  });

  // ===== Tenant management ================================================
  // Create (provision) a client company: tenant + owner login + default branch +
  // trial subscription + entitlements, so the client can sign in immediately.
  app.post('/tenants', { preHandler: tenantManage }, async (request, reply) => {
    const body = z.object({
      name: z.string().trim().min(2).max(160),
      // The authority on slug shape is app_platform_provision_tenant (3-40,
      // lowercase alnum + inner hyphens). Accepting anything looser here only
      // moves the rejection to the end of a long form.
      slug: slugInput,
      planKey: z.string().min(1).max(40).optional(),
      ownerName: z.string().trim().min(2).max(120),
      ownerEmail: z.string().email().trim().toLowerCase(),
      ownerPassword: z.string().min(1).max(200),
      defaultBranchName: z.string().trim().min(2).max(160).optional(),
      timezone: timezoneInput.optional(),
    }).parse(request.body);
    if (await db.tenant.findUnique({ where: { slug: body.slug } })) throw app.httpErrors.conflict('Slug already in use');
    // Apply the global platform defaults from Platform Settings.
    const cfg = await ensureConfig();
    try {
      const result = await runPlatformAuditedMutation(request, (provisioned: Awaited<ReturnType<typeof platformProvisionTenant>>) => ({
        action: 'tenant.created',
        target: { type: 'tenant', id: provisioned.tenant.id, tenantId: provisioned.tenant.id },
        metadata: { name: body.name, planKey: body.planKey ?? cfg.defaultPlanKey },
      }), tx => platformProvisionTenant({
        clinicName: body.name, clinicSlug: body.slug,
        ownerName: body.ownerName, ownerEmail: body.ownerEmail, ownerPassword: body.ownerPassword,
        defaultBranchName: body.defaultBranchName ?? cfg.defaultBranchName,
        timezone: body.timezone ?? cfg.defaultTimezone, planKey: body.planKey ?? cfg.defaultPlanKey,
        trialDays: cfg.defaultTrialDays ?? env.TRIAL_DAYS,
        voiceMinutesLimit: cfg.defaultVoiceMinutes,
        securityFloor: { requireMfa: cfg.requireMfaFloor, sessionTimeoutMinutes: cfg.sessionTimeoutMaxMinutes },
      }, tx), PROVISIONING_BUDGET);
      return reply.code(201).send(await tenantSummary(result.tenant.id));
    } catch (error) {
      if (error instanceof PlatformProvisionError) throw app.httpErrors.badRequest(error.message);
      // A blown transaction budget is an infrastructure fact, not a bad
      // request: say so instead of leaking P2028 as a bare 500.
      if ((error as { code?: string }).code === 'P2028') {
        throw app.httpErrors.serviceUnavailable('Provisioning timed out before it could finish. No company was created - retry, and check database latency if it repeats.');
      }
      throw error;
    }
  });

  app.patch('/tenants/:tenantId', { preHandler: tenantManage }, async request => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const body = z.object({ name: z.string().trim().min(2).max(160) }).parse(request.body);
    const existing = await db.tenant.findUnique({ where: { id: tenantId } });
    if (!existing) throw app.httpErrors.notFound('Tenant not found');
    await runPlatformAuditedMutation(request, {
      action: 'tenant.updated', target: { type: 'tenant', id: tenantId, tenantId }, metadata: { name: body.name },
    }, tx => tx.tenant.update({ where: { id: tenantId }, data: { name: body.name } }));
    return tenantSummary(tenantId);
  });

  // Suspend / reactivate — sets Tenant.status (enforced at tenant login + feature
  // checks) AND the subscription status, then recomputes entitlements.
  async function setTenantStatus(request: import('fastify').FastifyRequest, tenantId: string, action: 'suspend' | 'reactivate') {
    const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw app.httpErrors.notFound('Tenant not found');
    const tenantStatus = action === 'suspend' ? 'suspended' : 'active';
    const subStatus = action === 'suspend' ? 'SUSPENDED' : 'ACTIVE';
    await runPlatformAuditedMutation(request, {
      action: action === 'suspend' ? 'tenant.suspended' : 'tenant.reactivated',
      target: { type: 'tenant', id: tenantId, tenantId }, metadata: { status: tenantStatus },
    }, async tx => {
      await tx.tenant.update({ where: { id: tenantId }, data: { status: tenantStatus } });
      await tx.tenantSubscription.updateMany({ where: { tenantId }, data: { status: subStatus } });
      await recomputeEntitlements(tenantId, tx);
    });
    return { tenantId, status: tenantStatus };
  }

  app.post('/tenants/:tenantId/suspend', { preHandler: tenantManage }, async request => setTenantStatus(request, z.object({ tenantId: uuid }).parse(request.params).tenantId, 'suspend'));
  app.post('/tenants/:tenantId/reactivate', { preHandler: tenantManage }, async request => setTenantStatus(request, z.object({ tenantId: uuid }).parse(request.params).tenantId, 'reactivate'));
  app.patch('/tenants/:tenantId/status', { preHandler: subscriptionManage }, async request => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const { action } = z.object({ action: z.enum(['suspend', 'reactivate']) }).parse(request.body);
    return setTenantStatus(request, tenantId, action);
  });

  // ===== Subscription / add-on / entitlement management ===================
  app.post('/tenants/:tenantId/subscription/change-plan', { preHandler: subscriptionManage }, async (request, reply) => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const body = z.object({ planKey: z.string().min(1).max(40), status: z.enum(['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED']).optional() }).parse(request.body);
    const existing = await db.tenantSubscription.findUnique({ where: { tenantId }, include: { plan: true } });
    try {
      await runPlatformAuditedMutation(request, {
        action: 'subscription.plan.changed', target: { type: 'tenant', id: tenantId, tenantId }, metadata: { fromPlan: existing?.plan.key ?? null, toPlan: body.planKey },
      }, tx => applySubscriptionChange(tenantId, body, tx));
    } catch (e) {
      if (['unknown_plan', 'no_plan'].includes((e as Error).message)) return reply.code(400).send({ error: (e as Error).message });
      throw e;
    }
    return tenantSummary(tenantId);
  });

  app.post('/tenants/:tenantId/addons', { preHandler: subscriptionManage }, async (request, reply) => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const body = z.object({ addonKey: z.string().min(1).max(40) }).parse(request.body);
    const sub = await db.tenantSubscription.findUnique({ where: { tenantId }, include: { addons: { where: { active: true }, include: { addon: true } } } });
    if (!sub) return reply.code(404).send({ error: 'not_found' });
    const current = sub.addons.map(a => a.addon.key);
    try {
      await runPlatformAuditedMutation(request, {
        action: 'subscription.addon.enabled', target: { type: 'tenant', id: tenantId, tenantId }, metadata: { addonKey: body.addonKey },
      }, tx => applySubscriptionChange(tenantId, { addonKeys: [...new Set([...current, body.addonKey])] }, tx));
    } catch (e) {
      if (['unknown_plan', 'no_plan'].includes((e as Error).message)) return reply.code(400).send({ error: (e as Error).message });
      throw e;
    }
    return tenantSummary(tenantId);
  });

  app.delete('/tenants/:tenantId/addons/:addonKey', { preHandler: subscriptionManage }, async (request, reply) => {
    const { tenantId, addonKey } = z.object({ tenantId: uuid, addonKey: z.string().min(1).max(40) }).parse(request.params);
    const sub = await db.tenantSubscription.findUnique({ where: { tenantId }, include: { addons: { where: { active: true }, include: { addon: true } } } });
    if (!sub) return reply.code(404).send({ error: 'not_found' });
    const remaining = sub.addons.map(a => a.addon.key).filter(k => k !== addonKey);
    await runPlatformAuditedMutation(request, {
      action: 'subscription.addon.disabled', target: { type: 'tenant', id: tenantId, tenantId }, metadata: { addonKey },
    }, tx => applySubscriptionChange(tenantId, { addonKeys: remaining }, tx));
    return tenantSummary(tenantId);
  });

  app.patch('/tenants/:tenantId/entitlements/:featureKey', { preHandler: tenantManage }, async request => {
    const { tenantId, featureKey } = z.object({ tenantId: uuid, featureKey: z.string().min(1).max(60) }).parse(request.params);
    const body = z.object({
      enabled: z.boolean(),
      // An override is nearly always temporary. The end date is optional
      // because a permanent one is sometimes right - but it has to be chosen,
      // not arrived at by nobody revisiting a pilot comp.
      expiresAt: dateOrNull,
      reason: z.string().trim().min(3).max(500).optional(),
    }).parse(request.body);
    const { enabled } = body;
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw app.httpErrors.badRequest('An override that has already expired grants nothing. Choose a future date, or leave it open-ended.');
    }
    const override = {
      enabled,
      source: 'platform_override',
      overrideEnabled: enabled,
      overrideExpiresAt: expiresAt,
      overrideReason: body.reason ?? null,
    };
    await runPlatformAuditedMutation(request, {
      action: 'entitlement.overridden',
      target: { type: 'tenant', id: tenantId, tenantId },
      metadata: { featureKey, enabled, expiresAt: expiresAt?.toISOString() ?? null, reason: body.reason ?? null },
    }, tx => tx.tenantFeatureEntitlement.upsert({
      where: { tenantId_featureKey: { tenantId, featureKey } },
      // overrideEnabled is the standing decision; enabled is the resolved answer
      // guards read. Recording both is what makes the override outlive a plan change.
      update: override,
      create: { tenantId, featureKey, limitValue: null, ...override },
    }));
    return { tenantId, featureKey, enabled, source: 'platform_override', expiresAt: expiresAt?.toISOString() ?? null, reason: body.reason ?? null };
  });

  // Legacy direct edit endpoint (kept for backward compatibility).
  app.patch('/tenants/:tenantId/subscription', { preHandler: subscriptionManage }, async (request, reply) => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const body = z.object({ planKey: z.string().min(1).max(40).optional(), status: z.enum(['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED']).optional(), addonKeys: z.array(z.string().min(1).max(40)).optional() }).parse(request.body);
    try {
      await runPlatformAuditedMutation(request, {
        action: 'subscription.plan.changed', target: { type: 'tenant', id: tenantId, tenantId }, metadata: { toPlan: body.planKey, status: body.status, addonKeys: body.addonKeys },
      }, tx => applySubscriptionChange(tenantId, body, tx));
    } catch (e) {
      if (['unknown_plan', 'no_plan'].includes((e as Error).message)) return reply.code(400).send({ error: (e as Error).message });
      throw e;
    }
    return tenantSummary(tenantId);
  });

  // ===== Subscription requests (approve/reject) ===========================
  async function reviewRequest(request: import('fastify').FastifyRequest, id: string, decision: 'approve' | 'reject', reviewerNote?: string) {
    type ReviewResult = { id: string; status: 'APPROVED' | 'REJECTED'; tenantId: string; requestedPlanKey: string | null; requestType: string };
    const reviewed = await runPlatformAuditedMutation(request, (result: ReviewResult) => ({
      action: result.status === 'APPROVED' ? 'subscription.request.approved' : 'subscription.request.rejected',
      target: { type: 'subscriptionRequest', id: result.id, tenantId: result.tenantId },
      metadata: {
        ...(reviewerNote ? { reviewerNote } : {}),
        toPlan: result.requestedPlanKey,
        requestType: result.requestType,
      },
    }), async (tx): Promise<ReviewResult> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'platform.subscription-request:' + id}, 0))`;
      const req = await tx.tenantSubscriptionRequest.findUnique({ where: { id }, include: { requestedPlan: true } });
      if (!req) throw app.httpErrors.notFound('Request not found');
      const claimed = await tx.tenantSubscriptionRequest.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: decision === 'approve' ? 'APPROVED' : 'REJECTED', reviewerNote },
      });
      if (claimed.count !== 1) throw app.httpErrors.conflict('Request already reviewed');
      if (decision === 'approve') {
        await applySubscriptionChange(req.tenantId, {
          planKey: req.requestedPlan?.key,
          addonKeys: req.requestType === 'ADDON_CHANGE' ? req.requestedAddonKeys : undefined,
          status: req.requestType === 'CANCEL' ? 'CANCELLED' : 'ACTIVE',
        }, tx);
      }
      return {
        id,
        status: decision === 'approve' ? 'APPROVED' : 'REJECTED',
        tenantId: req.tenantId,
        requestedPlanKey: req.requestedPlan?.key ?? null,
        requestType: req.requestType,
      };
    });
    return { id: reviewed.id, status: reviewed.status };
  }
  app.post('/subscription-requests/:id/approve', { preHandler: subscriptionManage }, async request => reviewRequest(request, z.object({ id: uuid }).parse(request.params).id, 'approve', z.object({ reviewerNote: z.string().max(1000).optional() }).parse(request.body ?? {}).reviewerNote));
  app.post('/subscription-requests/:id/reject', { preHandler: subscriptionManage }, async request => reviewRequest(request, z.object({ id: uuid }).parse(request.params).id, 'reject', z.object({ reviewerNote: z.string().max(1000).optional() }).parse(request.body ?? {}).reviewerNote));
  // Legacy combined endpoint.
  app.patch('/subscription-requests/:id', { preHandler: subscriptionManage }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { decision, reviewerNote } = z.object({ decision: z.enum(['approve', 'reject']), reviewerNote: z.string().max(1000).optional() }).parse(request.body);
    return reviewRequest(request, id, decision, reviewerNote);
  });

  // ===== Platform user management =========================================
  app.post('/users', { preHandler: userManage }, async (request, reply) => {
    const body = z.object({ email: z.string().email(), name: z.string().trim().min(2).max(120), password: z.string().min(8).max(200), role: z.enum(PLATFORM_ROLES) }).parse(request.body);
    if (body.role === 'PLATFORM_OWNER' && request.platformUser!.role !== 'PLATFORM_OWNER') throw app.httpErrors.forbidden('Only a PLATFORM_OWNER can create another PLATFORM_OWNER');
    const policy = validatePassword(body.password);
    if (!policy.ok) throw app.httpErrors.badRequest(policy.message ?? 'Weak password');
    if (await db.platformUser.findUnique({ where: { email: body.email } })) throw app.httpErrors.conflict('Email already in use');
    const passwordHash = await generatePasswordHash(body.password);
    const user = await runPlatformAuditedMutation(request, (created: Awaited<ReturnType<typeof db.platformUser.create>>) => ({
      action: 'platform.user.created', target: { type: 'platformUser', id: created.id }, metadata: { role: body.role },
    }), tx => tx.platformUser.create({ data: { email: body.email, name: body.name, passwordHash, role: body.role, status: 'active' } }));
    return reply.code(201).send({ id: user.id, email: user.email, name: user.name, role: user.role, status: user.status });
  });

  app.patch('/users/:id', { preHandler: userManage }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const body = z.object({ status: z.enum(['active', 'disabled', 'locked']).optional(), role: z.enum(PLATFORM_ROLES).optional() }).parse(request.body);
    if (body.role === 'PLATFORM_OWNER' && request.platformUser!.role !== 'PLATFORM_OWNER') throw app.httpErrors.forbidden('Only a PLATFORM_OWNER can grant PLATFORM_OWNER');
    const updated = await runPlatformAuditedMutation(request, {
      action: body.status && body.status !== 'active' ? 'platform.user.disabled' : 'platform.user.updated',
      target: { type: 'platformUser', id }, metadata: { status: body.status, role: body.role },
    }, async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('platform.active-owner.guard', 0))`;
      const target = await tx.platformUser.findUnique({ where: { id } });
      if (!target) throw app.httpErrors.notFound('Platform user not found');
      if (target.role === 'PLATFORM_OWNER' && request.platformUser!.role !== 'PLATFORM_OWNER') throw app.httpErrors.forbidden('Only a PLATFORM_OWNER can modify a PLATFORM_OWNER');
      const demoting = (body.status && body.status !== 'active') || (body.role && body.role !== 'PLATFORM_OWNER');
      if (target.role === 'PLATFORM_OWNER' && target.status === 'active' && demoting) {
        const owners = await tx.platformUser.count({ where: { role: 'PLATFORM_OWNER', status: 'active' } });
        if (owners <= 1) throw app.httpErrors.conflict('Cannot disable or demote the last active PLATFORM_OWNER');
      }
      return tx.platformUser.update({ where: { id }, data: { status: body.status, role: body.role } });
    });
    return { id: updated.id, email: updated.email, role: updated.role, status: updated.status };
  });

  // ===== Control Tower: Billing ==========================================
  async function ensureBilling(tenantId: string, client: PrismaClient | Prisma.TransactionClient = db) {
    const existing = await client.tenantBilling.findUnique({ where: { tenantId } });
    if (existing) return existing;
    const sub = await client.tenantSubscription.findUnique({ where: { tenantId }, include: { plan: true } });
    const mrr = Number(sub?.plan.monthlyPrice ?? 0);
    return client.tenantBilling.create({ data: { tenantId, mrr, currency: 'USD', cycle: 'monthly', paymentStatus: 'ok', renewalDate: sub?.currentPeriodEnd ?? sub?.trialEndsAt ?? new Date(Date.now() + 30 * 86400000), provider: 'manual' } });
  }
  function billingView(b: Awaited<ReturnType<typeof ensureBilling>>) {
    const mrr = Number(b.mrr);
    return { status: b.paymentStatus === 'failed' ? 'past_due' : 'active', cycle: b.cycle as 'monthly' | 'annual', currency: b.currency, mrr, arr: mrr * 12, renewalDate: b.renewalDate?.toISOString() ?? null, paymentStatus: b.paymentStatus, gracePeriodDays: b.gracePeriodDays, provider: b.provider };
  }
  app.get('/tenants/:tenantId/billing', async request => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    return billingView(await ensureBilling(tenantId));
  });
  app.patch('/tenants/:tenantId/billing', { preHandler: subscriptionManage }, async request => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const body = z.object({ cycle: z.enum(['monthly', 'annual']).optional(), paymentStatus: z.enum(['ok', 'failed', 'no_method']).optional(), gracePeriodDays: z.number().int().min(0).max(90).optional(), renewalDate: z.coerce.date().optional(), reason: reasonSchema }).parse(request.body);
    const updated = await runPlatformAuditedMutation(request, (result: { before: { cycle: string; paymentStatus: string } | null; updated: Awaited<ReturnType<typeof ensureBilling>> }) => ({
      action: 'billing.updated', target: { type: 'tenant', id: tenantId, tenantId },
      metadata: { reason: body.reason, before: result.before, after: { cycle: result.updated.cycle, paymentStatus: result.updated.paymentStatus } },
    }), async tx => {
      await ensureBilling(tenantId, tx);
      const before = await tx.tenantBilling.findUnique({ where: { tenantId }, select: { cycle: true, paymentStatus: true } });
      const updated = await tx.tenantBilling.update({ where: { tenantId }, data: { cycle: body.cycle, paymentStatus: body.paymentStatus, gracePeriodDays: body.gracePeriodDays, renewalDate: body.renewalDate } });
      return { before, updated };
    });
    return billingView(updated.updated);
  });
  app.post('/tenants/:tenantId/billing/extend-trial', { preHandler: subscriptionManage }, async request => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const body = z.object({ days: z.number().int().min(1).max(180), reason: reasonSchema }).parse(request.body);
    const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
    if (!sub) throw app.httpErrors.notFound('No subscription');
    const base = sub.trialEndsAt && sub.trialEndsAt > new Date() ? sub.trialEndsAt : new Date();
    const trialEndsAt = new Date(base.getTime() + body.days * 86400000);
    await runPlatformAuditedMutation(request, {
      action: 'billing.trial.extended', target: { type: 'tenant', id: tenantId, tenantId }, metadata: { reason: body.reason, days: body.days, trialEndsAt: trialEndsAt.toISOString() },
    }, async tx => {
      await tx.tenantSubscription.update({ where: { tenantId }, data: { trialEndsAt, status: 'TRIAL' } });
      await tx.tenantBilling.updateMany({ where: { tenantId }, data: { renewalDate: trialEndsAt } });
    });
    return { trialEndsAt: trialEndsAt.toISOString() };
  });

  // ===== Control Tower: Usage limits =====================================
  async function ensureUsageLimits(tenantId: string, client: PrismaClient | Prisma.TransactionClient = db) {
    const rows = await client.tenantUsageLimit.findMany({ where: { tenantId } });
    if (rows.length >= USAGE_KEYS.length) return rows;
    const have = new Set(rows.map(r => r.key));
    const { activeUsers, branches } = await tenantActivityCounts(tenantId, client);
    const usedFor = (k: string) => k === 'seats' ? activeUsers : k === 'locations' ? branches : 0;
    for (const k of USAGE_KEYS) if (!have.has(k)) {
      await client.tenantUsageLimit.create({ data: { tenantId, key: k, limitValue: USAGE_DEFAULTS[k].limit, used: usedFor(k) } });
    }
    return client.tenantUsageLimit.findMany({ where: { tenantId }, orderBy: { key: 'asc' } });
  }
  app.get('/tenants/:tenantId/usage-limits', async request => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const rows = await ensureUsageLimits(tenantId);
    // `used` on the row is a lifetime total. The limit is per billing period,
    // so report what the gates actually enforce against: this period's metered
    // usage. Keys with no meter behind them say so rather than showing a zero
    // an operator would read as "nothing used".
    const metered = await periodUsageByMetric(db, tenantId);
    const usedByLimitKey = new Map(
      Object.entries(metered).map(([metric, total]) => [USAGE_LIMIT_KEY_BY_METRIC[metric as keyof typeof USAGE_LIMIT_KEY_BY_METRIC] ?? metric, total]),
    );
    return {
      periodKey: usagePeriodKey(new Date()),
      rows: rows.map(r => ({
        key: r.key,
        used: usedByLimitKey.get(r.key) ?? 0,
        limit: r.limitValue,
        metered: usedByLimitKey.has(r.key),
        lifetimeUsed: r.used,
      })),
    };
  });
  app.patch('/tenants/:tenantId/usage-limits/:key', { preHandler: tenantManage }, async request => {
    const { tenantId, key } = z.object({ tenantId: uuid, key: z.enum(USAGE_KEYS) }).parse(request.params);
    const body = z.object({ limit: z.number().int().min(0).max(1_000_000).nullable() }).parse(request.body);
    const updated = await runPlatformAuditedMutation(request, {
      action: 'usage_limit.updated', target: { type: 'tenant', id: tenantId, tenantId }, metadata: { key, limit: body.limit },
    }, async tx => {
      await ensureUsageLimits(tenantId, tx);
      return tx.tenantUsageLimit.update({ where: { tenantId_key: { tenantId, key } }, data: { limitValue: body.limit } });
    });
    return { key: updated.key, used: updated.used, limit: updated.limitValue };
  });

  // ===== Control Tower: AI usage & kill switch ===========================
  async function ensureAiUsage(tenantId: string, client: PrismaClient | Prisma.TransactionClient = db) {
    const existing = await client.tenantAiUsage.findUnique({ where: { tenantId } });
    return existing ?? client.tenantAiUsage.create({ data: { tenantId, aiCreditsLimit: 1000, modelTier: 'standard' } });
  }
  app.get('/tenants/:tenantId/ai-usage', async request => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const a = await ensureAiUsage(tenantId);
    return { aiCreditsUsed: a.aiCreditsUsed, aiCreditsLimit: a.aiCreditsLimit, receptionistMinutes: a.receptionistMinutes, campaignGenerations: a.campaignGenerations, reportGenerations: a.reportGenerations, modelTier: a.modelTier, overageAllowed: a.overageAllowed, killSwitch: a.killSwitch };
  });
  app.patch('/tenants/:tenantId/ai-usage', { preHandler: tenantManage }, async request => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const body = z.object({ aiCreditsLimit: z.number().int().min(0).nullable().optional(), modelTier: z.enum(['standard', 'advanced', 'premium']).optional(), overageAllowed: z.boolean().optional() }).parse(request.body);
    const a = await runPlatformAuditedMutation(request, {
      action: 'ai_usage.updated', target: { type: 'tenant', id: tenantId, tenantId }, metadata: body,
    }, async tx => {
      await ensureAiUsage(tenantId, tx);
      return tx.tenantAiUsage.update({ where: { tenantId }, data: body });
    });
    return { modelTier: a.modelTier, aiCreditsLimit: a.aiCreditsLimit, overageAllowed: a.overageAllowed };
  });
  app.post('/tenants/:tenantId/ai-usage/kill-switch', { preHandler: tenantManage }, async request => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const body = z.object({ on: z.boolean(), reason: reasonSchema }).parse(request.body);
    const a = await runPlatformAuditedMutation(request, {
      action: body.on ? 'ai.kill_switch.enabled' : 'ai.kill_switch.disabled', target: { type: 'tenant', id: tenantId, tenantId }, metadata: { reason: body.reason },
    }, async tx => {
      await ensureAiUsage(tenantId, tx);
      return tx.tenantAiUsage.update({ where: { tenantId }, data: { killSwitch: body.on, killSwitchReason: body.on ? body.reason : null } });
    });
    return { killSwitch: a.killSwitch };
  });

  // ===== Control Tower: Security policy (platform-scoped) ================
  async function ensureSecurity(tenantId: string, client: PrismaClient | Prisma.TransactionClient = db) {
    const existing = await client.tenantSecurityPolicy.findUnique({ where: { tenantId } });
    return existing ?? client.tenantSecurityPolicy.create({ data: { tenantId } });
  }
  app.get('/tenants/:tenantId/security', async request => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const s = await ensureSecurity(tenantId);
    return { forceMfa: s.requireMfa, passwordExpiryDays: s.passwordExpiryDays, sessionTimeoutMinutes: s.sessionTimeoutMinutes, ipAllowlist: s.allowedIpRanges, failedLoginLockout: s.failedLoginLockout, sessionsRevokedAt: s.sessionsRevokedAt?.toISOString() ?? null };
  });
  app.patch('/tenants/:tenantId/security', { preHandler: tenantManage }, async request => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const body = z.object({ forceMfa: z.boolean().optional(), passwordExpiryDays: z.number().int().min(0).max(3650).nullable().optional(), sessionTimeoutMinutes: z.number().int().min(5).max(1440).optional(), failedLoginLockout: z.boolean().optional(), ipAllowlist: z.array(z.string().trim().max(64)).max(50).optional(), reason: reasonSchema }).parse(request.body);
    await runPlatformAuditedMutation(request, (s: Awaited<ReturnType<typeof ensureSecurity>>) => ({
      action: 'security.policy.updated', target: { type: 'tenant', id: tenantId, tenantId }, metadata: { reason: body.reason, forceMfa: s.requireMfa, sessionTimeoutMinutes: s.sessionTimeoutMinutes },
    }), async tx => {
      const existing = await ensureSecurity(tenantId, tx);
      const enablingMfa = body.forceMfa === true && !existing.requireMfa;
      const revokedAt = enablingMfa ? new Date() : undefined;
      if (enablingMfa) {
        await tx.user.updateMany({
          where: { tenantId },
          data: { refreshTokenHash: null, refreshTokenExpiresAt: null },
        });
      }
      return tx.tenantSecurityPolicy.update({
        where: { tenantId },
        data: {
          requireMfa: body.forceMfa,
          passwordExpiryDays: body.passwordExpiryDays,
          sessionTimeoutMinutes: body.sessionTimeoutMinutes,
          failedLoginLockout: body.failedLoginLockout,
          allowedIpRanges: body.ipAllowlist,
          sessionsRevokedAt: revokedAt,
        },
      });
    });
    return { ok: true };
  });
  app.post('/tenants/:tenantId/security/revoke-sessions', { preHandler: tenantManage }, async request => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const body = z.object({ reason: reasonSchema }).parse(request.body);
    const now = new Date();
    await runPlatformAuditedMutation(request, {
      action: 'security.sessions.revoked', target: { type: 'tenant', id: tenantId, tenantId }, metadata: { reason: body.reason, revokedAt: now.toISOString() },
    }, async tx => {
      await ensureSecurity(tenantId, tx);
      await tx.tenantSecurityPolicy.update({ where: { tenantId }, data: { sessionsRevokedAt: now } });
    });
    return { revokedAt: now.toISOString() };
  });

  // ===== Control Tower: Support access mode ==============================
  app.post('/tenants/:tenantId/support-session', { preHandler: tenantManage }, async request => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const body = z.object({ reason: reasonSchema, minutes: z.number().int().min(5).max(480).default(60) }).parse(request.body);
    const session = await runPlatformAuditedMutation(request, (created: Awaited<ReturnType<typeof db.supportAccessSession.create>>) => ({
      action: 'support.session.started', target: { type: 'tenant', id: tenantId, tenantId }, metadata: { reason: body.reason, minutes: body.minutes, sessionId: created.id },
    }), tx => tx.supportAccessSession.create({ data: { tenantId, platformUserId: request.platformUser?.id, operatorEmail: request.platformUser?.email, reason: body.reason, expiresAt: new Date(Date.now() + body.minutes * 60000) } }));
    return { id: session.id, tenantId, reason: session.reason, startedAt: session.startedAt.toISOString(), expiresAt: session.expiresAt.toISOString(), active: true };
  });
  app.get('/support-sessions', async () => {
    const rows = await db.supportAccessSession.findMany({ where: { endedAt: null, expiresAt: { gt: new Date() } }, orderBy: { startedAt: 'desc' }, take: 100 });
    return rows.map(s => ({ id: s.id, tenantId: s.tenantId, operatorEmail: s.operatorEmail, reason: s.reason, startedAt: s.startedAt.toISOString(), expiresAt: s.expiresAt.toISOString(), active: true }));
  });
  app.delete('/support-session/:id', { preHandler: tenantManage }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const s = await db.supportAccessSession.findUnique({ where: { id } });
    if (!s) throw app.httpErrors.notFound('Session not found');
    await runPlatformAuditedMutation(request, {
      action: 'support.session.ended', target: { type: 'tenant', id: s.tenantId, tenantId: s.tenantId }, metadata: { sessionId: id },
    }, tx => tx.supportAccessSession.update({ where: { id }, data: { endedAt: new Date() } }));
    return { id, ended: true };
  });

  // ===== Control Tower: Archive tenant (soft-delete) =====================
  app.post('/tenants/:tenantId/archive', { preHandler: tenantManage }, async request => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const body = z.object({ reason: reasonSchema }).parse(request.body);
    const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw app.httpErrors.notFound('Tenant not found');
    await runPlatformAuditedMutation(request, {
      action: 'tenant.archived', target: { type: 'tenant', id: tenantId, tenantId }, metadata: { reason: body.reason },
    }, async tx => {
      await tx.tenant.update({ where: { id: tenantId }, data: { status: 'archived' } });
      await tx.tenantSubscription.updateMany({ where: { tenantId }, data: { status: 'CANCELLED' } });
      await recomputeEntitlements(tenantId, tx);
    });
    return { tenantId, status: 'archived' };
  });

  // ===== Control Tower: Provider health + failed-job retry ===============
  app.get('/health/providers', async () => {
    const providers = [];
    for (const key of PROVIDER_KEYS) {
      const def = PROVIDERS[key];
      const { values, source } = resolveValues(key, def, await db.platformIntegration.findUnique({ where: { key } }));
      const ok = def.required.every(r => !!values[r]);
      providers.push({ key, label: def.label, status: ok ? 'ok' : 'setup_required', detail: ok ? `configured (${source})` : 'setup_required' });
    }
    let failedJobs: number;
    try { failedJobs = await withTimeout(autopilotQueue.getFailedCount(), 1000); } catch { failedJobs = -1; }
    return { providers, failedJobs };
  });
  // ===== Voice line: the mechanics the tenant no longer receives ==========
  //
  // Everything stripped out of the receptionist's tenant routes lands here.
  // The point of the split was never to delete the capability — support has to
  // be able to answer "what is actually published on this clinic's line?" —
  // only to stop the clinic reading our supply chain to do it. This surface is
  // behind the platform JWT, which a tenant token cannot mint.

  /**
   * The failure catalogue with the supplier instruction attached.
   *
   * A clinic that hits `tag_dynamic_variables_not_empty` now reads "your voice
   * line needs attention from CareCommand support" and a reference. This is
   * where the person they reach looks up what that actually means and what to
   * do in the provider console.
   */
  app.get('/voice-line/remediation', async () => ({
    provider: PROVIDERS.voice?.label ?? 'Voice',
    entries: platformRemediationCatalogue(),
  }));

  /**
   * One tenant's live voice-line mechanics: provider agent ids, published and
   * response-engine versions, the deployment tag, the webhook URL, every
   * fingerprint, and the `configurationReference` the tenant was shown — so a
   * support engineer can go from a quoted "LINE-4F2C91" to the exact row.
   */
  app.get('/tenants/:tenantId/voice-line', async request => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const [agents, deployments] = await Promise.all([
      db.receptionistAgent.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, clinicId: true, name: true, active: true, voice: true, language: true,
          providerAgentId: true, providerVersion: true, providerVersionTag: true, providerStatus: true,
          providerPublished: true, providerAssignedTags: true, providerVoiceId: true, providerLanguage: true,
          providerWebhookUrl: true, providerWebhookEvents: true, providerDataStorageSetting: true,
          providerSignedUrl: true, providerResponseEngineType: true, providerResponseEngineId: true,
          providerResponseEngineVersion: true, providerBookToolFingerprint: true,
          providerToolCallStrictMode: true, providerFingerprint: true, providerLastErrorCode: true,
          providerVerifiedAt: true, providerVerificationExpiresAt: true,
        },
      }),
      db.receptionistAgentDeployment.findMany({
        where: { tenantId },
        orderBy: { startedAt: 'desc' },
        take: 50,
      }),
    ]);
    return {
      provider: PROVIDERS.voice?.label ?? 'Voice',
      agents,
      deployments: deployments.map(row => ({
        ...platformDeploymentProjection(row),
        campaignId: row.campaignId,
        agentId: row.agentId,
      })),
    };
  });

  app.post('/health/retry-jobs', { preHandler: tenantManage }, async (request, reply) => {
    const body = z.object({ queue: z.literal('autopilot').default('autopilot') }).parse(request.body ?? {});
    let failed: Awaited<ReturnType<typeof autopilotQueue.getFailed>>;
    try {
      failed = await withTimeout(autopilotQueue.getFailed(0, 100), 2000);
    } catch {
      throw app.httpErrors.serviceUnavailable('Failed job queue is unavailable');
    }
    const operationId = request.id;
    await platformAuditEvent(request, 'health.jobs.retry.requested', { type: 'platform', id: body.queue }, { operationId, selected: failed.length });
    let retried = 0;
    let retryFailed = 0;
    for (const job of failed) {
      try {
        await job.retry();
        retried++;
      } catch {
        retryFailed++;
      }
    }
    await platformAuditEvent(request, 'health.jobs.retried', { type: 'platform', id: body.queue }, { operationId, selected: failed.length, retried, failed: retryFailed });
    const result = { queue: body.queue, selected: failed.length, retried, failed: retryFailed };
    return retryFailed > 0 ? reply.code(502).send(result) : result;
  });

  // ===== Control Tower: Announcements ====================================
  app.get('/announcements', async () => {
    const rows = await db.platformAnnouncement.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map(a => ({ id: a.id, title: a.title, body: a.body, severity: a.severity, audience: a.audience, active: a.active, createdByName: a.createdByName, createdAt: a.createdAt.toISOString() }));
  });
  app.post('/announcements', { preHandler: tenantManage }, async request => {
    const body = z.object({ title: z.string().trim().min(2).max(160), body: z.string().trim().min(2).max(4000), severity: z.enum(['info', 'warning', 'critical']).default('info'), audience: z.enum(['all', 'operators', 'tenants']).default('all') }).parse(request.body);
    const a = await runPlatformAuditedMutation(request, (created: Awaited<ReturnType<typeof db.platformAnnouncement.create>>) => ({
      action: 'announcement.created', target: { type: 'platform', id: created.id }, metadata: { severity: created.severity },
    }), tx => tx.platformAnnouncement.create({ data: { ...body, createdById: request.platformUser?.id, createdByName: request.platformUser?.email } }));
    return { id: a.id, title: a.title, body: a.body, severity: a.severity, audience: a.audience, active: a.active, createdByName: a.createdByName, createdAt: a.createdAt.toISOString() };
  });
  app.patch('/announcements/:id', { preHandler: tenantManage }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const body = z.object({ active: z.boolean().optional() }).parse(request.body);
    const a = await runPlatformAuditedMutation(request, (updated: Awaited<ReturnType<typeof db.platformAnnouncement.update>>) => ({
      action: 'announcement.updated', target: { type: 'platform', id: updated.id }, metadata: { active: updated.active },
    }), tx => tx.platformAnnouncement.update({ where: { id }, data: { active: body.active } }));
    return { id: a.id, active: a.active };
  });

  // ===== Control Tower: Platform Settings (global, singleton) ============
  // Presets are a starting point, never a lock: applying one fills the form,
  // and every field stays editable afterwards. They live on the server so the
  // console has no hardcoded catalog of its own.
  app.get('/settings/presets', async () => ({ presets: PLATFORM_SETTING_PRESETS }));
  app.get('/settings', async () => settingsView(await ensureConfig()));
  app.patch('/settings', { preHandler: tenantManage }, async request => {
    const body = z.object({
      platformName: z.string().trim().min(2).max(80).optional(),
      supportEmail: z.string().email().trim().nullable().optional(),
      defaultTrialDays: z.number().int().min(0).max(365).optional(),
      defaultPlanKey: z.string().trim().max(40).optional(),
      defaultTimezone: timezoneInput.optional(),
      defaultCountry: z.string().trim().length(2).toUpperCase().optional(),
      defaultBranchName: z.string().trim().min(2).max(160).optional(),
      defaultVoiceMinutes: z.number().int().min(0).max(1_000_000).optional(),
      requireMfaFloor: z.boolean().optional(),
      sessionTimeoutMaxMinutes: z.number().int().min(5).max(1440).optional(),
      requireOperatorMfa: z.boolean().optional(),
      presetKey: z.string().trim().max(40).optional(),
    }).parse(request.body);
    if (body.defaultPlanKey && !(await db.subscriptionPlan.findUnique({ where: { key: body.defaultPlanKey } }))) throw app.httpErrors.badRequest('Unknown plan');
    if (body.presetKey && body.presetKey !== 'custom' && !PLATFORM_SETTING_PRESETS.some(p => p.key === body.presetKey)) throw app.httpErrors.badRequest('Unknown preset');
    const c = await runPlatformAuditedMutation(request, {
      action: 'settings.updated', target: { type: 'platform', id: 'config' }, metadata: body,
    }, async tx => {
      await ensureConfig(tx);
      return tx.platformConfig.update({ where: { id: 'singleton' }, data: { ...body, updatedById: request.platformUser?.id } });
    });
    return settingsView(c);
  });

  // ===== Control Tower: Integrations (encrypted credential store) ========
  // Built-in providers come from PROVIDERS; operators can also add custom
  // services (row.isCustom with a stored fieldSchema). UI-saved config (DB,
  // encrypted) wins; built-ins fall back to server env.
  type IntegrationRow = NonNullable<Awaited<ReturnType<typeof db.platformIntegration.findUnique>>>;
  function defFor(key: string, row: IntegrationRow | null): ProviderDef | null {
    if (PROVIDERS[key]) return PROVIDERS[key];
    if (row?.isCustom && Array.isArray(row.fieldSchema)) {
      const fields = (row.fieldSchema as Array<{ k: string; label: string; secret?: boolean; required?: boolean }>).map(f => ({ k: f.k, label: f.label, secret: !!f.secret }));
      return { label: row.label ?? key, fields, required: (row.fieldSchema as Array<{ k: string; required?: boolean }>).filter(f => f.required).map(f => f.k), env: {} };
    }
    return null;
  }
  function decryptConfig(row: IntegrationRow | null): Record<string, string> {
    if (!row?.configEnc) return {};
    try { return JSON.parse(decryptSecret(row.configEnc) ?? '{}') as Record<string, string>; } catch { return {}; }
  }
  function resolveValues(key: string, def: ProviderDef, row: IntegrationRow | null): { values: Record<string, string>; source: 'db' | 'env' | null } {
    // Catalog providers resolve exactly the way a sender resolves them, so the
    // badge cannot say "connected - via db" over a credential the product will
    // not use. Custom services have no sender and no env, so they answer from
    // their own row.
    if (PROVIDERS[key]) return providerConfig(key);
    if (row?.configEnc) { const v = decryptConfig(row); if (Object.keys(v).length) return { values: v, source: 'db' }; }
    return { values: {}, source: null };
  }
  function viewFor(key: string, def: ProviderDef, row: IntegrationRow | null) {
    const { values, source } = resolveValues(key, def, row);
    const configured = def.required.length > 0 && def.required.every(r => !!values[r]);
    return {
      key, label: def.label, isCustom: !!row?.isCustom, source,
      status: configured ? 'connected' : 'disconnected',
      fields: def.fields.map(f => { const v = values[f.k]; return { key: f.k, label: f.label, secret: f.secret, isSet: !!v, masked: !v ? null : f.secret ? `••••${v.slice(-4)}` : v }; }),
      required: def.required,
      lastTestAt: row?.lastTestAt?.toISOString() ?? null, lastTestStatus: row?.lastTestStatus ?? null, lastTestDetail: row?.lastTestDetail ?? null,
    };
  }
  async function loadRow(key: string) { return db.platformIntegration.findUnique({ where: { key } }); }

  app.get('/integrations', async () => {
    const rows = await db.platformIntegration.findMany();
    const byKey = new Map(rows.map(r => [r.key, r]));
    const out = [];
    for (const key of PROVIDER_KEYS) out.push(viewFor(key, PROVIDERS[key], byKey.get(key) ?? null));
    for (const row of rows.filter(r => r.isCustom)) { const def = defFor(row.key, row); if (def) out.push(viewFor(row.key, def, row)); }
    return out;
  });

  // Add a custom service (name + its configuration fields + initial values).
  app.post('/integrations', { preHandler: tenantManage }, async request => {
    const body = z.object({
      label: z.string().trim().min(2).max(60),
      fields: z.array(z.object({ label: z.string().trim().min(1).max(60), secret: z.boolean().default(false), required: z.boolean().default(true), value: z.string().max(2000).optional() })).min(1).max(20),
    }).parse(request.body);
    const key = `custom_${body.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)}_${Math.random().toString(36).slice(2, 6)}`;
    const schema = body.fields.map((f, i) => ({ k: `f${i}_${f.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 24)}`, label: f.label, secret: f.secret, required: f.required }));
    const values: Record<string, string> = {};
    schema.forEach((s, i) => { const v = body.fields[i].value?.trim(); if (v) values[s.k] = v; });
    const configured = schema.filter(s => s.required).every(s => !!values[s.k]);
    await runPlatformAuditedMutation(request, {
      action: 'integration.service.created', target: { type: 'integration', id: key }, metadata: { label: body.label, fields: schema.map(s => s.label) },
    }, tx => tx.platformIntegration.create({ data: { key, label: body.label, isCustom: true, fieldSchema: schema, configEnc: Object.keys(values).length ? encryptSecret(JSON.stringify(values)) : null, setFields: Object.keys(values), status: configured ? 'connected' : 'disconnected', updatedById: request.platformUser?.id } }));
    return viewFor(key, defFor(key, await loadRow(key))!, await loadRow(key));
  });

  // Add a new configuration field to an existing custom service.
  app.patch('/integrations/:key/fields', { preHandler: tenantManage }, async request => {
    const { key } = z.object({ key: z.string().min(1).max(80) }).parse(request.params);
    const body = z.object({ label: z.string().trim().min(1).max(60), secret: z.boolean().default(false), required: z.boolean().default(false) }).parse(request.body);
    const row = await loadRow(key);
    if (!row?.isCustom) throw app.httpErrors.badRequest('Only custom services support adding fields');
    const schema = (row.fieldSchema as Array<{ k: string; label: string; secret: boolean; required: boolean }>) ?? [];
    schema.push({ k: `f${schema.length}_${body.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 24)}`, label: body.label, secret: body.secret, required: body.required });
    await runPlatformAuditedMutation(request, {
      action: 'integration.field.added', target: { type: 'integration', id: key }, metadata: { label: body.label },
    }, tx => tx.platformIntegration.update({ where: { key }, data: { fieldSchema: schema } }));
    return viewFor(key, defFor(key, await loadRow(key))!, await loadRow(key));
  });

  app.put('/integrations/:key', { preHandler: tenantManage }, async request => {
    const { key } = z.object({ key: z.string().min(1).max(80) }).parse(request.params);
    const row = await loadRow(key);
    const def = defFor(key, row);
    if (!def) throw app.httpErrors.notFound('Unknown integration');
    const allowed = new Set(def.fields.map(f => f.k));
    const body = z.object({ fields: z.record(z.string(), z.string().max(2000)) }).parse(request.body);
    const current = decryptConfig(row);
    for (const [k, v] of Object.entries(body.fields)) { if (!allowed.has(k)) continue; if (v.trim() === '') delete current[k]; else current[k] = v.trim(); }
    const setFields = Object.keys(current);
    const configured = def.required.length > 0 && def.required.every(r => !!current[r]);
    const configEnc = setFields.length ? encryptSecret(JSON.stringify(current)) : null;
    await runPlatformAuditedMutation(request, {
      action: 'integration.updated', target: { type: 'integration', id: key }, metadata: { fields: Object.keys(body.fields), configured },
    }, tx => tx.platformIntegration.upsert({
      where: { key },
      update: { configEnc, setFields, status: configured ? 'connected' : 'disconnected', updatedById: request.platformUser?.id },
      create: { key, configEnc, setFields, status: configured ? 'connected' : 'disconnected', updatedById: request.platformUser?.id },
    }));
    // The senders read a cached snapshot; a save that does not invalidate it
    // would leave the console green and the product on the old credential.
    invalidateProviderCredentials();
    await refreshProviderCredentials();
    const fresh = await loadRow(key);
    return viewFor(key, defFor(key, fresh)!, fresh);
  });

  app.delete('/integrations/:key', { preHandler: tenantManage }, async request => {
    const { key } = z.object({ key: z.string().min(1).max(80) }).parse(request.params);
    const row = await loadRow(key);
    await runPlatformAuditedMutation(request, {
      action: row?.isCustom ? 'integration.service.deleted' : 'integration.disconnected', target: { type: 'integration', id: key }, metadata: {},
    }, tx => tx.platformIntegration.deleteMany({ where: { key } }));
    invalidateProviderCredentials();
    await refreshProviderCredentials();
    // Built-ins revert to env fallback; custom services are gone.
    if (PROVIDERS[key]) return viewFor(key, PROVIDERS[key], null);
    return { key, deleted: true };
  });

  app.post('/integrations/:key/test', { preHandler: tenantManage }, async request => {
    const { key } = z.object({ key: z.string().min(1).max(80) }).parse(request.params);
    const row = await loadRow(key);
    const def = defFor(key, row);
    if (!def) throw app.httpErrors.notFound('Unknown integration');
    const { values } = resolveValues(key, def, row);
    const missing = def.required.filter(r => !values[r]);
    let status = 'ok'; let detail: string;
    if (def.required.length && missing.length) { status = 'failed'; detail = `Missing: ${missing.join(', ')}`; }
    else {
      try {
        if (key === 'payments') {
          const res = await withTimeout(fetch('https://api.stripe.com/v1/balance', { headers: { Authorization: `Bearer ${values.secretKey}` } }), 4000);
          status = res.ok ? 'ok' : 'failed'; detail = res.ok ? 'Stripe API reachable' : `Stripe returned ${res.status}`;
        } else if (key === 'sms') {
          const auth = Buffer.from(`${values.accountSid}:${values.authToken}`).toString('base64');
          const res = await withTimeout(fetch(`https://api.twilio.com/2010-04-01/Accounts/${values.accountSid}.json`, { headers: { Authorization: `Basic ${auth}` } }), 4000);
          status = res.ok ? 'ok' : 'failed'; detail = res.ok ? 'Twilio account reachable' : `Twilio returned ${res.status}`;
        } else if (key === 'voice') {
          // Retell has no cheap unauthenticated probe, but listing agents proves
          // the key is accepted. Previously this branch reported "ok" for any
          // provider without a ping, so "Voice (Retell) - test ok" meant only
          // "two fields are non-empty".
          const res = await withTimeout(fetch('https://api.retellai.com/list-agents', { headers: { Authorization: `Bearer ${values.apiKey}` } }), 4000);
          status = res.ok ? 'ok' : 'failed';
          detail = res.ok ? 'Retell API accepted the key' : `Retell returned ${res.status}`;
        } else {
          // Say what was actually established. Reporting "ok" for an unverified
          // credential is the failure mode this whole change exists to remove.
          status = 'not_verified';
          detail = 'Credentials are present. This provider has no connection test, so nothing has been verified.';
        }
      } catch (e) { status = 'failed'; detail = `Connection error: ${(e as Error).message.slice(0, 80)}`; }
    }
    await runPlatformAuditedMutation(request, {
      action: 'integration.tested', target: { type: 'integration', id: key }, metadata: { status },
    }, tx => tx.platformIntegration.upsert({ where: { key }, update: { lastTestAt: new Date(), lastTestStatus: status, lastTestDetail: detail }, create: { key, lastTestAt: new Date(), lastTestStatus: status, lastTestDetail: detail } }));
    return { key, status, detail, testedAt: new Date().toISOString() };
  });

  // ===== Control Tower: Audit CSV export =================================
  app.get('/audit/export.csv', async (request, reply) => {
    const q = z.object({ tenantId: uuid.optional(), action: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(5000).default(1000) }).parse(request.query);
    const rows = await db.platformAuditEvent.findMany({ where: { tenantId: q.tenantId, action: q.action ? { contains: q.action } : undefined }, orderBy: { createdAt: 'desc' }, take: q.limit });
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = 'createdAt,action,targetType,targetId,tenantId,metadata';
    const lines = rows.map(r => [r.createdAt.toISOString(), r.action, r.targetType, r.targetId ?? '', r.tenantId ?? '', JSON.stringify(r.metadata ?? {})].map(esc).join(','));
    await platformAuditEvent(request, 'audit.exported', { type: 'platform', id: 'audit' }, { count: rows.length });
    reply.header('Content-Type', 'text/csv').header('Content-Disposition', 'attachment; filename="platform-audit.csv"');
    return [header, ...lines].join('\n');
  });
};
