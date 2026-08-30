-- C2: clinic knowledge, hours engine, locale packs.
-- Hand-written. Every new tenant table declares its own RLS policies because
-- the 20260730120000_complete_rls_isolation loop ran once, at that migration.
SET lock_timeout = '5s';
SET statement_timeout = '5min';

-- ---------------------------------------------------------------------------
-- 1. Clinic: country, Prisma defaults removed, optional supplemental wording,
--    E.164 CHECK on the fallback number.
-- ---------------------------------------------------------------------------
ALTER TABLE "ReceptionistClinic"
  ADD COLUMN "country" TEXT,
  ALTER COLUMN "timezone" DROP DEFAULT,
  ALTER COLUMN "defaultLanguage" DROP DEFAULT,
  ALTER COLUMN "complianceDisclosure" DROP DEFAULT,
  ALTER COLUMN "complianceDisclosure" DROP NOT NULL,
  ALTER COLUMN "doNotContactPolicy" DROP DEFAULT,
  ALTER COLUMN "doNotContactPolicy" DROP NOT NULL,
  ADD CONSTRAINT "ReceptionistClinic_country_iso2_check" CHECK ("country" IS NULL OR "country" ~ '^[A-Z]{2}$');

-- Backfill only from a valid tenant company record; never infer from timezone.
UPDATE "ReceptionistClinic" c
   SET "country" = upper(t."country")
  FROM "Tenant" t
 WHERE t.id = c."tenantId" AND c."country" IS NULL AND t."country" ~* '^[a-z]{2}$';

-- The old Prisma placeholder wording was never approved wording.
UPDATE "ReceptionistClinic" SET "complianceDisclosure" = NULL
 WHERE "complianceDisclosure" = 'Hi, this is your AI assistant calling on behalf of the clinic.';
UPDATE "ReceptionistClinic" SET "doNotContactPolicy" = NULL
 WHERE "doNotContactPolicy" = 'If the person asks not to be contacted again, confirm politely and mark them do-not-contact.';

-- Fallback number: canonicalise formatting, null anything still invalid (audited), then CHECK.
UPDATE "ReceptionistClinic"
   SET "humanFallbackNumber" = regexp_replace("humanFallbackNumber", '[().[:space:]-]', '', 'g')
 WHERE "humanFallbackNumber" IS NOT NULL;
INSERT INTO "AuditEvent" ("id", "tenantId", "action", "resource", "resourceId", "metadata", "occurredAt")
SELECT gen_random_uuid(), "tenantId", 'receptionistClinic.fallbackNumberCleared', 'receptionistClinic', id,
       jsonb_build_object('reason', 'not_e164', 'migration', '20260830110000'), now()
  FROM "ReceptionistClinic"
 WHERE "humanFallbackNumber" IS NOT NULL AND "humanFallbackNumber" !~ '^\+[1-9][0-9]{7,14}$';
UPDATE "ReceptionistClinic" SET "humanFallbackNumber" = NULL
 WHERE "humanFallbackNumber" IS NOT NULL AND "humanFallbackNumber" !~ '^\+[1-9][0-9]{7,14}$';
ALTER TABLE "ReceptionistClinic"
  ADD CONSTRAINT "ReceptionistClinic_humanFallbackNumber_e164_check"
  CHECK ("humanFallbackNumber" IS NULL OR "humanFallbackNumber" ~ '^\+[1-9][0-9]{7,14}$');

-- ---------------------------------------------------------------------------
-- 2. Location: drop the dead timezone column (audited where it diverged from
--    the branch), add accessNotes, tenant-scoped uniqueness for composite FKs.
-- ---------------------------------------------------------------------------
INSERT INTO "AuditEvent" ("id", "tenantId", "action", "resource", "resourceId", "metadata", "occurredAt")
SELECT gen_random_uuid(), l."tenantId", 'receptionistLocation.timezoneDivergenceDropped', 'receptionistLocation', l.id,
       jsonb_build_object('stored', l."timezone", 'branch', b."timezone", 'migration', '20260830110000'), now()
  FROM "ReceptionistLocation" l JOIN "Branch" b ON b.id = l."branchId"
 WHERE l."timezone" IS NOT NULL AND l."timezone" <> b."timezone";
ALTER TABLE "ReceptionistLocation" DROP COLUMN "timezone";
ALTER TABLE "ReceptionistLocation" ADD COLUMN "accessNotes" TEXT;
CREATE UNIQUE INDEX "ReceptionistLocation_tenantId_id_key" ON "ReceptionistLocation"("tenantId", "id");

