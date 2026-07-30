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

const timezoneInput = z.string().trim().min(1).max(80).refine(value => {
  try { validateIanaTimezone(value); return true; } catch { return false; }
}, { message: 'timezone must be a valid IANA timezone identifier' });

// Integration provider catalog. `env` is the fallback config source; UI-saved
// credentials live encrypted in PlatformIntegration and take precedence.
interface ProviderField { k: string; label: string; secret: boolean }
interface ProviderDef { label: string; fields: ProviderField[]; required: string[]; env: Record<string, keyof typeof env> }
const PROVIDERS: Record<string, ProviderDef> = {
  sms: { label: 'SMS (Twilio)', required: ['accountSid', 'authToken', 'fromNumber'],
    fields: [{ k: 'accountSid', label: 'Account SID', secret: false }, { k: 'authToken', label: 'Auth Token', secret: true }, { k: 'fromNumber', label: 'From Number', secret: false }],
    env: { accountSid: 'TWILIO_ACCOUNT_SID', authToken: 'TWILIO_AUTH_TOKEN', fromNumber: 'TWILIO_FROM_NUMBER' } },
  email: { label: 'Email (HTTP API)', required: ['apiUrl', 'apiKey'],
    fields: [{ k: 'apiUrl', label: 'API URL', secret: false }, { k: 'apiKey', label: 'API Key', secret: true }, { k: 'fromAddress', label: 'From Address', secret: false }],
    env: { apiUrl: 'EMAIL_HTTP_API_URL', apiKey: 'EMAIL_HTTP_API_KEY', fromAddress: 'EMAIL_FROM_ADDRESS' } },
  payments: { label: 'Payments (Stripe)', required: ['secretKey'],
    fields: [{ k: 'secretKey', label: 'Secret Key', secret: true }],
    env: { secretKey: 'STRIPE_SECRET_KEY' } },
  payments_webhook: { label: 'Payment webhook', required: ['webhookSecret'],
    fields: [{ k: 'webhookSecret', label: 'Webhook Secret', secret: true }],
    env: { webhookSecret: 'STRIPE_WEBHOOK_SECRET' } },
  insurance: { label: 'Insurance (Stedi)', required: ['apiKey'],
    fields: [{ k: 'apiKey', label: 'API Key', secret: true }],
    env: { apiKey: 'STEDI_API_KEY' } },
  voice: { label: 'Voice (Retell)', required: ['apiKey', 'agentId', 'fromNumber'],
    fields: [{ k: 'apiKey', label: 'API Key', secret: true }, { k: 'agentId', label: 'Agent ID', secret: false }, { k: 'fromNumber', label: 'From Number', secret: false }],
    env: { apiKey: 'RETELL_API_KEY', agentId: 'RETELL_AGENT_ID', fromNumber: 'RETELL_FROM_NUMBER' } },
};
const PROVIDER_KEYS = Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS & string>;

const reasonSchema = z.string().trim().min(3).max(500);
const USAGE_KEYS = ['seats', 'locations', 'storage_gb', 'sms', 'voice_minutes', 'ai_credits', 'devices'] as const;
const USAGE_DEFAULTS: Record<string, { limit: number | null }> = {
  seats: { limit: 25 }, locations: { limit: 5 }, storage_gb: { limit: 50 }, sms: { limit: 1000 },
  voice_minutes: { limit: 500 }, ai_credits: { limit: 1000 }, devices: { limit: 25 },
};

const uuid = z.string().uuid();

