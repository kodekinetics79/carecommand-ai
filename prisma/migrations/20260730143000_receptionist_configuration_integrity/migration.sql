-- M09 trusted destination + explicit canonical scheduling-location mapping.
-- Existing location mappings remain NULL and therefore fail closed until an
-- operator selects a tenant-owned active Branch in Receptionist Studio.

ALTER TABLE "ReceptionistLocation"
  ADD COLUMN "branchId" uuid;

ALTER TABLE "ReceptionistLocation"
  ADD CONSTRAINT "ReceptionistLocation_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"(id)
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "ReceptionistLocation_tenantId_branchId_active_idx"
  ON "ReceptionistLocation"("tenantId", "branchId", active);

-- Mirror the migration-owned tenant-integrity convention established by
-- 20260730120000: Prisma models the ordinary id FK while this additional
-- composite FK prevents cross-tenant attachment at the database boundary.
CREATE INDEX "rls_ix_ead08ade4940f4807f47"
  ON "ReceptionistLocation"("tenantId", "branchId");

ALTER TABLE "ReceptionistLocation"
  ADD CONSTRAINT "rls_fk_1843ead4a0910c4950b2"
  FOREIGN KEY ("tenantId", "branchId") REFERENCES "Branch"("tenantId", id)
  NOT VALID;

ALTER TABLE "ReceptionistLocation"
  VALIDATE CONSTRAINT "rls_fk_1843ead4a0910c4950b2";

-- Canonicalize legacy destination formatting only after proving every value
-- can be represented as E.164 and that canonicalization will not collapse two
-- active destinations. The migration aborts for manual reconciliation instead
-- of silently choosing a tenant/clinic winner.
DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ReceptionistClinic" c
    CROSS JOIN LATERAL (
      SELECT '+' || regexp_replace(c.phone, '[^0-9]', '', 'g') AS canonical_phone
    ) normalized
    WHERE left(trim(c.phone), 1) <> '+'
       OR normalized.canonical_phone !~ '^\+[1-9][0-9]{7,14}$'
  ) THEN
    RAISE EXCEPTION 'receptionist_destination_invalid_e164: reconcile ReceptionistClinic.phone before migration';
  END IF;

  IF EXISTS (
    SELECT normalized.canonical_phone
    FROM "ReceptionistClinic" c
    CROSS JOIN LATERAL (
      SELECT '+' || regexp_replace(c.phone, '[^0-9]', '', 'g') AS canonical_phone
    ) normalized
    WHERE c.active
    GROUP BY normalized.canonical_phone
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'receptionist_destination_duplicate_active: reconcile duplicate active destinations before migration';
  END IF;
END
$preflight$;

UPDATE "ReceptionistClinic" c
SET phone = '+' || regexp_replace(c.phone, '[^0-9]', '', 'g');

ALTER TABLE "ReceptionistClinic"
  ADD CONSTRAINT "ReceptionistClinic_phone_e164_check"
  CHECK (phone ~ '^\+[1-9][0-9]{7,14}$');

DROP INDEX IF EXISTS "ReceptionistClinic_active_phone_idx";

CREATE UNIQUE INDEX "ReceptionistClinic_active_phone_unique"
  ON "ReceptionistClinic"(phone)
  WHERE active;
