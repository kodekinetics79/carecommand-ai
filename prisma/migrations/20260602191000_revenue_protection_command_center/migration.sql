-- CreateTable
CREATE TABLE "InsurancePayer" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "tradingPartnerServiceId" TEXT,
    "sourceProvider" TEXT NOT NULL DEFAULT 'stedi',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InsurancePayer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientInsurancePolicy" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "payerId" UUID,
    "planName" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "groupNumber" TEXT,
    "relationship" TEXT,
    "subscriberName" TEXT,
    "payerReference" TEXT,
    "verificationStatus" TEXT NOT NULL DEFAULT 'pending',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatientInsurancePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EligibilityVerification" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "appointmentId" UUID,
    "payerId" UUID,
    "policyId" UUID,
    "providerMode" TEXT NOT NULL,
    "coverageStatus" TEXT NOT NULL,
    "planName" TEXT NOT NULL,
    "payerName" TEXT NOT NULL,
    "copay" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "deductibleRemaining" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "coinsurance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "coverageActive" BOOLEAN NOT NULL DEFAULT false,
    "eligibilityMessage" TEXT NOT NULL,
    "payerReference" TEXT,
    "normalizedResponse" JSONB NOT NULL,
    "rawResponse" JSONB,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EligibilityVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BenefitSnapshot" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "verificationId" UUID NOT NULL,
    "summary" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BenefitSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriorAuthorization" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "patientId" UUID,
    "appointmentId" UUID,
    "payerId" UUID,
    "serviceName" TEXT NOT NULL,
    "authNumber" TEXT,
    "status" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3),
    "notes" TEXT,
    "lastUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriorAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientResponsibilityEstimate" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "appointmentId" UUID,
    "eligibilityVerificationId" UUID,
    "estimatedInsurancePortion" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "estimatedPatientResponsibility" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "recommendedCollectAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientResponsibilityEstimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentProviderConnection" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "providerKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "baseUrl" TEXT,
    "configuration" JSONB,
    "connectedAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentProviderConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "patientId" UUID,
    "appointmentId" UUID,
    "paymentProviderConnectionId" UUID,
    "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "paymentUrl" TEXT,
    "providerReference" TEXT,
    "dueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentTransaction" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "patientId" UUID,
    "appointmentId" UUID,
    "paymentRequestId" UUID,
    "paymentProviderConnectionId" UUID,
    "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "providerReference" TEXT,
    "receivedAt" TIMESTAMP(3),
    "rawResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepositRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID,
    "name" TEXT NOT NULL,
    "ruleType" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "depositRequired" BOOLEAN NOT NULL DEFAULT true,
    "amountType" TEXT NOT NULL,
    "amountValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "refundable" BOOLEAN NOT NULL DEFAULT true,
    "cancellationWindowHours" INTEGER NOT NULL DEFAULT 24,
    "appliesToNewPatients" BOOLEAN NOT NULL DEFAULT false,
    "appliesToHighNoShowRisk" BOOLEAN NOT NULL DEFAULT false,
    "appliesToPremiumServices" BOOLEAN NOT NULL DEFAULT false,
    "appliesToSameDayAppointments" BOOLEAN NOT NULL DEFAULT false,
    "appliesToExemptPatients" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepositRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepositRequirement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "patientId" UUID,
    "appointmentId" UUID,
    "depositRuleId" UUID,
    "paymentRequestId" UUID,
    "status" TEXT NOT NULL,
    "requiredAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "collectedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "waiverReason" TEXT,
    "reason" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3),
    "collectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DepositRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenueProtectionAlert" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID NOT NULL,
    "patientId" UUID,
    "appointmentId" UUID,
    "sourceType" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "evidence" JSONB,
    "estimatedValue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "recommendedAction" TEXT NOT NULL,
    "actionLink" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevenueProtectionAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationRunLog" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "branchId" UUID,
    "provider" TEXT NOT NULL,
    "providerMode" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requestSummary" JSONB,
    "responseSummary" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationRunLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InsurancePayer_tenantId_active_idx" ON "InsurancePayer"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "InsurancePayer_tenantId_name_key" ON "InsurancePayer"("tenantId", "name");

-- CreateIndex
CREATE INDEX "PatientInsurancePolicy_tenantId_branchId_active_idx" ON "PatientInsurancePolicy"("tenantId", "branchId", "active");

-- CreateIndex
CREATE INDEX "PatientInsurancePolicy_tenantId_patientId_active_idx" ON "PatientInsurancePolicy"("tenantId", "patientId", "active");

-- CreateIndex
CREATE INDEX "EligibilityVerification_tenantId_branchId_checkedAt_idx" ON "EligibilityVerification"("tenantId", "branchId", "checkedAt");

-- CreateIndex
CREATE INDEX "EligibilityVerification_tenantId_coverageStatus_checkedAt_idx" ON "EligibilityVerification"("tenantId", "coverageStatus", "checkedAt");

-- CreateIndex
CREATE INDEX "BenefitSnapshot_tenantId_branchId_createdAt_idx" ON "BenefitSnapshot"("tenantId", "branchId", "createdAt");

-- CreateIndex
CREATE INDEX "PriorAuthorization_tenantId_branchId_status_idx" ON "PriorAuthorization"("tenantId", "branchId", "status");

-- CreateIndex
CREATE INDEX "PriorAuthorization_tenantId_dueAt_idx" ON "PriorAuthorization"("tenantId", "dueAt");

