-- Confirmations for appointments a human books.
--
-- The confirmation outbox exists and works — consent fence, quiet hours, DNC,
-- truthful delivery reporting — but nothing enqueued into it except the AI voice
-- path, where the channels are gated by the calling campaign's settings. A
-- staff-booked appointment has no campaign, so a clinic that books at the front
-- desk had no confirmation at all, and therefore no lever on no-shows.
--
-- Both default FALSE on purpose. Turning messaging on for every existing tenant
-- would start sending patients messages their clinic never asked to send, which
-- is exactly the kind of claim-without-consent this codebase fails closed on
-- everywhere else. A clinic opts in.
ALTER TABLE "SchedulingPolicy" ADD COLUMN IF NOT EXISTS "confirmBookingsBySms" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SchedulingPolicy" ADD COLUMN IF NOT EXISTS "confirmBookingsByEmail" BOOLEAN NOT NULL DEFAULT false;
