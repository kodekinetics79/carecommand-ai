import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from './db';
import { FEATURE_KEYS, ENTITLED_STATUSES } from '../modules/subscriptions/catalog';

// ===========================================================================
// Tenant feature entitlements. Resolves a tenant's plan + active add-ons into
// TenantFeatureEntitlement rows for fast guard lookups, and provides the
// backend feature guard. Every query is scoped by tenantId (these tables are
// RLS-ready but not RLS-enabled yet).
// ===========================================================================

export interface ResolvedEntitlement { featureKey: string; enabled: boolean; source: string; limitValue: number | null }

/** Recompute and persist a tenant's entitlements from its subscription + add-ons. */
export async function recomputeEntitlements(tenantId: string): Promise<ResolvedEntitlement[]> {
  const subscription = await db.tenantSubscription.findUnique({
    where: { tenantId },
    include: { plan: { include: { features: true } }, addons: { where: { active: true }, include: { addon: true } } },
  });

  const resolved = new Map<string, ResolvedEntitlement>();
  const entitled = subscription && ENTITLED_STATUSES.includes(subscription.status);
  if (subscription && entitled) {
    for (const feature of subscription.plan.features) {
      if (feature.included) resolved.set(feature.featureKey, { featureKey: feature.featureKey, enabled: true, source: 'plan', limitValue: feature.limitValue });
    }
    for (const tenantAddon of subscription.addons) {
      const featureKey = tenantAddon.addon.featureKey;
      if (!featureKey) continue;
      const existing = resolved.get(featureKey);
      // Extra Location add-ons raise the multi_location limit; other add-ons
      // simply enable their feature.
      const isLocationBump = tenantAddon.addon.key === 'extra_location';
      const limitValue = isLocationBump
        ? (existing?.limitValue ?? 0) + tenantAddon.quantity
        : existing?.limitValue ?? null;
      resolved.set(featureKey, { featureKey, enabled: true, source: existing?.source ?? 'addon', limitValue });
    }
  }

  const rows: ResolvedEntitlement[] = [];
  for (const key of FEATURE_KEYS) {
    const ent = resolved.get(key) ?? { featureKey: key, enabled: false, source: 'plan', limitValue: null };
    await db.tenantFeatureEntitlement.upsert({
      where: { tenantId_featureKey: { tenantId, featureKey: key } },
      update: { enabled: ent.enabled, source: ent.source, limitValue: ent.limitValue },
      create: { tenantId, featureKey: key, enabled: ent.enabled, source: ent.source, limitValue: ent.limitValue },
    });
    rows.push(ent);
  }
  return rows;
}

/** Fast entitlement check for a single feature. */
export async function isFeatureEnabled(tenantId: string, featureKey: string): Promise<boolean> {
  const ent = await db.tenantFeatureEntitlement.findUnique({ where: { tenantId_featureKey: { tenantId, featureKey } } });
  return Boolean(ent?.enabled);
}

/**
 * Backend feature guard preHandler. Returns a 403 `feature_locked` response when
 * the tenant's plan/add-ons do not include the feature — enforcement is at the
 * API, never frontend-only.
 */
export function requireFeature(featureKey: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!(await isFeatureEnabled(request.auth.tenantId, featureKey))) {
      return reply.code(403).send({
        error: 'feature_locked',
        feature: featureKey,
        message: `This feature (${featureKey}) is not included in your current plan. Upgrade your plan or add the add-on to enable it.`,
      });
    }
  };
}
