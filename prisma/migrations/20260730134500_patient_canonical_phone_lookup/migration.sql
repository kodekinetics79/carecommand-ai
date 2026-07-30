-- Bounded AI-receptionist identity and booking lookup. The expression mirrors
-- the application E.164 canonicalizer for the default North-American country
-- code while preserving already international digit strings.
CREATE INDEX IF NOT EXISTS "Patient_tenant_canonical_phone_active_idx"
ON "Patient" (
  "tenantId",
  (CASE
    WHEN "phone" LIKE '+%' THEN '+' || regexp_replace("phone", '[^0-9]', '', 'g')
    WHEN length(regexp_replace("phone", '[^0-9]', '', 'g')) = 10 THEN '+1' || regexp_replace("phone", '[^0-9]', '', 'g')
    ELSE '+' || regexp_replace("phone", '[^0-9]', '', 'g')
  END)
)
WHERE "deletedAt" IS NULL AND "phone" IS NOT NULL;
