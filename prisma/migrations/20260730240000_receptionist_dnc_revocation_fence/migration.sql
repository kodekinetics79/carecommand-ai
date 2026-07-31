-- Preserve DNC history. Removing suppression is a reasoned revocation, never a
-- physical delete, so the original request remains available for compliance
-- evidence and incident reconstruction.
ALTER TABLE "ReceptionistOptOut"
  ADD COLUMN "revokedAt" TIMESTAMP(3),
  ADD COLUMN "revokedByUserId" UUID,
  ADD COLUMN "revocationReason" TEXT;

ALTER TABLE "ReceptionistOptOut"
  ADD CONSTRAINT "ReceptionistOptOut_revocation_complete_check"
  CHECK (
    ("revokedAt" IS NULL AND "revokedByUserId" IS NULL AND "revocationReason" IS NULL)
    OR
    ("revokedAt" IS NOT NULL AND "revokedByUserId" IS NOT NULL AND length(btrim("revocationReason")) BETWEEN 5 AND 500)
  );

ALTER TABLE "ReceptionistOptOut"
  ADD CONSTRAINT "ReceptionistOptOut_reason_bounded_check"
  CHECK ("reason" IS NULL OR length(btrim("reason")) BETWEEN 3 AND 300) NOT VALID;

ALTER TABLE "ReceptionistOptOut"
  ADD CONSTRAINT "ReceptionistOptOut_tenantId_revokedByUserId_fkey"
  FOREIGN KEY ("tenantId", "revokedByUserId") REFERENCES "User"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION receptionist_canonical_suppression_destination(value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  trimmed text := btrim(value);
  digits text;
BEGIN
  IF trimmed IS NULL OR trimmed = '' THEN RETURN ''; END IF;
  IF position('@' IN trimmed) > 0 THEN RETURN lower(trimmed); END IF;
  digits := regexp_replace(trimmed, '[^0-9]', '', 'g');
  IF digits = '' THEN RETURN ''; END IF;
  IF left(trimmed, 1) = '+' THEN RETURN '+' || digits; END IF;
  IF length(digits) = 10 THEN RETURN '+1' || digits; END IF;
  RETURN '+' || digits;
END;
$$;

CREATE OR REPLACE FUNCTION receptionist_lock_suppression_keys(keys text[])
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  lock_key text;
BEGIN
  FOR lock_key IN SELECT DISTINCT value FROM unnest(keys) AS value WHERE value IS NOT NULL AND value <> '' ORDER BY value
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(lock_key, 0));
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION receptionist_opt_out_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  row_tenant uuid := COALESCE(NEW."tenantId", OLD."tenantId");
  old_phone text := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE receptionist_canonical_suppression_destination(OLD."contactPhone") END;
  old_email text := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE receptionist_canonical_suppression_destination(OLD."contactEmail") END;
  new_phone text := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE receptionist_canonical_suppression_destination(NEW."contactPhone") END;
  new_email text := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE receptionist_canonical_suppression_destination(NEW."contactEmail") END;
BEGIN
  PERFORM receptionist_lock_suppression_keys(ARRAY[
    CASE WHEN old_phone <> '' THEN 'receptionist-suppression:destination:' || row_tenant || ':' || old_phone END,
    CASE WHEN old_email <> '' THEN 'receptionist-suppression:destination:' || row_tenant || ':' || old_email END,
    CASE WHEN new_phone <> '' THEN 'receptionist-suppression:destination:' || row_tenant || ':' || new_phone END,
    CASE WHEN new_email <> '' THEN 'receptionist-suppression:destination:' || row_tenant || ':' || new_email END
  ]);

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ReceptionistOptOut is append-only; record a reasoned revocation' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;

  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."clinicId" IS DISTINCT FROM OLD."clinicId"
    OR NEW."contactPhone" IS DISTINCT FROM OLD."contactPhone"
    OR NEW."contactEmail" IS DISTINCT FROM OLD."contactEmail"
    OR NEW."channel" IS DISTINCT FROM OLD."channel"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'ReceptionistOptOut original evidence is immutable' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'ReceptionistOptOut revocation evidence is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."revokedAt" IS NULL THEN
    IF NEW."revokedByUserId" IS NOT NULL OR NEW."revocationReason" IS NOT NULL THEN
      RAISE EXCEPTION 'ReceptionistOptOut revocation evidence must be complete' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."revokedByUserId" IS NULL OR length(btrim(NEW."revocationReason")) NOT BETWEEN 5 AND 500 THEN
    RAISE EXCEPTION 'ReceptionistOptOut revocation evidence must be complete' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ReceptionistOptOut_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ReceptionistOptOut"
