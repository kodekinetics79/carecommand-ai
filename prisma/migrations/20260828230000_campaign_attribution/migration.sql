-- Closed-loop campaign attribution.
--
-- WHY
-- ---
-- "Campaign"."opened", "responded", "booked" and "revenue" have existed since
-- 20260602003000_expand_operations and NO application code path has ever
-- written one of them. The only mutation anywhere is "sent", in
-- server/lib/campaignDispatch.ts. They are nevertheless rendered as "Attributed
-- Revenue", "Recorded Bookings", "Open Rate" and "Booking / accepted": a clinic
-- could run a campaign end to end, successfully, and still be shown $0 — and,
-- worse, nothing prevented a future caller from typing any number it liked into
-- them. There was no join anywhere from CampaignDelivery to Appointment or to a
-- payment.
--
-- This migration lands that join as evidence, and then takes the four columns
-- out of anybody's hands.
--
-- WHAT
-- ----
--  1. "GrowthPolicy"."campaignAttributionWindowDays" — the configured window.
--     server/lib/campaignAttribution.ts reads it; there is no literal window in
--     the job. Adding a COLUMN to an existing table needs no RLS declaration:
--     GrowthPolicy already carries its own policies from
--     20260828140000_growth_config_spine.
--
--  2. "CampaignAttribution" — one row per (delivery, outcome). It records the
--     window that justified the link AT ATTRIBUTION TIME so a later policy edit
--     cannot retroactively rewrite what was already claimed, plus a PHI-free
--     evidence blob naming the delivery acceptance timestamp, the outcome
--     timestamp and the rule applied. It is a normal tenant-owned table (real
--     "tenantId" UUID NOT NULL with a Tenant FK — deliberately NOT the mistake
--     "AutomationRule" makes), so it declares the same four app_rls policies and
--     CRUD grants as every other MUTABLE table in
--     server/lib/rlsTableAdapters.ts. Immutability is enforced by the unique
--     indexes and the code paths that write it, exactly as
--     "CampaignSubmissionClaim" documents.
--
--  3. Three triggers that make the four legacy columns a MATERIALIZED ROLLUP of
--     that evidence and nothing else:
--       * "CampaignAttribution_tenant_consistency" — an attribution's campaign
--         must belong to its own tenant AND must be the campaign its delivery
--         belongs to. This is strictly stronger than the composite FK it stands
--         in for.
--       * "Campaign_attribution_rollup_guard" — any statement that tries to move
--         opened/responded/booked/revenue to a value the evidence does not
--         produce is refused with P0001; every other write silently re-derives
--         all four, so no ordinary campaign UPDATE can leave a stale number
--         behind. There is no session flag, no GUC and no role that turns this
--         off: the value you may write is the value the evidence produces, so a
--         human or a route CANNOT hand-set them.
--       * "CampaignAttribution_rollup_refresh" — writing/removing evidence
--         re-derives the owning campaign through that one guard, so the
--         arithmetic has exactly one definition.
--
-- NOT IN SCOPE, ON PURPOSE
-- ------------------------
-- Nothing here touches the dispatch fence (20260828200000_campaign_dispatch_fence)
-- and nothing here activates live dispatch for anybody. There is deliberately no
-- INSERT into "CampaignLiveDispatchActivation" in this file, no default that
-- could create one, and no backfill that could imply one. Attribution reads
-- delivery evidence; it never sends anything.

SET lock_timeout = '5s';
SET statement_timeout = '5min';

-- ---------------------------------------------------------------------------
-- 1. The configured attribution window.
-- ---------------------------------------------------------------------------
ALTER TABLE "GrowthPolicy" ADD COLUMN "campaignAttributionWindowDays" INTEGER NOT NULL DEFAULT 30;

-- ---------------------------------------------------------------------------
-- 2. The evidence table.
-- ---------------------------------------------------------------------------
CREATE TABLE "CampaignAttribution" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID,
    "campaignId" UUID NOT NULL,
    "campaignDeliveryId" UUID NOT NULL,
    "patientId" UUID,
    "leadId" UUID,
    "outcomeType" TEXT NOT NULL,
    "appointmentId" UUID,
    "paymentTransactionId" UUID,
    "attributedValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "windowDays" INTEGER NOT NULL,
    "windowStartsAt" TIMESTAMP(3) NOT NULL,
    "windowEndsAt" TIMESTAMP(3) NOT NULL,
    "rule" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "attributedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignAttribution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignAttribution_tenantId_campaignId_outcomeType_idx" ON "CampaignAttribution"("tenantId", "campaignId", "outcomeType");
CREATE INDEX "CampaignAttribution_tenantId_attributedAt_idx" ON "CampaignAttribution"("tenantId", "attributedAt");
CREATE INDEX "CampaignAttribution_tenantId_campaignDeliveryId_idx" ON "CampaignAttribution"("tenantId", "campaignDeliveryId");

-- CreateIndex
-- Idempotence. Re-running the attribution job for a delivery whose outcome of
-- this type is already recorded can only ever be a no-op.
CREATE UNIQUE INDEX "CampaignAttribution_tenantId_campaignDeliveryId_outcomeType_key" ON "CampaignAttribution"("tenantId", "campaignDeliveryId", "outcomeType");

