-- Subscription catalog reference data: plans, plan features, and add-ons.
--
-- This is REQUIRED reference data, not demo data. Without it every tenant
-- resolves to zero entitlements (the whole product renders as "upgrade your
-- plan") and provisionTenant() aborts with `plan_unavailable`, so a fresh
-- database can neither onboard a client nor absorb a disaster-recovery restore.
--
-- It lives in a migration rather than a seed script for two reasons:
--   1. Privilege. 20260730120000_complete_rls_isolation classifies these three
--      tables as global reference/control objects and grants app_rls only
--      SELECT; 20260730133000_platform_database_plane grants app_platform only
--      SELECT. No runtime principal may write them. The schema owner behind
--      DATABASE_MIGRATION_URL is the only principal permitted to, and that is
--      exactly the principal `prisma migrate deploy` runs as.
--   2. Reach. Migrations are the one step every fresh environment already runs
--      (render.yaml `db:deploy`, the render.pilot.yaml release job through
--      scripts/deploy-migrations.sh, `prisma migrate dev`, the disposable
--      test/e2e databases, and a DR restore). A seed script would have to be
--      wired into each of those separately, and prisma/synthetic/seedSafety.ts
--      deliberately refuses to run seeds outside a test-named database.
--
-- The rows below are generated from server/modules/subscriptions/catalog.ts,
-- which remains the single source of truth. server/test/subscriptionCatalogSeed.unit.test.ts
-- fails the build if the two drift apart.
--
-- Convergent and additive only, so it is safe against the existing production
-- catalog and safe to re-run by hand:
--   * Descriptive fields the source owns (name, description, tier, and an
--     add-on's feature mapping) are converged on conflict.
--   * `monthlyPrice` and `active` are NEVER written. Commercial terms and plan
--     retirement are operator decisions held in the database, and this file has
--     no truthful value for either.
--   * Nothing is deleted. Removing a plan feature would revoke a paying
--     tenant's access at the next entitlement recompute; that is a commercial
--     decision, not a side effect of installing reference data.
--   * No TenantSubscription, TenantSubscriptionAddon or TenantFeatureEntitlement
--     row is read or written, so no existing tenant's plan or entitlements move.
--
-- One PL/pgSQL block so the whole catalog install is a single atomic statement
-- that does not depend on how the migration runner frames transactions.

DO $catalog$
DECLARE
  plans_inserted int;
  plans_updated int;
  features_inserted int;
  features_updated int;
  addons_inserted int;
  addons_updated int;
BEGIN
  -- @catalog-seed plans
  WITH source (key, name, description, tier) AS (VALUES
    ('starter', 'Starter', 'Core scheduling and CRM for a single clinic.', 1),
    ('growth', 'Growth', 'Revenue tools and automation for growing clinics.', 2),
    ('command', 'Command', 'AI front desk, advanced reporting, and compliance readiness.', 3),
    ('enterprise', 'Enterprise', 'Full platform with integrations, eligibility, and API access.', 4)
  ), upserted AS (
    INSERT INTO "SubscriptionPlan" ("id", "key", "name", "description", "tier", "createdAt", "updatedAt")
    SELECT gen_random_uuid(), s.key, s.name, s.description, s.tier::int, now(), now()
    FROM source s
    ON CONFLICT ("key") DO UPDATE SET
      "name" = EXCLUDED."name",
      "description" = EXCLUDED."description",
      "tier" = EXCLUDED."tier",
      "updatedAt" = now()
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted)
  INTO plans_inserted, plans_updated
  FROM upserted;

  -- @catalog-seed plan_features
  WITH source (plan_key, feature_key, limit_value, note) AS (VALUES
    ('starter', 'appointments', NULL, NULL),
    ('starter', 'patient_crm', NULL, NULL),
    ('starter', 'basic_reports', NULL, NULL),
    ('growth', 'appointments', NULL, NULL),
    ('growth', 'patient_crm', NULL, NULL),
    ('growth', 'basic_reports', NULL, NULL),
    ('growth', 'payments_deposits', NULL, NULL),
    ('growth', 'revenue_protection', NULL, NULL),
    ('growth', 'campaign_automation', NULL, NULL),
    ('growth', 'multi_location', 2, 'Up to 2 locations'),
    ('command', 'appointments', NULL, NULL),
    ('command', 'patient_crm', NULL, NULL),
    ('command', 'basic_reports', NULL, NULL),
    ('command', 'payments_deposits', NULL, NULL),
    ('command', 'revenue_protection', NULL, NULL),
    ('command', 'campaign_automation', NULL, NULL),
    ('command', 'multi_location', 5, 'Up to 5 locations'),
    ('command', 'ai_receptionist', NULL, NULL),
    ('command', 'advanced_reports', NULL, NULL),
    ('command', 'staff_kpis', NULL, NULL),
    ('command', 'compliance_readiness', NULL, NULL),
    ('enterprise', 'appointments', NULL, NULL),
    ('enterprise', 'patient_crm', NULL, NULL),
    ('enterprise', 'basic_reports', NULL, NULL),
    ('enterprise', 'payments_deposits', NULL, NULL),
    ('enterprise', 'revenue_protection', NULL, NULL),
    ('enterprise', 'campaign_automation', NULL, NULL),
    ('enterprise', 'ai_receptionist', NULL, NULL),
    ('enterprise', 'advanced_reports', NULL, NULL),
    ('enterprise', 'staff_kpis', NULL, NULL),
    ('enterprise', 'compliance_readiness', NULL, NULL),
    ('enterprise', 'multi_location', NULL, 'Unlimited locations'),
    ('enterprise', 'device_integration', NULL, NULL),
    ('enterprise', 'insurance_eligibility', NULL, NULL),
    ('enterprise', 'api_access', NULL, NULL),
    ('enterprise', 'custom_integrations', NULL, NULL)
  ), upserted AS (
    INSERT INTO "SubscriptionPlanFeature" ("id", "planId", "featureKey", "included", "limitValue", "note")
    SELECT gen_random_uuid(), p."id", s.feature_key, true, s.limit_value::int, s.note::text
    FROM source s
    JOIN "SubscriptionPlan" p ON p."key" = s.plan_key
    -- `included` and `limitValue` are AUTHORIZATION GRANTS, not cosmetic copy.
    -- Converging them would silently revert a deliberate operator change on a
    -- live database: lowering a growth tenant's limitValue revokes locations
    -- from every tenant on that plan at the next recomputeEntitlements, with
    -- no human gate because main auto-deploys and db:deploy runs unattended.
    -- This migration installs MISSING reference data; it must never take a
    -- grant away. Only the human-readable note converges.
    ON CONFLICT ("planId", "featureKey") DO UPDATE SET
      "note" = EXCLUDED."note"
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted)
  INTO features_inserted, features_updated
  FROM upserted;

  -- @catalog-seed addons
  WITH source (key, name, description, feature_key) AS (VALUES
    ('ai_receptionist', 'AI Receptionist', 'Voice/SMS AI front desk and receptionist studio.', 'ai_receptionist'),
    ('device_integration', 'Device Integration Center', 'Connect clinical and front-desk devices.', 'device_integration'),
    ('insurance_eligibility', 'Insurance Eligibility', 'Eligibility and benefit inquiries through a configured provider.', 'insurance_eligibility'),
    ('advanced_reports', 'Advanced Reports', 'Advanced analytics and custom reporting.', 'advanced_reports'),
    ('extra_location', 'Extra Location', 'Add additional clinic locations.', 'multi_location'),
    ('extra_users', 'Extra Users', 'Add additional user seats.', NULL),
    ('campaign_automation', 'Campaign Automation', 'Automated multi-channel patient campaigns.', 'campaign_automation'),
    ('compliance_readiness', 'Compliance Readiness Center', 'Internal SOC 2 readiness and HIPAA alignment self-assessment tooling; not certification.', 'compliance_readiness')
  ), upserted AS (
    INSERT INTO "SubscriptionAddon" ("id", "key", "name", "description", "featureKey", "createdAt", "updatedAt")
    SELECT gen_random_uuid(), s.key, s.name, s.description, s.feature_key::text, now(), now()
    FROM source s
    -- `featureKey` is the grant this add-on unlocks; repointing it silently
    -- changes what every tenant holding the add-on can reach. Name and
    -- description are display copy and may converge.
    ON CONFLICT ("key") DO UPDATE SET
      "name" = EXCLUDED."name",
      "description" = EXCLUDED."description",
      "updatedAt" = now()
    RETURNING (xmax = 0) AS inserted
  )
  SELECT count(*) FILTER (WHERE inserted), count(*) FILTER (WHERE NOT inserted)
  INTO addons_inserted, addons_updated
  FROM upserted;

  -- Fail closed. A plan-key typo would silently drop plan-feature rows through
  -- the join above and leave a feature permanently locked with no error, so the
  -- migration asserts that every catalogued row was actually written.
  IF plans_inserted + plans_updated <> 4
     OR features_inserted + features_updated <> 36
     OR addons_inserted + addons_updated <> 8 THEN
    RAISE EXCEPTION
      'Subscription catalog seed incomplete: % plans, % plan features, % add-ons (expected 4/36/8)',
      plans_inserted + plans_updated,
      features_inserted + features_updated,
      addons_inserted + addons_updated;
  END IF;

  -- Evidence, on the global ledger. The catalog is not tenant-scoped, so this
  -- belongs on PlatformAuditEvent rather than the tenant-keyed AuditEvent. The
  -- counts distinguish a first install from a re-converged existing catalog
  -- instead of claiming work that did not happen.
  INSERT INTO "PlatformAuditEvent" ("id", "action", "targetType", "targetId", "metadata")
  VALUES (
    gen_random_uuid(),
    'subscription.catalog.seeded',
    'subscriptionCatalog',
    'subscription-catalog',
    jsonb_build_object(
      'source', 'migration:20260828120000_subscription_catalog_reference_data',
      'plansInserted', plans_inserted,
      'plansUpdated', plans_updated,
      'planFeaturesInserted', features_inserted,
      'planFeaturesUpdated', features_updated,
      'addonsInserted', addons_inserted,
      'addonsUpdated', addons_updated
    )
  );
END
$catalog$;
