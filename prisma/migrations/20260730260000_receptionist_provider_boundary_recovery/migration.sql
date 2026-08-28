-- Recover the outbound provider boundary without rewriting migration 25000.
-- Hot tables fail fast when the migration cannot acquire a bounded lock.
SET lock_timeout = '5s';
SET statement_timeout = '5min';

ALTER TABLE "Lead" ADD COLUMN "deletedAt" TIMESTAMP(3);

ALTER TABLE "NotificationDeliveryAttempt"
  DROP CONSTRAINT "NotificationDeliveryAttempt_failure_code_check",
  ADD CONSTRAINT "NotificationDeliveryAttempt_failure_code_check"
    CHECK ("failureCode" IS NULL OR "failureCode" IN (
      'dispatch_lease_expired','attempt_limit_reached','appointment_not_confirmed',
      'destination_unavailable','suppressed_by_shared_gate','suppressed_by_call_consent',
      'suppression_gate_unavailable','provider_acceptance_unknown','provider_setup_required',
      'provider_not_submitted','provider_boundary_upgrade_quarantine'
    )) NOT VALID;
ALTER TABLE "NotificationDeliveryAttempt"
  VALIDATE CONSTRAINT "NotificationDeliveryAttempt_failure_code_check";
ALTER TABLE "NotificationEvent"
  DROP CONSTRAINT "NotificationEvent_receptionist_confirmation_error_check",
  ADD CONSTRAINT "NotificationEvent_receptionist_confirmation_error_check"
    CHECK (
      source IS DISTINCT FROM 'receptionist.appointment_confirmation'
      OR "failureReason" IS NULL
      OR "failureReason" IN (
        'dispatch_lease_expired','attempt_limit_reached','appointment_not_confirmed',
        'destination_unavailable','suppressed_by_shared_gate','suppressed_by_call_consent',
        'suppression_gate_unavailable','provider_acceptance_unknown','provider_setup_required',
        'provider_not_submitted','provider_boundary_upgrade_quarantine'
      )
    ) NOT VALID;
ALTER TABLE "NotificationEvent"
  VALIDATE CONSTRAINT "NotificationEvent_receptionist_confirmation_error_check";

-- Every confirmation already claimed by an older worker is conservatively
-- dead-lettered. It cannot be selected or submitted again after this upgrade.
DO $confirmation_quarantine$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "NotificationEvent" e
    WHERE e.source='receptionist.appointment_confirmation' AND e.status='retrying'
      AND (
        e.attempts < 1
        OR NOT EXISTS (
          SELECT 1 FROM "NotificationDeliveryAttempt" a
          WHERE a."tenantId"=e."tenantId" AND a."notificationEventId"=e.id
            AND a."attemptNumber"=e.attempts AND a.phase='INTENT'
        )
        OR EXISTS (
          SELECT 1 FROM "NotificationDeliveryAttempt" a
          WHERE a."tenantId"=e."tenantId" AND a."notificationEventId"=e.id
            AND a."attemptNumber"=e.attempts AND a.phase='RESULT'
        )
      )
  ) THEN
    RAISE EXCEPTION USING MESSAGE='legacy confirmation quarantine preflight failed',
      DETAIL='A retrying confirmation lacks a unique current INTENT or already has RESULT evidence.';
  END IF;

  INSERT INTO "NotificationDeliveryAttempt" (
    id,"tenantId","notificationEventId","attemptNumber",phase,status,
    "failureCode","startedAt","completedAt"
  )
  SELECT gen_random_uuid(),e."tenantId",e.id,e.attempts,'RESULT','dead_lettered',
    'provider_boundary_upgrade_quarantine',clock_timestamp(),clock_timestamp()
  FROM "NotificationEvent" e
  WHERE e.source='receptionist.appointment_confirmation' AND e.status='retrying';

  UPDATE "NotificationEvent" e
  SET status='dead_lettered',"nextAttemptAt"=NULL,"deadLetteredAt"=clock_timestamp(),
      "failureReason"='provider_boundary_upgrade_quarantine',"updatedAt"=clock_timestamp()
  WHERE e.source='receptionist.appointment_confirmation' AND e.status='retrying';

  IF EXISTS (
    SELECT 1 FROM "NotificationEvent"
    WHERE source='receptionist.appointment_confirmation' AND status='retrying'
  ) THEN
    RAISE EXCEPTION 'legacy confirmation quarantine was incomplete';
  END IF;
