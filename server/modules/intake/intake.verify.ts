/* eslint-disable @typescript-eslint/no-explicit-any -- dev verification script */
/**
 * Patient Intake + Consent Engine verification.
 *   npx tsx server/modules/intake/intake.verify.ts
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';

const { PrismaPg } = await import('@prisma/adapter-pg');
const { PrismaClient } = await import('../../generated/prisma/client');
const { buildApp } = await import('../../app');
const { recomputeEntitlements } = await import('../../lib/entitlements');

const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL }) });
let fail = 0;
const check = (l: string, ok: boolean) => { console.log(`${ok ? '✓' : '✗'} ${l}`); if (!ok) fail++; };

async function setupTenant(tag: string, planKey: string) {
  const id = randomUUID();
  await ownerDb.tenant.create({ data: { id, name: `Intk ${tag}`, slug: `intk-${tag}-${id.slice(0, 8)}` } });
  const plan = await ownerDb.subscriptionPlan.findUnique({ where: { key: planKey } });
  await ownerDb.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id);
  const branch = await ownerDb.branch.create({ data: { tenantId: id, name: `${tag} branch`, location: 'Main St' } });
  const patient = await ownerDb.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Pat', lastName: tag, email: 'pat@secret.test', phone: '+15551239999', lifecycleStage: 'NEW' } });
  const mkUser = (role: string) => ownerDb.user.create({ data: { tenantId: id, role: role as never, active: true, email: `${role}-${id.slice(0, 8)}@intk.test`, displayName: `${tag} ${role}` } });
  return { id, branchId: branch.id, patientId: patient.id, admin: await mkUser('ADMIN'), frontDesk: await mkUser('FRONT_DESK'), provider: await mkUser('PROVIDER') };
}

async function main() {
  const tA = await setupTenant('a', 'enterprise');
  const tB = await setupTenant('b', 'enterprise');

  // Appointment + estimate + deposit so the packet plans the rich section set.
  const startsAt = new Date(Date.now() + 4 * 86400000);
  const appt = await ownerDb.appointment.create({ data: { tenantId: tA.id, branchId: tA.branchId, patientId: tA.patientId, service: 'Consultation', startsAt, endsAt: new Date(startsAt.getTime() + 1800000), channel: 'CALL', value: 300 } });
  await ownerDb.patientResponsibilityEstimate.create({ data: { tenantId: tA.id, branchId: tA.branchId, patientId: tA.patientId, appointmentId: appt.id, estimatedPatientResponsibility: 250, reason: 'estimate' } });
  await ownerDb.depositRequirement.create({ data: { tenantId: tA.id, branchId: tA.branchId, patientId: tA.patientId, appointmentId: appt.id, status: 'required', requiredAmount: 50, reason: 'deposit', mode: 'mock' } });

  const app = await buildApp();
  let ipN = 0;
  const ip = () => `10.99.${(++ipN >> 8) & 255}.${ipN & 255}`;
  const tok = (userId: string, tenantId: string) => app.jwt.sign({ userId, tenantId, role: 'ADMIN', type: 'access' });
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, t: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${t}`, 'x-forwarded-for': ip() }, payload: payload as object });
  const pub = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, payload: payload as object });
  const aTok = tok(tA.admin.id, tA.id);
  const aFront = tok(tA.frontDesk.id, tA.id);
  const aProvider = tok(tA.provider.id, tA.id);
  const bTok = tok(tB.admin.id, tB.id);

  // 1) Packet creation for an appointment.
  const createRes = await call('POST', '/v1/intake/packets', aFront, { appointmentId: appt.id, source: 'staff' });
  const packet = JSON.parse(createRes.body);
  const expectedSections = ['demographics', 'communication_consent', 'insurance', 'insurance_card', 'photo_id', 'payment_policy', 'estimate_acknowledgement', 'pre_visit_checklist'];
  check('1. packet created for appointment + plans data-driven sections', createRes.statusCode === 201 && packet.created === true && expectedSections.every(s => packet.sections.some((x: any) => x.sectionType === s)) && typeof packet.publicToken === 'string');

  // 2) Idempotent — repeated creation reuses the active packet.
  const create2 = JSON.parse((await call('POST', '/v1/intake/packets', aFront, { appointmentId: appt.id })).body);
  check('2. packet creation idempotent (reuses active packet)', create2.created === false && create2.intakePacketId === packet.intakePacketId);

  // 3) Token is hashed + expiring (raw token never stored).
  const dbPacket = await ownerDb.patientIntakePacket.findUnique({ where: { id: packet.intakePacketId } });
  check('3. public token hashed + expiring (raw token not stored)', !!dbPacket?.publicTokenHash && dbPacket.publicTokenHash !== packet.publicToken && !!dbPacket.tokenExpiresAt && dbPacket.tokenExpiresAt.getTime() > Date.now());

  // 4) Public GET exposes no tenant/internal ids.
  const token = packet.publicToken as string;
  const pubViewRes = await pub('GET', `/v1/intake/public/${token}`);
  const pubBody = pubViewRes.body;
  check('4. public GET exposes no tenant/internal IDs', pubViewRes.statusCode === 200 && !pubBody.includes(tA.id) && !pubBody.includes(tA.patientId) && !pubBody.includes(appt.id) && JSON.parse(pubBody).clinicName);

  // 21) A different/invalid token cannot access this packet.
  const wrong = await pub('GET', `/v1/intake/public/${'0'.repeat(48)}`);
  check('21. invalid token cannot access a packet (404)', wrong.statusCode === 404);

  // 7) Demographics stored safely.
  await pub('POST', `/v1/intake/public/${token}/sections`, { sectionType: 'demographics', data: { firstName: 'Jo', lastName: 'Smith', email: 'jo@x.test', phone: '+15550001111' } });
  const demoSection = await ownerDb.patientIntakeSection.findFirst({ where: { packetId: packet.intakePacketId, sectionType: 'demographics' } });
  check('7. demographics section stored + completed', demoSection?.status === 'completed' && (demoSection?.data as any)?.firstName === 'Jo');

  // 8 + 9) Communication consent updates CommunicationConsent (opt-out suppresses).
  await pub('POST', `/v1/intake/public/${token}/sections`, { sectionType: 'communication_consent', data: { sms: false, email: true } });
  const smsConsent = await ownerDb.communicationConsent.findFirst({ where: { tenantId: tA.id, patientId: tA.patientId, channel: 'sms' } });
  const emailConsent = await ownerDb.communicationConsent.findFirst({ where: { tenantId: tA.id, patientId: tA.patientId, channel: 'email' } });
  check('8/9. consent updates CommunicationConsent (sms opted_out, email opted_in)', smsConsent?.status === 'opted_out' && emailConsent?.status === 'opted_in');
  const consentRec = await ownerDb.patientConsentRecord.findFirst({ where: { tenantId: tA.id, packetId: packet.intakePacketId, consentType: 'communication_sms' } });
  check('10. PatientConsentRecord captured (no fabricated opt-in)', consentRec?.status === 'declined');

  // 5) Section submit idempotent.
  await pub('POST', `/v1/intake/public/${token}/sections`, { sectionType: 'communication_consent', data: { sms: false, email: true } });
  const consentCount = await ownerDb.patientConsentRecord.count({ where: { tenantId: tA.id, packetId: packet.intakePacketId, consentType: 'communication_sms' } });
  check('5. section submit idempotent (no duplicate consent record)', consentCount === 1);

  // 11) Insurance update links to PatientInsurancePolicy.
  await pub('POST', `/v1/intake/public/${token}/sections`, { sectionType: 'insurance', data: { payerName: 'Acme', planName: 'PPO', memberId: 'M-77' } });
  const policy = await ownerDb.patientInsurancePolicy.findFirst({ where: { tenantId: tA.id, patientId: tA.patientId, memberId: 'M-77' } });
  check('11. insurance update links to PatientInsurancePolicy (needs_review)', !!policy && policy.verificationStatus === 'needs_review');

  // 12) Insurance card metadata-only.
  await pub('POST', `/v1/intake/public/${token}/sections`, { sectionType: 'insurance_card', data: { hasFront: true, hasBack: true } });
  const doc = await ownerDb.patientIntakeDocument.findFirst({ where: { tenantId: tA.id, packetId: packet.intakePacketId } });
  check('12. insurance card document is metadata_only (no fake upload)', doc?.status === 'metadata_only');

  // 13) Estimate acknowledgement records consent + audit.
  await pub('POST', `/v1/intake/public/${token}/sections`, { sectionType: 'estimate_acknowledgement', data: { accepted: true } });
  const estConsent = await ownerDb.patientConsentRecord.findFirst({ where: { tenantId: tA.id, packetId: packet.intakePacketId, consentType: 'estimate_acknowledgement' } });
  const estAudit = await ownerDb.auditEvent.findFirst({ where: { tenantId: tA.id, action: 'intake.consent.accepted' } });
  check('13. estimate acknowledgement records consent + audit', estConsent?.status === 'accepted' && !!estAudit);

  // 14) Payment policy section does not fake payment.
  await pub('POST', `/v1/intake/public/${token}/sections`, { sectionType: 'payment_policy', data: { accepted: true } });
  const dep = await ownerDb.depositRequirement.findFirst({ where: { tenantId: tA.id, appointmentId: appt.id } });
  check('14. payment policy ack does NOT mark deposit paid', dep?.status === 'required');

  // 6 + 17) Final submit (idempotent) + gaps create signals/recs/task without dupes.
  const submit1 = JSON.parse((await pub('POST', `/v1/intake/public/${token}/submit`)).body);
  const submit2 = JSON.parse((await pub('POST', `/v1/intake/public/${token}/submit`)).body);
  check('6. final submit idempotent', submit1.submitted === true && submit2.alreadySubmitted === true);
  const signals1 = await ownerDb.operationalSignal.count({ where: { tenantId: tA.id, entityType: 'intakePacket', entityId: packet.intakePacketId } });
  const task1 = await ownerDb.staffTask.count({ where: { tenantId: tA.id, metadata: { path: ['intakePacketId'], equals: packet.intakePacketId } } });
  const rec1 = await ownerDb.aIRecommendation.count({ where: { tenantId: tA.id, allowedActionType: 'resolve_intake_gap' } });
  const gapEvent = await ownerDb.businessEvent.findFirst({ where: { tenantId: tA.id, eventType: 'intake.gap_detected', entityId: packet.intakePacketId } });
  check('17. gaps create signal+rec+task+event without duplicates (idempotent submit)', signals1 >= 1 && task1 === 1 && rec1 >= 1 && !!gapEvent);

  // 15) Staff queue shows submitted/needs_review.
  const queue = JSON.parse((await call('GET', '/v1/intake/queue', aTok)).body);
  check('15. staff queue shows submitted/needs_review packet', Array.isArray(queue) && queue.some((p: any) => p.intakePacketId === packet.intakePacketId));

  // 16) Review actions audit.
  const review = await call('PATCH', `/v1/intake/packets/${packet.intakePacketId}/review`, aFront, { action: 'approve' });
  const reviewAudit = await ownerDb.auditEvent.findFirst({ where: { tenantId: tA.id, action: 'intake.packet.reviewed', resourceId: packet.intakePacketId } });
  check('16. review action works + audited', review.statusCode === 200 && JSON.parse(review.body).status === 'approved' && !!reviewAudit);

  // 18) Briefing includes intake gaps.
  const briefing = JSON.parse((await call('GET', '/v1/briefing', aTok)).body);
  check('18. briefing includes real intake gap counts + reports360 hooks', typeof briefing.summary.intakePacketsNeedingReview === 'number' && !!briefing.reports360Hooks && typeof briefing.reports360Hooks.intakePending === 'number');

  // 19) Tenant isolation.
  const crossGet = await call('GET', `/v1/intake/packets/${packet.intakePacketId}`, bTok);
  const bList = JSON.parse((await call('GET', '/v1/intake/packets', bTok)).body);
  check('19. tenant B cannot access tenant A packet', crossGet.statusCode === 404 && !bList.some((p: any) => p.intakePacketId === packet.intakePacketId));

  // 20) RBAC + entitlement.
  const provCreate = await call('POST', '/v1/intake/packets', aProvider, { patientId: tA.patientId });
  await ownerDb.tenantFeatureEntitlement.updateMany({ where: { tenantId: tB.id, featureKey: 'patient_crm' }, data: { enabled: false } });
  const lockedList = await call('GET', '/v1/intake/packets', bTok);
  check('20. PROVIDER cannot create (403) + entitlement gate blocks disabled tenant (403)', provCreate.statusCode === 403 && lockedList.statusCode === 403 && JSON.parse(lockedList.body).feature === 'patient_crm');

  // 22) No PHI-heavy payloads in audit/event logs.
  const events = await ownerDb.businessEvent.findMany({ where: { tenantId: tA.id }, select: { payload: true } });
  const audits = await ownerDb.auditEvent.findMany({ where: { tenantId: tA.id }, select: { metadata: true } });
  const blob = JSON.stringify(events) + JSON.stringify(audits);
  check('22. no PHI-heavy fields in audit/event logs', !blob.includes('jo@x.test') && !blob.includes('+15550001111') && !blob.includes('M-77'));

  // 23) Mobile-ready fields.
  check('23. mobile-ready fields present', ['intakePacketId', 'status', 'readinessScore', 'allowedActions', 'deepLinkTarget', 'setupRequired'].every(k => k in packet));

  await app.close();
  for (const t of [tA, tB]) await ownerDb.tenant.delete({ where: { id: t.id } }).catch(() => {});
  await ownerDb.$disconnect();
  console.log(`\n${fail === 0 ? 'ALL PATIENT INTAKE CHECKS PASSED' : `${fail} FAILED`}`);
  process.exit(fail === 0 ? 0 : 1);
}

await main();
