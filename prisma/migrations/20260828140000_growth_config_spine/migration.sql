-- Growth configuration spine + lead lost-reason history.
--
-- Two things land here:
--
--  1. `Lead.lostReason` and `LeadActivity`. The "mark lost" modal blocks the
--     operator until they type a justification and tells them it is "captured
--     for lost-reason intelligence" and "recorded in the audit trail" — and the
--     reason was then discarded in the browser. `Lead.stage` is also overwritten
--     in place, so a stage change left no trace at all. LeadActivity gives the
--     module a per-transition history it never had.
--
--  2. `GrowthPolicy`, `GrowthSegmentDefinition`, `GrowthChannelCost`. The Growth
--     module compiled ~40 clinic business rules into frontend source. These are
--     their tenant-configurable home.
--
-- The seeded values below are the constants the code uses TODAY (see
-- server/modules/growth/defaults.ts, which is the single source of truth;
-- server/test/growthConfigSeed.unit.test.ts fails the build if the two drift).
-- Nothing reads these tables yet, and every seeded number equals the current
-- hardcoded one, so this migration changes no observable number.
--
-- Two exceptions where today's code disagrees with ITSELF and one value had to
-- be chosen (see the report / defaults.ts for the reasoning):
--   * churnRiskHigh = 50, INCLUSIVE. Frontend used >= 50, server/modules/
--     patients/routes.ts:202 uses >= 60. 50 wins.
--   * highValuePatientLtv = 4000, INCLUSIVE. Frontend used >= 4000,
--     server/modules/patients/routes.ts:203 uses > 4000. >= wins.
-- patients/routes.ts is not rewired here; it is the remaining call site.
--
-- Seed rows are inserted BEFORE row-level security is enabled on the new tables,
-- because 20260730120000_complete_rls_isolation's FORCE ROW LEVEL SECURITY
-- applies to the table owner as well and the policies are granted only to
-- app_rls. Tenants created after this migration get their configuration from the
-- column defaults / the module's code defaults, exactly like SchedulingPolicy.

SET lock_timeout = '5s';
SET statement_timeout = '5min';

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "lostReason" TEXT;

-- CreateTable
CREATE TABLE "LeadActivity" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "activityType" TEXT NOT NULL,
    "fromStage" TEXT,
    "toStage" TEXT,
    "reason" TEXT,
    "actorUserId" UUID,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrowthPolicy" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "hotLeadScore" INTEGER NOT NULL DEFAULT 70,
    "scoreBandHigh" INTEGER NOT NULL DEFAULT 70,
    "scoreBandMid" INTEGER NOT NULL DEFAULT 40,
    "goingColdDays" INTEGER NOT NULL DEFAULT 14,
    "churnRiskHigh" INTEGER NOT NULL DEFAULT 50,
    "highValuePatientLtv" DECIMAL(12,2) NOT NULL DEFAULT 4000,
    "recoverableLtvFraction" DECIMAL(5,4) NOT NULL DEFAULT 0.30,
    "inactiveAudienceDays" INTEGER NOT NULL DEFAULT 180,
    "maxAudienceSize" INTEGER NOT NULL DEFAULT 500,
    "slotFillHorizonDays" INTEGER NOT NULL DEFAULT 7,
    "reviewRatingGood" DECIMAL(3,2) NOT NULL DEFAULT 4.5,
    "reviewRatingFair" DECIMAL(3,2) NOT NULL DEFAULT 4.0,
    "reputationRiskHigh" INTEGER NOT NULL DEFAULT 80,
    "reputationRiskMedium" INTEGER NOT NULL DEFAULT 55,
    "competitorRatingHighSeverityMax" DECIMAL(3,2) NOT NULL DEFAULT 4.2,
    "competitorRatingMediumSeverityMax" DECIMAL(3,2) NOT NULL DEFAULT 4.5,
    "competitorReviewVolumeHigh" INTEGER NOT NULL DEFAULT 350,
    "leadSendCooldownHours" INTEGER NOT NULL DEFAULT 24,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GrowthPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrowthSegmentDefinition" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "minInactiveDays" INTEGER,
    "maxInactiveDays" INTEGER,
    "includeNeverVisited" BOOLEAN NOT NULL DEFAULT false,
    "minLifetimeValue" DECIMAL(12,2),
    "minChurnRisk" INTEGER,
    "requiredTag" TEXT,
    "suggestedChannel" TEXT NOT NULL,
    "plannedOffer" TEXT NOT NULL,
    "assumedBookingRatePct" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GrowthSegmentDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrowthChannelCost" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "unitCostMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GrowthChannelCost_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeadActivity_tenantId_leadId_occurredAt_idx" ON "LeadActivity"("tenantId", "leadId", "occurredAt");

