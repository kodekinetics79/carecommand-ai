-- Durable, tenant-isolated appointment-confirmation outbox.
--
-- NotificationEvent predates this workflow and is also used for in-app
-- monitoring notifications. The receptionist-specific invariants below are
-- therefore conditional on its source instead of narrowing legacy producers.
-- Delivery attempts are immutable operational evidence: the runtime can append
-- and read them, but neither update nor delete them.

ALTER TABLE "NotificationEvent"
  ADD COLUMN "appointmentId" UUID,
  ADD COLUMN "source" TEXT,
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "provider" TEXT,
  ADD COLUMN "providerMessageId" TEXT,
  ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "acceptedAt" TIMESTAMP(3),
  ADD COLUMN "deliveredAt" TIMESTAMP(3),
  ADD COLUMN "deadLetteredAt" TIMESTAMP(3);

-- Abort rather than silently detach or rewrite legacy notification ownership.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "NotificationEvent" event
    LEFT JOIN "Patient" patient
      ON patient."tenantId" = event."tenantId" AND patient.id = event."patientId"
    WHERE event."patientId" IS NOT NULL AND patient.id IS NULL
  ) THEN
    RAISE EXCEPTION 'NotificationEvent contains an orphan or cross-tenant patientId; reconcile it explicitly before deploying the confirmation outbox';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "NotificationEvent"
    WHERE "status" NOT IN (
      'queued', 'sent', 'accepted', 'delivered', 'failed', 'retrying',
      'suppressed', 'dead_lettered', 'delivery_unknown'
    )
  ) THEN
    RAISE EXCEPTION 'NotificationEvent contains a status outside the durable notification state allowlist; reconcile it explicitly before deploying the confirmation outbox';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "NotificationEvent"
    WHERE "attempts" < 0 OR "attempts" > "maxAttempts"
  ) THEN
    RAISE EXCEPTION 'NotificationEvent contains attempts outside its configured retry bounds; reconcile it explicitly before deploying the confirmation outbox';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "NotificationEvent"
    WHERE "consentResult" IS NOT NULL
      AND "consentResult" NOT IN (
        'granted', 'granted_unchecked', 'denied', 'not_required',
        'not_recorded_transactional', 'not_suppressed_transactional'
      )
  ) THEN
    RAISE EXCEPTION 'NotificationEvent contains consentResult outside the durable consent-evidence allowlist; reconcile it explicitly before deploying the confirmation outbox';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "NotificationEvent" event
    JOIN "Appointment" appointment
      ON appointment."tenantId" = event."tenantId" AND appointment.id = event."appointmentId"
    WHERE event."appointmentId" IS NOT NULL
      AND event."patientId" IS NOT NULL
      AND event."patientId" IS DISTINCT FROM appointment."patientId"
  ) THEN
    RAISE EXCEPTION 'NotificationEvent patientId conflicts with its Appointment patientId; reconcile the tenant/appointment/patient ownership before deploying the confirmation outbox';
  END IF;
END
$$;

CREATE UNIQUE INDEX "Patient_tenantId_id_key"
  ON "Patient"("tenantId", "id");
CREATE UNIQUE INDEX "NotificationEvent_tenantId_id_key"
  ON "NotificationEvent"("tenantId", "id");
CREATE INDEX "NotificationEvent_tenantId_appointmentId_idx"
  ON "NotificationEvent"("tenantId", "appointmentId");
CREATE UNIQUE INDEX "NotificationEvent_tenantId_source_idempotencyKey_key"
  ON "NotificationEvent"("tenantId", "source", "idempotencyKey");
CREATE UNIQUE INDEX "NotificationEvent_tenantId_appointmentId_channel_source_key"
  ON "NotificationEvent"("tenantId", "appointmentId", "channel", "source");
CREATE UNIQUE INDEX "rls_uq_41af3f7d2c8e4b691a02"
  ON "Appointment"("tenantId", "id", "patientId");
CREATE INDEX "rls_ix_41af3f7d2c8e4b691a02"
  ON "NotificationEvent"("tenantId", "appointmentId", "patientId");