END
$confirmation_quarantine$;

-- Install an upgrade fence before legacy provider-intent rows are backfilled.
-- Runtime inserts fail closed while the catalog transition is in progress.
CREATE OR REPLACE FUNCTION receptionist_outbound_provider_intent_guard()
RETURNS trigger LANGUAGE plpgsql AS $upgrade_fence$
BEGIN
  IF TG_OP='UPDATE'
     AND ROW(NEW.id,NEW."tenantId",NEW."callLogId",NEW."outboundCampaignId",NEW."targetId",
             NEW."voiceConsentEventId",NEW.purpose,NEW."policyVersion",NEW."authorizedAt",NEW."createdAt")
         IS NOT DISTINCT FROM
         ROW(OLD.id,OLD."tenantId",OLD."callLogId",OLD."outboundCampaignId",OLD."targetId",
             OLD."voiceConsentEventId",OLD.purpose,OLD."policyVersion",OLD."authorizedAt",OLD."createdAt") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ReceptionistOutboundProviderIntent is closed for boundary upgrade'
    USING ERRCODE='55000';
END
$upgrade_fence$;

ALTER TABLE "ReceptionistOutboundProviderIntent"
  ADD COLUMN "patientId" UUID,
  ADD COLUMN "leadId" UUID,
  ADD COLUMN "destinationCanonical" TEXT,
  ADD COLUMN "identityUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "correlationNonceHash" TEXT,
  ADD COLUMN "boundaryVersion" INTEGER NOT NULL DEFAULT 0;

UPDATE "ReceptionistOutboundProviderIntent" intent
SET "patientId"=target."patientId",
    "leadId"=target."leadId",
    "destinationCanonical"=receptionist_canonical_suppression_destination(target.phone),
    "identityUpdatedAt"=COALESCE(patient."updatedAt",lead."updatedAt"),
    "correlationNonceHash"=md5('legacy-unrecoverable:' || intent.id::text)
                           || md5(intent.id::text || ':legacy-unrecoverable')
FROM "ReceptionistCallTarget" target
LEFT JOIN "Patient" patient
  ON patient."tenantId"=target."tenantId" AND patient.id=target."patientId"
LEFT JOIN "Lead" lead
  ON lead."tenantId"=target."tenantId" AND lead.id=target."leadId"
WHERE target."tenantId"=intent."tenantId"
  AND target."campaignId"=intent."outboundCampaignId" AND target.id=intent."targetId";

DO $provider_preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ReceptionistOutboundProviderIntent" intent
    LEFT JOIN "ReceptionistCallLog" call
      ON call."tenantId"=intent."tenantId"
     AND call."outboundCampaignId"=intent."outboundCampaignId" AND call.id=intent."callLogId"
    WHERE call.id IS NULL OR intent."patientId" IS NULL AND intent."leadId" IS NULL
       OR intent."destinationCanonical" IS NULL OR intent."identityUpdatedAt" IS NULL
       OR intent."correlationNonceHash" IS NULL
  ) THEN
    RAISE EXCEPTION USING MESSAGE='provider boundary recovery preflight failed',
      DETAIL='A legacy intent cannot be bound to its exact call, target, identity, or destination.';
  END IF;
END
$provider_preflight$;

