-- Campaign branch scope.
--
-- WHY
-- ---
-- 20260828140000_growth_config_spine branch-scoped the audience PREVIEW
-- (buildAudience accepts a branchId) but left DISPATCH tenant-wide, because
-- "Campaign" had nowhere to record the scope the campaign was created under.
-- The result: a branch-restricted MANAGER previewed only their own branch and
-- then launched to the entire tenant, reaching patients they cannot otherwise
-- read.
--
-- "branchId" is that missing column. It is the ONE place the scope lives, and
-- the audience query, the launch preview, the launch fingerprint and dispatch
-- all resolve through it, so preview and dispatch can no longer disagree about
-- who is in scope.
--
-- NULLABLE ON PURPOSE
-- -------------------
-- NULL means "deliberately tenant-wide". That is a legitimate campaign for an
-- operator who is not restricted to a branch, and it is what every campaign
-- created before this migration actually was. There is therefore NO backfill
-- below: every existing row keeps NULL and keeps behaving exactly as it did.
-- Only server/modules/campaigns/routes.ts can write a non-NULL value, and only
-- from the authenticated caller's own branch.
--
-- Semantics match branchScope() in server/lib/scope.ts: exact match, and a
-- NULL-branch row is OUT of scope for a branch-restricted caller (fail closed),
-- so a scoped MANAGER cannot open — or launch — someone else's tenant-wide
-- campaign either.
--
-- RLS
-- ---
-- None required. "Campaign" is a pre-existing tenant table already enrolled by
-- 20260730120000_complete_rls_isolation's dynamic loop over every table with a
-- tenantId column: it already has ENABLE/FORCE ROW LEVEL SECURITY, its four
-- app_rls policies and its CRUD grants. Those cover a new COLUMN automatically.
-- Only a NEW table would have to declare its own (see
-- 20260828200000_campaign_dispatch_fence).
--
-- DISPATCH FENCE
-- --------------
-- Nothing here touches CampaignSubmissionClaim or
-- CampaignLiveDispatchActivation. Live dispatch stays default OFF: this
-- migration contains no INSERT, no DEFAULT and no UPDATE that could activate a
-- tenant, and it neither adds nor removes a step in the submission fence.

SET lock_timeout = '5s';
SET statement_timeout = '5min';

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "branchId" UUID;

-- CreateIndex
CREATE INDEX "Campaign_tenantId_branchId_createdAt_idx" ON "Campaign"("tenantId", "branchId", "createdAt");

-- AddForeignKey
-- Tenant-consistent composite FK ("tenantId" leads, as every branch-scoped
-- table in this schema does): a campaign can never be attached to another
-- tenant's branch, even if a branch id is guessed. RESTRICT, not SET NULL —
-- SET NULL would silently promote a branch-scoped campaign to tenant-wide the
-- moment its branch was removed, which is precisely the widening this
-- migration exists to prevent. MATCH SIMPLE (the PostgreSQL default) leaves the
-- constraint unenforced when "branchId" IS NULL, which is what makes the
-- tenant-wide campaign representable.
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
