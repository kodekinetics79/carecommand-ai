import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { requirePlatformOperator, platformAudit } from '../../lib/platform';
import { recomputeEntitlements } from '../../lib/entitlements';

const uuid = z.string().uuid();

// Apply tenant subscription changes (plan/status/addons) and recompute
// entitlements. Shared by direct platform edits and request approval.
async function applySubscriptionChange(tenantId: string, change: { planKey?: string; status?: string; addonKeys?: string[] }) {
  const existing = await db.tenantSubscription.findUnique({ where: { tenantId }, include: { plan: true } });
  let planId = existing?.planId;
  if (change.planKey) {
    const plan = await db.subscriptionPlan.findUnique({ where: { key: change.planKey } });
    if (!plan) throw new Error('unknown_plan');
    planId = plan.id;
  }
  if (!planId) throw new Error('no_plan');

  const subscription = existing
    ? await db.tenantSubscription.update({ where: { tenantId }, data: { planId, ...(change.status ? { status: change.status as never } : {}) } })
    : await db.tenantSubscription.create({ data: { tenantId, planId, status: (change.status as never) ?? 'ACTIVE', startedAt: new Date() } });

  if (change.addonKeys) {
    const addons = await db.subscriptionAddon.findMany({ where: { key: { in: change.addonKeys }, active: true } });
    const wanted = new Set(addons.map(a => a.id));
    await db.tenantSubscriptionAddon.updateMany({ where: { subscriptionId: subscription.id, addonId: { notIn: [...wanted] } }, data: { active: false } });
    for (const addon of addons) {
      await db.tenantSubscriptionAddon.upsert({
        where: { subscriptionId_addonId: { subscriptionId: subscription.id, addonId: addon.id } },
        update: { active: true },
        create: { tenantId, subscriptionId: subscription.id, addonId: addon.id, active: true },
      });
    }
  }
  await recomputeEntitlements(tenantId);
  return subscription;
}

async function tenantSummary(tenantId: string) {
  const [tenant, sub, userCount, branchCount, enabledCount] = await Promise.all([
    db.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, slug: true, createdAt: true } }),
    db.tenantSubscription.findUnique({ where: { tenantId }, include: { plan: true, addons: { where: { active: true }, include: { addon: true } } } }),
    db.user.count({ where: { tenantId, active: true } }),
    db.branch.count({ where: { tenantId } }),
    db.tenantFeatureEntitlement.count({ where: { tenantId, enabled: true } }),
  ]);
  return {
    tenant,
    subscription: sub ? { planKey: sub.plan.key, planName: sub.plan.name, status: sub.status, trialEndsAt: sub.trialEndsAt?.toISOString() ?? null, addons: sub.addons.map(a => a.addon.key) } : null,
    activeUsers: userCount,
    branches: branchCount,
    enabledFeatures: enabledCount,
  };
}

