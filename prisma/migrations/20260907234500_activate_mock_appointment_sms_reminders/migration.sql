-- Durable SMS reminder plumbing. This migration does not activate real-world
-- egress: application admission remains restricted to non-production mock SMS.
SET lock_timeout = '5s';
SET statement_timeout = '5min';

ALTER TYPE "AppointmentCommunicationActionStatus" ADD VALUE 'PROVIDER_ACCEPTED';
ALTER TYPE "AppointmentCommunicationActionStatus" ADD VALUE 'DELIVERY_UNKNOWN';
ALTER TYPE "AppointmentCommunicationActionStatus" ADD VALUE 'SUPPRESSED';

ALTER TABLE "AppointmentCommunicationPlan"
  DROP CONSTRAINT "AppointmentCommunicationPlan_mode_status_check",
  ADD CONSTRAINT "AppointmentCommunicationPlan_mode_status_check" CHECK (
    "status" IN ('COMPLETED', 'CANCELLED')
    OR ("mode" = 'NONE' AND "status" = 'PAUSED')
    OR ("mode" = 'SMS' AND "status" IN ('ACTIVE', 'BLOCKED_SETUP'))
    OR ("mode" IN ('VOICE', 'BOTH') AND "status" = 'BLOCKED_SETUP')
  );

ALTER TABLE "AppointmentCommunicationAction"
  DROP CONSTRAINT "AppointmentCommunicationAction_dispatch_setup_check",
  ADD CONSTRAINT "AppointmentCommunicationAction_channel_status_check" CHECK (
    ("channel" = 'VOICE' AND "status" IN ('BLOCKED_SETUP', 'CANCELLED'))
    OR ("channel" = 'SMS' AND "status" IN (
      'QUEUED', 'BLOCKED_SETUP', 'CANCELLED', 'PROVIDER_ACCEPTED',
      'DELIVERY_UNKNOWN', 'SUPPRESSED', 'FAILED'
    ))
  ),
  ADD CONSTRAINT "AppointmentCommunicationAction_tenantId_appointmentId_id_key"
    UNIQUE ("tenantId", "appointmentId", "id");

ALTER TABLE "NotificationEvent"
  ADD COLUMN "appointmentCommunicationActionId" UUID;

-- Confirmation remains one row per appointment/channel. Reminders need one row
-- per immutable appointment-version/plan-revision action, so the old global
-- uniqueness is narrowed to confirmations only.
DROP INDEX "NotificationEvent_tenantId_appointmentId_channel_source_key";
CREATE UNIQUE INDEX "NotificationEvent_confirmation_appointment_channel_key"
  ON "NotificationEvent"("tenantId", "appointmentId", "channel")
  WHERE source = 'receptionist.appointment_confirmation';

CREATE UNIQUE INDEX "NotificationEvent_tenantId_appointmentId_appointmentCommuni_key"
  ON "NotificationEvent"("tenantId", "appointmentId", "appointmentCommunicationActionId");

-- The existing confirmation indexes are source-specific. The minute worker
-- needs an equally selective path for due/recoverable reminder rows.
CREATE INDEX "NotificationEvent_appointment_reminder_due_idx"
  ON "NotificationEvent"("tenantId", "nextAttemptAt", "createdAt")
  WHERE source = 'appointment.reminder' AND status IN ('queued', 'failed');
CREATE INDEX "NotificationEvent_appointment_reminder_retrying_idx"
  ON "NotificationEvent"("tenantId", "updatedAt")
  WHERE source = 'appointment.reminder' AND status = 'retrying';

ALTER TABLE "NotificationEvent"
  ADD CONSTRAINT "NotificationEvent_appointmentCommunicationAction_scope_fkey"
  FOREIGN KEY ("tenantId", "appointmentId", "appointmentCommunicationActionId")
  REFERENCES "AppointmentCommunicationAction"("tenantId", "appointmentId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "NotificationEvent_appointment_reminder_shape_check" CHECK (
    source IS DISTINCT FROM 'appointment.reminder' OR (
      channel = 'sms'
      AND "appointmentId" IS NOT NULL
      AND "appointmentCommunicationActionId" IS NOT NULL
      AND "patientId" IS NOT NULL
      AND NULLIF(btrim("idempotencyKey"), '') IS NOT NULL
      AND status <> 'sent'
      AND "sentAt" IS NULL
      AND "deliveredAt" IS NULL
      AND (status <> 'accepted' OR (
        attempts >= 1 AND "acceptedAt" IS NOT NULL
        AND NULLIF(btrim(provider), '') IS NOT NULL
        AND NULLIF(btrim("providerMessageId"), '') IS NOT NULL
      ))
      AND (status NOT IN ('dead_lettered', 'delivery_unknown') OR "deadLetteredAt" IS NOT NULL)
      AND (status NOT IN ('suppressed', 'accepted', 'dead_lettered', 'delivery_unknown') OR "nextAttemptAt" IS NULL)
    )
  );

