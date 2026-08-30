-- ===========================================================================
-- Package A — "the line is ours".
--
-- Two facts this migration makes representable.
--
-- 1. A clinic owns ONE inbound line. Until now every deploy bound the single
--    process-wide RETELL_FROM_NUMBER, so the second clinic's deploy silently
--    repointed the first clinic's number: callers to A reached B's agent, B's
--    hours and B's disclosure, and bookings landed in B's branch — while both
--    clinics' checklists read `number_bound = pass`. `inboundNumber` is that
--    line, globally unique among active clinics exactly as `phone` already is,
--    because a phone number is unique in the world and not per tenant.
--
-- 2. `numberBound` was a claim CareCommand wrote at deploy time and then read
--    back to itself. The five `numberBinding*` columns are what the PROVIDER
--    answered when asked again, and `numberBindingVerifiedAt` is the only one a
--    readiness check may pass on.
--
-- No new tables: the RLS catalogue count is unchanged.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- ReceptionistClinic.inboundNumber
-- ---------------------------------------------------------------------------
ALTER TABLE "ReceptionistClinic"
  ADD COLUMN "inboundNumber" text;

-- Backfill from the advertised line. `phone` is already canonical E.164 and
-- already carries a global active-unique index (20260730143000), so this
-- backfill can neither produce an invalid value nor collide.
UPDATE "ReceptionistClinic" SET "inboundNumber" = phone;

ALTER TABLE "ReceptionistClinic"
  ADD CONSTRAINT "ReceptionistClinic_inbound_number_e164_check"
  CHECK ("inboundNumber" IS NULL OR "inboundNumber" ~ '^\+[1-9][0-9]{7,14}$');

-- Global, not tenant-scoped, and deliberately so: two active clinics — in one
-- tenant or in two — cannot both answer on the same number, and the database is
-- where that is settled rather than in whichever deploy ran last.
CREATE UNIQUE INDEX "ReceptionistClinic_active_inbound_number_unique"
  ON "ReceptionistClinic"("inboundNumber")
  WHERE active AND "inboundNumber" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- ReceptionistAgentDeployment: the provider's own answer about the binding
-- ---------------------------------------------------------------------------
ALTER TABLE "ReceptionistAgentDeployment"
  ADD COLUMN "numberBindingReadAt" timestamp(3),
  ADD COLUMN "numberBindingAgentId" text,
  ADD COLUMN "numberBindingAgentVersion" integer,
  ADD COLUMN "numberBindingVerifiedAt" timestamp(3),
  ADD COLUMN "numberBindingErrorCode" text;

-- The old shape check forbade recording WHICH number a failed bind targeted,
-- which is the one thing an operator needs when a bind fails. Keep the real
-- invariant (a bound deployment names a real E.164 number) and drop the part
-- that was only forcing us to forget.
ALTER TABLE "ReceptionistAgentDeployment"
  DROP CONSTRAINT "ReceptionistAgentDeployment_bound_number_check";

ALTER TABLE "ReceptionistAgentDeployment"
  ADD CONSTRAINT "ReceptionistAgentDeployment_bound_number_check"
    CHECK (
      ("boundPhoneNumber" IS NULL OR "boundPhoneNumber" ~ '^\+[1-9][0-9]{7,14}$')
      AND (NOT "numberBound" OR "boundPhoneNumber" IS NOT NULL)
    ),
  -- A read-back is a fact or it is absent; it is never half-recorded.
  ADD CONSTRAINT "ReceptionistAgentDeployment_number_binding_read_check"
    CHECK (
      ("numberBindingAgentId" IS NULL OR "numberBindingAgentId" ~ '^[A-Za-z0-9_-]{1,128}$')
      AND ("numberBindingAgentVersion" IS NULL OR "numberBindingAgentVersion" >= 0)
      AND ("numberBindingAgentId" IS NULL OR "numberBindingReadAt" IS NOT NULL)
    ),
  -- `numberBindingVerifiedAt` is an attestation: it exists only when the
  -- provider named THIS deployment's published agent and version.
  ADD CONSTRAINT "ReceptionistAgentDeployment_number_binding_verified_check"
    CHECK (
      "numberBindingVerifiedAt" IS NULL
      OR (
        "numberBindingReadAt" IS NOT NULL
        AND "boundPhoneNumber" IS NOT NULL
        AND "providerAgentId" IS NOT NULL
        AND "providerAgentVersion" IS NOT NULL
        AND "numberBindingAgentId" = "providerAgentId"
        AND "numberBindingAgentVersion" = "providerAgentVersion"
        AND "numberBindingErrorCode" IS NULL
      )
    );

-- Deploy asks "does a live deployment already own this line?" before it binds.
-- 63-byte identifier limit: this is exactly the name Prisma gives
-- @@index([tenantId, boundPhoneNumber, status]).
CREATE INDEX "ReceptionistAgentDeployment_tenantId_boundPhoneNumber_statu_idx"
  ON "ReceptionistAgentDeployment"("tenantId", "boundPhoneNumber", "status");
