-- Receptionist delivery, consent, and outbound ownership integrity hardening.
--
-- Rollout note for the hot NotificationEvent / ReceptionistCallLog tables:
-- every ownership and state preflight runs before any legacy FK is removed.
-- Composite FKs are installed NOT VALID, then explicitly VALIDATEd before the
-- weaker legacy FK is dropped. Unique-index creation can briefly block writers;
-- deploy this migration in a controlled database migration window and monitor
-- lock_timeout / statement_timeout at the runner. This migration never rewrites
-- legacy evidence to make it pass.

-- Prisma deploy does not guarantee a surrounding transaction for handwritten
-- SQL. Use session-scoped bounds (reset at EOF) so hot-table lock acquisition
-- fails fast instead of waiting behind production traffic indefinitely, while
-- still allowing catalog validation on a normally sized tenant dataset.
SET lock_timeout = '5s';
SET statement_timeout = '5min';

-- -------------------------------------------------------------------------
-- 1. Preflight and tenant-composite ownership
-- -------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ReceptionistOutboundCampaign" campaign
    LEFT JOIN "ReceptionistClinic" clinic
      ON clinic."tenantId" = campaign."tenantId" AND clinic.id = campaign."clinicId"
    LEFT JOIN "Branch" branch
      ON branch."tenantId" = campaign."tenantId" AND branch.id = campaign."defaultBranchId"
    WHERE clinic.id IS NULL OR (campaign."defaultBranchId" IS NOT NULL AND branch.id IS NULL)
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'outbound campaign ownership preflight failed',
      DETAIL = 'A clinic/default branch is orphaned or cross-tenant; reconcile explicitly before retrying.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "ReceptionistCallTarget" target
    LEFT JOIN "ReceptionistOutboundCampaign" campaign
      ON campaign."tenantId" = target."tenantId" AND campaign.id = target."campaignId"
    WHERE campaign.id IS NULL
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'outbound target campaign ownership preflight failed',
      DETAIL = 'A target campaign is orphaned or cross-tenant; reconcile explicitly before retrying.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "ReceptionistCallLog" call
    LEFT JOIN "ReceptionistClinic" clinic
      ON clinic."tenantId" = call."tenantId" AND clinic.id = call."clinicId"
    LEFT JOIN "ReceptionistCampaign" booking_campaign
      ON booking_campaign."tenantId" = call."tenantId" AND booking_campaign.id = call."campaignId"
    LEFT JOIN "ReceptionistOutboundCampaign" outbound_campaign
      ON outbound_campaign."tenantId" = call."tenantId" AND outbound_campaign.id = call."outboundCampaignId"
    LEFT JOIN "ReceptionistCallTarget" target
      ON target."tenantId" = call."tenantId"
     AND target."campaignId" = call."outboundCampaignId"
     AND target.id = call."targetId"
    WHERE (call."clinicId" IS NOT NULL AND clinic.id IS NULL)
       OR (call."campaignId" IS NOT NULL AND booking_campaign.id IS NULL)
       OR (call."outboundCampaignId" IS NOT NULL AND outbound_campaign.id IS NULL)
       OR (call."targetId" IS NOT NULL AND target.id IS NULL)
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'receptionist call ownership preflight failed',
      DETAIL = 'A call clinic/campaign/target is orphaned, cross-tenant, or attached to another outbound campaign.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "ReceptionistCallTarget" target
    LEFT JOIN "ReceptionistCallLog" call
      ON call."tenantId" = target."tenantId"
     AND call."outboundCampaignId" = target."campaignId"
     AND call.id = target."lastCallLogId"
    WHERE target."lastCallLogId" IS NOT NULL AND call.id IS NULL
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'outbound target last-call ownership preflight failed',
      DETAIL = 'A target points to a call from another tenant/campaign or to an orphaned call.';
  END IF;
END $$;

CREATE UNIQUE INDEX "Branch_tenantId_id_key" ON "Branch"("tenantId", id);
CREATE UNIQUE INDEX "ReceptionistClinic_tenantId_id_key" ON "ReceptionistClinic"("tenantId", id);
CREATE UNIQUE INDEX "ReceptionistCampaign_tenantId_id_key" ON "ReceptionistCampaign"("tenantId", id);
CREATE UNIQUE INDEX "ReceptionistOutboundCampaign_tenantId_id_key" ON "ReceptionistOutboundCampaign"("tenantId", id);
CREATE UNIQUE INDEX "ReceptionistCallTarget_tenantId_campaignId_id_key"
  ON "ReceptionistCallTarget"("tenantId", "campaignId", id);
CREATE UNIQUE INDEX "ReceptionistCallLog_tenantId_outboundCampaignId_id_key"
  ON "ReceptionistCallLog"("tenantId", "outboundCampaignId", id);