-- Reuse the existing immutable delivery-attempt ledger with explicit reminder
-- gate outcomes; free-form provider text is never admitted here.
ALTER TABLE "NotificationDeliveryAttempt"
  DROP CONSTRAINT "NotificationDeliveryAttempt_failure_code_check",
  ADD CONSTRAINT "NotificationDeliveryAttempt_failure_code_check" CHECK (
    "failureCode" IS NULL OR "failureCode" IN (
      'dispatch_lease_expired', 'attempt_limit_reached',
      'appointment_not_confirmed', 'destination_unavailable',
      'suppressed_by_shared_gate', 'suppressed_by_call_consent',
      'suppression_gate_unavailable', 'provider_acceptance_unknown',
      'provider_setup_required', 'provider_not_submitted',
      'provider_boundary_upgrade_quarantine', 'quiet_hours',
      'quiet_hours_invalid', 'confirmation_window_closed',
      'appointment_reminder_stale', 'destination_changed_or_unavailable',
      'production_activation_required', 'automation_queue_unavailable',
      'messaging_provider_not_allowed', 'messaging_provider_setup_required',
      'real_provider_activation_required'
    )
  );

-- The reminder row is durable and version-linked. Cross-table currentness is
-- rechecked under the appointment communication advisory lock immediately
-- before provider intent; this trigger protects immutable event identity and
-- prevents fabricated delivery evidence at rest.
CREATE FUNCTION "protect_appointment_reminder_event"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reminder_source CONSTANT text := 'appointment.reminder';
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.source = reminder_source THEN
      RAISE EXCEPTION 'Appointment reminder NotificationEvent is durable and cannot be deleted' USING ERRCODE='55000';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.source IS DISTINCT FROM reminder_source THEN RETURN NEW; END IF;
    IF NEW.status <> 'queued' OR NEW.attempts <> 0 OR NEW."acceptedAt" IS NOT NULL
       OR NEW."deliveredAt" IS NOT NULL OR NEW."sentAt" IS NOT NULL OR NEW."deadLetteredAt" IS NOT NULL
       OR NEW.provider IS NOT NULL OR NEW."providerMessageId" IS NOT NULL OR NEW."consentChecked" THEN
      RAISE EXCEPTION 'Appointment reminder must begin as an unsubmitted queued event' USING ERRCODE='check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.source = reminder_source OR NEW.source = reminder_source) AND NEW.source IS DISTINCT FROM OLD.source THEN
    RAISE EXCEPTION 'Appointment reminder NotificationEvent source is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.source IS DISTINCT FROM reminder_source THEN RETURN NEW; END IF;
  IF ROW(NEW.id,NEW."tenantId",NEW."appointmentId",NEW."appointmentCommunicationActionId",NEW."patientId",NEW."recipientType",NEW.channel,NEW."idempotencyKey",NEW."maxAttempts",NEW."createdAt")
     IS DISTINCT FROM ROW(OLD.id,OLD."tenantId",OLD."appointmentId",OLD."appointmentCommunicationActionId",OLD."patientId",OLD."recipientType",OLD.channel,OLD."idempotencyKey",OLD."maxAttempts",OLD."createdAt") THEN
    RAISE EXCEPTION 'Appointment reminder NotificationEvent identity is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.attempts < OLD.attempts OR NEW.attempts > NEW."maxAttempts" THEN
    RAISE EXCEPTION 'Appointment reminder attempts violate monotonic bounds' USING ERRCODE='55000';
  END IF;
  IF NEW.status = 'delivered' OR NEW."deliveredAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Appointment reminder delivery requires a separately activated signed provider receipt' USING ERRCODE='55000';
  END IF;
  IF OLD.status IN ('accepted','suppressed','dead_lettered','delivery_unknown')
     AND (to_jsonb(NEW)-'updatedAt') IS DISTINCT FROM (to_jsonb(OLD)-'updatedAt') THEN
    RAISE EXCEPTION 'Appointment reminder terminal evidence is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "NotificationEvent_appointment_reminder_state_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "NotificationEvent"
  FOR EACH ROW EXECUTE FUNCTION "protect_appointment_reminder_event"();