// All routes require a valid platform operator token (NOT a tenant role). No
// patient/PHI data is exposed — tenant + subscription summaries only.
export const platformRoutes: FastifyPluginAsync = async app => {
  app.addHook('preHandler', requirePlatformOperator);

  app.get('/tenants', async () => {
    const tenants = await db.tenant.findMany({ orderBy: { createdAt: 'desc' }, select: { id: true } });
    return Promise.all(tenants.map(t => tenantSummary(t.id)));
  });

  app.get('/subscriptions/tenants', async () => {
    const subs = await db.tenantSubscription.findMany({ include: { plan: true, tenant: { select: { name: true, slug: true } } }, orderBy: { updatedAt: 'desc' } });
    return subs.map(s => ({ tenantId: s.tenantId, tenantName: s.tenant.name, slug: s.tenant.slug, planKey: s.plan.key, status: s.status, trialEndsAt: s.trialEndsAt?.toISOString() ?? null }));
  });

  app.get('/tenants/:tenantId', async (request, reply) => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const summary = await tenantSummary(tenantId);
    if (!summary.tenant) return reply.code(404).send({ error: 'not_found', message: 'Tenant not found' });
    const entitlements = await db.tenantFeatureEntitlement.findMany({ where: { tenantId }, orderBy: { featureKey: 'asc' }, select: { featureKey: true, enabled: true, source: true, limitValue: true } });
    return { ...summary, entitlements };
  });

  // Suspend / reactivate a tenant (implemented via subscription status, since
  // there is no separate tenant active flag). Suspended → all features locked.
  app.patch('/tenants/:tenantId/status', async (request, reply) => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const { action } = z.object({ action: z.enum(['suspend', 'reactivate']) }).parse(request.body);
    const sub = await db.tenantSubscription.findUnique({ where: { tenantId } });
    if (!sub) return reply.code(404).send({ error: 'not_found', message: 'No subscription for tenant' });
    const status = action === 'suspend' ? 'SUSPENDED' : 'ACTIVE';
    await db.tenantSubscription.update({ where: { tenantId }, data: { status } });
    await recomputeEntitlements(tenantId);
    await platformAudit(tenantId, action === 'suspend' ? 'tenant.suspended' : 'tenant.reactivated', tenantId, { status });
    return { tenantId, status };
  });

  app.patch('/tenants/:tenantId/subscription', async (request, reply) => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const body = z.object({
      planKey: z.string().min(1).max(40).optional(),
      status: z.enum(['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED']).optional(),
      addonKeys: z.array(z.string().min(1).max(40)).optional(),
    }).parse(request.body);
    const existing = await db.tenantSubscription.findUnique({ where: { tenantId }, include: { plan: true } });
    try {
      await applySubscriptionChange(tenantId, body);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    await platformAudit(tenantId, 'subscription.updated', tenantId, { fromPlan: existing?.plan.key ?? null, toPlan: body.planKey ?? existing?.plan.key ?? null, status: body.status, addonKeys: body.addonKeys, source: 'platform-operator' });
    return tenantSummary(tenantId);
  });

  app.get('/subscription-requests', async request => {
    const { status } = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional() }).parse(request.query);
    const rows = await db.tenantSubscriptionRequest.findMany({
      where: { ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { tenant: { select: { name: true, slug: true } }, requestedPlan: { select: { key: true, name: true } } },
    });
    return rows.map(r => ({
      id: r.id, tenantId: r.tenantId, tenantName: r.tenant.name, slug: r.tenant.slug,
      requestType: r.requestType, status: r.status, requestedPlanKey: r.requestedPlan?.key ?? null,
      requestedAddonKeys: r.requestedAddonKeys, notes: r.notes, reviewerNote: r.reviewerNote, createdAt: r.createdAt.toISOString(),
    }));
  });

  app.patch('/subscription-requests/:id', async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { decision, reviewerNote } = z.object({ decision: z.enum(['approve', 'reject']), reviewerNote: z.string().max(1000).optional() }).parse(request.body);
    const req = await db.tenantSubscriptionRequest.findUnique({ where: { id }, include: { requestedPlan: true } });
    if (!req) return reply.code(404).send({ error: 'not_found', message: 'Request not found' });
    if (req.status !== 'PENDING') return reply.code(409).send({ error: 'already_reviewed', message: 'Request already reviewed' });

    if (decision === 'reject') {
      await db.tenantSubscriptionRequest.update({ where: { id }, data: { status: 'REJECTED', reviewerNote } });
      await platformAudit(req.tenantId, 'subscription.request.rejected', id, { reviewerNote });
      return { id, status: 'REJECTED' };
    }

    // Approve → apply the requested change, then mark approved.
    try {
      await applySubscriptionChange(req.tenantId, {
        planKey: req.requestedPlan?.key,
        addonKeys: req.requestType === 'ADDON_CHANGE' ? req.requestedAddonKeys : undefined,
        status: req.requestType === 'CANCEL' ? 'CANCELLED' : 'ACTIVE',
      });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    await db.tenantSubscriptionRequest.update({ where: { id }, data: { status: 'APPROVED', reviewerNote } });
    await platformAudit(req.tenantId, 'subscription.request.approved', id, { toPlan: req.requestedPlan?.key ?? null, requestType: req.requestType, reviewerNote });
    await platformAudit(req.tenantId, 'subscription.updated', req.tenantId, { toPlan: req.requestedPlan?.key ?? null, source: 'request-approval' });
    return { id, status: 'APPROVED' };
  });
};
