import type { PrismaClient } from '../../generated/prisma/client';
import { PLANS } from '../../modules/subscriptions/catalog';

/**
 * Install the production-defined commercial catalog required by integration
 * fixtures. Migrations intentionally create schema only, while tenant fixtures
 * need stable plan IDs and feature mappings to exercise real entitlements.
 *
 * This helper is deliberately limited to global reference data: it does not
 * create tenants, subscriptions, users, provider state, or payment records.
 */
export async function ensureTestSubscriptionCatalog(db: PrismaClient): Promise<void> {
  for (const definition of PLANS) {
    const plan = await db.subscriptionPlan.upsert({
      where: { key: definition.key },
      update: {
        name: definition.name,
        description: definition.description,
        tier: definition.tier,
        active: true,
      },
      create: {
        key: definition.key,
        name: definition.name,
        description: definition.description,
        tier: definition.tier,
        active: true,
      },
    });

    for (const feature of definition.features) {
      await db.subscriptionPlanFeature.upsert({
        where: {
          planId_featureKey: {
            planId: plan.id,
            featureKey: feature.featureKey,
          },
        },
        update: {
          included: true,
          limitValue: feature.limitValue ?? null,
          note: feature.note ?? null,
        },
        create: {
          planId: plan.id,
          featureKey: feature.featureKey,
          included: true,
          limitValue: feature.limitValue ?? null,
          note: feature.note ?? null,
        },
      });
    }
  }
}