ALTER TABLE "ReceptionistOutboundProviderIntent"
  ALTER COLUMN "destinationCanonical" SET NOT NULL,
  ALTER COLUMN "identityUpdatedAt" SET NOT NULL,
  ALTER COLUMN "correlationNonceHash" SET NOT NULL,
  ALTER COLUMN "boundaryVersion" SET DEFAULT 1,
  ADD CONSTRAINT "ReceptionistOutboundProviderIntent_boundary_check"
    CHECK (
      (("patientId" IS NOT NULL)::int + ("leadId" IS NOT NULL)::int)=1
      AND "destinationCanonical" ~ '^\+[0-9]{7,15}$'
      AND "correlationNonceHash" ~ '^[0-9a-f]{64}$'
      AND "boundaryVersion" IN (0,1)
    ) NOT VALID;
ALTER TABLE "ReceptionistOutboundProviderIntent"
  VALIDATE CONSTRAINT "ReceptionistOutboundProviderIntent_boundary_check";

CREATE UNIQUE INDEX "ReceptionistOutboundProviderIntent_nonce_hash_key"
  ON "ReceptionistOutboundProviderIntent"("tenantId","correlationNonceHash");
CREATE UNIQUE INDEX "ReceptionistOutboundProviderIntent_call_campaign_key"
  ON "ReceptionistOutboundProviderIntent"("tenantId","outboundCampaignId","callLogId");

ALTER TABLE "ReceptionistOutboundProviderIntent"
  ADD CONSTRAINT "ReceptionistOutboundProviderIntent_patient_scope_fkey"
    FOREIGN KEY ("tenantId","patientId") REFERENCES "Patient"("tenantId",id)
    ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "ReceptionistOutboundProviderIntent_lead_scope_fkey"
    FOREIGN KEY ("tenantId","leadId") REFERENCES "Lead"("tenantId",id)
    ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "ReceptionistOutboundProviderIntent_call_campaign_scope_fkey"
    FOREIGN KEY ("tenantId","outboundCampaignId","callLogId")
    REFERENCES "ReceptionistCallLog"("tenantId","outboundCampaignId",id)
    ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReceptionistOutboundProviderIntent"
  VALIDATE CONSTRAINT "ReceptionistOutboundProviderIntent_patient_scope_fkey";
ALTER TABLE "ReceptionistOutboundProviderIntent"
  VALIDATE CONSTRAINT "ReceptionistOutboundProviderIntent_lead_scope_fkey";
ALTER TABLE "ReceptionistOutboundProviderIntent"
  VALIDATE CONSTRAINT "ReceptionistOutboundProviderIntent_call_campaign_scope_fkey";
ALTER TABLE "ReceptionistOutboundProviderIntent"
  DROP CONSTRAINT "ReceptionistOutboundProviderIntent_call_scope_fkey";

