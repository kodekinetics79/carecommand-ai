ALTER TABLE "ReceptionistCallLog"
  ADD COLUMN "boundProviderAgentId" TEXT,
  ADD COLUMN "boundProviderAgentVersion" INTEGER,
  ADD COLUMN "boundProviderConfigRevision" INTEGER,
  ADD COLUMN "boundProviderFingerprint" TEXT;

ALTER TABLE "ReceptionistCallLog"
  ADD CONSTRAINT "ReceptionistCallLog_provider_binding_complete_check"
  CHECK (
    ("boundProviderAgentId" IS NULL
      AND "boundProviderAgentVersion" IS NULL
      AND "boundProviderConfigRevision" IS NULL
      AND "boundProviderFingerprint" IS NULL)
    OR
    ("boundProviderAgentId" IS NOT NULL
      AND "boundProviderAgentVersion" IS NOT NULL
      AND "boundProviderConfigRevision" IS NOT NULL
      AND "boundProviderFingerprint" IS NOT NULL)
  );

CREATE INDEX "ReceptionistCallLog_tenantId_boundProviderAgentId_boundProv_idx"
  ON "ReceptionistCallLog"("tenantId", "boundProviderAgentId", "boundProviderAgentVersion");

CREATE OR REPLACE FUNCTION "prevent_receptionist_call_provider_binding_mutation"()
RETURNS trigger AS $$
BEGIN
  IF OLD."boundProviderAgentId" IS NOT NULL AND (
    NEW."boundProviderAgentId" IS DISTINCT FROM OLD."boundProviderAgentId"
    OR NEW."boundProviderAgentVersion" IS DISTINCT FROM OLD."boundProviderAgentVersion"
    OR NEW."boundProviderConfigRevision" IS DISTINCT FROM OLD."boundProviderConfigRevision"
    OR NEW."boundProviderFingerprint" IS DISTINCT FROM OLD."boundProviderFingerprint"
  ) THEN
    RAISE EXCEPTION 'receptionist inbound provider deployment binding is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ReceptionistCallLog_provider_binding_immutable"
BEFORE UPDATE ON "ReceptionistCallLog"
FOR EACH ROW EXECUTE FUNCTION "prevent_receptionist_call_provider_binding_mutation"();
