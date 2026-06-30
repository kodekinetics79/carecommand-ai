import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

// ===========================================================================
// Per-module demo-data coverage verifier.
//
// A module whose backing table has no rows for the demo tenant renders empty in
// the UI — a "dead module". This script counts every model for the demo tenant
// (tenant-scoped models filtered by tenantId; platform tables counted globally)
// and reports which modules are empty. It connects via DATABASE_MIGRATION_URL
// (the RLS-bypassing owner role) so row-level security never masks the counts.
//
// Run: npm run verify:modules     (exits 1 if any non-ephemeral module is empty)
// ===========================================================================

const DEMO_TENANT_ID = process.env.DEV_TENANT_ID ?? '11111111-1111-4111-8111-111111111111';
const connectionString = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL!;
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

// Models populated only by runtime activity (events, tokens, caches, derived
// rows). Empty here is expected, not a dead module — excluded from the gate.
const EPHEMERAL = new Set<string>([
  'auditEvent', 'platformAuditEvent', 'businessEvent', 'operationalSignal',
  'aIUsageLog', 'aIEvaluation', 'tenantAiUsage', 'tenantFeatureEntitlement',
  'idempotencyKey', 'passwordResetToken', 'patientPortalToken', 'translationCache',
  'notificationEvent', 'campaignSuppression', 'campaignDelivery',
]);

// tenant-scoped models (filter by tenantId)
const TENANT_SCOPED = ['user','branch','patient','appointment','consentEvent','autopilotPlaybook','autopilotApproval','lead','campaign','review','inventoryItem','partnerReport','integration','providerProfile','staffProfile','staffTask','revenueSnapshot','conversation','revenueLeak','opportunity','insurancePayer','patientInsurancePolicy','eligibilityVerification','benefitSnapshot','priorAuthorization','patientResponsibilityEstimate','paymentProviderConnection','paymentRequest','paymentTransaction','depositRule','depositRequirement','revenueProtectionAlert','integrationRunLog','competitor','competitorReviewInsight','reputationCase','reviewRequest','notificationTemplate','aiGuardrail','customerPreference','roleDefinition','userClinicAccess','receptionistClinic','receptionistLocation','receptionistAgent','receptionistCampaign','receptionistIntakeField','receptionistAppointmentRequest','receptionistCallLog','receptionistOptOut','complianceFramework','complianceControl','complianceEvidence','complianceControlEvidence','complianceEvidenceVersion','compliancePolicy','complianceRisk','complianceTask','complianceException','vendorRisk','securityIncident','accessReview','dataRetentionPolicy','backupVerification','securityScanResult','tenantSecurityPolicy','tenantSubscription','tenantSubscriptionAddon','tenantSubscriptionRequest','receptionistOutboundCampaign','receptionistCallTarget','appointmentRequest','serviceCatalogItem','aIRecommendation','communicationConsent','patientIntakePacket','patientIntakeSection','patientIntakeDocument','patientConsentRecord','tenantBilling','tenantUsageLimit','supportAccessSession','automationRule','patientPortalAccount','device','deviceEvent','monitoringRule','deviceReading','readingAlert','morningBriefingSignal','insuranceProvider','deviceProvider','patientDeviceEnrollment','deviceProviderSyncLog','patientConsent','rPMBillingReadiness','portalAccessRequest','morningBriefingSignal'] as const;

const GLOBAL = ['tenant','subscriptionPlan','subscriptionPlanFeature','subscriptionAddon','platformUser','platformIntegration','platformConfig','platformAnnouncement'] as const;

type Counter = { count: (args?: { where?: { tenantId: string } }) => Promise<number> };
const model = (name: string) => (db as unknown as Record<string, Counter>)[name];

async function main() {
  const empties: string[] = [];
  const ephemeralEmpties: string[] = [];
  let covered = 0;

  for (const name of new Set(TENANT_SCOPED)) {
    const n = await model(name).count({ where: { tenantId: DEMO_TENANT_ID } });
    if (n > 0) covered++;
    else (EPHEMERAL.has(name) ? ephemeralEmpties : empties).push(name);
  }
  for (const name of GLOBAL) {
    const n = await model(name).count();
    if (n > 0) covered++;
    else (EPHEMERAL.has(name) ? ephemeralEmpties : empties).push(name);
  }

  const total = new Set([...TENANT_SCOPED, ...GLOBAL]).size;
  console.log(`\nModule coverage for demo tenant ${DEMO_TENANT_ID}`);
  console.log(`  total models: ${total} · covered: ${covered} · empty(ephemeral, ok): ${ephemeralEmpties.length} · empty(modules): ${empties.length}`);
  if (ephemeralEmpties.length) console.log(`  ephemeral-empty (expected): ${ephemeralEmpties.sort().join(', ')}`);
  if (empties.length) {
    console.log(`\n  ❌ DEAD MODULES (no demo data): ${empties.length}`);
    for (const e of empties.sort()) console.log(`     - ${e}`);
  } else {
    console.log('\n  ✅ every non-ephemeral module has demo data for the demo tenant.');
  }
  await db.$disconnect();
  process.exit(empties.length > 0 ? 1 : 0);
}

main().catch(async err => { console.error(err); await db.$disconnect(); process.exit(2); });
