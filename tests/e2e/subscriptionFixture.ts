import { fixtureDb as db } from '../../server/test/helpers/fixtureDb';
import { PLANS } from '../../server/modules/subscriptions/catalog';

/**
 * Browser tests start from migrations alone, so they cannot assume that a
 * developer previously ran a seed command. Keep the fixture aligned with the
 * production catalog instead of duplicating an ad-hoc "enterprise" plan.
 */
export async function ensureE2eSubscriptionPlan(key = 'enterprise') {
  const definition = PLANS.find(plan => plan.key === key);
  if (!definition) throw new Error(`Unknown subscription plan fixture: ${key}`);

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

  await db.$transaction(definition.features.map(feature => db.subscriptionPlanFeature.upsert({
    where: { planId_featureKey: { planId: plan.id, featureKey: feature.featureKey } },
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
  })));

  return plan;
}
