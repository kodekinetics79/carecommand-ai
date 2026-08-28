-- Additive, non-destructive migration.
--
-- 1) DB-LEVEL double-book prevention (P0). Application-layer conflict checks race
--    under concurrency (check-then-insert). A Postgres GiST exclusion constraint
--    makes overlapping bookings for the SAME provider impossible at the storage
--    layer, closing the race across ALL create paths (staff, scheduling, portal,
--    receptionist) at once. Only rows with a real provider link and a
--    still-active status participate — CANCELED / NO_SHOW free the slot, and
--    provider-less legacy appointments keep their prior (unconstrained) behavior.
--
-- 2) Front-desk date-of-birth capture (MAJOR). Nullable, date-only column so the
--    front desk can record / verify a patient's DOB.
--
-- Rollback:
--   ALTER TABLE "Appointment" DROP CONSTRAINT "appointment_no_double_book";
--   ALTER TABLE "Patient" DROP COLUMN "dateOfBirth";
--   -- (btree_gist left installed; harmless and may be shared)

-- Required for an exclusion constraint that mixes equality (=) on a UUID with an
-- overlap (&&) on a range. Idempotent.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Overlap guard: no two live appointments for one provider may share time.
-- startsAt/endsAt are `timestamp without time zone` (Prisma DateTime default), so
-- tsrange (not tstzrange) keeps the index expression IMMUTABLE. '[)' bounds treat
-- back-to-back slots (09:00-09:30, 09:30-10:00) as non-overlapping, matching the
-- app's half-open slot math.
ALTER TABLE "Appointment"
  ADD CONSTRAINT "appointment_no_double_book"
  EXCLUDE USING gist (
    "providerProfileId" WITH =,
    tsrange("startsAt", "endsAt", '[)') WITH &&
  )
  WHERE (
    "deletedAt" IS NULL
    AND "providerProfileId" IS NOT NULL
    AND "status" NOT IN ('CANCELED', 'NO_SHOW')
  );

-- Front-desk date of birth (nullable, additive, date-only).
ALTER TABLE "Patient" ADD COLUMN "dateOfBirth" DATE;