-- Legacy intents do not carry a recoverable correlation nonce. Any such intent
-- still appearing submit-capable is moved to explicit human reconciliation;
-- it is never left silently stuck or eligible for an automated retry.
DO $legacy_intent_quarantine$
BEGIN
  INSERT INTO "AuditEvent" (id,"tenantId",action,resource,"resourceId",metadata,"occurredAt")
  SELECT gen_random_uuid(),i."tenantId",'receptionist.outbound.legacyProviderIntentQuarantined',
    'receptionistCallLog',i."callLogId",
    jsonb_build_object('providerIntentId',i.id,'campaignId',i."outboundCampaignId",'reason','NON_RECOVERABLE_LEGACY_CORRELATION'),
    clock_timestamp()
  FROM "ReceptionistOutboundProviderIntent" i
  JOIN "ReceptionistCallLog" c
    ON c."tenantId"=i."tenantId" AND c."outboundCampaignId"=i."outboundCampaignId" AND c.id=i."callLogId"
  WHERE i."boundaryVersion"=0 AND c."retellCallId" IS NULL AND c.outcome='IN_PROGRESS';

  INSERT INTO "BusinessEvent" (id,"tenantId","eventType","entityType","entityId","sourceModule",payload,"occurredAt","createdAt")
  SELECT gen_random_uuid(),i."tenantId",'receptionist.outbound.legacy_provider_intent_quarantined',
    'ReceptionistCallLog',i."callLogId",'receptionist_provider_boundary_migration',
    jsonb_build_object('providerIntentId',i.id,'campaignId',i."outboundCampaignId",'reconciliationRequired',true),
    clock_timestamp(),clock_timestamp()
  FROM "ReceptionistOutboundProviderIntent" i
  JOIN "ReceptionistCallLog" c
    ON c."tenantId"=i."tenantId" AND c."outboundCampaignId"=i."outboundCampaignId" AND c.id=i."callLogId"
  WHERE i."boundaryVersion"=0 AND c."retellCallId" IS NULL AND c.outcome='IN_PROGRESS';

  INSERT INTO "StaffTask" (id,"tenantId",title,priority,status,metadata,"createdAt","updatedAt")
  SELECT gen_random_uuid(),i."tenantId",'Reconcile quarantined outbound provider intent','URGENT','OPEN',
    jsonb_build_object('providerIntentId',i.id,'callLogId',i."callLogId",'campaignId',i."outboundCampaignId",'reason','RECONCILIATION_REQUIRED'),
    clock_timestamp(),clock_timestamp()
  FROM "ReceptionistOutboundProviderIntent" i
  JOIN "ReceptionistCallLog" c
    ON c."tenantId"=i."tenantId" AND c."outboundCampaignId"=i."outboundCampaignId" AND c.id=i."callLogId"
  WHERE i."boundaryVersion"=0 AND c."retellCallId" IS NULL AND c.outcome='IN_PROGRESS';

  UPDATE "ReceptionistCallTarget" target
  SET status='FAILED',"lastOutcome"='RECONCILIATION_REQUIRED',"updatedAt"=clock_timestamp()
  FROM "ReceptionistOutboundProviderIntent" i
  JOIN "ReceptionistCallLog" c
    ON c."tenantId"=i."tenantId" AND c."outboundCampaignId"=i."outboundCampaignId" AND c.id=i."callLogId"
  WHERE i."boundaryVersion"=0 AND c."retellCallId" IS NULL AND c.outcome='IN_PROGRESS'
    AND target."tenantId"=i."tenantId" AND target."campaignId"=i."outboundCampaignId" AND target.id=i."targetId";

  UPDATE "ReceptionistCallLog" call
  SET outcome='ESCALATED',"endedAt"=COALESCE(call."endedAt",clock_timestamp()),"updatedAt"=clock_timestamp()
  FROM "ReceptionistOutboundProviderIntent" i
  WHERE i."boundaryVersion"=0 AND i."tenantId"=call."tenantId"
    AND i."outboundCampaignId"=call."outboundCampaignId" AND i."callLogId"=call.id
    AND call."retellCallId" IS NULL AND call.outcome='IN_PROGRESS';

  IF EXISTS (
    SELECT 1 FROM "ReceptionistOutboundProviderIntent" i
    JOIN "ReceptionistCallLog" c
      ON c."tenantId"=i."tenantId" AND c."outboundCampaignId"=i."outboundCampaignId" AND c.id=i."callLogId"
    WHERE i."boundaryVersion"=0 AND c."retellCallId" IS NULL AND c.outcome='IN_PROGRESS'
  ) THEN
    RAISE EXCEPTION 'legacy provider-intent quarantine was incomplete';
  END IF;
END
$legacy_intent_quarantine$;

