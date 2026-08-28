-- Make an appointment-confirmation provider submission a one-consumer durable
-- boundary. PROVIDER_INTENT authorizes a submission; SUBMISSION_CLAIM proves
-- that one worker consumed that authorization before provider I/O began.
SET lock_timeout = '5s';
SET statement_timeout = '5min';

ALTER TABLE "NotificationDeliveryAttempt"
  DROP CONSTRAINT "NotificationDeliveryAttempt_phase_check",
  DROP CONSTRAINT "NotificationDeliveryAttempt_status_check",
  DROP CONSTRAINT "NotificationDeliveryAttempt_phase_status_check";

ALTER TABLE "NotificationDeliveryAttempt"
  ADD CONSTRAINT "NotificationDeliveryAttempt_phase_check"
    CHECK (phase IN ('INTENT', 'PROVIDER_INTENT', 'SUBMISSION_CLAIM', 'RESULT', 'RECEIPT')) NOT VALID,
  ADD CONSTRAINT "NotificationDeliveryAttempt_status_check"
    CHECK (status IN ('started', 'provider_intent_committed', 'submission_claimed', 'accepted', 'delivered', 'failed', 'suppressed', 'dead_lettered', 'delivery_unknown')) NOT VALID,
  ADD CONSTRAINT "NotificationDeliveryAttempt_phase_status_check"
    CHECK (
      (phase = 'INTENT' AND status = 'started' AND "completedAt" IS NULL)
      OR (phase = 'PROVIDER_INTENT' AND status = 'provider_intent_committed' AND "completedAt" IS NOT NULL)
      OR (phase = 'SUBMISSION_CLAIM' AND status = 'submission_claimed' AND "completedAt" IS NOT NULL)
      OR (phase = 'RESULT' AND status IN ('accepted', 'failed', 'suppressed', 'dead_lettered', 'delivery_unknown') AND "completedAt" IS NOT NULL)
      OR (phase = 'RECEIPT' AND status = 'delivered' AND "completedAt" IS NOT NULL)
    ) NOT VALID;

ALTER TABLE "NotificationDeliveryAttempt" VALIDATE CONSTRAINT "NotificationDeliveryAttempt_phase_check";
ALTER TABLE "NotificationDeliveryAttempt" VALIDATE CONSTRAINT "NotificationDeliveryAttempt_status_check";
ALTER TABLE "NotificationDeliveryAttempt" VALIDATE CONSTRAINT "NotificationDeliveryAttempt_phase_status_check";

CREATE OR REPLACE FUNCTION protect_notification_delivery_attempt()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  event_row "NotificationEvent"%ROWTYPE;
  result_row "NotificationDeliveryAttempt"%ROWTYPE;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'NotificationDeliveryAttempt is append-only; % is not permitted', TG_OP
      USING ERRCODE = '55000';
  END IF;
  SELECT * INTO STRICT event_row FROM "NotificationEvent"
    WHERE "tenantId" = NEW."tenantId" AND id = NEW."notificationEventId";
  IF event_row.source IS DISTINCT FROM 'receptionist.appointment_confirmation' THEN RETURN NEW; END IF;

  IF NEW.phase = 'INTENT' THEN
    IF event_row.status NOT IN ('queued', 'failed') OR NEW."attemptNumber" <> event_row.attempts + 1 THEN
      RAISE EXCEPTION 'Confirmation INTENT is not the next claimable attempt' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.phase = 'PROVIDER_INTENT' THEN
    IF event_row.status <> 'retrying' OR NEW."attemptNumber" <> event_row.attempts
       OR NOT EXISTS (SELECT 1 FROM "NotificationDeliveryAttempt" a WHERE a."tenantId"=NEW."tenantId" AND a."notificationEventId"=NEW."notificationEventId" AND a."attemptNumber"=NEW."attemptNumber" AND a.phase='INTENT')
       OR EXISTS (SELECT 1 FROM "NotificationDeliveryAttempt" a WHERE a."tenantId"=NEW."tenantId" AND a."notificationEventId"=NEW."notificationEventId" AND a."attemptNumber"=NEW."attemptNumber" AND a.phase IN ('SUBMISSION_CLAIM','RESULT')) THEN
      RAISE EXCEPTION 'Confirmation PROVIDER_INTENT requires an active ordered lease' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.phase = 'SUBMISSION_CLAIM' THEN
    IF event_row.status <> 'retrying' OR NEW."attemptNumber" <> event_row.attempts
       OR NOT EXISTS (SELECT 1 FROM "NotificationDeliveryAttempt" a WHERE a."tenantId"=NEW."tenantId" AND a."notificationEventId"=NEW."notificationEventId" AND a."attemptNumber"=NEW."attemptNumber" AND a.phase='PROVIDER_INTENT')
       OR EXISTS (SELECT 1 FROM "NotificationDeliveryAttempt" a WHERE a."tenantId"=NEW."tenantId" AND a."notificationEventId"=NEW."notificationEventId" AND a."attemptNumber"=NEW."attemptNumber" AND a.phase='RESULT') THEN
      RAISE EXCEPTION 'Confirmation SUBMISSION_CLAIM requires an unused provider intent' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.phase = 'RESULT' THEN
    IF NOT EXISTS (SELECT 1 FROM "NotificationDeliveryAttempt" a WHERE a."tenantId"=NEW."tenantId" AND a."notificationEventId"=NEW."notificationEventId" AND a."attemptNumber"=NEW."attemptNumber" AND a.phase='INTENT')
       OR NOT ((event_row.status='retrying' AND NEW."attemptNumber"=event_row.attempts)
            OR (event_row.status IN ('queued','failed') AND NEW."attemptNumber"=event_row.attempts+1)) THEN
      RAISE EXCEPTION 'Confirmation RESULT requires its ordered INTENT' USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.status='accepted' OR (NEW.status='delivery_unknown' AND NEW."failureCode"='provider_acceptance_unknown'))
       AND NOT EXISTS (SELECT 1 FROM "NotificationDeliveryAttempt" a WHERE a."tenantId"=NEW."tenantId" AND a."notificationEventId"=NEW."notificationEventId" AND a."attemptNumber"=NEW."attemptNumber" AND a.phase='SUBMISSION_CLAIM') THEN
      RAISE EXCEPTION 'Provider-facing confirmation RESULT requires a consumed submission claim' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status='accepted' AND (NULLIF(btrim(NEW.provider),'') IS NULL OR NULLIF(btrim(NEW."providerMessageId"),'') IS NULL) THEN
      RAISE EXCEPTION 'Accepted confirmation RESULT requires provider receipt identity' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT * INTO STRICT result_row FROM "NotificationDeliveryAttempt"
      WHERE "tenantId"=NEW."tenantId" AND "notificationEventId"=NEW."notificationEventId"
        AND "attemptNumber"=NEW."attemptNumber" AND phase='RESULT' AND status='accepted';
    IF event_row.status <> 'accepted' OR NEW."attemptNumber" <> event_row.attempts
       OR NEW.provider IS DISTINCT FROM result_row.provider
       OR NEW."providerMessageId" IS DISTINCT FROM result_row."providerMessageId" THEN
      RAISE EXCEPTION 'Confirmation delivery RECEIPT must match immutable accepted evidence' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'Confirmation attempt references missing ordered evidence' USING ERRCODE = 'foreign_key_violation';
END $$;