FOR EACH ROW EXECUTE FUNCTION receptionist_opt_out_guard();

CREATE OR REPLACE FUNCTION receptionist_identity_suppression_fence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  tenant uuid := COALESCE(NEW."tenantId", OLD."tenantId");
BEGIN
  PERFORM receptionist_lock_suppression_keys(ARRAY[
    CASE WHEN TG_OP <> 'INSERT' AND OLD."patientId" IS NOT NULL THEN 'receptionist-suppression:patient:' || OLD."tenantId" || ':' || OLD."patientId" END,
    CASE WHEN TG_OP <> 'INSERT' AND OLD."leadId" IS NOT NULL THEN 'receptionist-suppression:lead:' || OLD."tenantId" || ':' || OLD."leadId" END,
    CASE WHEN TG_OP <> 'DELETE' AND NEW."patientId" IS NOT NULL THEN 'receptionist-suppression:patient:' || NEW."tenantId" || ':' || NEW."patientId" END,
    CASE WHEN TG_OP <> 'DELETE' AND NEW."leadId" IS NOT NULL THEN 'receptionist-suppression:lead:' || NEW."tenantId" || ':' || NEW."leadId" END
  ]);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "CommunicationConsent_suppression_fence"
BEFORE INSERT OR UPDATE OR DELETE ON "CommunicationConsent"
FOR EACH ROW EXECUTE FUNCTION receptionist_identity_suppression_fence();

CREATE TRIGGER "CampaignSuppression_suppression_fence"
BEFORE INSERT OR UPDATE OR DELETE ON "CampaignSuppression"
FOR EACH ROW EXECUTE FUNCTION receptionist_identity_suppression_fence();

CREATE OR REPLACE FUNCTION receptionist_consent_event_suppression_fence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM receptionist_lock_suppression_keys(ARRAY[
    CASE WHEN TG_OP <> 'INSERT' THEN 'receptionist-suppression:patient:' || OLD."tenantId" || ':' || OLD."patientId" END,
    CASE WHEN TG_OP <> 'DELETE' THEN 'receptionist-suppression:patient:' || NEW."tenantId" || ':' || NEW."patientId" END
  ]);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "ConsentEvent_suppression_fence"
BEFORE INSERT OR UPDATE OR DELETE ON "ConsentEvent"
FOR EACH ROW EXECUTE FUNCTION receptionist_consent_event_suppression_fence();

-- A late provider acceptance is stronger evidence than an earlier local
-- "FAILED before provider id" assumption. Permit only that monotonic safety
-- upgrade; every other first-terminal transition remains prohibited.
CREATE OR REPLACE FUNCTION "enforce_receptionist_call_first_terminal_outcome"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."outcome" <> 'IN_PROGRESS' AND NEW."outcome" <> OLD."outcome" THEN
    IF NOT (
      OLD."outcome" = 'FAILED'
      AND NEW."outcome" = 'ESCALATED'
      AND OLD."retellCallId" IS NULL
      AND NEW."retellCallId" IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'ReceptionistCallLog terminal outcome is immutable (% -> %)', OLD."outcome", NEW."outcome";
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
