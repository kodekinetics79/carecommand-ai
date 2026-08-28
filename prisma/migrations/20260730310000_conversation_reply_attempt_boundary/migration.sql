-- Durable, append-only evidence for AI Front Desk outbound reply submissions.
-- A provider-facing request is preceded by an immutable submission claim. If
-- provider I/O or result persistence is ambiguous, the claim blocks retries.
-- Raw destination and reviewed message content are deliberately not retained.
SET lock_timeout = '5s';
SET statement_timeout = '5min';

CREATE UNIQUE INDEX IF NOT EXISTS "Conversation_tenantId_id_key"
  ON "Conversation"("tenantId", id);

CREATE TABLE "ConversationReplyAttempt" (
  id UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "actorUserId" UUID NOT NULL,
  "clientAttemptKey" UUID NOT NULL,
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  channel TEXT NOT NULL,
  "destinationMasked" TEXT NOT NULL,
  "messageHash" TEXT NOT NULL,
  "subjectHash" TEXT NOT NULL,
  "senderIdentityHash" TEXT NOT NULL,
  "providerMode" TEXT,
  "providerMessageId" TEXT,
  "failureCode" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationReplyAttempt_pkey" PRIMARY KEY (id),
  CONSTRAINT "ConversationReplyAttempt_phase_check"
    CHECK (phase IN ('INTENT', 'SUBMISSION_CLAIM', 'RESULT')),
  CONSTRAINT "ConversationReplyAttempt_status_check"
    CHECK (status IN ('authorized', 'submission_claimed', 'provider_accepted', 'provider_pending', 'provider_rejected', 'suppressed', 'submission_result_unknown')),
  CONSTRAINT "ConversationReplyAttempt_phase_status_check" CHECK (
    (phase = 'INTENT' AND status = 'authorized' AND "completedAt" IS NOT NULL AND "providerMode" IS NULL AND "providerMessageId" IS NULL AND "failureCode" IS NULL)
    OR (phase = 'SUBMISSION_CLAIM' AND status = 'submission_claimed' AND "completedAt" IS NOT NULL AND "providerMode" IS NULL AND "providerMessageId" IS NULL AND "failureCode" IS NULL)
    OR (phase = 'RESULT' AND status IN ('provider_accepted', 'provider_pending', 'provider_rejected', 'suppressed', 'submission_result_unknown') AND "completedAt" IS NOT NULL)
  ),
  CONSTRAINT "ConversationReplyAttempt_hashes_check" CHECK (
    "messageHash" ~ '^[0-9a-f]{64}$'
    AND "subjectHash" ~ '^[0-9a-f]{64}$'
    AND "senderIdentityHash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "ConversationReplyAttempt_channel_check" CHECK (channel IN ('sms', 'email', 'whatsapp')),
  CONSTRAINT "ConversationReplyAttempt_destination_mask_check" CHECK (length(btrim("destinationMasked")) BETWEEN 4 AND 320),
  CONSTRAINT "ConversationReplyAttempt_provider_acceptance_check" CHECK (
    status <> 'provider_accepted'
    OR (NULLIF(btrim("providerMode"), '') IS NOT NULL AND NULLIF(btrim("providerMessageId"), '') IS NOT NULL)
  ),
  CONSTRAINT "ConversationReplyAttempt_tenant_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ConversationReplyAttempt_conversation_scope_fkey"
    FOREIGN KEY ("tenantId", "conversationId") REFERENCES "Conversation"("tenantId", id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ConversationReplyAttempt_actor_scope_fkey"
    FOREIGN KEY ("tenantId", "actorUserId") REFERENCES "User"("tenantId", id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ConversationReplyAttempt_tenant_conversation_key_phase_key"
  ON "ConversationReplyAttempt"("tenantId", "conversationId", "clientAttemptKey", phase);
CREATE INDEX "ConversationReplyAttempt_tenant_conversation_created_idx"
  ON "ConversationReplyAttempt"("tenantId", "conversationId", "createdAt");
CREATE INDEX "ConversationReplyAttempt_tenant_status_created_idx"
  ON "ConversationReplyAttempt"("tenantId", status, "createdAt");

CREATE OR REPLACE FUNCTION enforce_conversation_reply_attempt_boundary()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior_row "ConversationReplyAttempt"%ROWTYPE;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF current_user = 'app_rls' THEN
      RAISE EXCEPTION 'ConversationReplyAttempt is append-only for the runtime role'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.phase = 'INTENT' THEN
    IF EXISTS (
      SELECT 1 FROM "ConversationReplyAttempt"
      WHERE "tenantId" = NEW."tenantId"
        AND "conversationId" = NEW."conversationId"
        AND "clientAttemptKey" = NEW."clientAttemptKey"
    ) THEN
      RAISE EXCEPTION 'Conversation reply INTENT must begin a new attempt'
        USING ERRCODE = '23505';
    END IF;
  ELSIF NEW.phase = 'SUBMISSION_CLAIM' THEN
    SELECT * INTO STRICT prior_row FROM "ConversationReplyAttempt"
    WHERE "tenantId" = NEW."tenantId"
      AND "conversationId" = NEW."conversationId"
      AND "clientAttemptKey" = NEW."clientAttemptKey"
      AND phase = 'INTENT' AND status = 'authorized';
    IF prior_row.channel IS DISTINCT FROM NEW.channel
       OR prior_row."destinationMasked" IS DISTINCT FROM NEW."destinationMasked"
       OR prior_row."messageHash" IS DISTINCT FROM NEW."messageHash"
       OR prior_row."subjectHash" IS DISTINCT FROM NEW."subjectHash"
       OR prior_row."senderIdentityHash" IS DISTINCT FROM NEW."senderIdentityHash"
       OR prior_row."actorUserId" IS DISTINCT FROM NEW."actorUserId"
       OR EXISTS (
         SELECT 1 FROM "ConversationReplyAttempt"
         WHERE "tenantId" = NEW."tenantId"
           AND "conversationId" = NEW."conversationId"
           AND "clientAttemptKey" = NEW."clientAttemptKey"
           AND phase IN ('SUBMISSION_CLAIM', 'RESULT')
       ) THEN
      RAISE EXCEPTION 'Conversation reply claim does not match an unused intent'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO STRICT prior_row FROM "ConversationReplyAttempt"
    WHERE "tenantId" = NEW."tenantId"
      AND "conversationId" = NEW."conversationId"
      AND "clientAttemptKey" = NEW."clientAttemptKey"
      AND phase = 'SUBMISSION_CLAIM' AND status = 'submission_claimed';
    IF prior_row.channel IS DISTINCT FROM NEW.channel
       OR prior_row."destinationMasked" IS DISTINCT FROM NEW."destinationMasked"
       OR prior_row."messageHash" IS DISTINCT FROM NEW."messageHash"
       OR prior_row."subjectHash" IS DISTINCT FROM NEW."subjectHash"
       OR prior_row."senderIdentityHash" IS DISTINCT FROM NEW."senderIdentityHash"
       OR prior_row."actorUserId" IS DISTINCT FROM NEW."actorUserId"
       OR EXISTS (
         SELECT 1 FROM "ConversationReplyAttempt"
         WHERE "tenantId" = NEW."tenantId"
           AND "conversationId" = NEW."conversationId"
           AND "clientAttemptKey" = NEW."clientAttemptKey"
           AND phase = 'RESULT'
       ) THEN
      RAISE EXCEPTION 'Conversation reply result does not match one submission claim'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'Conversation reply evidence is missing its ordered predecessor'
    USING ERRCODE = '23503';
END $$;

CREATE TRIGGER "ConversationReplyAttempt_boundary_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "ConversationReplyAttempt"
  FOR EACH ROW EXECUTE FUNCTION enforce_conversation_reply_attempt_boundary();

ALTER TABLE "ConversationReplyAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConversationReplyAttempt" FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_conversation_reply_attempt_select
  ON "ConversationReplyAttempt" FOR SELECT TO app_rls
  USING (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_conversation_reply_attempt_insert
  ON "ConversationReplyAttempt" FOR INSERT TO app_rls
  WITH CHECK (app_rls_tenant_allowed("tenantId"));

REVOKE ALL ON TABLE "ConversationReplyAttempt" FROM app_rls;
GRANT SELECT, INSERT ON TABLE "ConversationReplyAttempt" TO app_rls;