async function withTimeout<T>(op: Promise<T>, ms: number): Promise<T> {
  return Promise.race([op, new Promise<T>((_r, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

async function tenantActivityCounts(tenantId: string, client: PrismaClient | Prisma.TransactionClient = db): Promise<{ activeUsers: number; branches: number }> {
  const rows = await client.$queryRaw<Array<{ active_users: bigint; branches: bigint }>>`
    SELECT active_users, branches FROM app_platform_tenant_activity(${tenantId}::uuid)
  `;
  return { activeUsers: Number(rows[0]?.active_users ?? 0), branches: Number(rows[0]?.branches ?? 0) };
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
  return subscription;
}

async function tenantSummary(tenantId: string) {
  const [tenant, sub, activity, enabledCount] = await Promise.all([
    db.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, slug: true, status: true, createdAt: true, updatedAt: true } }),
    db.tenantSubscription.findUnique({ where: { tenantId }, include: { plan: true, addons: { where: { active: true }, include: { addon: true } } } }),
    tenantActivityCounts(tenantId),
    db.tenantFeatureEntitlement.count({ where: { tenantId, enabled: true } }),
  ]);
  return {
    tenant: tenant ? { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status, createdAt: tenant.createdAt.toISOString(), lastActivityAt: tenant.updatedAt.toISOString() } : null,
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

  app.get('/subscriptions/addons', async () => {
    const addons = await db.subscriptionAddon.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
    return addons.map(a => ({ key: a.key, name: a.name, featureKey: a.featureKey }));
  });

  app.get('/tenants/:tenantId', async (request, reply) => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const summary = await tenantSummary(tenantId);
    if (!summary.tenant) return reply.code(404).send({ error: 'not_found', message: 'Tenant not found' });
    const entitlements = await db.tenantFeatureEntitlement.findMany({ where: { tenantId }, orderBy: { featureKey: 'asc' }, select: { featureKey: true, enabled: true, source: true, limitValue: true } });
    return { ...summary, entitlements };
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
      slug: z.string().trim().min(2).max(80),
      planKey: z.string().min(1).max(40).optional(),
      ownerName: z.string().trim().min(2).max(120),
      ownerEmail: z.string().email().trim().toLowerCase(),
      ownerPassword: z.string().min(1).max(200),
      defaultBranchName: z.string().trim().min(2).max(160).optional(),
      timezone: timezoneInput.optional(),
    }).parse(request.body);
    if (await db.tenant.findUnique({ where: { slug: body.slug } })) throw app.httpErrors.conflict('Slug already in use');
    // Apply global platform defaults (default plan + trial length) from settings.
    const cfg = await db.platformConfig.findUnique({ where: { id: 'singleton' } });
    try {
      const result = await runPlatformAuditedMutation(request, (provisioned: Awaited<ReturnType<typeof platformProvisionTenant>>) => ({
        action: 'tenant.created',
        target: { type: 'tenant', id: provisioned.tenant.id, tenantId: provisioned.tenant.id },
        metadata: { name: body.name, planKey: body.planKey },
      }), tx => platformProvisionTenant({
        clinicName: body.name, clinicSlug: body.slug,
        ownerName: body.ownerName, ownerEmail: body.ownerEmail, ownerPassword: body.ownerPassword,
        defaultBranchName: body.defaultBranchName ?? 'Main Branch',
        timezone: body.timezone, planKey: body.planKey ?? cfg?.defaultPlanKey ?? 'starter',
        trialDays: cfg?.defaultTrialDays ?? env.TRIAL_DAYS,
      }, tx));
      return reply.code(201).send(await tenantSummary(result.tenant.id));
    } catch (error) {
      if (error instanceof PlatformProvisionError) throw app.httpErrors.badRequest(error.message);
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
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
    await runPlatformAuditedMutation(request, {
      action: 'entitlement.overridden', target: { type: 'tenant', id: tenantId, tenantId }, metadata: { featureKey, enabled },
    }, tx => tx.tenantFeatureEntitlement.upsert({
      where: { tenantId_featureKey: { tenantId, featureKey } },
      update: { enabled, source: 'platform_override' },
      create: { tenantId, featureKey, enabled, source: 'platform_override', limitValue: null },
    }));
    return { tenantId, featureKey, enabled, source: 'platform_override' };
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
    return rows.map(r => ({ key: r.key, used: r.used, limit: r.limitValue }));
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
      await ensureSecurity(tenantId, tx);
      return tx.tenantSecurityPolicy.update({ where: { tenantId }, data: { requireMfa: body.forceMfa, passwordExpiryDays: body.passwordExpiryDays, sessionTimeoutMinutes: body.sessionTimeoutMinutes, failedLoginLockout: body.failedLoginLockout, allowedIpRanges: body.ipAllowlist } });
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
  async function ensureConfig(client: PrismaClient | Prisma.TransactionClient = db) {
    return (await client.platformConfig.findUnique({ where: { id: 'singleton' } }))
      ?? client.platformConfig.create({ data: { id: 'singleton' } });
  }
  app.get('/settings', async () => {
    const c = await ensureConfig();
    return { platformName: c.platformName, supportEmail: c.supportEmail, defaultTrialDays: c.defaultTrialDays, defaultPlanKey: c.defaultPlanKey, updatedAt: c.updatedAt.toISOString() };
  });
  app.patch('/settings', { preHandler: tenantManage }, async request => {
    const body = z.object({
      platformName: z.string().trim().min(2).max(80).optional(),
      supportEmail: z.string().email().trim().nullable().optional(),
      defaultTrialDays: z.number().int().min(0).max(365).optional(),
      defaultPlanKey: z.string().trim().max(40).optional(),
    }).parse(request.body);
    if (body.defaultPlanKey && !(await db.subscriptionPlan.findUnique({ where: { key: body.defaultPlanKey } }))) throw app.httpErrors.badRequest('Unknown plan');
    const c = await runPlatformAuditedMutation(request, {
      action: 'settings.updated', target: { type: 'platform', id: 'config' }, metadata: body,
    }, async tx => {
      await ensureConfig(tx);
      return tx.platformConfig.update({ where: { id: 'singleton' }, data: { ...body, updatedById: request.platformUser?.id } });
    });
    return { platformName: c.platformName, supportEmail: c.supportEmail, defaultTrialDays: c.defaultTrialDays, defaultPlanKey: c.defaultPlanKey, updatedAt: c.updatedAt.toISOString() };
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
    if (row?.configEnc) { const v = decryptConfig(row); if (Object.keys(v).length) return { values: v, source: 'db' }; }
    if (PROVIDERS[key]) {
      const values: Record<string, string> = {};
      for (const f of def.fields) { const ev = env[def.env[f.k]] as string | undefined; if (ev) values[f.k] = ev; }
      if (Object.keys(values).length) return { values, source: 'env' };
    }
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
    const fresh = await loadRow(key);
    return viewFor(key, defFor(key, fresh)!, fresh);
  });

  app.delete('/integrations/:key', { preHandler: tenantManage }, async request => {
    const { key } = z.object({ key: z.string().min(1).max(80) }).parse(request.params);
    const row = await loadRow(key);
    await runPlatformAuditedMutation(request, {
      action: row?.isCustom ? 'integration.service.deleted' : 'integration.disconnected', target: { type: 'integration', id: key }, metadata: {},
    }, tx => tx.platformIntegration.deleteMany({ where: { key } }));
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
        } else {
          detail = 'Credentials present (no live ping for this provider)';
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
