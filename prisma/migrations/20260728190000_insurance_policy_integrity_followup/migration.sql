-- Preserve long-running patient insurance histories. The API limits ordinary
-- coordination order entry, but legacy ranks may be greater than nine.
ALTER TABLE "PatientInsurancePolicy"
  DROP CONSTRAINT IF EXISTS "PatientInsurancePolicy_coverageOrder_check";

UPDATE "PatientInsurancePolicy"
SET "coverageOrder" = 1
WHERE "active" = false;

ALTER TABLE "PatientInsurancePolicy"
  ADD CONSTRAINT "PatientInsurancePolicy_coverageOrder_check"
    CHECK ("coverageOrder" >= 1);