ALTER TABLE "ReceptionistOutboundCampaign"
  ADD CONSTRAINT "ReceptionistOutboundCampaign_clinic_scope_fkey"
  FOREIGN KEY ("tenantId", "clinicId") REFERENCES "ReceptionistClinic"("tenantId", id)
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "ReceptionistOutboundCampaign_default_branch_scope_fkey"
  FOREIGN KEY ("tenantId", "defaultBranchId") REFERENCES "Branch"("tenantId", id)
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReceptionistOutboundCampaign" VALIDATE CONSTRAINT "ReceptionistOutboundCampaign_clinic_scope_fkey";
ALTER TABLE "ReceptionistOutboundCampaign" VALIDATE CONSTRAINT "ReceptionistOutboundCampaign_default_branch_scope_fkey";
ALTER TABLE "ReceptionistOutboundCampaign" DROP CONSTRAINT "ReceptionistOutboundCampaign_clinicId_fkey";

ALTER TABLE "ReceptionistCallTarget"
  ADD CONSTRAINT "ReceptionistCallTarget_campaign_scope_fkey"
  FOREIGN KEY ("tenantId", "campaignId") REFERENCES "ReceptionistOutboundCampaign"("tenantId", id)
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReceptionistCallTarget" VALIDATE CONSTRAINT "ReceptionistCallTarget_campaign_scope_fkey";
ALTER TABLE "ReceptionistCallTarget" DROP CONSTRAINT "ReceptionistCallTarget_campaignId_fkey";

ALTER TABLE "ReceptionistCallLog"
  ADD CONSTRAINT "ReceptionistCallLog_clinic_scope_fkey"
  FOREIGN KEY ("tenantId", "clinicId") REFERENCES "ReceptionistClinic"("tenantId", id)
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "ReceptionistCallLog_campaign_scope_fkey"
  FOREIGN KEY ("tenantId", "campaignId") REFERENCES "ReceptionistCampaign"("tenantId", id)
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "ReceptionistCallLog_outbound_campaign_scope_fkey"
  FOREIGN KEY ("tenantId", "outboundCampaignId") REFERENCES "ReceptionistOutboundCampaign"("tenantId", id)
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "ReceptionistCallLog_target_ownership_fkey"
  FOREIGN KEY ("tenantId", "outboundCampaignId", "targetId")
  REFERENCES "ReceptionistCallTarget"("tenantId", "campaignId", id)
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID,
  ADD CONSTRAINT "ReceptionistCallLog_target_requires_campaign_check"
  CHECK ("targetId" IS NULL OR "outboundCampaignId" IS NOT NULL) NOT VALID;
ALTER TABLE "ReceptionistCallLog" VALIDATE CONSTRAINT "ReceptionistCallLog_clinic_scope_fkey";
ALTER TABLE "ReceptionistCallLog" VALIDATE CONSTRAINT "ReceptionistCallLog_campaign_scope_fkey";
ALTER TABLE "ReceptionistCallLog" VALIDATE CONSTRAINT "ReceptionistCallLog_outbound_campaign_scope_fkey";
ALTER TABLE "ReceptionistCallLog" VALIDATE CONSTRAINT "ReceptionistCallLog_target_ownership_fkey";
ALTER TABLE "ReceptionistCallLog" VALIDATE CONSTRAINT "ReceptionistCallLog_target_requires_campaign_check";
ALTER TABLE "ReceptionistCallLog"
  DROP CONSTRAINT "ReceptionistCallLog_clinicId_fkey",
  DROP CONSTRAINT "ReceptionistCallLog_campaignId_fkey",
  DROP CONSTRAINT "ReceptionistCallLog_outboundCampaignId_fkey";

ALTER TABLE "ReceptionistCallTarget"
  ADD CONSTRAINT "ReceptionistCallTarget_last_call_ownership_fkey"
  FOREIGN KEY ("tenantId", "campaignId", "lastCallLogId")
  REFERENCES "ReceptionistCallLog"("tenantId", "outboundCampaignId", id)
  ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ReceptionistCallTarget" VALIDATE CONSTRAINT "ReceptionistCallTarget_last_call_ownership_fkey";

-- -------------------------------------------------------------------------
-- 2. Immutable, purpose/policy-bound voice-consent evidence
-- -------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "CommunicationConsent"
    WHERE (("patientId" IS NOT NULL)::int + ("leadId" IS NOT NULL)::int) <> 1
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'communication consent identity preflight failed',
      DETAIL = 'Every current consent row must identify exactly one patient or lead.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "CommunicationConsent"
    GROUP BY "tenantId", "patientId", "leadId", channel HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'communication consent uniqueness preflight failed',
      DETAIL = 'Duplicate nullable patient/lead channel rows must be reconciled before enforcing NULLS NOT DISTINCT.';
  END IF;
END $$;
DROP INDEX "CommunicationConsent_tenantId_patientId_leadId_channel_key";
CREATE UNIQUE INDEX "CommunicationConsent_tenantId_patientId_leadId_channel_key"
  ON "CommunicationConsent"("tenantId", "patientId", "leadId", channel) NULLS NOT DISTINCT;
ALTER TABLE "CommunicationConsent"
  ADD CONSTRAINT "CommunicationConsent_exact_identity_check"
  CHECK ((("patientId" IS NOT NULL)::int + ("leadId" IS NOT NULL)::int) = 1) NOT VALID;
ALTER TABLE "CommunicationConsent" VALIDATE CONSTRAINT "CommunicationConsent_exact_identity_check";

