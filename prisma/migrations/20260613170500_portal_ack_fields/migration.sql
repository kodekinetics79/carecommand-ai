ALTER TABLE "PatientPortalAccount" ADD COLUMN IF NOT EXISTS "paymentPolicyAckAt" TIMESTAMP(3);
ALTER TABLE "PatientResponsibilityEstimate" ADD COLUMN IF NOT EXISTS "acknowledgedAt" TIMESTAMP(3);
