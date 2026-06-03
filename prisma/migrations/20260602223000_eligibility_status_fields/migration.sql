ALTER TABLE "Patient"
ADD COLUMN IF NOT EXISTS "eligibilityStatus" TEXT,
ADD COLUMN IF NOT EXISTS "eligibilityLastVerifiedAt" TIMESTAMP(3);

ALTER TABLE "Appointment"
ADD COLUMN IF NOT EXISTS "eligibilityStatus" TEXT,
ADD COLUMN IF NOT EXISTS "eligibilityLastVerifiedAt" TIMESTAMP(3);
