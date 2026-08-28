import 'dotenv/config';
import { createHash } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../server/generated/prisma/client';

// ===========================================================================
// Module-coverage demo seed.
//
// Fills the modules that had NO demo data for the demo tenant (so they no longer
// render empty / "dead"): the compliance policy/risk/task/evidence/exception
// sub-modules, security incidents + scans + vendor risk, platform integration,
// support-access session, the commercial billing/usage/add-on/request layer,
// outbound calling targets, and consent/intake detail records.
//
// Idempotent: every block is guarded by a count for the demo tenant, so re-runs
// are no-ops. Connects via DATABASE_MIGRATION_URL (owner role) so it can write
// regardless of RLS. Run: npm run db:seed:coverage
// ===========================================================================

const T = process.env.DEV_TENANT_ID ?? '11111111-1111-4111-8111-111111111111';
const connectionString = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL!;
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const days = (n: number) => new Date(Date.now() + n * 86_400_000);

async function ensure(model: string, count: () => Promise<number>, create: () => Promise<void>) {
  const existing = await count();
  if (existing > 0) {
    console.log(`  • ${model}: already has ${existing} row(s) — skip`);
    return;
  }
  await create();
  console.log(`  ✓ ${model}: seeded`);
}

async function main() {
  const tenant = await db.tenant.findUnique({ where: { id: T }, select: { id: true } });
  if (!tenant) throw new Error(`Demo tenant ${T} not found — run \`npm run db:seed\` first.`);

  const owner = await db.user.findFirst({ where: { tenantId: T }, select: { id: true } });
  const ownerId = owner?.id ?? null;
  const control = await db.complianceControl.findFirst({ where: { tenantId: T }, select: { id: true } });
  const packet = await db.patientIntakePacket.findFirst({ where: { tenantId: T }, select: { id: true } });
  const patient = await db.patient.findFirst({ where: { tenantId: T }, select: { id: true } });
  const clinic = await db.receptionistClinic.findFirst({ where: { tenantId: T }, select: { id: true } });
  const agent = await db.receptionistAgent.findFirst({ where: { tenantId: T }, select: { id: true } });
  const subscription = await db.tenantSubscription.findFirst({ where: { tenantId: T }, select: { id: true } });
  const addon = await db.subscriptionAddon.findFirst({ select: { id: true } });

  console.log(`Seeding module coverage for demo tenant ${T}`);

  // ── Compliance: policies ──────────────────────────────────────────────────
  await ensure('compliancePolicy', () => db.compliancePolicy.count({ where: { tenantId: T } }), async () => {
    await db.compliancePolicy.createMany({
      data: [
        { tenantId: T, name: 'HIPAA Privacy Policy', version: '1.0', status: 'approved', approvedByUserId: ownerId, effectiveAt: days(-120), reviewAt: days(245), content: 'Governs use and disclosure of PHI across the practice.' },
        { tenantId: T, name: 'Information Security Policy', version: '2.1', status: 'approved', approvedByUserId: ownerId, effectiveAt: days(-90), reviewAt: days(275), content: 'Access control, encryption, and incident response standards.' },
        { tenantId: T, name: 'Data Retention & Disposal Policy', version: '1.0', status: 'draft', reviewAt: days(30), content: 'Retention schedules for clinical, billing, and audit data.' },
      ],
    });
  });

  // ── Compliance: risks (+ a task on one) ───────────────────────────────────
  await ensure('complianceRisk', () => db.complianceRisk.count({ where: { tenantId: T } }), async () => {
    const phishing = await db.complianceRisk.create({ data: { tenantId: T, title: 'Staff phishing exposure', description: 'Front-desk staff targeted by credential-phishing emails.', categoryKey: 'security', likelihood: 'high', impact: 'high', score: 16, status: 'MITIGATING', ownerUserId: ownerId, mitigationPlan: 'Quarterly security-awareness training + MFA enforcement.' } });
    await db.complianceRisk.create({ data: { tenantId: T, title: 'Vendor without signed BAA', description: 'A sub-processor handling PHI has no executed BAA.', categoryKey: 'vendor', likelihood: 'medium', impact: 'high', score: 12, status: 'OPEN', ownerUserId: ownerId } });
    // a task tied to the risk + an existing control
    await db.complianceTask.create({ data: { tenantId: T, title: 'Enable MFA for all staff accounts', description: 'Roll out TOTP MFA tenant-wide.', riskId: phishing.id, controlId: control?.id ?? null, assigneeUserId: ownerId, dueAt: days(14), status: 'IN_PROGRESS' } });
  });

  // ── Compliance: standalone tasks ──────────────────────────────────────────
  await ensure('complianceTask', () => db.complianceTask.count({ where: { tenantId: T } }), async () => {
    await db.complianceTask.createMany({
      data: [
        { tenantId: T, title: 'Annual access review', description: 'Review all user access grants for least-privilege.', controlId: control?.id ?? null, assigneeUserId: ownerId, dueAt: days(21), status: 'OPEN' },
        { tenantId: T, title: 'Restore-from-backup drill', description: 'Validate backup integrity with a test restore.', assigneeUserId: ownerId, dueAt: days(45), status: 'OPEN' },
      ],
    });
  });

  // ── Compliance: evidence (+ version history + control link) ───────────────
  await ensure('complianceEvidence', () => db.complianceEvidence.count({ where: { tenantId: T } }), async () => {
    const evidence = await db.complianceEvidence.create({ data: { tenantId: T, title: 'SOC 2 Type II report (sub-processor)', description: 'Latest attestation from cloud hosting vendor.', ownerUserId: ownerId, reviewStatus: 'APPROVED', sourceType: 'upload', contentHash: hash('soc2-report-v1'), reviewedAt: days(-15), expiresAt: days(350) } });
    const evidence2 = await db.complianceEvidence.create({ data: { tenantId: T, title: 'Penetration test summary', description: 'Third-party pentest executive summary.', ownerUserId: ownerId, reviewStatus: 'PENDING', sourceType: 'upload', contentHash: hash('pentest-v1'), expiresAt: days(300) } });
    await db.complianceEvidenceVersion.createMany({
      data: [
        { tenantId: T, evidenceId: evidence.id, version: 1, changeType: 'create', contentHash: hash('soc2-report-v1'), rowHash: hash('row-soc2-1'), actorUserId: ownerId },
        { tenantId: T, evidenceId: evidence2.id, version: 1, changeType: 'create', contentHash: hash('pentest-v1'), rowHash: hash('row-pentest-1'), actorUserId: ownerId },
      ],
    });
    if (control) {
      await db.complianceControlEvidence.create({ data: { tenantId: T, controlId: control.id, evidenceId: evidence.id } });
    }
  });

  // ── Compliance: exceptions ────────────────────────────────────────────────
  await ensure('complianceException', () => db.complianceException.count({ where: { tenantId: T } }), async () => {
    await db.complianceException.create({ data: { tenantId: T, controlId: control?.id ?? null, title: 'Legacy device without disk encryption', reason: 'Imaging workstation pending replacement in Q3; compensating network isolation in place.', approvedByUserId: ownerId, expiresAt: days(75), status: 'active' } });
  });

  // ── Security: incidents ───────────────────────────────────────────────────
  await ensure('securityIncident', () => db.securityIncident.count({ where: { tenantId: T } }), async () => {
    await db.securityIncident.createMany({
      data: [
        { tenantId: T, title: 'Suspicious login from new geography', severity: 'medium', status: 'resolved', detectedAt: days(-9), resolvedAt: days(-9), summary: 'MFA challenge blocked an unrecognized login; user confirmed travel.', affectedScope: '1 user account', reportedByUserId: ownerId },
        { tenantId: T, title: 'Lost mobile device reported', severity: 'high', status: 'investigating', detectedAt: days(-2), summary: 'Staff reported a lost phone with the portal app installed; session revoked.', affectedScope: '1 staff device', reportedByUserId: ownerId },
      ],
    });
  });

  // ── Security: scan results ────────────────────────────────────────────────
  await ensure('securityScanResult', () => db.securityScanResult.count({ where: { tenantId: T } }), async () => {
    await db.securityScanResult.createMany({
      data: [
        { tenantId: T, scanner: 'dependency-audit', scanAt: days(-1), status: 'passed', severityCounts: { critical: 0, high: 0, medium: 2, low: 5 } },
        { tenantId: T, scanner: 'secret-scan', scanAt: days(-1), status: 'passed', severityCounts: { critical: 0, high: 0 } },
      ],
    });
  });

  // ── Security: vendor risk register ────────────────────────────────────────
  await ensure('vendorRisk', () => db.vendorRisk.count({ where: { tenantId: T } }), async () => {
    await db.vendorRisk.createMany({
      data: [
        { tenantId: T, vendorName: 'Neon (Postgres hosting)', category: 'infrastructure', dataAccessLevel: 'phi', baaStatus: 'signed', riskTier: 'high', lastReviewedAt: days(-30), nextReviewAt: days(335), status: 'active', notes: 'Primary database host; BAA on file.' },
        { tenantId: T, vendorName: 'Retell (voice AI)', category: 'communications', dataAccessLevel: 'limited_phi', baaStatus: 'pending', riskTier: 'medium', nextReviewAt: days(30), status: 'active', notes: 'Receptionist voice agent; BAA in negotiation.' },
        { tenantId: T, vendorName: 'Stedi (eligibility)', category: 'clearinghouse', dataAccessLevel: 'phi', baaStatus: 'signed', riskTier: 'medium', lastReviewedAt: days(-60), nextReviewAt: days(305), status: 'active' },
      ],
    });
  });

  // ── Platform: integration catalogue (global) ──────────────────────────────
  await ensure('platformIntegration', () => db.platformIntegration.count(), async () => {
    await db.platformIntegration.createMany({
      data: [
        { key: 'sms', status: 'disconnected', setFields: [] },
        { key: 'email', status: 'disconnected', setFields: [] },
      ],
      skipDuplicates: true,
    });
  });

  // ── Platform: a closed support-access session (audit trail) ───────────────
  await ensure('supportAccessSession', () => db.supportAccessSession.count({ where: { tenantId: T } }), async () => {
    await db.supportAccessSession.create({ data: { tenantId: T, operatorEmail: 'support@carecommand.ai', reason: 'Investigated a billing-sync question at tenant request.', startedAt: days(-3), expiresAt: days(-3), endedAt: days(-3) } });
  });

  // ── Commercial: billing snapshot ──────────────────────────────────────────
  await ensure('tenantBilling', () => db.tenantBilling.count({ where: { tenantId: T } }), async () => {
    await db.tenantBilling.create({ data: { tenantId: T, cycle: 'monthly', currency: 'USD', mrr: 499, paymentStatus: 'ok', renewalDate: days(18), provider: 'stripe', externalRef: 'demo_sub_harley' } });
  });

  // ── Commercial: usage limits ──────────────────────────────────────────────
  await ensure('tenantUsageLimit', () => db.tenantUsageLimit.count({ where: { tenantId: T } }), async () => {
    await db.tenantUsageLimit.createMany({
      data: [
        { tenantId: T, key: 'seats', limitValue: 25, used: 11 },
        { tenantId: T, key: 'locations', limitValue: 5, used: 2 },
        { tenantId: T, key: 'sms', limitValue: 5000, used: 1840 },
        { tenantId: T, key: 'ai_credits', limitValue: 10000, used: 3275 },
      ],
    });
  });

  // ── Commercial: an active add-on on the subscription ──────────────────────
  await ensure('tenantSubscriptionAddon', () => db.tenantSubscriptionAddon.count({ where: { tenantId: T } }), async () => {
    if (!subscription || !addon) { console.log('    (no subscription/addon to link — skipped)'); return; }
    await db.tenantSubscriptionAddon.create({ data: { tenantId: T, subscriptionId: subscription.id, addonId: addon.id, active: true, quantity: 1 } });
  });

  // ── Commercial: a pending plan-change request ─────────────────────────────
  await ensure('tenantSubscriptionRequest', () => db.tenantSubscriptionRequest.count({ where: { tenantId: T } }), async () => {
    await db.tenantSubscriptionRequest.create({ data: { tenantId: T, requestType: 'ADDON_CHANGE', status: 'PENDING', requestedAddonKeys: ['extra_location'], requestedByUserId: ownerId, notes: 'Adding a third clinic location next month.' } });
  });

  // ── Receptionist: an outbound campaign with call targets ──────────────────
  await ensure('receptionistOutboundCampaign', () => db.receptionistOutboundCampaign.count({ where: { tenantId: T } }), async () => {
    if (!clinic) { console.log('    (no receptionist clinic — skipped outbound campaign)'); return; }
    const campaign = await db.receptionistOutboundCampaign.create({
      data: {
        tenantId: T, clinicId: clinic.id, agentId: agent?.id ?? null,
        name: 'Recall: overdue annual physicals', script: 'Friendly reminder that the patient is due for their annual physical; offer to book.',
        requiredFields: ['preferredDay'], consentText: 'This call may be recorded for quality.',
        bookingMode: 'APPOINTMENT_REQUEST_ONLY', maxRetryAttempts: 2, status: 'SCHEDULED',
      },
    });
    await db.receptionistCallTarget.createMany({
      data: [
        { tenantId: T, campaignId: campaign.id, patientId: patient?.id ?? null, firstName: 'Eleanor', lastName: 'Hughes', phone: '+15551234001', status: 'PENDING', attempts: 0 },
        { tenantId: T, campaignId: campaign.id, firstName: 'Marcus', lastName: 'Reed', phone: '+15551234002', status: 'COMPLETED', attempts: 1, lastOutcome: 'booked' },
        { tenantId: T, campaignId: campaign.id, firstName: 'Priya', lastName: 'Anand', phone: '+15551234003', status: 'FAILED', attempts: 2, lastOutcome: 'no_answer' },
      ],
    });
  });

  // ── Consent: communication consent ledger ─────────────────────────────────
  await ensure('communicationConsent', () => db.communicationConsent.count({ where: { tenantId: T } }), async () => {
    if (!patient) { console.log('    (no patient — skipped communication consent)'); return; }
    await db.communicationConsent.createMany({
      data: [
        { tenantId: T, patientId: patient.id, channel: 'SMS', status: 'granted', source: 'portal', capturedAt: days(-40) },
        { tenantId: T, patientId: patient.id, channel: 'EMAIL', status: 'granted', source: 'intake', capturedAt: days(-40) },
      ],
    });
  });

  // ── Consent: structured consent records (HIPAA / financial) ───────────────
  await ensure('patientConsentRecord', () => db.patientConsentRecord.count({ where: { tenantId: T } }), async () => {
    if (!patient) { console.log('    (no patient — skipped consent records)'); return; }
    await db.patientConsentRecord.createMany({
      data: [
        { tenantId: T, packetId: packet?.id ?? null, patientId: patient.id, consentType: 'hipaa_acknowledgment', status: 'accepted', version: 'v1', source: 'intake', acceptedAt: days(-40), ipAddressHash: hash('203.0.113.10'), userAgentHash: hash('demo-ua') },
        { tenantId: T, packetId: packet?.id ?? null, patientId: patient.id, consentType: 'financial_responsibility', status: 'accepted', version: 'v1', source: 'intake', acceptedAt: days(-40) },
      ],
    });
  });

  // ── Intake: packet sections + a metadata-only document ────────────────────
  await ensure('patientIntakeSection', () => db.patientIntakeSection.count({ where: { tenantId: T } }), async () => {
    if (!packet) { console.log('    (no intake packet — skipped sections)'); return; }
    await db.patientIntakeSection.createMany({
      data: [
        { tenantId: T, packetId: packet.id, sectionType: 'demographics', status: 'completed', completedAt: days(-5), data: { confirmed: true } },
        { tenantId: T, packetId: packet.id, sectionType: 'medical_history', status: 'completed', completedAt: days(-5), data: { conditions: ['hypertension'] } },
        { tenantId: T, packetId: packet.id, sectionType: 'insurance', status: 'pending' },
      ],
      skipDuplicates: true,
    });
  });

  await ensure('patientIntakeDocument', () => db.patientIntakeDocument.count({ where: { tenantId: T } }), async () => {
    if (!packet) { console.log('    (no intake packet — skipped documents)'); return; }
    await db.patientIntakeDocument.create({ data: { tenantId: T, packetId: packet.id, documentType: 'insurance_card_front', fileName: 'insurance-front.jpg', mimeType: 'image/jpeg', fileSize: 184320, status: 'metadata_only', fileHash: hash('insurance-front-demo') } });
  });

  console.log('Module-coverage seed complete.');
  await db.$disconnect();
}

main().catch(async err => { console.error(err); await db.$disconnect(); process.exit(1); });
