import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { requireRoles } from '../../plugins/roles';
import { FEATURE_LABELS } from './catalog';

const ownerAdminRoles = requireRoles('OWNER', 'ADMIN');

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function loadCurrent(tenantId: string) {
  return db.tenantSubscription.findUnique({
    where: { tenantId },
    include: {
      plan: { include: { features: { orderBy: { featureKey: 'asc' } } } },
      addons: { include: { addon: true } },
    },
  });
}

export const subscriptionRoutes: FastifyPluginAsync = async app => {
  // ----- Catalog (any authenticated user) ---------------------------------
  app.get('/plans', async () => {
    const plans = await db.subscriptionPlan.findMany({
      where: { active: true },
      orderBy: { tier: 'asc' },
      include: { features: { orderBy: { featureKey: 'asc' } } },
    });
    return plans.map(plan => ({
      key: plan.key, name: plan.name, description: plan.description, tier: plan.tier,
      monthlyPrice: toNumber(plan.monthlyPrice),
      features: plan.features.map(f => ({ featureKey: f.featureKey, label: FEATURE_LABELS[f.featureKey] ?? f.featureKey, included: f.included, limitValue: f.limitValue, note: f.note })),
    }));
  });

  // ----- Current tenant subscription --------------------------------------
  app.get('/current', async request => {
    const sub = await loadCurrent(request.auth.tenantId);
    if (!sub) {
      return { status: 'none', plan: null, addons: [], note: 'No active subscription. Contact your administrator.' };
    }
    return {
      status: sub.status,
      plan: { key: sub.plan.key, name: sub.plan.name, tier: sub.plan.tier, description: sub.plan.description },
      trialEndsAt: sub.trialEndsAt?.toISOString() ?? null,
      currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
      startedAt: sub.startedAt.toISOString(),
      addons: sub.addons.map(a => ({ key: a.addon.key, name: a.addon.name, featureKey: a.addon.featureKey, active: a.active, quantity: a.quantity })),
    };
  });

  // ----- Resolved feature entitlements (the availability matrix) ----------
  app.get('/features', async request => {
    const rows = await db.tenantFeatureEntitlement.findMany({ where: { tenantId: request.auth.tenantId }, orderBy: { featureKey: 'asc' } });
    return rows.map(r => ({ featureKey: r.featureKey, label: FEATURE_LABELS[r.featureKey] ?? r.featureKey, enabled: r.enabled, source: r.source, limitValue: r.limitValue }));
  });

  app.get('/feature/:featureKey', async request => {
    const { featureKey } = z.object({ featureKey: z.string().min(1).max(60) }).parse(request.params);
    const ent = await db.tenantFeatureEntitlement.findUnique({ where: { tenantId_featureKey: { tenantId: request.auth.tenantId, featureKey } } });
    return { featureKey, label: FEATURE_LABELS[featureKey] ?? featureKey, enabled: Boolean(ent?.enabled), source: ent?.source ?? null, limitValue: ent?.limitValue ?? null };
  });

  // ----- Tenant-admin management (NOT platform superadmin) -----------------
  // Operates ONLY on the caller's own tenant (request.auth.tenantId). Cross-
  // tenant plan management requires the future platform SuperAdmin, which does
  // not exist yet.
  app.get('/admin/overview', { preHandler: ownerAdminRoles }, async request => {
    const [current, plans, addons, entitlements] = await Promise.all([
      loadCurrent(request.auth.tenantId),
      db.subscriptionPlan.findMany({ where: { active: true }, orderBy: { tier: 'asc' }, include: { features: true } }),
      db.subscriptionAddon.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
      db.tenantFeatureEntitlement.findMany({ where: { tenantId: request.auth.tenantId }, orderBy: { featureKey: 'asc' } }),
    ]);
    const activeAddonKeys = new Set((current?.addons ?? []).filter(a => a.active).map(a => a.addon.key));
    return {
      scope: 'tenant-admin',
      note: 'You are managing your own clinic tenant. Platform-wide (cross-tenant) management requires a platform SuperAdmin, which is not available yet.',
      current: current ? { status: current.status, planKey: current.plan.key } : null,
      plans: plans.map(p => ({ key: p.key, name: p.name, tier: p.tier, description: p.description, featureKeys: p.features.filter(f => f.included).map(f => f.featureKey) })),
      addons: addons.map(a => ({ key: a.key, name: a.name, description: a.description, featureKey: a.featureKey, active: activeAddonKeys.has(a.key) })),
      entitlements: entitlements.map(e => ({ featureKey: e.featureKey, label: FEATURE_LABELS[e.featureKey] ?? e.featureKey, enabled: e.enabled, source: e.source, limitValue: e.limitValue })),
    };
  });

  // Tenant admins can no longer change their own plan directly (no free
  // self-upgrade). A change creates a request for platform-operator approval.
  async function createRequest(tenantId: string, userId: string, body: { planKey?: string; addonKeys?: string[]; requestType?: string; notes?: string }) {
    const current = await db.tenantSubscription.findUnique({ where: { tenantId }, include: { plan: true } });
    let requestedPlanId: string | null = null;
    let type = body.requestType;
    if (body.planKey) {
      const plan = await db.subscriptionPlan.findUnique({ where: { key: body.planKey } });
      if (!plan) throw app.httpErrors.badRequest('Unknown plan');
      requestedPlanId = plan.id;
      if (!type) type = current && plan.tier < current.plan.tier ? 'DOWNGRADE' : 'UPGRADE';
    }
    if (type === 'CANCEL') requestedPlanId = null;
    if (!type) type = 'ADDON_CHANGE';

    // Keep a single pending request per tenant (update if one exists).
    const pending = await db.tenantSubscriptionRequest.findFirst({ where: { tenantId, status: 'PENDING' } });
    const row = pending
      ? await db.tenantSubscriptionRequest.update({ where: { id: pending.id }, data: { requestedPlanId, requestedAddonKeys: body.addonKeys ?? [], requestType: type as never, notes: body.notes } })
      : await db.tenantSubscriptionRequest.create({ data: { tenantId, requestedPlanId, requestedAddonKeys: body.addonKeys ?? [], requestType: type as never, notes: body.notes, requestedByUserId: userId } });
    return row;
  }

  app.patch('/admin/plan', { preHandler: ownerAdminRoles }, async (request, reply) => {
    const input = z.object({
      planKey: z.string().min(1).max(40).optional(),
      addonKeys: z.array(z.string().min(1).max(40)).optional(),
      notes: z.string().max(1000).optional(),
    }).parse(request.body);
    const row = await createRequest(request.auth.tenantId, request.auth.userId, input);
    await audit(request, { action: 'subscription.requested', resource: 'tenantSubscriptionRequest', resourceId: row.id, metadata: { requestType: row.requestType, planKey: input.planKey ?? null, addonKeys: input.addonKeys } });
    return reply.code(202).send({
      status: 'plan_change_requires_platform_approval',
      requestId: row.id,
      requestType: row.requestType,
      message: 'Your plan change has been submitted for platform approval. A platform operator will review it.',
    });
  });

  app.post('/requests', { preHandler: ownerAdminRoles }, async (request, reply) => {
    const input = z.object({
      planKey: z.string().min(1).max(40).optional(),
      addonKeys: z.array(z.string().min(1).max(40)).optional(),
      requestType: z.enum(['UPGRADE', 'DOWNGRADE', 'ADDON_CHANGE', 'CANCEL']).optional(),
      notes: z.string().max(1000).optional(),
    }).parse(request.body);
    const row = await createRequest(request.auth.tenantId, request.auth.userId, input);
    await audit(request, { action: 'subscription.requested', resource: 'tenantSubscriptionRequest', resourceId: row.id, metadata: { requestType: row.requestType, planKey: input.planKey ?? null, addonKeys: input.addonKeys } });
    return reply.code(202).send({ status: 'upgrade_request_created', requestId: row.id, requestType: row.requestType });
  });

  app.get('/requests', async request => {
    const rows = await db.tenantSubscriptionRequest.findMany({
      where: { tenantId: request.auth.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { requestedPlan: { select: { key: true, name: true } } },
    });
    return rows.map(r => ({ id: r.id, requestType: r.requestType, status: r.status, requestedPlanKey: r.requestedPlan?.key ?? null, requestedAddonKeys: r.requestedAddonKeys, notes: r.notes, reviewerNote: r.reviewerNote, createdAt: r.createdAt.toISOString() }));
  });
};
