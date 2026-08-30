-- ===========================================================================
-- The number question, answered for a hand-linked agent too.
--
-- Package B made `number_bound` blocking, which is right — contract §16 froze
-- it that way after REC-P0-001 found the advertised line answering with
-- nothing. But a hand-linked (BYO) agent has no deployment row, so it had no
-- evidence it could ever present, and a clinic running a BYO agent could no
-- longer go live at all.
--
-- The tempting fix is an operator attestation: a box somebody ticks to say the
-- number is bound. That is a value a human wrote that we never re-read, which
-- is the precise anti-pattern this whole day exists to remove — the same shape
-- as the `numberBound` column that started it.
--
-- So BYO gets the same evidence a deployed agent gets, from the same place:
-- ask Retell who answers this clinic's inbound line, and record what it said.
-- The one thing it still cannot attest is the PROMPT, which is
-- `deployment_current`'s question and not this one.
-- ===========================================================================

ALTER TABLE "ReceptionistAgent"
  ADD COLUMN "providerInboundNumber" text,
  ADD COLUMN "providerInboundNumberVerifiedAt" timestamp(3),
  ADD COLUMN "providerInboundNumberErrorCode" text;

ALTER TABLE "ReceptionistAgent"
  ADD CONSTRAINT "ReceptionistAgent_inbound_number_check"
    CHECK ("providerInboundNumber" IS NULL OR "providerInboundNumber" ~ '^\+[1-9][0-9]{7,14}$'),
  -- An attestation names a number and carries no unresolved error, or it does
  -- not exist. There is no half-attested state to misread as a pass.
  ADD CONSTRAINT "ReceptionistAgent_inbound_number_verified_check"
    CHECK (
      "providerInboundNumberVerifiedAt" IS NULL
      OR ("providerInboundNumber" IS NOT NULL
        AND "providerAgentId" IS NOT NULL
        AND "providerInboundNumberErrorCode" IS NULL)
    );
