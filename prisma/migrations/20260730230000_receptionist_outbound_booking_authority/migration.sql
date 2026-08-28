-- Safe, explicit booking authority for autonomous outbound receptionist calls.
-- Existing campaigns remain request-only/unapproved until an operator links and
-- activates a currently attested ReceptionistCampaign.

ALTER TABLE "ReceptionistOutboundCampaign"
  ADD COLUMN "receptionistCampaignId" UUID,
  ADD COLUMN "purpose" TEXT,
  ADD COLUMN "legalBasis" TEXT,
  ADD COLUMN "policyVersion" TEXT,
  ADD COLUMN "authorityApprovedAt" TIMESTAMP(3),
  ADD COLUMN "authorityApprovedById" UUID,
  ADD COLUMN "authorityFingerprint" TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ReceptionistOutboundCampaign"
    WHERE "status" IN ('SCHEDULED', 'RUNNING')
       OR "bookingMode" = 'DIRECT_BOOKING_IF_SLOT_AVAILABLE'
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'receptionist outbound authority preflight failed',
      DETAIL = 'Pause existing runnable campaigns and link/re-approve legacy direct campaigns before applying this migration; no rows were changed.';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ReceptionistCallTarget"
    WHERE (("patientId" IS NOT NULL)::int + ("leadId" IS NOT NULL)::int) <> 1
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'receptionist outbound target selector preflight failed',
      DETAIL = 'Every existing target must identify exactly one patient or lead before migration; no rows were changed.';
  END IF;
END $$;

CREATE UNIQUE INDEX "ReceptionistCampaign_tenantId_clinicId_id_key"
  ON "ReceptionistCampaign"("tenantId", "clinicId", "id");

CREATE UNIQUE INDEX "User_tenantId_id_key"
  ON "User"("tenantId", "id");

CREATE UNIQUE INDEX "Lead_tenantId_id_key"
  ON "Lead"("tenantId", "id");

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ReceptionistCallTarget"
    GROUP BY "tenantId", "campaignId", "phone"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'receptionist outbound target uniqueness preflight failed',
      DETAIL = 'Duplicate campaign destinations must be reconciled before migration; no rows were changed.';
  END IF;
END $$;

CREATE UNIQUE INDEX "ReceptionistCallTarget_tenantId_campaignId_phone_key"
  ON "ReceptionistCallTarget"("tenantId", "campaignId", "phone");

CREATE INDEX "ReceptionistOutboundCampaign_tenantId_receptionistCampaignI_idx"
  ON "ReceptionistOutboundCampaign"("tenantId", "receptionistCampaignId");

ALTER TABLE "ReceptionistOutboundCampaign"
  ADD CONSTRAINT "ReceptionistOutboundCampaign_booking_authority_fkey"
  FOREIGN KEY ("tenantId", "clinicId", "receptionistCampaignId")
  REFERENCES "ReceptionistCampaign"("tenantId", "clinicId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ReceptionistCallTarget" target
    LEFT JOIN "Patient" patient
      ON patient."tenantId" = target."tenantId" AND patient."id" = target."patientId"
    LEFT JOIN "Lead" lead
      ON lead."tenantId" = target."tenantId" AND lead."id" = target."leadId"
    WHERE (target."patientId" IS NOT NULL AND patient."id" IS NULL)
       OR (target."leadId" IS NOT NULL AND lead."id" IS NULL)
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'receptionist outbound target identity preflight failed',
      DETAIL = 'One or more target patient/lead selectors are cross-tenant or orphaned; no rows were changed.';
  END IF;
END $$;

ALTER TABLE "ReceptionistCallTarget"
  ADD CONSTRAINT "ReceptionistCallTarget_patient_scope_fkey"
  FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReceptionistCallTarget"
  ADD CONSTRAINT "ReceptionistCallTarget_lead_scope_fkey"
  FOREIGN KEY ("tenantId", "leadId") REFERENCES "Lead"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReceptionistCallTarget"
  ADD CONSTRAINT "ReceptionistCallTarget_exact_identity_check"
  CHECK (("patientId" IS NOT NULL)::int + ("leadId" IS NOT NULL)::int = 1);

ALTER TABLE "ReceptionistOutboundCampaign"
  ADD CONSTRAINT "ReceptionistOutboundCampaign_tenantId_authorityApprovedByI_fkey"
  FOREIGN KEY ("tenantId", "authorityApprovedById")
  REFERENCES "User"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReceptionistOutboundCampaign"
  ADD CONSTRAINT "ReceptionistOutboundCampaign_direct_authority_check"
  CHECK (
    "bookingMode" <> 'DIRECT_BOOKING_IF_SLOT_AVAILABLE'
    OR (
      "receptionistCampaignId" IS NOT NULL
      AND "agentId" IS NOT NULL
      AND "defaultBranchId" IS NOT NULL
      AND NULLIF(BTRIM("defaultService"), '') IS NOT NULL
      AND "purpose" IN ('CARE_COORDINATION', 'APPOINTMENT_REMINDER', 'PATIENT_REACTIVATION')
      AND "legalBasis" IN ('EXPLICIT_CONSENT', 'TREATMENT_OPERATIONS')
      AND NULLIF(BTRIM("policyVersion"), '') IS NOT NULL
    )
  );

ALTER TABLE "ReceptionistOutboundCampaign"
  ADD CONSTRAINT "ReceptionistOutboundCampaign_runnable_authority_check"
  CHECK (
    "status" NOT IN ('SCHEDULED', 'RUNNING')
    OR (
      "purpose" IN ('CARE_COORDINATION', 'APPOINTMENT_REMINDER', 'PATIENT_REACTIVATION')
      AND "legalBasis" IN ('EXPLICIT_CONSENT', 'TREATMENT_OPERATIONS')
      AND NULLIF(BTRIM("policyVersion"), '') IS NOT NULL
      AND "authorityApprovedAt" IS NOT NULL
      AND "authorityApprovedById" IS NOT NULL
      AND NULLIF(BTRIM("authorityFingerprint"), '') IS NOT NULL
    )
  );
