-- Durable, human-reviewable AI receptionist operational notes.
-- Provider-derived summaries remain separate from explicitly attributed staff
-- corrections, and every state change is paired with a tenant audit event by
-- the application transaction.

CREATE TYPE "ReceptionistCallReviewStatus" AS ENUM (
  'UNREVIEWED',
  'DRAFT',
  'REVIEWED',
  'SIGNED_OFF'
);

ALTER TABLE "ReceptionistCallLog"
  ADD COLUMN "operationalNotes" JSONB,
  ADD COLUMN "unresolvedActionItems" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "reviewStatus" "ReceptionistCallReviewStatus" NOT NULL DEFAULT 'UNREVIEWED',
  ADD COLUMN "reviewRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reviewedByUserId" UUID,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "signedOffByUserId" UUID,
  ADD COLUMN "signedOffAt" TIMESTAMP(3);

ALTER TABLE "ReceptionistCallLog"
  ADD CONSTRAINT "ReceptionistCallLog_reviewer_scope_fkey"
    FOREIGN KEY ("tenantId", "reviewedByUserId")
    REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ReceptionistCallLog_signoff_scope_fkey"
    FOREIGN KEY ("tenantId", "signedOffByUserId")
    REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "ReceptionistCallLog_tenantId_reviewStatus_updatedAt_idx"
  ON "ReceptionistCallLog"("tenantId", "reviewStatus", "updatedAt");