-- CreateIndex
CREATE INDEX "PatientResponsibilityEstimate_tenantId_branchId_createdAt_idx" ON "PatientResponsibilityEstimate"("tenantId", "branchId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentProviderConnection_tenantId_status_idx" ON "PaymentProviderConnection"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentProviderConnection_tenantId_providerKey_key" ON "PaymentProviderConnection"("tenantId", "providerKey");

-- CreateIndex
CREATE INDEX "PaymentRequest_tenantId_branchId_status_idx" ON "PaymentRequest"("tenantId", "branchId", "status");

-- CreateIndex
CREATE INDEX "PaymentTransaction_tenantId_branchId_createdAt_idx" ON "PaymentTransaction"("tenantId", "branchId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentTransaction_tenantId_status_createdAt_idx" ON "PaymentTransaction"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "DepositRule_tenantId_active_sortOrder_idx" ON "DepositRule"("tenantId", "active", "sortOrder");

-- CreateIndex
CREATE INDEX "DepositRequirement_tenantId_branchId_status_idx" ON "DepositRequirement"("tenantId", "branchId", "status");

-- CreateIndex
CREATE INDEX "RevenueProtectionAlert_tenantId_branchId_status_idx" ON "RevenueProtectionAlert"("tenantId", "branchId", "status");

-- CreateIndex
CREATE INDEX "RevenueProtectionAlert_tenantId_severity_createdAt_idx" ON "RevenueProtectionAlert"("tenantId", "severity", "createdAt");

-- CreateIndex
CREATE INDEX "IntegrationRunLog_tenantId_provider_operation_createdAt_idx" ON "IntegrationRunLog"("tenantId", "provider", "operation", "createdAt");

-- AddForeignKey
ALTER TABLE "InsurancePayer" ADD CONSTRAINT "InsurancePayer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientInsurancePolicy" ADD CONSTRAINT "PatientInsurancePolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientInsurancePolicy" ADD CONSTRAINT "PatientInsurancePolicy_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientInsurancePolicy" ADD CONSTRAINT "PatientInsurancePolicy_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientInsurancePolicy" ADD CONSTRAINT "PatientInsurancePolicy_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "InsurancePayer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EligibilityVerification" ADD CONSTRAINT "EligibilityVerification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EligibilityVerification" ADD CONSTRAINT "EligibilityVerification_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EligibilityVerification" ADD CONSTRAINT "EligibilityVerification_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EligibilityVerification" ADD CONSTRAINT "EligibilityVerification_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EligibilityVerification" ADD CONSTRAINT "EligibilityVerification_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "InsurancePayer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EligibilityVerification" ADD CONSTRAINT "EligibilityVerification_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "PatientInsurancePolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitSnapshot" ADD CONSTRAINT "BenefitSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitSnapshot" ADD CONSTRAINT "BenefitSnapshot_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitSnapshot" ADD CONSTRAINT "BenefitSnapshot_verificationId_fkey" FOREIGN KEY ("verificationId") REFERENCES "EligibilityVerification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriorAuthorization" ADD CONSTRAINT "PriorAuthorization_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriorAuthorization" ADD CONSTRAINT "PriorAuthorization_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriorAuthorization" ADD CONSTRAINT "PriorAuthorization_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriorAuthorization" ADD CONSTRAINT "PriorAuthorization_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriorAuthorization" ADD CONSTRAINT "PriorAuthorization_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "InsurancePayer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientResponsibilityEstimate" ADD CONSTRAINT "PatientResponsibilityEstimate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientResponsibilityEstimate" ADD CONSTRAINT "PatientResponsibilityEstimate_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientResponsibilityEstimate" ADD CONSTRAINT "PatientResponsibilityEstimate_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientResponsibilityEstimate" ADD CONSTRAINT "PatientResponsibilityEstimate_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientResponsibilityEstimate" ADD CONSTRAINT "PatientResponsibilityEstimate_eligibilityVerificationId_fkey" FOREIGN KEY ("eligibilityVerificationId") REFERENCES "EligibilityVerification"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentProviderConnection" ADD CONSTRAINT "PaymentProviderConnection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_paymentProviderConnectionId_fkey" FOREIGN KEY ("paymentProviderConnectionId") REFERENCES "PaymentProviderConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_paymentRequestId_fkey" FOREIGN KEY ("paymentRequestId") REFERENCES "PaymentRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_paymentProviderConnectionId_fkey" FOREIGN KEY ("paymentProviderConnectionId") REFERENCES "PaymentProviderConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositRule" ADD CONSTRAINT "DepositRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositRule" ADD CONSTRAINT "DepositRule_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositRequirement" ADD CONSTRAINT "DepositRequirement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositRequirement" ADD CONSTRAINT "DepositRequirement_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositRequirement" ADD CONSTRAINT "DepositRequirement_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositRequirement" ADD CONSTRAINT "DepositRequirement_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositRequirement" ADD CONSTRAINT "DepositRequirement_depositRuleId_fkey" FOREIGN KEY ("depositRuleId") REFERENCES "DepositRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepositRequirement" ADD CONSTRAINT "DepositRequirement_paymentRequestId_fkey" FOREIGN KEY ("paymentRequestId") REFERENCES "PaymentRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueProtectionAlert" ADD CONSTRAINT "RevenueProtectionAlert_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueProtectionAlert" ADD CONSTRAINT "RevenueProtectionAlert_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueProtectionAlert" ADD CONSTRAINT "RevenueProtectionAlert_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueProtectionAlert" ADD CONSTRAINT "RevenueProtectionAlert_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationRunLog" ADD CONSTRAINT "IntegrationRunLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationRunLog" ADD CONSTRAINT "IntegrationRunLog_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