ALTER TABLE "NotificationEvent"
  ADD CONSTRAINT "NotificationEvent_tenantId_appointmentId_fkey"
  FOREIGN KEY ("tenantId", "appointmentId")
  REFERENCES "Appointment"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "NotificationEvent"
  ADD CONSTRAINT "NotificationEvent_tenantId_patientId_fkey"
  FOREIGN KEY ("tenantId", "patientId")
  REFERENCES "Patient"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "NotificationEvent"
  ADD CONSTRAINT "rls_fk_41af3f7d2c8e4b691a02"
  FOREIGN KEY ("tenantId", "appointmentId", "patientId")
  REFERENCES "Appointment"("tenantId", "id", "patientId")
  MATCH SIMPLE
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "NotificationEvent"
  ADD CONSTRAINT "NotificationEvent_status_check"
  CHECK ("status" IN (
    'queued', 'sent', 'accepted', 'delivered', 'failed', 'retrying',
    'suppressed', 'dead_lettered', 'delivery_unknown'
  )),
  ADD CONSTRAINT "NotificationEvent_attempt_bounds_check"
  CHECK ("attempts" >= 0 AND "maxAttempts" BETWEEN 1 AND 25 AND "attempts" <= "maxAttempts"),
  ADD CONSTRAINT "NotificationEvent_consent_result_check"
  CHECK ("consentResult" IS NULL OR "consentResult" IN (
    'granted', 'granted_unchecked', 'denied', 'not_required',
    'not_recorded_transactional', 'not_suppressed_transactional'
  )),
  ADD CONSTRAINT "NotificationEvent_receptionist_confirmation_shape_check"
  CHECK (
    "source" IS DISTINCT FROM 'receptionist.appointment_confirmation'
    OR (
      "appointmentId" IS NOT NULL
      AND "patientId" IS NOT NULL
      AND "idempotencyKey" IS NOT NULL
      AND "idempotencyKey" <> ''
      AND "channel" IN ('sms', 'email')
      AND "recipientType" = 'patient'
    )
  ),
  ADD CONSTRAINT "NotificationEvent_receptionist_confirmation_error_check"
  CHECK (
    "source" IS DISTINCT FROM 'receptionist.appointment_confirmation'
    OR "failureReason" IS NULL
    OR "failureReason" IN (
      'dispatch_lease_expired', 'attempt_limit_reached',
      'appointment_not_confirmed', 'destination_unavailable',
      'suppressed_by_shared_gate', 'suppressed_by_call_consent',
      'suppression_gate_unavailable', 'provider_acceptance_unknown',
      'provider_setup_required', 'provider_not_submitted'
    )
  ),
  ADD CONSTRAINT "NotificationEvent_receptionist_confirmation_accepted_check"
  CHECK (
    "source" IS DISTINCT FROM 'receptionist.appointment_confirmation'
    OR "status" <> 'accepted'
    OR ("acceptedAt" IS NOT NULL AND "sentAt" IS NULL)
  ),
  ADD CONSTRAINT "NotificationEvent_receptionist_confirmation_terminal_check"
  CHECK (
    "source" IS DISTINCT FROM 'receptionist.appointment_confirmation'
    OR "status" NOT IN ('dead_lettered', 'delivery_unknown')
    OR "deadLetteredAt" IS NOT NULL
  );

CREATE OR REPLACE FUNCTION "set_notification_event_updated_at"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."updatedAt" := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "NotificationEvent_updatedAt_trg"
  BEFORE UPDATE ON "NotificationEvent"
  FOR EACH ROW
  EXECUTE FUNCTION "set_notification_event_updated_at"();

CREATE OR REPLACE FUNCTION "protect_receptionist_confirmation_event"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  confirmation_source CONSTANT text := 'receptionist.appointment_confirmation';
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."source" = confirmation_source THEN
      RAISE EXCEPTION 'Receptionist confirmation NotificationEvent is durable and cannot be deleted'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF (OLD."source" = confirmation_source OR NEW."source" = confirmation_source)
     AND NEW."source" IS DISTINCT FROM OLD."source" THEN
    RAISE EXCEPTION 'Receptionist confirmation NotificationEvent source is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD."source" IS DISTINCT FROM confirmation_source THEN
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.id, NEW."tenantId", NEW."appointmentId", NEW."patientId",
    NEW."recipientType", NEW.channel, NEW."idempotencyKey", NEW."maxAttempts", NEW."createdAt"
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD."tenantId", OLD."appointmentId", OLD."patientId",
    OLD."recipientType", OLD.channel, OLD."idempotencyKey", OLD."maxAttempts", OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'Receptionist confirmation NotificationEvent identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.attempts < OLD.attempts OR NEW.attempts > NEW."maxAttempts" THEN
    RAISE EXCEPTION 'Receptionist confirmation NotificationEvent attempts cannot decrease or exceed maxAttempts'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status = OLD.status THEN
    IF NEW.attempts <> OLD.attempts THEN
      RAISE EXCEPTION 'Receptionist confirmation NotificationEvent attempts require a forward status transition'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.status IN ('accepted', 'delivered', 'suppressed', 'dead_lettered', 'delivery_unknown')
       AND (to_jsonb(NEW) - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'updatedAt') THEN
      RAISE EXCEPTION 'Receptionist confirmation terminal evidence is immutable'
        USING ERRCODE = '55000';
    ELSIF OLD.status IN ('queued', 'failed')
       AND (to_jsonb(NEW) - ARRAY['updatedAt', 'nextAttemptAt'])
           IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['updatedAt', 'nextAttemptAt']) THEN
      RAISE EXCEPTION 'Receptionist confirmation pending evidence permits scheduling changes only'
        USING ERRCODE = '55000';
    ELSIF OLD.status = 'retrying'
       AND (to_jsonb(NEW) - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'updatedAt') THEN
      RAISE EXCEPTION 'Receptionist confirmation in-flight evidence is immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('queued', 'failed') AND NEW.status = 'retrying' THEN
    IF NEW.attempts <> OLD.attempts + 1 THEN
      RAISE EXCEPTION 'Receptionist confirmation retry claim must increment attempts exactly once'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status IN ('queued', 'failed') AND NEW.status IN ('suppressed', 'dead_lettered') THEN
    IF NEW.attempts NOT IN (OLD.attempts, OLD.attempts + 1) THEN
      RAISE EXCEPTION 'Receptionist confirmation pre-provider terminal transition has invalid attempts'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'retrying' AND NEW.status IN (
    'accepted', 'failed', 'suppressed', 'dead_lettered', 'delivery_unknown'
  ) THEN
    IF NEW.attempts <> OLD.attempts THEN
      RAISE EXCEPTION 'Receptionist confirmation dispatch result cannot change attempts'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status IN ('accepted', 'sent') AND NEW.status = 'delivered' THEN
    IF NEW.attempts <> OLD.attempts THEN
      RAISE EXCEPTION 'Receptionist confirmation delivery acknowledgement cannot change attempts'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'Illegal receptionist confirmation NotificationEvent status transition (% -> %)', OLD.status, NEW.status
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "NotificationEvent_confirmation_state_trg"
  BEFORE UPDATE OR DELETE ON "NotificationEvent"
  FOR EACH ROW
  EXECUTE FUNCTION "protect_receptionist_confirmation_event"();