-- CreateIndex
-- The anti-double-count, at the database. One appointment can be claimed by at
-- most ONE delivery per outcome type, so two campaigns that both reached the
-- same patient can never both book the same booking. NULLs stay distinct, which
-- is what lets a future non-appointment outcome type coexist here.
CREATE UNIQUE INDEX "CampaignAttribution_tenantId_outcomeType_appointmentId_key" ON "CampaignAttribution"("tenantId", "outcomeType", "appointmentId");

-- CreateIndex
-- Parent unique required by the tenant-composite payment FK below.
CREATE UNIQUE INDEX "PaymentTransaction_tenantId_id_key" ON "PaymentTransaction"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "CampaignAttribution" ADD CONSTRAINT "CampaignAttribution_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Tenant-composite throughout: an attribution can never point at another
-- tenant's branch, delivery, patient, lead, appointment or payment, even if an
-- id is guessed. CASCADE everywhere — an attribution to a record that no longer
-- exists is not evidence, and no attribution may block the deletion of the
-- thing it describes.
ALTER TABLE "CampaignAttribution" ADD CONSTRAINT "CampaignAttribution_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignAttribution" ADD CONSTRAINT "CampaignAttribution_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignAttribution" ADD CONSTRAINT "CampaignAttribution_tenantId_campaignDeliveryId_fkey" FOREIGN KEY ("tenantId", "campaignDeliveryId") REFERENCES "CampaignDelivery"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignAttribution" ADD CONSTRAINT "CampaignAttribution_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignAttribution" ADD CONSTRAINT "CampaignAttribution_tenantId_leadId_fkey" FOREIGN KEY ("tenantId", "leadId") REFERENCES "Lead"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignAttribution" ADD CONSTRAINT "CampaignAttribution_tenantId_appointmentId_fkey" FOREIGN KEY ("tenantId", "appointmentId") REFERENCES "Appointment"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignAttribution" ADD CONSTRAINT "CampaignAttribution_tenantId_paymentTransactionId_fkey" FOREIGN KEY ("tenantId", "paymentTransactionId") REFERENCES "PaymentTransaction"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security. 20260730120000_complete_rls_isolation applied its policy
-- loop once, at that migration; a table created afterwards inherits nothing and
-- must declare its own or it would be readable across tenants.
-- ---------------------------------------------------------------------------
ALTER TABLE "CampaignAttribution" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CampaignAttribution" FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_campaign_attribution_select ON "CampaignAttribution" FOR SELECT TO app_rls USING (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_campaign_attribution_insert ON "CampaignAttribution" FOR INSERT TO app_rls WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_campaign_attribution_update ON "CampaignAttribution" FOR UPDATE TO app_rls USING (app_rls_tenant_allowed("tenantId")) WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_campaign_attribution_delete ON "CampaignAttribution" FOR DELETE TO app_rls USING (app_rls_tenant_allowed("tenantId"));
REVOKE ALL ON TABLE "CampaignAttribution" FROM app_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "CampaignAttribution" TO app_rls;

-- ---------------------------------------------------------------------------
-- 3a. An attribution's campaign must be its own tenant's campaign, and must be
--     the campaign its delivery belongs to.
--
--     "Campaign" already carries a (tenantId, id) unique index under a
--     migration-owned rls_uq_ name, so declaring the composite relation in
--     Prisma would turn a managed DROP INDEX into an ALTER INDEX ... RENAME in
--     `prisma migrate diff` and move the pinned counts in
--     server/modules/platform/prismaDriftGuard.ts, which this increment does not
--     own. This trigger is what stands in for that FK — and it checks more than
--     the FK could, because it also refuses a campaignId that disagrees with the
--     delivery being attributed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign_attribution_tenant_consistency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  delivery_campaign uuid;
BEGIN
  SELECT d."campaignId" INTO delivery_campaign
  FROM "CampaignDelivery" d
  WHERE d."tenantId" = NEW."tenantId" AND d.id = NEW."campaignDeliveryId";

  -- P0001 (raise_exception), deliberately, and not 23503: Prisma rewrites a
  -- foreign-key SQLSTATE into "Foreign key constraint violated on the (not
  -- available)" and DISCARDS the message, which would make the most important
  -- refusal in this file unreadable in a log. P0001 surfaces the sentence.
  IF delivery_campaign IS NULL THEN
    RAISE EXCEPTION 'CampaignAttribution references a delivery outside its own tenant'
      USING ERRCODE = 'P0001';
  END IF;

  IF delivery_campaign <> NEW."campaignId" THEN
    RAISE EXCEPTION 'CampaignAttribution.campaignId is not the campaign its delivery belongs to'
      USING ERRCODE = 'P0001',
            HINT = 'An attribution names the campaign that actually sent the message being credited.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "Campaign" c WHERE c.id = NEW."campaignId" AND c."tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION 'CampaignAttribution references a campaign outside its own tenant'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "CampaignAttribution_tenant_consistency"
  BEFORE INSERT OR UPDATE ON "CampaignAttribution"
  FOR EACH ROW EXECUTE FUNCTION campaign_attribution_tenant_consistency();