CREATE OR REPLACE FUNCTION receptionist_outbound_provider_intent_guard()
RETURNS trigger LANGUAGE plpgsql AS $provider_guard$
DECLARE
  call_row "ReceptionistCallLog"%ROWTYPE;
  campaign_row "ReceptionistOutboundCampaign"%ROWTYPE;
  target_row "ReceptionistCallTarget"%ROWTYPE;
  consent_row "ReceptionistVoiceConsentEvent"%ROWTYPE;
  latest_consent_id uuid;
  canonical_destination text;
  identity_phone text;
  identity_deleted_at timestamp(3);
  identity_updated_at timestamp(3);
  latest_legacy_grant boolean;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    RAISE EXCEPTION 'ReceptionistOutboundProviderIntent is append-only' USING ERRCODE='55000';
  END IF;
  NEW."authorizedAt" := clock_timestamp();
  IF NEW."boundaryVersion"<>1 OR NEW."correlationNonceHash" !~ '^[0-9a-f]{64}$'
     OR ((NEW."patientId" IS NOT NULL)::int + (NEW."leadId" IS NOT NULL)::int)<>1 THEN
    RAISE EXCEPTION 'Outbound provider intent boundary evidence is invalid' USING ERRCODE='check_violation';
  END IF;

  SELECT * INTO STRICT call_row FROM "ReceptionistCallLog"
  WHERE "tenantId"=NEW."tenantId" AND "outboundCampaignId"=NEW."outboundCampaignId"
    AND id=NEW."callLogId" FOR UPDATE;
  SELECT * INTO STRICT campaign_row FROM "ReceptionistOutboundCampaign"
  WHERE "tenantId"=NEW."tenantId" AND id=NEW."outboundCampaignId";
  SELECT * INTO STRICT target_row FROM "ReceptionistCallTarget"
  WHERE "tenantId"=NEW."tenantId" AND "campaignId"=NEW."outboundCampaignId"
    AND id=NEW."targetId" FOR UPDATE;

  IF call_row.direction<>'outbound' OR call_row.outcome<>'IN_PROGRESS'
     OR call_row."endedAt" IS NOT NULL OR call_row."retellCallId" IS NOT NULL
     OR call_row."targetId" IS DISTINCT FROM NEW."targetId"
     OR NULLIF(btrim(call_row."callerPhone"),'') IS NULL THEN
    RAISE EXCEPTION 'Outbound provider intent call is not an exact unsubmitted in-progress call'
      USING ERRCODE='check_violation';
  END IF;
  IF campaign_row.status<>'RUNNING' OR campaign_row."authorityApprovedAt" IS NULL
     OR campaign_row."authorityApprovedById" IS NULL
     OR NULLIF(btrim(campaign_row."authorityFingerprint"),'') IS NULL
     OR campaign_row.purpose IS DISTINCT FROM NEW.purpose
     OR campaign_row."policyVersion" IS DISTINCT FROM NEW."policyVersion" THEN
    RAISE EXCEPTION 'Outbound provider intent campaign authority/purpose/policy is not current'
      USING ERRCODE='check_violation';
  END IF;
  IF target_row.status<>'CALLING'
     OR target_row."patientId" IS DISTINCT FROM NEW."patientId"
     OR target_row."leadId" IS DISTINCT FROM NEW."leadId" THEN
    RAISE EXCEPTION 'Outbound provider intent target identity is not exact' USING ERRCODE='check_violation';
  END IF;

  canonical_destination := NEW."destinationCanonical";
  IF canonical_destination IS DISTINCT FROM receptionist_canonical_suppression_destination(target_row.phone)
     OR canonical_destination IS DISTINCT FROM receptionist_canonical_suppression_destination(call_row."callerPhone") THEN
    RAISE EXCEPTION 'Outbound provider intent destination boundary is mismatched' USING ERRCODE='check_violation';
  END IF;
  -- Match consent/suppression writer lock order: advisory identity fences first,
  -- then the current Patient/Lead row lock.
  PERFORM receptionist_lock_suppression_keys(ARRAY[
    'receptionist-suppression:destination:'||NEW."tenantId"||':'||canonical_destination,
    CASE WHEN NEW."patientId" IS NOT NULL THEN 'receptionist-suppression:patient:'||NEW."tenantId"||':'||NEW."patientId" END,
    CASE WHEN NEW."leadId" IS NOT NULL THEN 'receptionist-suppression:lead:'||NEW."tenantId"||':'||NEW."leadId" END
  ]);

  IF NEW."patientId" IS NOT NULL THEN
    SELECT phone,"deletedAt","updatedAt" INTO STRICT identity_phone,identity_deleted_at,identity_updated_at
    FROM "Patient" WHERE "tenantId"=NEW."tenantId" AND id=NEW."patientId" FOR UPDATE;
  ELSE
    SELECT phone,"deletedAt","updatedAt" INTO STRICT identity_phone,identity_deleted_at,identity_updated_at
    FROM "Lead" WHERE "tenantId"=NEW."tenantId" AND id=NEW."leadId" FOR UPDATE;
  END IF;
  IF identity_deleted_at IS NOT NULL OR receptionist_canonical_suppression_destination(identity_phone) IS NULL
     OR receptionist_canonical_suppression_destination(identity_phone) IS DISTINCT FROM canonical_destination
     OR identity_updated_at IS DISTINCT FROM NEW."identityUpdatedAt" THEN
    RAISE EXCEPTION 'Outbound provider intent current identity boundary is stale or mismatched'
      USING ERRCODE='check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "ReceptionistOptOut" o WHERE o."tenantId"=NEW."tenantId" AND o."revokedAt" IS NULL
      AND o.channel IN ('ALL','VOICE')
      AND receptionist_canonical_suppression_destination(o."contactPhone")=canonical_destination
  ) OR EXISTS (
    SELECT 1 FROM "CommunicationConsent" c WHERE c."tenantId"=NEW."tenantId"
      AND c.channel='voice' AND c.status='opted_out'
      AND c."patientId" IS NOT DISTINCT FROM NEW."patientId" AND c."leadId" IS NOT DISTINCT FROM NEW."leadId"
  ) OR EXISTS (
    SELECT 1 FROM "CampaignSuppression" s WHERE s."tenantId"=NEW."tenantId"
      AND s.channel='voice' AND s.active
      AND s."patientId" IS NOT DISTINCT FROM NEW."patientId" AND s."leadId" IS NOT DISTINCT FROM NEW."leadId"
  ) THEN
    RAISE EXCEPTION 'Outbound provider intent is suppressed at the linearization point'
      USING ERRCODE='check_violation';
  END IF;

  IF NEW."patientId" IS NOT NULL THEN
    SELECT granted INTO latest_legacy_grant FROM "ConsentEvent"
    WHERE "tenantId"=NEW."tenantId" AND "patientId"=NEW."patientId" AND purpose='MARKETING'
      AND "occurredAt"<=NEW."authorizedAt"
    ORDER BY "occurredAt" DESC,granted ASC,id DESC LIMIT 1;
    IF latest_legacy_grant IS FALSE THEN
      RAISE EXCEPTION 'Outbound provider intent is denied by latest legacy patient consent'
        USING ERRCODE='check_violation';
    END IF;
  END IF;

  IF campaign_row."legalBasis"='EXPLICIT_CONSENT' OR NEW.purpose='PATIENT_REACTIVATION' THEN
    IF NEW."voiceConsentEventId" IS NULL THEN
      RAISE EXCEPTION 'Outbound provider intent requires immutable compatible voice consent evidence'
        USING ERRCODE='check_violation';
    END IF;
    SELECT * INTO STRICT consent_row FROM "ReceptionistVoiceConsentEvent"
    WHERE "tenantId"=NEW."tenantId" AND id=NEW."voiceConsentEventId";
    SELECT id INTO latest_consent_id FROM "ReceptionistVoiceConsentEvent"
    WHERE "tenantId"=NEW."tenantId"
      AND "patientId" IS NOT DISTINCT FROM NEW."patientId"
      AND "leadId" IS NOT DISTINCT FROM NEW."leadId"
      AND purpose=NEW.purpose AND "policyVersion"=NEW."policyVersion"
      AND "occurredAt"<=NEW."authorizedAt"
    ORDER BY "occurredAt" DESC,granted ASC,id DESC LIMIT 1;
    IF latest_consent_id IS DISTINCT FROM consent_row.id OR NOT consent_row.granted
       OR consent_row."patientId" IS DISTINCT FROM NEW."patientId"
       OR consent_row."leadId" IS DISTINCT FROM NEW."leadId"
       OR consent_row.purpose IS DISTINCT FROM NEW.purpose
       OR consent_row."policyVersion" IS DISTINCT FROM NEW."policyVersion"
       OR consent_row."occurredAt">NEW."authorizedAt"
       OR (consent_row."expiresAt" IS NOT NULL AND consent_row."expiresAt"<=NEW."authorizedAt") THEN
      RAISE EXCEPTION 'Outbound provider intent voice consent is stale, revoked, expired, future, or incompatible'
        USING ERRCODE='check_violation';
    END IF;
  ELSIF NEW."voiceConsentEventId" IS NOT NULL THEN
    RAISE EXCEPTION 'Outbound provider intent must not attach unrelated voice consent evidence'
      USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
