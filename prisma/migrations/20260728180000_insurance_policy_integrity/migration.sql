-- Multi-policy coordination of benefits.
-- Coverage intervals are [effectiveFrom, effectiveTo): start inclusive, end exclusive.
-- Deterministically rank legacy active policies so existing data is preserved.
ALTER TABLE "PatientInsurancePolicy"
  ADD COLUMN "coverageOrder" INTEGER,
  ADD COLUMN "effectiveFrom" TIMESTAMP(3),
  ADD COLUMN "effectiveTo" TIMESTAMP(3);

UPDATE "PatientInsurancePolicy"
SET "coverageOrder" = 1,
    "effectiveFrom" = "createdAt";

WITH ranked AS (
  SELECT "id",
         ROW_NUMBER() OVER (
           PARTITION BY "tenantId", "patientId"
           ORDER BY "updatedAt" DESC, "createdAt" DESC, "id" ASC
         ) AS rank
  FROM "PatientInsurancePolicy"
  WHERE "active" = true
)
UPDATE "PatientInsurancePolicy" AS policy
SET "coverageOrder" = ranked.rank
FROM ranked
WHERE ranked."id" = policy."id";

ALTER TABLE "PatientInsurancePolicy"
  ALTER COLUMN "coverageOrder" SET DEFAULT 1,
  ALTER COLUMN "coverageOrder" SET NOT NULL,
  ALTER COLUMN "effectiveFrom" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "effectiveFrom" SET NOT NULL;

ALTER TABLE "PatientInsurancePolicy"
  ADD CONSTRAINT "PatientInsurancePolicy_coverageOrder_check"
    CHECK ("coverageOrder" >= 1),
  ADD CONSTRAINT "PatientInsurancePolicy_effectiveRange_check"
    CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");

CREATE INDEX "PatientInsurancePolicy_tenantId_patientId_coverageOrder_effective_idx"
  ON "PatientInsurancePolicy"("tenantId", "patientId", "coverageOrder", "effectiveFrom", "effectiveTo");

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "PatientInsurancePolicy"
  ADD CONSTRAINT "PatientInsurancePolicy_active_order_range_excl"
  EXCLUDE USING gist (
    "tenantId" WITH =,
    "patientId" WITH =,
    "coverageOrder" WITH =,
    tsrange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::timestamp), '[)') WITH &&
  ) WHERE ("active" = true);
