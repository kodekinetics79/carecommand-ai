-- Preserve every historical deployment's inbound purpose. Outbound-only
-- publication must never claim (or attest) that any inbound number was bound.
ALTER TABLE "ReceptionistAgentDeployment"
  ADD COLUMN "deploymentMode" text NOT NULL DEFAULT 'INBOUND',
  ADD CONSTRAINT "ReceptionistAgentDeployment_mode_check"
    CHECK ("deploymentMode" IN ('INBOUND', 'OUTBOUND_ONLY')),
  ADD CONSTRAINT "ReceptionistAgentDeployment_outbound_unbound_check"
    CHECK ("deploymentMode" <> 'OUTBOUND_ONLY' OR (
      NOT "numberBound"
      AND "boundPhoneNumber" IS NULL
      AND "numberBindingReadAt" IS NULL
      AND "numberBindingAgentId" IS NULL
      AND "numberBindingAgentVersion" IS NULL
      AND "numberBindingVerifiedAt" IS NULL
      AND "numberBindingErrorCode" IS NULL
    ));