CREATE TABLE "ReceptionistVoiceConsentEvent" (
  id UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "patientId" UUID,
  "leadId" UUID,
  purpose TEXT NOT NULL,
  granted BOOLEAN NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "disclosureTextHash" TEXT NOT NULL,
  "evidenceReference" TEXT NOT NULL,
  "captureMethod" TEXT NOT NULL,
  source TEXT NOT NULL,
  "actorUserId" UUID,
  jurisdiction TEXT,
  "expiresAt" TIMESTAMP(3),
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReceptionistVoiceConsentEvent_pkey" PRIMARY KEY (id),
  CONSTRAINT "ReceptionistVoiceConsentEvent_exact_identity_check"
    CHECK ((("patientId" IS NOT NULL)::int + ("leadId" IS NOT NULL)::int) = 1),
  CONSTRAINT "ReceptionistVoiceConsentEvent_purpose_check"
    CHECK (purpose IN ('CARE_COORDINATION', 'APPOINTMENT_REMINDER', 'PATIENT_REACTIVATION')),
  CONSTRAINT "ReceptionistVoiceConsentEvent_policy_check"
    CHECK (length(btrim("policyVersion")) BETWEEN 1 AND 100),
  CONSTRAINT "ReceptionistVoiceConsentEvent_disclosure_hash_check"
    CHECK ("disclosureTextHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ReceptionistVoiceConsentEvent_evidence_reference_check"
    CHECK (length(btrim("evidenceReference")) BETWEEN 3 AND 200),
  CONSTRAINT "ReceptionistVoiceConsentEvent_capture_method_check"
    CHECK ("captureMethod" IN ('verbal_recorded', 'written', 'portal', 'staff_attestation', 'import_verified')),
  CONSTRAINT "ReceptionistVoiceConsentEvent_source_check"
    CHECK (source IN ('patient_verbal', 'patient_written', 'patient_portal', 'staff_attested', 'verified_import')),
  CONSTRAINT "ReceptionistVoiceConsentEvent_method_source_check"
    CHECK (
      ("captureMethod" = 'verbal_recorded' AND source = 'patient_verbal')
      OR ("captureMethod" = 'written' AND source = 'patient_written')
      OR ("captureMethod" = 'portal' AND source = 'patient_portal')
      OR ("captureMethod" = 'staff_attestation' AND source = 'staff_attested')
      OR ("captureMethod" = 'import_verified' AND source = 'verified_import')
    ),
  CONSTRAINT "ReceptionistVoiceConsentEvent_actor_check"
    CHECK ("captureMethod" NOT IN ('staff_attestation', 'import_verified') OR "actorUserId" IS NOT NULL),
  CONSTRAINT "ReceptionistVoiceConsentEvent_jurisdiction_check"
    CHECK (jurisdiction IS NULL OR length(btrim(jurisdiction)) BETWEEN 2 AND 100),
  CONSTRAINT "ReceptionistVoiceConsentEvent_time_check"
    CHECK ("occurredAt" <= "createdAt" + interval '5 minutes' AND ("expiresAt" IS NULL OR "expiresAt" > "occurredAt"))
);
CREATE UNIQUE INDEX "ReceptionistVoiceConsentEvent_tenantId_id_key"
  ON "ReceptionistVoiceConsentEvent"("tenantId", id);
CREATE INDEX "ReceptionistVoiceConsentEvent_patient_lookup_idx"
  ON "ReceptionistVoiceConsentEvent"("tenantId", "patientId", purpose, "policyVersion", "occurredAt" DESC, granted ASC, id DESC);
CREATE INDEX "ReceptionistVoiceConsentEvent_lead_lookup_idx"
  ON "ReceptionistVoiceConsentEvent"("tenantId", "leadId", purpose, "policyVersion", "occurredAt" DESC, granted ASC, id DESC);

ALTER TABLE "ReceptionistVoiceConsentEvent"
  ADD CONSTRAINT "ReceptionistVoiceConsentEvent_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ReceptionistVoiceConsentEvent_patient_scope_fkey"
  FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ReceptionistVoiceConsentEvent_lead_scope_fkey"
  FOREIGN KEY ("tenantId", "leadId") REFERENCES "Lead"("tenantId", id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ReceptionistVoiceConsentEvent_actor_scope_fkey"
  FOREIGN KEY ("tenantId", "actorUserId") REFERENCES "User"("tenantId", id) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION receptionist_voice_consent_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'ReceptionistVoiceConsentEvent is append-only; append a new grant/revocation event'
      USING ERRCODE = '55000';
  END IF;
  PERFORM receptionist_lock_suppression_keys(ARRAY[
    CASE WHEN NEW."patientId" IS NOT NULL THEN 'receptionist-suppression:patient:' || NEW."tenantId" || ':' || NEW."patientId" END,
    CASE WHEN NEW."leadId" IS NOT NULL THEN 'receptionist-suppression:lead:' || NEW."tenantId" || ':' || NEW."leadId" END
  ]);
  RETURN NEW;
END $$;
CREATE TRIGGER "ReceptionistVoiceConsentEvent_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "ReceptionistVoiceConsentEvent"
  FOR EACH ROW EXECUTE FUNCTION receptionist_voice_consent_guard();

-- -------------------------------------------------------------------------
-- 3. Authoritative outbound provider-intent evidence
-- -------------------------------------------------------------------------
CREATE TABLE "ReceptionistOutboundProviderIntent" (
  id UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "callLogId" UUID NOT NULL,
  "outboundCampaignId" UUID NOT NULL,
  "targetId" UUID,
  "voiceConsentEventId" UUID,
  purpose TEXT NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "authorizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReceptionistOutboundProviderIntent_pkey" PRIMARY KEY (id),
  CONSTRAINT "ReceptionistOutboundProviderIntent_purpose_check"
    CHECK (purpose IN ('CARE_COORDINATION', 'APPOINTMENT_REMINDER', 'PATIENT_REACTIVATION')),
  CONSTRAINT "ReceptionistOutboundProviderIntent_policy_check"
    CHECK (length(btrim("policyVersion")) BETWEEN 1 AND 100),
  CONSTRAINT "ReceptionistOutboundProviderIntent_time_check"
    CHECK ("authorizedAt" <= "createdAt" + interval '5 minutes')
);
CREATE UNIQUE INDEX "ReceptionistOutboundProviderIntent_tenantId_callLogId_key"
  ON "ReceptionistOutboundProviderIntent"("tenantId", "callLogId");
CREATE INDEX "ReceptionistOutboundProviderIntent_campaign_idx"
  ON "ReceptionistOutboundProviderIntent"("tenantId", "outboundCampaignId", "authorizedAt");
CREATE INDEX "ReceptionistOutboundProviderIntent_target_idx"
  ON "ReceptionistOutboundProviderIntent"("tenantId", "targetId", "authorizedAt");

ALTER TABLE "ReceptionistOutboundProviderIntent"
  ADD CONSTRAINT "ReceptionistOutboundProviderIntent_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ReceptionistOutboundProviderIntent_call_scope_fkey"
  FOREIGN KEY ("tenantId", "callLogId") REFERENCES "ReceptionistCallLog"("tenantId", id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ReceptionistOutboundProviderIntent_campaign_scope_fkey"
  FOREIGN KEY ("tenantId", "outboundCampaignId") REFERENCES "ReceptionistOutboundCampaign"("tenantId", id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ReceptionistOutboundProviderIntent_target_ownership_fkey"
  FOREIGN KEY ("tenantId", "outboundCampaignId", "targetId")
  REFERENCES "ReceptionistCallTarget"("tenantId", "campaignId", id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ReceptionistOutboundProviderIntent_consent_scope_fkey"
  FOREIGN KEY ("tenantId", "voiceConsentEventId") REFERENCES "ReceptionistVoiceConsentEvent"("tenantId", id) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION receptionist_outbound_provider_intent_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  call_row "ReceptionistCallLog"%ROWTYPE;
  campaign_row "ReceptionistOutboundCampaign"%ROWTYPE;
  target_row "ReceptionistCallTarget"%ROWTYPE;
  consent_row "ReceptionistVoiceConsentEvent"%ROWTYPE;
  latest_consent_id uuid;
  canonical_destination text;
  latest_legacy_grant boolean;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'ReceptionistOutboundProviderIntent is append-only'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO STRICT call_row FROM "ReceptionistCallLog"
   WHERE "tenantId" = NEW."tenantId" AND id = NEW."callLogId";
  SELECT * INTO STRICT campaign_row FROM "ReceptionistOutboundCampaign"
   WHERE "tenantId" = NEW."tenantId" AND id = NEW."outboundCampaignId";

  IF call_row.direction <> 'outbound'
     OR call_row.outcome <> 'IN_PROGRESS'
     OR call_row."endedAt" IS NOT NULL
     OR call_row."retellCallId" IS NOT NULL
     OR call_row."outboundCampaignId" IS DISTINCT FROM NEW."outboundCampaignId"
     OR call_row."targetId" IS DISTINCT FROM NEW."targetId"
     OR NULLIF(btrim(call_row."callerPhone"), '') IS NULL THEN
    RAISE EXCEPTION 'Outbound provider intent call is not an exact unsubmitted in-progress call'
      USING ERRCODE = 'check_violation';
  END IF;
  IF campaign_row.status <> 'RUNNING'
     OR campaign_row."authorityApprovedAt" IS NULL
     OR campaign_row."authorityApprovedById" IS NULL
     OR NULLIF(btrim(campaign_row."authorityFingerprint"), '') IS NULL
     OR campaign_row.purpose IS DISTINCT FROM NEW.purpose
     OR campaign_row."policyVersion" IS DISTINCT FROM NEW."policyVersion" THEN
    RAISE EXCEPTION 'Outbound provider intent campaign authority/purpose/policy is not current'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."targetId" IS NOT NULL THEN
    SELECT * INTO STRICT target_row FROM "ReceptionistCallTarget"
     WHERE "tenantId" = NEW."tenantId"
       AND "campaignId" = NEW."outboundCampaignId" AND id = NEW."targetId";
    IF target_row.status <> 'CALLING'
       OR receptionist_canonical_suppression_destination(target_row.phone)
          IS DISTINCT FROM receptionist_canonical_suppression_destination(call_row."callerPhone") THEN
      RAISE EXCEPTION 'Outbound provider intent target is not the exact claimed destination'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  canonical_destination := receptionist_canonical_suppression_destination(call_row."callerPhone");
  PERFORM receptionist_lock_suppression_keys(ARRAY[
    'receptionist-suppression:destination:' || NEW."tenantId" || ':' || canonical_destination,
    CASE WHEN NEW."targetId" IS NOT NULL AND target_row."patientId" IS NOT NULL
      THEN 'receptionist-suppression:patient:' || NEW."tenantId" || ':' || target_row."patientId" END,
    CASE WHEN NEW."targetId" IS NOT NULL AND target_row."leadId" IS NOT NULL
      THEN 'receptionist-suppression:lead:' || NEW."tenantId" || ':' || target_row."leadId" END
  ]);

  IF EXISTS (
    SELECT 1 FROM "ReceptionistOptOut" opt_out
    WHERE opt_out."tenantId" = NEW."tenantId" AND opt_out."revokedAt" IS NULL
      AND opt_out.channel IN ('ALL', 'VOICE')
      AND receptionist_canonical_suppression_destination(opt_out."contactPhone") = canonical_destination
  ) OR EXISTS (
    SELECT 1 FROM "CommunicationConsent" consent
    WHERE consent."tenantId" = NEW."tenantId" AND consent.channel = 'voice' AND consent.status = 'opted_out'
      AND consent."patientId" IS NOT DISTINCT FROM CASE WHEN NEW."targetId" IS NULL THEN NULL ELSE target_row."patientId" END
      AND consent."leadId" IS NOT DISTINCT FROM CASE WHEN NEW."targetId" IS NULL THEN NULL ELSE target_row."leadId" END
  ) OR EXISTS (
    SELECT 1 FROM "CampaignSuppression" suppression
    WHERE suppression."tenantId" = NEW."tenantId" AND suppression.channel = 'voice' AND suppression.active
      AND suppression."patientId" IS NOT DISTINCT FROM CASE WHEN NEW."targetId" IS NULL THEN NULL ELSE target_row."patientId" END
      AND suppression."leadId" IS NOT DISTINCT FROM CASE WHEN NEW."targetId" IS NULL THEN NULL ELSE target_row."leadId" END
  ) THEN
    RAISE EXCEPTION 'Outbound provider intent is suppressed at the linearization point'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."targetId" IS NOT NULL AND target_row."patientId" IS NOT NULL THEN
    SELECT granted INTO latest_legacy_grant FROM "ConsentEvent"
     WHERE "tenantId" = NEW."tenantId" AND "patientId" = target_row."patientId" AND purpose = 'MARKETING'
     ORDER BY "occurredAt" DESC, granted ASC, id DESC LIMIT 1;
    IF latest_legacy_grant IS FALSE THEN
      RAISE EXCEPTION 'Outbound provider intent is denied by latest legacy patient consent'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF campaign_row."legalBasis" = 'EXPLICIT_CONSENT' OR NEW.purpose = 'PATIENT_REACTIVATION' THEN
    IF NEW."targetId" IS NULL OR NEW."voiceConsentEventId" IS NULL THEN
      RAISE EXCEPTION 'Outbound provider intent requires immutable compatible voice consent evidence'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO STRICT consent_row FROM "ReceptionistVoiceConsentEvent"
     WHERE "tenantId" = NEW."tenantId" AND id = NEW."voiceConsentEventId";
    SELECT id INTO latest_consent_id FROM "ReceptionistVoiceConsentEvent"
     WHERE "tenantId" = NEW."tenantId"
       AND "patientId" IS NOT DISTINCT FROM target_row."patientId"
       AND "leadId" IS NOT DISTINCT FROM target_row."leadId"
       AND purpose = NEW.purpose AND "policyVersion" = NEW."policyVersion"
     ORDER BY "occurredAt" DESC, id DESC LIMIT 1;
    IF latest_consent_id IS DISTINCT FROM consent_row.id
       OR NOT consent_row.granted
       OR consent_row.purpose IS DISTINCT FROM NEW.purpose
       OR consent_row."policyVersion" IS DISTINCT FROM NEW."policyVersion"
       OR consent_row."patientId" IS DISTINCT FROM target_row."patientId"
       OR consent_row."leadId" IS DISTINCT FROM target_row."leadId"
       OR (consent_row."expiresAt" IS NOT NULL AND consent_row."expiresAt" <= NEW."authorizedAt") THEN
      RAISE EXCEPTION 'Outbound provider intent voice consent is stale, revoked, expired, or incompatible'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."voiceConsentEventId" IS NOT NULL THEN
    RAISE EXCEPTION 'Outbound provider intent must not attach unrelated voice consent evidence'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'Outbound provider intent references missing exact authority evidence'
      USING ERRCODE = 'foreign_key_violation';
END $$;
CREATE TRIGGER "ReceptionistOutboundProviderIntent_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "ReceptionistOutboundProviderIntent"
  FOR EACH ROW EXECUTE FUNCTION receptionist_outbound_provider_intent_guard();

-- -------------------------------------------------------------------------
-- 4. Confirmation outbox state and attempt ordering
-- -------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "NotificationEvent" event
    WHERE event.source = 'receptionist.appointment_confirmation'
      AND (
        event.status = 'sent'
        OR (event.status IN ('accepted', 'delivered') AND (
          event."acceptedAt" IS NULL OR NULLIF(btrim(event.provider), '') IS NULL
          OR NULLIF(btrim(event."providerMessageId"), '') IS NULL OR event.attempts < 1
        ))
        OR (event.status = 'delivered' AND event."deliveredAt" IS NULL)
      )
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'confirmation state preflight failed',
      DETAIL = 'A legacy confirmation has fabricated/incomplete sent, accepted, or delivered evidence.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "NotificationDeliveryAttempt" result
    JOIN "NotificationEvent" event
      ON event."tenantId" = result."tenantId" AND event.id = result."notificationEventId"
    WHERE event.source = 'receptionist.appointment_confirmation' AND result.phase = 'RESULT'
      AND NOT EXISTS (
        SELECT 1 FROM "NotificationDeliveryAttempt" intent
        WHERE intent."tenantId" = result."tenantId"
          AND intent."notificationEventId" = result."notificationEventId"
          AND intent."attemptNumber" = result."attemptNumber" AND intent.phase = 'INTENT'
      )
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'confirmation attempt-order preflight failed',
      DETAIL = 'A RESULT exists without its same-number INTENT; reconcile evidence explicitly.';
  END IF;
END $$;

ALTER TABLE "NotificationDeliveryAttempt"
  DROP CONSTRAINT "NotificationDeliveryAttempt_phase_check",
  DROP CONSTRAINT "NotificationDeliveryAttempt_status_check",
  DROP CONSTRAINT "NotificationDeliveryAttempt_phase_status_check";
ALTER TABLE "NotificationDeliveryAttempt"
  ADD CONSTRAINT "NotificationDeliveryAttempt_phase_check"
    CHECK (phase IN ('INTENT', 'PROVIDER_INTENT', 'RESULT', 'RECEIPT')),
  ADD CONSTRAINT "NotificationDeliveryAttempt_status_check"
    CHECK (status IN ('started', 'provider_intent_committed', 'accepted', 'delivered', 'failed', 'suppressed', 'dead_lettered', 'delivery_unknown')),
  ADD CONSTRAINT "NotificationDeliveryAttempt_phase_status_check"
    CHECK (
      (phase = 'INTENT' AND status = 'started' AND "completedAt" IS NULL)
      OR (phase = 'PROVIDER_INTENT' AND status = 'provider_intent_committed' AND "completedAt" IS NOT NULL)
      OR (phase = 'RESULT' AND status IN ('accepted', 'failed', 'suppressed', 'dead_lettered', 'delivery_unknown') AND "completedAt" IS NOT NULL)
      OR (phase = 'RECEIPT' AND status = 'delivered' AND "completedAt" IS NOT NULL)
    );

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
       OR EXISTS (SELECT 1 FROM "NotificationDeliveryAttempt" a WHERE a."tenantId"=NEW."tenantId" AND a."notificationEventId"=NEW."notificationEventId" AND a."attemptNumber"=NEW."attemptNumber" AND a.phase='RESULT') THEN
      RAISE EXCEPTION 'Confirmation PROVIDER_INTENT requires an active ordered lease' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.phase = 'RESULT' THEN
    IF NOT EXISTS (SELECT 1 FROM "NotificationDeliveryAttempt" a WHERE a."tenantId"=NEW."tenantId" AND a."notificationEventId"=NEW."notificationEventId" AND a."attemptNumber"=NEW."attemptNumber" AND a.phase='INTENT')
       OR NOT ((event_row.status='retrying' AND NEW."attemptNumber"=event_row.attempts)
            OR (event_row.status IN ('queued','failed') AND NEW."attemptNumber"=event_row.attempts+1)) THEN
      RAISE EXCEPTION 'Confirmation RESULT requires its ordered INTENT' USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.status='accepted' OR (NEW.status='delivery_unknown' AND NEW."failureCode"='provider_acceptance_unknown'))
       AND NOT EXISTS (SELECT 1 FROM "NotificationDeliveryAttempt" a WHERE a."tenantId"=NEW."tenantId" AND a."notificationEventId"=NEW."notificationEventId" AND a."attemptNumber"=NEW."attemptNumber" AND a.phase='PROVIDER_INTENT') THEN
      RAISE EXCEPTION 'Provider-facing confirmation RESULT requires committed provider intent' USING ERRCODE = 'check_violation';
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
DROP TRIGGER "NotificationDeliveryAttempt_append_only_trg" ON "NotificationDeliveryAttempt";
DROP FUNCTION "prevent_notification_delivery_attempt_mutation"();
CREATE TRIGGER "NotificationDeliveryAttempt_integrity_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "NotificationDeliveryAttempt"
  FOR EACH ROW EXECUTE FUNCTION protect_notification_delivery_attempt();

ALTER TABLE "NotificationEvent"
  DROP CONSTRAINT "NotificationEvent_receptionist_confirmation_accepted_check",
  DROP CONSTRAINT "NotificationEvent_receptionist_confirmation_terminal_check";
ALTER TABLE "NotificationEvent"
  ADD CONSTRAINT "NotificationEvent_receptionist_confirmation_evidence_check" CHECK (
    source IS DISTINCT FROM 'receptionist.appointment_confirmation' OR (
      status <> 'sent'
      AND (status NOT IN ('accepted','delivered') OR (
        attempts >= 1 AND "acceptedAt" IS NOT NULL AND "sentAt" IS NULL
        AND NULLIF(btrim(provider),'') IS NOT NULL AND NULLIF(btrim("providerMessageId"),'') IS NOT NULL
      ))
      AND (status <> 'delivered' OR "deliveredAt" IS NOT NULL)
      AND (status NOT IN ('dead_lettered','delivery_unknown') OR "deadLetteredAt" IS NOT NULL)
      AND (status NOT IN ('suppressed','accepted','delivered','dead_lettered','delivery_unknown') OR "nextAttemptAt" IS NULL)
    )
  );

CREATE OR REPLACE FUNCTION "protect_receptionist_confirmation_event"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  confirmation_source CONSTANT text := 'receptionist.appointment_confirmation';
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.source = confirmation_source THEN
      RAISE EXCEPTION 'Receptionist confirmation NotificationEvent is durable and cannot be deleted' USING ERRCODE='55000';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.source IS DISTINCT FROM confirmation_source THEN RETURN NEW; END IF;
    IF NEW.status <> 'queued' OR NEW.attempts <> 0 OR NEW."acceptedAt" IS NOT NULL
       OR NEW."deliveredAt" IS NOT NULL OR NEW."sentAt" IS NOT NULL OR NEW."deadLetteredAt" IS NOT NULL
       OR NEW.provider IS NOT NULL OR NEW."providerMessageId" IS NOT NULL OR NEW."consentChecked" THEN
      RAISE EXCEPTION 'Receptionist confirmation must begin as an unsubmitted queued event' USING ERRCODE='check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.source = confirmation_source OR NEW.source = confirmation_source) AND NEW.source IS DISTINCT FROM OLD.source THEN
    RAISE EXCEPTION 'Receptionist confirmation NotificationEvent source is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.source IS DISTINCT FROM confirmation_source THEN RETURN NEW; END IF;
  IF ROW(NEW.id,NEW."tenantId",NEW."appointmentId",NEW."patientId",NEW."recipientType",NEW.channel,NEW."idempotencyKey",NEW."maxAttempts",NEW."createdAt")
     IS DISTINCT FROM ROW(OLD.id,OLD."tenantId",OLD."appointmentId",OLD."patientId",OLD."recipientType",OLD.channel,OLD."idempotencyKey",OLD."maxAttempts",OLD."createdAt") THEN
    RAISE EXCEPTION 'Receptionist confirmation NotificationEvent identity is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.attempts < OLD.attempts OR NEW.attempts > NEW."maxAttempts" THEN
    RAISE EXCEPTION 'Receptionist confirmation attempts violate monotonic bounds' USING ERRCODE='55000';
  END IF;

  IF NEW.status = OLD.status THEN
    IF NEW.attempts <> OLD.attempts THEN RAISE EXCEPTION 'Confirmation attempts require a forward state transition' USING ERRCODE='55000'; END IF;
    IF OLD.status IN ('accepted','delivered','suppressed','dead_lettered','delivery_unknown')
       AND (to_jsonb(NEW)-'updatedAt') IS DISTINCT FROM (to_jsonb(OLD)-'updatedAt') THEN
      RAISE EXCEPTION 'Receptionist confirmation terminal evidence is immutable' USING ERRCODE='55000';
    ELSIF OLD.status IN ('queued','failed')
       AND (to_jsonb(NEW)-ARRAY['updatedAt','nextAttemptAt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['updatedAt','nextAttemptAt']) THEN
      RAISE EXCEPTION 'Receptionist confirmation pending evidence permits scheduling changes only' USING ERRCODE='55000';
    ELSIF OLD.status='retrying' AND (to_jsonb(NEW)-'updatedAt') IS DISTINCT FROM (to_jsonb(OLD)-'updatedAt') THEN
      RAISE EXCEPTION 'Receptionist confirmation in-flight evidence is immutable' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('queued','failed') AND NEW.status='retrying' THEN
    IF NEW.attempts <> OLD.attempts+1 OR NOT EXISTS (
      SELECT 1 FROM "NotificationDeliveryAttempt" a WHERE a."tenantId"=NEW."tenantId" AND a."notificationEventId"=NEW.id AND a."attemptNumber"=NEW.attempts AND a.phase='INTENT'
    ) THEN RAISE EXCEPTION 'Confirmation retry claim lacks its ordered INTENT' USING ERRCODE='55000'; END IF;
  ELSIF OLD.status IN ('queued','failed') AND NEW.status IN ('suppressed','dead_lettered') THEN
    IF NEW.attempts = OLD.attempts+1 AND NOT EXISTS (
      SELECT 1 FROM "NotificationDeliveryAttempt" a WHERE a."tenantId"=NEW."tenantId" AND a."notificationEventId"=NEW.id AND a."attemptNumber"=NEW.attempts AND a.phase='RESULT' AND a.status=NEW.status
    ) THEN RAISE EXCEPTION 'Confirmation terminal transition lacks its ordered RESULT' USING ERRCODE='55000';
    ELSIF NEW.attempts NOT IN (OLD.attempts,OLD.attempts+1) THEN RAISE EXCEPTION 'Confirmation pre-provider terminal attempt is invalid' USING ERRCODE='55000'; END IF;
  ELSIF OLD.status='retrying' AND NEW.status IN ('accepted','failed','suppressed','dead_lettered','delivery_unknown') THEN
    IF NEW.attempts <> OLD.attempts OR NOT EXISTS (
      SELECT 1 FROM "NotificationDeliveryAttempt" a WHERE a."tenantId"=NEW."tenantId" AND a."notificationEventId"=NEW.id AND a."attemptNumber"=NEW.attempts AND a.phase='RESULT' AND a.status=NEW.status
    ) THEN RAISE EXCEPTION 'Confirmation dispatch transition lacks its ordered RESULT' USING ERRCODE='55000'; END IF;
    IF NEW.status='accepted' AND NOT EXISTS (
      SELECT 1 FROM "NotificationDeliveryAttempt" a WHERE a."tenantId"=NEW."tenantId" AND a."notificationEventId"=NEW.id AND a."attemptNumber"=NEW.attempts AND a.phase='RESULT' AND a.status='accepted' AND a.provider=NEW.provider AND a."providerMessageId"=NEW."providerMessageId"
    ) THEN RAISE EXCEPTION 'Accepted confirmation does not match provider RESULT evidence' USING ERRCODE='55000'; END IF;
  ELSIF OLD.status='accepted' AND NEW.status='delivered' THEN
    IF NEW.attempts<>OLD.attempts OR NEW."acceptedAt" IS DISTINCT FROM OLD."acceptedAt"
       OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW."providerMessageId" IS DISTINCT FROM OLD."providerMessageId"
       OR NEW."deliveredAt" IS NULL OR NOT EXISTS (
         SELECT 1 FROM "NotificationDeliveryAttempt" a WHERE a."tenantId"=NEW."tenantId" AND a."notificationEventId"=NEW.id AND a."attemptNumber"=NEW.attempts AND a.phase='RECEIPT' AND a.status='delivered' AND a.provider=NEW.provider AND a."providerMessageId"=NEW."providerMessageId"
       ) OR (to_jsonb(NEW)-ARRAY['status','updatedAt','deliveredAt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','updatedAt','deliveredAt']) THEN
      RAISE EXCEPTION 'Delivered confirmation requires matching immutable provider receipt' USING ERRCODE='55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'Illegal receptionist confirmation NotificationEvent status transition (% -> %)',OLD.status,NEW.status USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER "NotificationEvent_confirmation_state_trg" ON "NotificationEvent";
CREATE TRIGGER "NotificationEvent_confirmation_state_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "NotificationEvent"
  FOR EACH ROW EXECUTE FUNCTION "protect_receptionist_confirmation_event"();

-- New evidence tables use the same forced tenant isolation as other protected
-- records. app_rls may append/read; trigger guards prohibit evidence mutation.
ALTER TABLE "ReceptionistVoiceConsentEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReceptionistVoiceConsentEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "rls_receptionist_voice_consent_event_select" ON "ReceptionistVoiceConsentEvent"
  FOR SELECT TO app_rls USING (app_rls_tenant_allowed("tenantId"));
CREATE POLICY "rls_receptionist_voice_consent_event_insert" ON "ReceptionistVoiceConsentEvent"
  FOR INSERT TO app_rls WITH CHECK (app_rls_tenant_allowed("tenantId"));
REVOKE ALL ON TABLE "ReceptionistVoiceConsentEvent" FROM app_rls;
GRANT SELECT, INSERT ON TABLE "ReceptionistVoiceConsentEvent" TO app_rls;

ALTER TABLE "ReceptionistOutboundProviderIntent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReceptionistOutboundProviderIntent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "rls_receptionist_outbound_provider_intent_select" ON "ReceptionistOutboundProviderIntent"
  FOR SELECT TO app_rls USING (app_rls_tenant_allowed("tenantId"));
CREATE POLICY "rls_receptionist_outbound_provider_intent_insert" ON "ReceptionistOutboundProviderIntent"
  FOR INSERT TO app_rls WITH CHECK (app_rls_tenant_allowed("tenantId"));
REVOKE ALL ON TABLE "ReceptionistOutboundProviderIntent" FROM app_rls;
GRANT SELECT, INSERT ON TABLE "ReceptionistOutboundProviderIntent" TO app_rls;

RESET statement_timeout;
RESET lock_timeout;
