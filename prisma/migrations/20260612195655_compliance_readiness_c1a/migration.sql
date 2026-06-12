-- CreateEnum
CREATE TYPE "ComplianceControlStatus" AS ENUM ('IMPLEMENTED', 'IN_PROGRESS', 'NOT_IMPLEMENTED', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "ComplianceReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ComplianceRiskStatus" AS ENUM ('OPEN', 'MITIGATING', 'ACCEPTED', 'CLOSED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "UserRole" ADD VALUE 'COMPLIANCE_OFFICER';
ALTER TYPE "UserRole" ADD VALUE 'AUDITOR';

-- CreateTable
CREATE TABLE "ComplianceFramework" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceFramework_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceControl" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "frameworkId" UUID NOT NULL,
    "categoryKey" TEXT NOT NULL,
    "controlKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "ComplianceControlStatus" NOT NULL DEFAULT 'NOT_IMPLEMENTED',
    "ownerUserId" UUID,
    "lastReviewedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceControl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceEvidence" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "ownerUserId" UUID,
    "reviewStatus" "ComplianceReviewStatus" NOT NULL DEFAULT 'PENDING',
    "sourceType" TEXT NOT NULL DEFAULT 'manual',
    "externalUrl" TEXT,
    "contentHash" TEXT,
    "auditorNotes" TEXT,
    "expiresAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceControlEvidence" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "controlId" UUID NOT NULL,
    "evidenceId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceControlEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceEvidenceVersion" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "evidenceId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "changeType" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "prevHash" TEXT,
    "rowHash" TEXT NOT NULL,
    "actorUserId" UUID,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceEvidenceVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompliancePolicy" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1.0',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "externalUrl" TEXT,
    "content" TEXT,
    "approvedByUserId" UUID,
    "effectiveAt" TIMESTAMP(3),
    "reviewAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompliancePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceRisk" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "categoryKey" TEXT NOT NULL,
    "likelihood" TEXT NOT NULL DEFAULT 'medium',
    "impact" TEXT NOT NULL DEFAULT 'medium',
    "score" INTEGER NOT NULL DEFAULT 0,
    "status" "ComplianceRiskStatus" NOT NULL DEFAULT 'OPEN',
    "ownerUserId" UUID,
    "mitigationPlan" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceRisk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceTask" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "controlId" UUID,
    "riskId" UUID,
    "assigneeUserId" UUID,
    "dueAt" TIMESTAMP(3),
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceException" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "controlId" UUID,
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "approvedByUserId" UUID,
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorRisk" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "vendorName" TEXT NOT NULL,
    "category" TEXT,
    "dataAccessLevel" TEXT,
    "baaStatus" TEXT NOT NULL DEFAULT 'unknown',
    "riskTier" TEXT NOT NULL DEFAULT 'medium',
    "lastReviewedAt" TIMESTAMP(3),
    "nextReviewAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'active',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorRisk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityIncident" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'low',
    "status" TEXT NOT NULL DEFAULT 'open',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "summary" TEXT,
    "affectedScope" TEXT,
    "timeline" JSONB,
    "reportedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessReview" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "reviewerUserId" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "findings" JSONB,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataRetentionPolicy" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "dataClass" TEXT NOT NULL,
    "retentionDays" INTEGER NOT NULL,
    "legalBasis" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataRetentionPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupVerification" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL DEFAULT 'database',
    "status" TEXT NOT NULL DEFAULT 'unverified',
    "location" TEXT,
    "verifiedByUserId" UUID,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackupVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityScanResult" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "scanner" TEXT NOT NULL,
    "scanAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "severityCounts" JSONB,
    "reportUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityScanResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantSecurityPolicy" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "requireMfa" BOOLEAN NOT NULL DEFAULT false,
    "passwordExpiryDays" INTEGER,
    "sessionTimeoutMinutes" INTEGER NOT NULL DEFAULT 15,
    "failedLoginLockout" BOOLEAN NOT NULL DEFAULT false,
    "allowedIpRanges" TEXT[],
    "dataRetentionDays" INTEGER NOT NULL DEFAULT 2555,
    "backupFrequency" TEXT NOT NULL DEFAULT 'daily',
    "evidenceReviewFrequency" TEXT NOT NULL DEFAULT 'quarterly',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantSecurityPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComplianceFramework_tenantId_idx" ON "ComplianceFramework"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceFramework_tenantId_key_key" ON "ComplianceFramework"("tenantId", "key");

-- CreateIndex
CREATE INDEX "ComplianceControl_tenantId_status_idx" ON "ComplianceControl"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ComplianceControl_tenantId_categoryKey_idx" ON "ComplianceControl"("tenantId", "categoryKey");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceControl_tenantId_frameworkId_controlKey_key" ON "ComplianceControl"("tenantId", "frameworkId", "controlKey");

-- CreateIndex
CREATE INDEX "ComplianceEvidence_tenantId_reviewStatus_idx" ON "ComplianceEvidence"("tenantId", "reviewStatus");

-- CreateIndex
CREATE INDEX "ComplianceEvidence_tenantId_expiresAt_idx" ON "ComplianceEvidence"("tenantId", "expiresAt");

-- CreateIndex
CREATE INDEX "ComplianceEvidence_tenantId_deletedAt_idx" ON "ComplianceEvidence"("tenantId", "deletedAt");

-- CreateIndex
CREATE INDEX "ComplianceControlEvidence_tenantId_idx" ON "ComplianceControlEvidence"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceControlEvidence_controlId_evidenceId_key" ON "ComplianceControlEvidence"("controlId", "evidenceId");

-- CreateIndex
CREATE INDEX "ComplianceEvidenceVersion_tenantId_evidenceId_idx" ON "ComplianceEvidenceVersion"("tenantId", "evidenceId");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceEvidenceVersion_evidenceId_version_key" ON "ComplianceEvidenceVersion"("evidenceId", "version");

-- CreateIndex
CREATE INDEX "CompliancePolicy_tenantId_status_idx" ON "CompliancePolicy"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CompliancePolicy_tenantId_name_version_key" ON "CompliancePolicy"("tenantId", "name", "version");

-- CreateIndex
CREATE INDEX "ComplianceRisk_tenantId_status_idx" ON "ComplianceRisk"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ComplianceTask_tenantId_status_idx" ON "ComplianceTask"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ComplianceException_tenantId_status_idx" ON "ComplianceException"("tenantId", "status");

-- CreateIndex
CREATE INDEX "VendorRisk_tenantId_status_idx" ON "VendorRisk"("tenantId", "status");

-- CreateIndex
CREATE INDEX "SecurityIncident_tenantId_status_detectedAt_idx" ON "SecurityIncident"("tenantId", "status", "detectedAt");

-- CreateIndex
CREATE INDEX "AccessReview_tenantId_status_idx" ON "AccessReview"("tenantId", "status");

-- CreateIndex
CREATE INDEX "DataRetentionPolicy_tenantId_idx" ON "DataRetentionPolicy"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "DataRetentionPolicy_tenantId_dataClass_key" ON "DataRetentionPolicy"("tenantId", "dataClass");

-- CreateIndex
CREATE INDEX "BackupVerification_tenantId_runAt_idx" ON "BackupVerification"("tenantId", "runAt");

-- CreateIndex
CREATE INDEX "SecurityScanResult_tenantId_scanAt_idx" ON "SecurityScanResult"("tenantId", "scanAt");

-- CreateIndex
CREATE UNIQUE INDEX "TenantSecurityPolicy_tenantId_key" ON "TenantSecurityPolicy"("tenantId");

-- AddForeignKey
ALTER TABLE "ComplianceFramework" ADD CONSTRAINT "ComplianceFramework_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceControl" ADD CONSTRAINT "ComplianceControl_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceControl" ADD CONSTRAINT "ComplianceControl_frameworkId_fkey" FOREIGN KEY ("frameworkId") REFERENCES "ComplianceFramework"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceEvidence" ADD CONSTRAINT "ComplianceEvidence_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceControlEvidence" ADD CONSTRAINT "ComplianceControlEvidence_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceControlEvidence" ADD CONSTRAINT "ComplianceControlEvidence_controlId_fkey" FOREIGN KEY ("controlId") REFERENCES "ComplianceControl"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceControlEvidence" ADD CONSTRAINT "ComplianceControlEvidence_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "ComplianceEvidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceEvidenceVersion" ADD CONSTRAINT "ComplianceEvidenceVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceEvidenceVersion" ADD CONSTRAINT "ComplianceEvidenceVersion_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "ComplianceEvidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompliancePolicy" ADD CONSTRAINT "CompliancePolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceRisk" ADD CONSTRAINT "ComplianceRisk_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceTask" ADD CONSTRAINT "ComplianceTask_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceTask" ADD CONSTRAINT "ComplianceTask_controlId_fkey" FOREIGN KEY ("controlId") REFERENCES "ComplianceControl"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceTask" ADD CONSTRAINT "ComplianceTask_riskId_fkey" FOREIGN KEY ("riskId") REFERENCES "ComplianceRisk"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceException" ADD CONSTRAINT "ComplianceException_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceException" ADD CONSTRAINT "ComplianceException_controlId_fkey" FOREIGN KEY ("controlId") REFERENCES "ComplianceControl"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorRisk" ADD CONSTRAINT "VendorRisk_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityIncident" ADD CONSTRAINT "SecurityIncident_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessReview" ADD CONSTRAINT "AccessReview_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataRetentionPolicy" ADD CONSTRAINT "DataRetentionPolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupVerification" ADD CONSTRAINT "BackupVerification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityScanResult" ADD CONSTRAINT "SecurityScanResult_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantSecurityPolicy" ADD CONSTRAINT "TenantSecurityPolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