EXCEPTION WHEN NO_DATA_FOUND THEN
  RAISE EXCEPTION 'Outbound provider intent references missing exact authority evidence'
    USING ERRCODE='foreign_key_violation';
END
$provider_guard$;

CREATE OR REPLACE FUNCTION receptionist_freeze_submitted_call_boundary()
RETURNS trigger LANGUAGE plpgsql AS $call_freeze$
BEGIN
  IF ROW(NEW."outboundCampaignId",NEW."targetId",NEW."callerPhone")
     IS DISTINCT FROM ROW(OLD."outboundCampaignId",OLD."targetId",OLD."callerPhone")
     AND EXISTS (
       SELECT 1 FROM "ReceptionistOutboundProviderIntent" i
       WHERE i."tenantId"=OLD."tenantId" AND i."callLogId"=OLD.id
     ) THEN
    RAISE EXCEPTION 'Submitted outbound call campaign, target, and destination are immutable'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$call_freeze$;
DROP TRIGGER IF EXISTS "ReceptionistCallLog_provider_boundary_freeze" ON "ReceptionistCallLog";
CREATE TRIGGER "ReceptionistCallLog_provider_boundary_freeze"
  BEFORE UPDATE ON "ReceptionistCallLog"
  FOR EACH ROW EXECUTE FUNCTION receptionist_freeze_submitted_call_boundary();