CREATE TABLE "NotificationDeliveryAttempt" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "notificationEventId" UUID NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "phase" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "provider" TEXT,
  "providerMessageId" TEXT,
  "failureCode" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "NotificationDeliveryAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationDeliveryAttempt_attempt_number_check"
    CHECK ("attemptNumber" BETWEEN 1 AND 25),
  CONSTRAINT "NotificationDeliveryAttempt_phase_check"
    CHECK ("phase" IN ('INTENT', 'RESULT')),
  CONSTRAINT "NotificationDeliveryAttempt_status_check"
    CHECK ("status" IN (
      'started', 'accepted', 'delivered', 'failed', 'suppressed',
      'dead_lettered', 'delivery_unknown'
    )),
  CONSTRAINT "NotificationDeliveryAttempt_failure_code_check"
    CHECK ("failureCode" IS NULL OR "failureCode" IN (
      'dispatch_lease_expired', 'attempt_limit_reached',
      'appointment_not_confirmed', 'destination_unavailable',
      'suppressed_by_shared_gate', 'suppressed_by_call_consent',
      'suppression_gate_unavailable', 'provider_acceptance_unknown',
      'provider_setup_required', 'provider_not_submitted'
    )),
  CONSTRAINT "NotificationDeliveryAttempt_phase_status_check"
    CHECK (
      ("phase" = 'INTENT' AND "status" = 'started' AND "completedAt" IS NULL)
      OR
      ("phase" = 'RESULT' AND "status" <> 'started' AND "completedAt" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "NotificationDeliveryAttempt_tenantId_notificationEventId_at_key"
  ON "NotificationDeliveryAttempt"("tenantId", "notificationEventId", "attemptNumber", "phase");
CREATE INDEX "NotificationDeliveryAttempt_tenantId_status_startedAt_idx"
  ON "NotificationDeliveryAttempt"("tenantId", "status", "startedAt");

ALTER TABLE "NotificationDeliveryAttempt"
  ADD CONSTRAINT "NotificationDeliveryAttempt_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NotificationDeliveryAttempt"
  ADD CONSTRAINT "NotificationDeliveryAttempt_tenantId_notificationEventId_fkey"
  FOREIGN KEY ("tenantId", "notificationEventId")
  REFERENCES "NotificationEvent"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "prevent_notification_delivery_attempt_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'NotificationDeliveryAttempt is append-only; % is not permitted', TG_OP
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "NotificationDeliveryAttempt_append_only_trg"
  BEFORE UPDATE OR DELETE ON "NotificationDeliveryAttempt"
  FOR EACH ROW
  EXECUTE FUNCTION "prevent_notification_delivery_attempt_mutation"();

ALTER TABLE "NotificationDeliveryAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NotificationDeliveryAttempt" FORCE ROW LEVEL SECURITY;

CREATE POLICY "rls_notification_delivery_attempt_select"
  ON "NotificationDeliveryAttempt" FOR SELECT TO app_rls
  USING (app_rls_tenant_allowed("tenantId"));
CREATE POLICY "rls_notification_delivery_attempt_insert"
  ON "NotificationDeliveryAttempt" FOR INSERT TO app_rls
  WITH CHECK (app_rls_tenant_allowed("tenantId"));

REVOKE ALL ON TABLE "NotificationDeliveryAttempt" FROM app_rls;
GRANT SELECT, INSERT ON TABLE "NotificationDeliveryAttempt" TO app_rls;
