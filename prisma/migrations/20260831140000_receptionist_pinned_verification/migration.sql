-- ===========================================================================
-- A version-pinned deployment does not need a provider tag.
--
-- `ReceptionistAgent_provider_verified_shape_check` required
--
--     "providerAssignedTags" @> ARRAY["providerVersionTag"]
--
-- for any row reaching VERIFIED. That encoded an assumption that has not been
-- true since deployments started pinning a numeric version: CareCommand routes
-- by number, not by tag. Inbound binds `inbound_agents[].agent_version` and
-- outbound sends `override_agent_version`; the tag is not even sent to the
-- provider when a pin is present.
--
-- Retell also exposes no public tag-assignment write, so an agent CareCommand
-- deploys comes back with `assigned_tags: []` and can never satisfy the
-- clause. `'{}' @> ARRAY['carecommand']` is false, so the success write threw
-- a constraint violation — a 500, not a remediation. Verification could
-- therefore never complete for an agent we deployed, which is why this has
-- never fired before: nothing had ever got far enough to write VERIFIED.
--
-- The invariant is kept where it still means something. A hand-linked (BYO)
-- agent is routed BY tag, so for those the tag must genuinely be assigned at
-- the provider before we call the row attested. `providerVersionPinned`
-- records which of the two a verified row is, so the database keeps refusing
-- a half-attested BYO agent while allowing a pinned deployment with no tags.
-- ===========================================================================

ALTER TABLE "ReceptionistAgent"
  ADD COLUMN IF NOT EXISTS "providerVersionPinned" boolean NOT NULL DEFAULT false;

ALTER TABLE "ReceptionistAgent"
  DROP CONSTRAINT IF EXISTS "ReceptionistAgent_provider_verified_shape_check";

ALTER TABLE "ReceptionistAgent"
  ADD CONSTRAINT "ReceptionistAgent_provider_verified_shape_check"
    CHECK (
      "providerStatus" <> 'VERIFIED'
      OR (
        "providerAgentId" IS NOT NULL
        AND "providerVersion" IS NOT NULL
        AND "providerPublished" IS TRUE
        AND ("providerVersionPinned" OR "providerAssignedTags" @> ARRAY["providerVersionTag"])
        AND "providerWebhookUrl" IS NOT NULL
        AND "providerWebhookEvents" @> ARRAY['call_started', 'call_ended', 'call_analyzed']::text[]
        AND "providerDataStorageSetting" = 'basic_attributes_only'
        AND "providerSignedUrl" IS TRUE
        AND NULLIF("providerResponseEngineType", '') IS NOT NULL
        AND NULLIF("providerResponseEngineId", '') IS NOT NULL
        AND "providerFingerprint" ~ '^[a-f0-9]{64}$'
        AND "providerVerifiedRevision" = "providerConfigRevision"
        AND "providerVerifiedAt" IS NOT NULL
        AND "providerVerificationExpiresAt" > "providerVerifiedAt"
      )
    );
