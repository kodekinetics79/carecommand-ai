-- Campaign evidence retention and truthful provider-delivery milestones.
ALTER TABLE "Campaign"
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "dispatchAuthorizationFingerprint" TEXT,
  ADD COLUMN "dispatchAuthorizedByUserId" UUID,
  ADD COLUMN "dispatchAuthorizedAt" TIMESTAMP(3),
  ADD CONSTRAINT "Campaign_dispatch_authorization_shape_check" CHECK (
    ("dispatchAuthorizationFingerprint" IS NULL AND "dispatchAuthorizedByUserId" IS NULL AND "dispatchAuthorizedAt" IS NULL)
    OR
    ("dispatchAuthorizationFingerprint" ~ '^[0-9a-f]{64}$' AND "dispatchAuthorizedByUserId" IS NOT NULL AND "dispatchAuthorizedAt" IS NOT NULL)
  );

ALTER TABLE "CampaignDelivery"
  ADD COLUMN "providerAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "deliveredAt" TIMESTAMP(3),
  ADD COLUMN "statusUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Legacy `sent` meant only that the provider API accepted the request. Preserve
-- the timestamp while translating the state to the explicit vocabulary.
UPDATE "CampaignDelivery"
SET status = 'accepted',
    "providerAcceptedAt" = COALESCE("sentAt", "updatedAt"),
    "statusUpdatedAt" = "updatedAt"
WHERE status = 'sent';

UPDATE "CampaignDelivery"
SET status = 'queued',
    "statusUpdatedAt" = "updatedAt"
WHERE status = 'pending';

CREATE INDEX "Campaign_tenantId_archivedAt_createdAt_idx"
  ON "Campaign"("tenantId", "archivedAt", "createdAt");

CREATE INDEX "CampaignDelivery_tenantId_providerMessageId_idx"
  ON "CampaignDelivery"("tenantId", "providerMessageId");

-- PostgreSQL's default UNIQUE semantics treat NULL values as distinct, while a
-- delivery identity intentionally has exactly one of patientId/leadId. Make
-- concurrent submission claims truly unique for both recipient kinds.
-- The former index did not enforce that invariant for NULL identity columns,
-- so an upgrade must stop before dropping it if legacy duplicates exist. This
-- preserves every delivery/evidence row and gives operators an actionable,
-- deterministic preflight instead of selecting an arbitrary row to destroy.
DO $campaign_delivery_duplicate_preflight$
DECLARE
  duplicate_groups bigint;
  sample_campaign uuid;
BEGIN
  SELECT count(*), min("campaignId"::text)::uuid
  INTO duplicate_groups, sample_campaign
  FROM (
    SELECT "campaignId", "patientId", "leadId", channel
    FROM "CampaignDelivery"
    GROUP BY "campaignId", "patientId", "leadId", channel
    HAVING count(*) > 1
  ) duplicates;

  IF duplicate_groups > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = format(
        'CampaignDelivery integrity preflight found %s duplicate recipient/channel group(s); sample campaignId=%s. Reconcile every legacy row into retained delivery evidence before retrying migration 20260730280000.',
        duplicate_groups,
        sample_campaign
      ),
      HINT = 'Query CampaignDelivery grouped by campaignId, patientId, leadId, channel HAVING count(*) > 1; preserve provider/audit evidence and document the reconciliation.';
  END IF;
END
$campaign_delivery_duplicate_preflight$;

DROP INDEX "CampaignDelivery_campaignId_patientId_leadId_channel_key";
CREATE UNIQUE INDEX "CampaignDelivery_campaignId_patientId_leadId_channel_key"
  ON "CampaignDelivery"("campaignId", "patientId", "leadId", channel) NULLS NOT DISTINCT;

-- Runtime users can archive campaigns and advance delivery evidence, but they
-- cannot hard-delete either evidence table. Schema owners retain DELETE for
-- migrations, tenant lifecycle cleanup, and privileged recovery procedures.
CREATE OR REPLACE FUNCTION protect_campaign_evidence_from_runtime_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user = 'app_rls' THEN
    RAISE EXCEPTION '% is retained evidence; archive the campaign instead of deleting it', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "Campaign_runtime_delete_guard"
  BEFORE DELETE ON "Campaign"
  FOR EACH ROW EXECUTE FUNCTION protect_campaign_evidence_from_runtime_delete();

CREATE TRIGGER "CampaignDelivery_runtime_delete_guard"
  BEFORE DELETE ON "CampaignDelivery"
  FOR EACH ROW EXECUTE FUNCTION protect_campaign_evidence_from_runtime_delete();
