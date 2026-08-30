-- ===========================================================================
-- Caller safety.
--
-- Two facts about a caller that no screen can be trusted to hold.
--
-- 1. "Human only" on the patient. Some people must never be routed to an AI
--    line: cognitive impairment, a speech difference the line has already
--    failed once, a safeguarding note. It is a stored clinical decision taken
--    by a named person, and it is honoured at `call_inbound` before the
--    receptionist takes a single turn. It is deliberately not inferable — the
--    model never sets it, and the CHECK below refuses a raised flag that
--    cannot say when it was raised, because an unattributed clinical decision
--    is not one.
--
-- 2. The comprehension counter on the call. In August 2026 a stroke survivor
--    tried five times to book an appointment through an AI receptionist and
--    could not get past it; the line asked her not to use speakerphone, which
--    she needed because she could hold the handset with only one hand. The
--    count of CONSECUTIVE unparseable turns lives on the server, not in the
--    model's head, so "stop trying after two" is a guarantee rather than an
--    instruction. `comprehensionBailoutAt` is the durable record that this
--    caller was failed by the line and handed to a person.
-- ===========================================================================

ALTER TABLE "Patient"
  ADD COLUMN "humanOnly" boolean NOT NULL DEFAULT false,
  ADD COLUMN "humanOnlyReason" varchar(240),
  ADD COLUMN "humanOnlySetAt" timestamp(3),
  ADD COLUMN "humanOnlySetByUserId" uuid;

-- A raised flag names the moment it was raised. Lowering it clears the flag and
-- keeps nothing to attribute, which is why only the raised state is checked.
ALTER TABLE "Patient"
  ADD CONSTRAINT "Patient_human_only_attribution_check"
    CHECK ("humanOnly" = false OR "humanOnlySetAt" IS NOT NULL);

ALTER TABLE "ReceptionistCallLog"
  ADD COLUMN "unparseableTurns" integer NOT NULL DEFAULT 0,
  ADD COLUMN "comprehensionBailoutAt" timestamp(3);

ALTER TABLE "ReceptionistCallLog"
  ADD CONSTRAINT "ReceptionistCallLog_unparseable_turns_check"
    CHECK ("unparseableTurns" >= 0);

-- The repeat-caller detector reads inbound rows for one number inside a short
-- window on every inbound call, before the caller hears anything at all. It
-- must not become the slowest thing between a ring and an answer.
CREATE INDEX "ReceptionistCallLog_repeat_caller_idx"
  ON "ReceptionistCallLog" ("tenantId", "callerPhone", "direction", "createdAt");