-- ---------------------------------------------------------------------------
-- 3. Services are catalog rows (one source of truth): voice-facing columns.
-- ---------------------------------------------------------------------------
ALTER TABLE "ServiceCatalogItem"
  ADD COLUMN "spokenDescription" TEXT,
  ADD COLUMN "bookableByVoice" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "voiceDurationMinutes" INTEGER,
  ADD COLUMN "priceFrom" DECIMAL(12, 2),
  ADD CONSTRAINT "ServiceCatalogItem_voiceDurationMinutes_check"
    CHECK ("voiceDurationMinutes" IS NULL OR ("voiceDurationMinutes" >= 5 AND "voiceDurationMinutes" <= 480)),
  ADD CONSTRAINT "ServiceCatalogItem_priceFrom_check" CHECK ("priceFrom" IS NULL OR "priceFrom" >= 0);

-- ---------------------------------------------------------------------------
-- 4. New tables
-- ---------------------------------------------------------------------------
CREATE TYPE "ReceptionistLocalePackStatus" AS ENUM ('DRAFT', 'APPROVED', 'RETIRED');

CREATE TABLE "ReceptionistClosure" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "clinicId" UUID NOT NULL,
  "locationId" UUID,
  "startsOn" DATE NOT NULL,
  "endsOn" DATE NOT NULL,
  "startTime" TEXT,
  "endTime" TEXT,
  "reason" TEXT NOT NULL,
  "internalNote" TEXT,
  "createdByUserId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReceptionistClosure_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReceptionistClosure_range_check" CHECK ("endsOn" >= "startsOn" AND "endsOn" - "startsOn" <= 366),
  CONSTRAINT "ReceptionistClosure_partial_day_check" CHECK (("startTime" IS NULL) = ("endTime" IS NULL))
);
CREATE INDEX "ReceptionistClosure_tenantId_clinicId_startsOn_endsOn_idx" ON "ReceptionistClosure"("tenantId", "clinicId", "startsOn", "endsOn");
CREATE UNIQUE INDEX "ReceptionistClosure_tenantId_id_key" ON "ReceptionistClosure"("tenantId", "id");
ALTER TABLE "ReceptionistClosure"
  ADD CONSTRAINT "ReceptionistClosure_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ReceptionistClosure_clinic_scope_fkey" FOREIGN KEY ("tenantId", "clinicId") REFERENCES "ReceptionistClinic"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ReceptionistClosure_location_scope_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "ReceptionistLocation"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ReceptionistClosure_creator_scope_fkey" FOREIGN KEY ("tenantId", "createdByUserId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ReceptionistClinicKnowledge" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "clinicId" UUID NOT NULL,
  "draft" JSONB NOT NULL,
  "draftRevision" INTEGER NOT NULL DEFAULT 1,
  "approved" JSONB,
  "approvedRevision" INTEGER,
  "approvedHash" TEXT,
  "approvedByUserId" UUID,
  "approvedAt" TIMESTAMP(3),
  "updatedByUserId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReceptionistClinicKnowledge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReceptionistClinicKnowledge_approval_complete_check"
    CHECK (("approved" IS NULL AND "approvedRevision" IS NULL AND "approvedHash" IS NULL AND "approvedAt" IS NULL)
        OR ("approved" IS NOT NULL AND "approvedRevision" IS NOT NULL AND "approvedHash" IS NOT NULL AND "approvedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "ReceptionistClinicKnowledge_tenantId_clinicId_key" ON "ReceptionistClinicKnowledge"("tenantId", "clinicId");
CREATE UNIQUE INDEX "ReceptionistClinicKnowledge_tenantId_id_key" ON "ReceptionistClinicKnowledge"("tenantId", "id");
ALTER TABLE "ReceptionistClinicKnowledge"
  ADD CONSTRAINT "ReceptionistClinicKnowledge_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ReceptionistClinicKnowledge_clinic_scope_fkey" FOREIGN KEY ("tenantId", "clinicId") REFERENCES "ReceptionistClinic"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ReceptionistClinicKnowledge_approver_scope_fkey" FOREIGN KEY ("tenantId", "approvedByUserId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ReceptionistClinicKnowledge_editor_scope_fkey" FOREIGN KEY ("tenantId", "updatedByUserId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ReceptionistLocalePack" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "language" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "ReceptionistLocalePackStatus" NOT NULL DEFAULT 'DRAFT',
  "source" TEXT NOT NULL,
  "baseDefaultVersion" INTEGER,
  "strings" JSONB NOT NULL,
  "evidenceHash" TEXT NOT NULL,
  "approvedByUserId" UUID,
  "approvedAt" TIMESTAMP(3),
  "retiredAt" TIMESTAMP(3),
  "createdByUserId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReceptionistLocalePack_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReceptionistLocalePack_country_iso2_check" CHECK ("country" ~ '^[A-Z]{2}$'),
  CONSTRAINT "ReceptionistLocalePack_source_check" CHECK ("source" IN ('platform_default', 'tenant')),
  CONSTRAINT "ReceptionistLocalePack_approval_complete_check"
    CHECK ("status" <> 'APPROVED' OR ("approvedByUserId" IS NOT NULL AND "approvedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "ReceptionistLocalePack_tenantId_language_country_version_key" ON "ReceptionistLocalePack"("tenantId", "language", "country", "version");
-- Exactly one APPROVED pack per (tenant, language, country). Prisma cannot express partial unique indexes.
CREATE UNIQUE INDEX "ReceptionistLocalePack_one_approved_idx" ON "ReceptionistLocalePack"("tenantId", "language", "country") WHERE "status" = 'APPROVED';
CREATE INDEX "ReceptionistLocalePack_tenantId_language_country_status_idx" ON "ReceptionistLocalePack"("tenantId", "language", "country", "status");
CREATE UNIQUE INDEX "ReceptionistLocalePack_tenantId_id_key" ON "ReceptionistLocalePack"("tenantId", "id");
ALTER TABLE "ReceptionistLocalePack"
  ADD CONSTRAINT "ReceptionistLocalePack_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ReceptionistLocalePack_approver_scope_fkey" FOREIGN KEY ("tenantId", "approvedByUserId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ReceptionistLocalePack_creator_scope_fkey" FOREIGN KEY ("tenantId", "createdByUserId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 5. Call log + campaign evidence columns
-- ---------------------------------------------------------------------------
ALTER TABLE "ReceptionistCallLog"
  ADD COLUMN "outsideHours" BOOLEAN,
  ADD COLUMN "transferOutcome" TEXT,
  ADD COLUMN "localePackId" UUID,
  ADD CONSTRAINT "ReceptionistCallLog_transferOutcome_check" CHECK ("transferOutcome" IS NULL OR "transferOutcome" IN ('connected', 'unknown')),
  ADD CONSTRAINT "ReceptionistCallLog_locale_pack_scope_fkey" FOREIGN KEY ("tenantId", "localePackId") REFERENCES "ReceptionistLocalePack"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "ReceptionistCallLog_tenantId_clinicId_outsideHours_startedAt_idx" ON "ReceptionistCallLog"("tenantId", "clinicId", "outsideHours", "startedAt");

ALTER TABLE "ReceptionistCampaign"
  ADD COLUMN "attestedLocalePackId" UUID,
  ADD COLUMN "attestedLocalePackHash" TEXT;

-- ---------------------------------------------------------------------------
-- 6. Row-level security for the three new tenant-owned tables (MUTABLE).
-- ---------------------------------------------------------------------------
ALTER TABLE "ReceptionistClosure" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReceptionistClosure" FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_receptionist_closure_select ON "ReceptionistClosure" FOR SELECT TO app_rls USING (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_receptionist_closure_insert ON "ReceptionistClosure" FOR INSERT TO app_rls WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_receptionist_closure_update ON "ReceptionistClosure" FOR UPDATE TO app_rls USING (app_rls_tenant_allowed("tenantId")) WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_receptionist_closure_delete ON "ReceptionistClosure" FOR DELETE TO app_rls USING (app_rls_tenant_allowed("tenantId"));
REVOKE ALL ON TABLE "ReceptionistClosure" FROM app_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReceptionistClosure" TO app_rls;

ALTER TABLE "ReceptionistClinicKnowledge" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReceptionistClinicKnowledge" FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_receptionist_clinic_knowledge_select ON "ReceptionistClinicKnowledge" FOR SELECT TO app_rls USING (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_receptionist_clinic_knowledge_insert ON "ReceptionistClinicKnowledge" FOR INSERT TO app_rls WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_receptionist_clinic_knowledge_update ON "ReceptionistClinicKnowledge" FOR UPDATE TO app_rls USING (app_rls_tenant_allowed("tenantId")) WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_receptionist_clinic_knowledge_delete ON "ReceptionistClinicKnowledge" FOR DELETE TO app_rls USING (app_rls_tenant_allowed("tenantId"));
REVOKE ALL ON TABLE "ReceptionistClinicKnowledge" FROM app_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReceptionistClinicKnowledge" TO app_rls;

ALTER TABLE "ReceptionistLocalePack" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReceptionistLocalePack" FORCE ROW LEVEL SECURITY;
CREATE POLICY rls_receptionist_locale_pack_select ON "ReceptionistLocalePack" FOR SELECT TO app_rls USING (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_receptionist_locale_pack_insert ON "ReceptionistLocalePack" FOR INSERT TO app_rls WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_receptionist_locale_pack_update ON "ReceptionistLocalePack" FOR UPDATE TO app_rls USING (app_rls_tenant_allowed("tenantId")) WITH CHECK (app_rls_tenant_allowed("tenantId"));
CREATE POLICY rls_receptionist_locale_pack_delete ON "ReceptionistLocalePack" FOR DELETE TO app_rls USING (app_rls_tenant_allowed("tenantId"));
REVOKE ALL ON TABLE "ReceptionistLocalePack" FROM app_rls;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ReceptionistLocalePack" TO app_rls;
