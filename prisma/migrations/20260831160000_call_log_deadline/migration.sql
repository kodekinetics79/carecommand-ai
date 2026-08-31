-- ===========================================================================
-- A non-terminal call must carry an expiry.
--
-- A call the provider never starts produces no lifecycle webhook, so nothing
-- closes its row. Observed in production 2026-08-31: an outbound call was
-- accepted, never connected, and its `ReceptionistCallLog` stayed
-- `IN_PROGRESS` with `endedAt` null permanently. Those rows are counted
-- against tenant concurrency, and nothing decrements them, so the leak is
-- monotonic — enough of them stop the clinic answering its phone.
--
-- `deadlineAt` is when such a row stops counting. The CHECK makes a
-- non-terminal row impossible to INSERT without one, so a future code path
-- that forgets to set an expiry fails loudly at the database rather than
-- leaking quietly. Capacity counts only unexpired rows, so a tenant recovers
-- on its own even when the reconciler is down.
--
-- Terminal rows never need it: they already stop counting by outcome.
-- ===========================================================================

ALTER TABLE "ReceptionistCallLog"
  ADD COLUMN IF NOT EXISTS "deadlineAt" timestamp(3) without time zone;

-- Existing stranded rows: give them an expiry so the current leak drains
-- rather than requiring a manual sweep. One hour past their start is well
-- beyond any real call.
UPDATE "ReceptionistCallLog"
   SET "deadlineAt" = COALESCE("startedAt", "createdAt") + interval '1 hour'
 WHERE "deadlineAt" IS NULL
   AND "outcome" = 'IN_PROGRESS'
   AND "endedAt" IS NULL;

ALTER TABLE "ReceptionistCallLog"
  DROP CONSTRAINT IF EXISTS "ReceptionistCallLog_non_terminal_needs_deadline_check";

ALTER TABLE "ReceptionistCallLog"
  ADD CONSTRAINT "ReceptionistCallLog_non_terminal_needs_deadline_check"
    CHECK (
      "outcome" <> 'IN_PROGRESS'
      OR "endedAt" IS NOT NULL
      OR "deadlineAt" IS NOT NULL
    );