-- ---------------------------------------------------------------------------
-- 3b. The four legacy columns become a rollup nobody can hand-set.
--
--     Every existing value is a number no code produced. Reset them here, while
--     the guard does not exist yet, so the table starts from the only defensible
--     state: zero, until evidence says otherwise.
-- ---------------------------------------------------------------------------
UPDATE "Campaign"
   SET "opened" = 0, "responded" = 0, "booked" = 0, "revenue" = 0
 WHERE "opened" <> 0 OR "responded" <> 0 OR "booked" <> 0 OR "revenue" <> 0;

CREATE OR REPLACE FUNCTION campaign_attribution_rollup_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  derived_booked  integer := 0;
  derived_revenue numeric(12,2) := 0;
BEGIN
  -- SECURITY DEFINER with an explicit "tenantId" predicate: the arithmetic must
  -- not depend on whether the writing session happens to have RLS context, and
  -- it can only ever see the campaign's OWN tenant's evidence.
  SELECT
    COALESCE(count(*) FILTER (WHERE a."outcomeType" = 'booked'), 0),
    COALESCE(sum(a."attributedValue") FILTER (WHERE a."outcomeType" = 'paid'), 0)
    INTO derived_booked, derived_revenue
  FROM "CampaignAttribution" a
  WHERE a."tenantId" = NEW."tenantId" AND a."campaignId" = NEW.id;

  -- opened/responded are PINNED AT ZERO, not merely unwritten. This platform has
  -- no truthful engagement receipt: normalizeProviderDeliveryStatus in
  -- server/lib/campaignIntegrity.ts deliberately maps a provider "opened" event
  -- to NULL rather than accept it. There is nothing to count, so the honest
  -- rendering of an open rate is 0%, held there by construction.
  IF TG_OP = 'INSERT' THEN
    IF NEW."opened" <> 0 OR NEW."responded" <> 0
       OR NEW."booked" <> derived_booked OR NEW."revenue" <> derived_revenue THEN
      RAISE EXCEPTION 'Campaign.opened/responded/booked/revenue are a rollup of CampaignAttribution and cannot be set by a caller'
        USING ERRCODE = 'P0001',
              HINT = 'Write the CampaignAttribution evidence; the rollup follows from it. See prisma/migrations/20260828230000_campaign_attribution.';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."opened"    IS DISTINCT FROM OLD."opened"    AND NEW."opened"    <> 0)
     OR (NEW."responded" IS DISTINCT FROM OLD."responded" AND NEW."responded" <> 0)
     OR (NEW."booked"    IS DISTINCT FROM OLD."booked"    AND NEW."booked"    <> derived_booked)
     OR (NEW."revenue"   IS DISTINCT FROM OLD."revenue"   AND NEW."revenue"   <> derived_revenue) THEN
    RAISE EXCEPTION 'Campaign.opened/responded/booked/revenue are a rollup of CampaignAttribution and cannot be set by a caller'
      USING ERRCODE = 'P0001',
            HINT = 'Write the CampaignAttribution evidence; the rollup follows from it. See prisma/migrations/20260828230000_campaign_attribution.';
  END IF;

  -- Any other UPDATE (a status change, an archive, a dispatch summary) silently
  -- re-derives all four, so a campaign row can never carry a stale figure.
  NEW."opened"    := 0;
  NEW."responded" := 0;
  NEW."booked"    := derived_booked;
  NEW."revenue"   := derived_revenue;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Campaign_attribution_rollup_guard"
  BEFORE INSERT OR UPDATE ON "Campaign"
  FOR EACH ROW EXECUTE FUNCTION campaign_attribution_rollup_guard();

-- ---------------------------------------------------------------------------
-- 3c. Evidence changes re-derive the owning campaign THROUGH the guard above,
--     so the rollup arithmetic is written down exactly once.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION campaign_attribution_rollup_refresh()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  new_tenant   uuid;
  new_campaign uuid;
  old_tenant   uuid;
  old_campaign uuid;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    new_tenant := NEW."tenantId";
    new_campaign := NEW."campaignId";
    -- A no-op assignment: the BEFORE trigger on "Campaign" recomputes the four
    -- columns, so this function never restates the arithmetic.
    UPDATE "Campaign" SET "updatedAt" = "updatedAt"
     WHERE id = new_campaign AND "tenantId" = new_tenant;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    old_tenant := OLD."tenantId";
    old_campaign := OLD."campaignId";
    IF old_campaign IS DISTINCT FROM new_campaign OR old_tenant IS DISTINCT FROM new_tenant THEN
      -- The campaign the row USED to credit must also stop counting it. The row
      -- is immutable by contract, so this only fires on DELETE in practice.
      UPDATE "Campaign" SET "updatedAt" = "updatedAt"
       WHERE id = old_campaign AND "tenantId" = old_tenant;
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER "CampaignAttribution_rollup_refresh"
  AFTER INSERT OR UPDATE OR DELETE ON "CampaignAttribution"
  FOR EACH ROW EXECUTE FUNCTION campaign_attribution_rollup_refresh();