-- CreateIndex
CREATE INDEX "LeadActivity_tenantId_activityType_occurredAt_idx" ON "LeadActivity"("tenantId", "activityType", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "GrowthPolicy_tenantId_key" ON "GrowthPolicy"("tenantId");

-- CreateIndex
CREATE INDEX "GrowthSegmentDefinition_tenantId_active_sortOrder_idx" ON "GrowthSegmentDefinition"("tenantId", "active", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "GrowthSegmentDefinition_tenantId_key_key" ON "GrowthSegmentDefinition"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "GrowthChannelCost_tenantId_channel_key" ON "GrowthChannelCost"("tenantId", "channel");

-- AddForeignKey
ALTER TABLE "LeadActivity" ADD CONSTRAINT "LeadActivity_tenant_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadActivity" ADD CONSTRAINT "LeadActivity_lead_scope_fkey" FOREIGN KEY ("tenantId", "leadId") REFERENCES "Lead"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadActivity" ADD CONSTRAINT "LeadActivity_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthPolicy" ADD CONSTRAINT "GrowthPolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthSegmentDefinition" ADD CONSTRAINT "GrowthSegmentDefinition_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthChannelCost" ADD CONSTRAINT "GrowthChannelCost_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Seed: today's constants, one configuration set per existing tenant.
-- Convergent and additive only. ON CONFLICT DO NOTHING so a re-run never
-- overwrites a value an operator has since tuned.
-- ---------------------------------------------------------------------------

-- @growth-seed policy
INSERT INTO "GrowthPolicy" (
  "id", "tenantId",
  "hotLeadScore", "scoreBandHigh", "scoreBandMid", "goingColdDays",
  "churnRiskHigh", "highValuePatientLtv", "recoverableLtvFraction",
  "inactiveAudienceDays", "maxAudienceSize", "slotFillHorizonDays",
  "reviewRatingGood", "reviewRatingFair", "reputationRiskHigh", "reputationRiskMedium",
  "competitorRatingHighSeverityMax", "competitorRatingMediumSeverityMax", "competitorReviewVolumeHigh",
  "leadSendCooldownHours",
  "createdAt", "updatedAt"
)
SELECT gen_random_uuid(), t.id,
  70, 70, 40, 14,
  50, 4000, 0.30,
  180, 500, 7,
  4.5, 4.0, 80, 55,
  4.2, 4.5, 350,
  24,
  now(), now()
FROM "Tenant" t
ON CONFLICT ("tenantId") DO NOTHING;

-- @growth-seed segments
-- Reproduces the six definitions in src/lib/crmService.ts:180-202 exactly:
-- the 30-60 / 60-90 / 90-180 inactivity windows (min inclusive, max exclusive),
-- high-LTV inactive (>= 4000 and >= 45 days), at-risk (churn >= 50), and the
-- winback tag — with their 18/14/11/26/20/12 assumed booking rates.
-- includeNeverVisited = true where today's `daysSince(null) = 9999` silently
-- lets a patient with no recorded visit into the group.
INSERT INTO "GrowthSegmentDefinition" (
  "id", "tenantId", "key", "label", "description",
  "minInactiveDays", "maxInactiveDays", "includeNeverVisited",
  "minLifetimeValue", "minChurnRisk", "requiredTag",
  "suggestedChannel", "plannedOffer", "assumedBookingRatePct",
  "active", "sortOrder", "createdAt", "updatedAt"
)
SELECT gen_random_uuid(), t.id, s.key, s.label, s.description,
  s.min_inactive_days, s.max_inactive_days, s.include_never_visited,
  s.min_lifetime_value, s.min_churn_risk, s.required_tag,
  s.suggested_channel, s.planned_offer, s.assumed_booking_rate_pct,
  true, s.sort_order, now(), now()
FROM "Tenant" t
CROSS JOIN (VALUES
  ('inactive-30-60', '30–60 days inactive', 'Patients quiet 30–60 days', 30, 60, false, NULL::numeric(12,2), NULL::int, NULL::text, 'SMS', 'Gentle check-in + booking link', 18, 1),
  ('inactive-60-90', '60–90 days inactive', 'Patients quiet 60–90 days', 60, 90, false, NULL::numeric(12,2), NULL::int, NULL::text, 'Email', 'Recall reminder + small incentive', 14, 2),
  ('inactive-90-180', '90–180 days inactive', 'Reactivation candidates', 90, 180, false, NULL::numeric(12,2), NULL::int, NULL::text, 'WhatsApp', 'Winback offer', 11, 3),
  ('high-ltv-inactive', 'High-LTV inactive', 'Valuable patients gone quiet', 45, NULL::int, true, 4000::numeric(12,2), NULL::int, NULL::text, 'Voice', 'Personal outreach from care team', 26, 4),
  ('at-risk', 'Patients at risk', 'High churn-risk patients', NULL::int, NULL::int, true, NULL::numeric(12,2), 50, NULL::text, 'SMS', 'Retention outreach + next-visit booking', 20, 5),
  ('winback-tagged', 'Reactivation candidates', 'Tagged for winback', NULL::int, NULL::int, true, NULL::numeric(12,2), NULL::int, 'winback', 'WhatsApp', 'Limited-time winback', 12, 6)
) AS s(key, label, description, min_inactive_days, max_inactive_days, include_never_visited,
       min_lifetime_value, min_churn_risk, required_tag, suggested_channel, planned_offer,
       assumed_booking_rate_pct, sort_order)
ON CONFLICT ("tenantId", "key") DO NOTHING;

-- @growth-seed channel-costs
-- Reproduces `channel === 'Email' ? 0 : channel === 'Voice' ? 3 : 1` in integer
-- minor units with an explicit currency, so the planning cost can no longer be
-- rendered as "$120" for a tenant that does not bill in dollars.
INSERT INTO "GrowthChannelCost" (
  "id", "tenantId", "channel", "unitCostMinor", "currency", "createdAt", "updatedAt"
)
SELECT gen_random_uuid(), t.id, c.channel, c.unit_cost_minor, c.currency, now(), now()
FROM "Tenant" t
CROSS JOIN (VALUES
  ('Email', 0, 'USD'),
  ('SMS', 100, 'USD'),
  ('WhatsApp', 100, 'USD'),
  ('Voice', 300, 'USD')
) AS c(channel, unit_cost_minor, currency)
ON CONFLICT ("tenantId", "channel") DO NOTHING;

-- ---------------------------------------------------------------------------
-- Row-level security. 20260730120000_complete_rls_isolation applied its policy
-- loop once, at that migration; tables created afterwards must declare their own
-- or they would be readable across tenants. Each new table carries a real
-- `tenantId UUID NOT NULL` and a Tenant FK, so it is a normal tenant-owned table
-- (MUTABLE in server/lib/rlsTableAdapters.ts) and gets the full four policies.
-- ---------------------------------------------------------------------------

ALTER TABLE "LeadActivity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LeadActivity" FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_lead_activity_select ON "LeadActivity" FOR SELECT TO app_rls USING (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_lead_activity_insert ON "LeadActivity" FOR INSERT TO app_rls WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_lead_activity_update ON "LeadActivity" FOR UPDATE TO app_rls USING (app_rls_tenant_allowed("tenantId")) WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_lead_activity_delete ON "LeadActivity" FOR DELETE TO app_rls USING (app_rls_tenant_allowed("tenantId"));
REVOKE ALL ON TABLE "LeadActivity" FROM app_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "LeadActivity" TO app_rls;

ALTER TABLE "GrowthPolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GrowthPolicy" FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_growth_policy_select ON "GrowthPolicy" FOR SELECT TO app_rls USING (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_growth_policy_insert ON "GrowthPolicy" FOR INSERT TO app_rls WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_growth_policy_update ON "GrowthPolicy" FOR UPDATE TO app_rls USING (app_rls_tenant_allowed("tenantId")) WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_growth_policy_delete ON "GrowthPolicy" FOR DELETE TO app_rls USING (app_rls_tenant_allowed("tenantId"));
REVOKE ALL ON TABLE "GrowthPolicy" FROM app_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "GrowthPolicy" TO app_rls;

ALTER TABLE "GrowthSegmentDefinition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GrowthSegmentDefinition" FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_growth_segment_definition_select ON "GrowthSegmentDefinition" FOR SELECT TO app_rls USING (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_growth_segment_definition_insert ON "GrowthSegmentDefinition" FOR INSERT TO app_rls WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_growth_segment_definition_update ON "GrowthSegmentDefinition" FOR UPDATE TO app_rls USING (app_rls_tenant_allowed("tenantId")) WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_growth_segment_definition_delete ON "GrowthSegmentDefinition" FOR DELETE TO app_rls USING (app_rls_tenant_allowed("tenantId"));
REVOKE ALL ON TABLE "GrowthSegmentDefinition" FROM app_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "GrowthSegmentDefinition" TO app_rls;

ALTER TABLE "GrowthChannelCost" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GrowthChannelCost" FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_growth_channel_cost_select ON "GrowthChannelCost" FOR SELECT TO app_rls USING (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_growth_channel_cost_insert ON "GrowthChannelCost" FOR INSERT TO app_rls WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_growth_channel_cost_update ON "GrowthChannelCost" FOR UPDATE TO app_rls USING (app_rls_tenant_allowed("tenantId")) WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_growth_channel_cost_delete ON "GrowthChannelCost" FOR DELETE TO app_rls USING (app_rls_tenant_allowed("tenantId"));
REVOKE ALL ON TABLE "GrowthChannelCost" FROM app_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "GrowthChannelCost" TO app_rls;
