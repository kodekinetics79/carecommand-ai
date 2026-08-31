-- ===========================================================================
-- Dialler pacing on the outbound campaign.
--
-- Until now a clinic dialled by clicking Call, once per patient. The dialler
-- works through a campaign's PENDING targets on its own, so the clinic needs
-- the two controls that matter to it: how many calls at once, and how fast.
-- Everything else that decides whether a phone rings stays a platform fence
-- inside the launch path and is not a clinic-facing setting.
--
-- `dialerEnabled` defaults FALSE on purpose. A campaign that is RUNNING today
-- means "a person may click Call on these targets". This migration must not
-- silently upgrade every existing RUNNING campaign to "the machine will phone
-- all of them tonight". Automatic dialling is a second, explicit decision an
-- operator makes per campaign.
--
-- Every column carries a DEFAULT. A CHECK without one breaks every existing
-- writer the moment it lands: rows already present have no value for the new
-- column and the constraint rejects them. Defaults first, then the CHECK.
-- ===========================================================================

ALTER TABLE "ReceptionistOutboundCampaign"
  ADD COLUMN IF NOT EXISTS "dialerEnabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "dialerMaxConcurrentCalls" integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "dialerCallsPerMinute" integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "dialerRetryGapMinutes" integer NOT NULL DEFAULT 60;

-- Bounds the API also enforces, restated where they cannot be bypassed. A
-- pacing value of zero would stall a campaign silently and a negative one
-- makes the per-tick budget arithmetic meaningless. A retry gap of zero is
-- legitimate — a campaign that never re-dials the same person — so only the
-- negative side is refused there.
ALTER TABLE "ReceptionistOutboundCampaign"
  DROP CONSTRAINT IF EXISTS "ReceptionistOutboundCampaign_dialer_pacing_check";

ALTER TABLE "ReceptionistOutboundCampaign"
  ADD CONSTRAINT "ReceptionistOutboundCampaign_dialer_pacing_check"
    CHECK (
      "dialerMaxConcurrentCalls" BETWEEN 1 AND 50
      AND "dialerCallsPerMinute" BETWEEN 1 AND 60
      AND "dialerRetryGapMinutes" BETWEEN 0 AND 1440
    );