-- Replace the minimal SECURITY DEFINER resolver. The new branch accepts only
-- an exact UUID provider-intent id and returns no destination or PHI.
CREATE OR REPLACE FUNCTION app_resolve_ingress_tenant(kind text, lookup_value text)
RETURNS TABLE(tenant_id uuid, resource_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $ingress$
BEGIN
  IF lookup_value IS NULL OR length(lookup_value)<3 THEN RETURN; END IF;
  IF kind='tenant_slug' THEN
    RETURN QUERY SELECT t.id,t.id FROM public."Tenant" t WHERE t.slug=lookup_value AND t.status='active' LIMIT 1;
  ELSIF kind='portal_token_hash' THEN
    RETURN QUERY SELECT p."tenantId",p.id FROM public."PatientPortalToken" p JOIN public."Tenant" t ON t.id=p."tenantId" AND t.status='active' WHERE p."tokenHash"=lookup_value AND p."usedAt" IS NULL AND p."expiresAt">statement_timestamp() LIMIT 1;
  ELSIF kind='refresh_token_hash' THEN
    RETURN QUERY SELECT u."tenantId",u.id FROM public."User" u JOIN public."Tenant" t ON t.id=u."tenantId" AND t.status='active' WHERE u."refreshTokenHash"=lookup_value AND u.active AND u."refreshTokenExpiresAt">statement_timestamp() LIMIT 1;
  ELSIF kind='password_reset_hash' THEN
    RETURN QUERY SELECT p."tenantId",p.id FROM public."PasswordResetToken" p JOIN public."Tenant" t ON t.id=p."tenantId" AND t.status='active' WHERE p."tokenHash"=lookup_value AND p."usedAt" IS NULL AND p."expiresAt">statement_timestamp() LIMIT 1;
  ELSIF kind='intake_token_hash' THEN
    RETURN QUERY SELECT p."tenantId",p.id FROM public."PatientIntakePacket" p JOIN public."Tenant" t ON t.id=p."tenantId" AND t.status='active' WHERE p."publicTokenHash"=lookup_value AND p."tokenExpiresAt">statement_timestamp() AND p.status NOT IN ('submitted','cancelled') LIMIT 1;
  ELSIF kind='payment_public_token' THEN
    RETURN QUERY SELECT p."tenantId",p.id FROM public."PaymentRequest" p JOIN public."Tenant" t ON t.id=p."tenantId" AND t.status='active' WHERE p."publicToken"::text=lookup_value AND (p."linkExpiresAt" IS NULL OR p."linkExpiresAt">statement_timestamp()) LIMIT 1;
  ELSIF kind='pilot_share_hash' THEN
    RETURN QUERY SELECT p."tenantId",p.id FROM public."PilotStatusShare" p JOIN public."Tenant" t ON t.id=p."tenantId" AND t.status='active' WHERE p."tokenHash"=lookup_value AND p."expiresAt">statement_timestamp() LIMIT 1;
  ELSIF kind='stripe_provider_reference' THEN
    RETURN QUERY WITH matches AS (SELECT p."tenantId",p.id FROM public."PaymentRequest" p JOIN public."Tenant" t ON t.id=p."tenantId" AND t.status='active' WHERE p."providerReference"=lookup_value) SELECT m."tenantId",m.id FROM matches m WHERE (SELECT count(*) FROM matches)=1 LIMIT 1;
  ELSIF kind='retell_call_id' THEN
    RETURN QUERY WITH matches AS (SELECT c."tenantId",c.id FROM public."ReceptionistCallLog" c JOIN public."Tenant" t ON t.id=c."tenantId" AND t.status='active' WHERE c."retellCallId"=lookup_value) SELECT m."tenantId",m.id FROM matches m WHERE (SELECT count(*) FROM matches)=1 LIMIT 1;
  ELSIF kind='retell_destination_phone' THEN
    RETURN QUERY WITH matches AS (SELECT c."tenantId",c.id FROM public."ReceptionistClinic" c JOIN public."Tenant" t ON t.id=c."tenantId" AND t.status='active' WHERE c.phone=lookup_value AND c.active) SELECT m."tenantId",m.id FROM matches m WHERE (SELECT count(*) FROM matches)=1 LIMIT 1;
  ELSIF kind='retell_provider_intent' THEN
    IF lookup_value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN; END IF;
    RETURN QUERY
      SELECT i."tenantId",i.id
      FROM public."ReceptionistOutboundProviderIntent" i
      JOIN public."ReceptionistCallLog" c
        ON c."tenantId"=i."tenantId" AND c."outboundCampaignId"=i."outboundCampaignId" AND c.id=i."callLogId"
      JOIN public."Tenant" t ON t.id=i."tenantId" AND t.status='active'
      WHERE i.id=lookup_value::uuid AND i."boundaryVersion"=1
        AND c.outcome='IN_PROGRESS' AND c."endedAt" IS NULL
      LIMIT 1;
  ELSIF kind='campaign_provider_message' THEN
    RETURN QUERY WITH matches AS (SELECT c."tenantId",c.id FROM public."CampaignDelivery" c JOIN public."Tenant" t ON t.id=c."tenantId" AND t.status='active' WHERE c."providerMessageId"=lookup_value) SELECT m."tenantId",m.id FROM matches m WHERE (SELECT count(*) FROM matches)=1 LIMIT 1;
  ELSE RETURN;
  END IF;
END
$ingress$;
REVOKE ALL ON FUNCTION app_resolve_ingress_tenant(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_resolve_ingress_tenant(text,text) TO app_rls;

RESET statement_timeout;
RESET lock_timeout;
