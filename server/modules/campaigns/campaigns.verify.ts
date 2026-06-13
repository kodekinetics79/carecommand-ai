/* eslint-disable @typescript-eslint/no-explicit-any -- dev verification script */
/**
 * CRM Campaign / Reactivation engine verification.
 *   npx tsx server/modules/campaigns/campaigns.verify.ts
 *
 * Proves: insurance carry-forward (eligibility by appointmentId), model reuse,
 * consent/suppression gating, campaign CRUD, deterministic audiences, provider
 * setup_required vs dev-mock sent, delivery idempotency/rerun, approval gating,
 * RBAC, tenant isolation, intelligence connection, briefing opportunities, audit,
 * mobile-ready fields, no-PHI payloads.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';

const { PrismaPg } = await import('@prisma/adapter-pg');
const { PrismaClient } = await import('../../generated/prisma/client');
const { buildApp } = await import('../../app');
const { env } = await import('../../config/env');
const { recomputeEntitlements } = await import('../../lib/entitlements');

const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL }) });
let fail = 0;
const check = (l: string, ok: boolean) => { console.log(`${ok ? '✓' : '✗'} ${l}`); if (!ok) fail++; };

async function setupTenant(tag: string, planKey: string) {
  const id = randomUUID();
  await ownerDb.tenant.create({ data: { id, name: `Crm ${tag}`, slug: `crm-${tag}-${id.slice(0, 8)}` } });
  const plan = await ownerDb.subscriptionPlan.findUnique({ where: { key: planKey } });
  await ownerDb.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id);
  const branch = await ownerDb.branch.create({ data: { tenantId: id, name: `${tag} branch`, location: 'Main St' } });
  const mkUser = (role: string) => ownerDb.user.create({ data: { tenantId: id, role: role as never, active: true, email: `${role}-${id.slice(0, 8)}@crm.test`, displayName: `${tag} ${role}` } });
  return { id, branchId: branch.id, admin: await mkUser('ADMIN'), frontDesk: await mkUser('FRONT_DESK'), billing: await mkUser('BILLING'), provider: await mkUser('PROVIDER') };
}

async function main() {
  const tA = await setupTenant('a', 'enterprise');
  const tB = await setupTenant('b', 'enterprise');
  const tLock = await setupTenant('lock', 'starter'); // no campaign_automation

  // Inactive-patient audience fixtures: eligible / opted-out / no-contact.
  const old = new Date(Date.now() - 200 * 86400000);
  const pElig = await ownerDb.patient.create({ data: { tenantId: tA.id, branchId: tA.branchId, firstName: 'Ann', lastName: 'Elig', phone: '+15551110001', lastVisitAt: old, lifecycleStage: 'AT_RISK' } });
  const pOpt = await ownerDb.patient.create({ data: { tenantId: tA.id, branchId: tA.branchId, firstName: 'Ben', lastName: 'Opt', phone: '+15551110002', lastVisitAt: old, lifecycleStage: 'AT_RISK' } });
  await ownerDb.patient.create({ data: { tenantId: tA.id, branchId: tA.branchId, firstName: 'Cara', lastName: 'NoPhone', lastVisitAt: old, lifecycleStage: 'AT_RISK' } });
  await ownerDb.communicationConsent.create({ data: { tenantId: tA.id, patientId: pOpt.id, channel: 'sms', status: 'opted_out', source: 'patient' } });

  const app = await buildApp();
  let ipN = 0;
  const ip = () => `10.88.${(++ipN >> 8) & 255}.${ipN & 255}`;
  const tok = (userId: string, tenantId: string) => app.jwt.sign({ userId, tenantId, role: 'ADMIN', type: 'access' });
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, t: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${t}`, 'x-forwarded-for': ip() }, payload: payload as object });
  const aTok = tok(tA.admin.id, tA.id);
  const aBilling = tok(tA.billing.id, tA.id);
  const aProvider = tok(tA.provider.id, tA.id);
  const bTok = tok(tB.admin.id, tB.id);
  const lockTok = tok(tLock.admin.id, tLock.id);

  // 1) Insurance carry-forward: eligibility check by appointmentId alone works.
  const patEl = await ownerDb.patient.create({ data: { tenantId: tA.id, branchId: tA.branchId, firstName: 'Eli', lastName: 'Gib', phone: '+15551119999', lifecycleStage: 'NEW' } });
  const startsAt = new Date(Date.now() + 4 * 86400000);
  const apptEl = JSON.parse((await call('POST', '/v1/appointments', aTok, { branchId: tA.branchId, patientId: patEl.id, service: 'Cleaning', startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 1800000).toISOString(), channel: 'CALL', value: 150 })).body);
  const eligRes = JSON.parse((await call('POST', '/v1/revenue-protection/eligibility/check', aTok, { appointmentId: apptEl.id })).body);
  const verif = eligRes.verificationId ? await ownerDb.eligibilityVerification.findUnique({ where: { id: eligRes.verificationId } }) : null;
  check('1. insurance carry-forward: eligibility by appointmentId derives patient', !!eligRes.verificationId && verif?.patientId === patEl.id);

  // 2) Model reuse: Campaign extended + 3 new tables, no duplicate campaign model.
  const tables = (await ownerDb.$queryRaw<Array<{ relname: string }>>`SELECT relname FROM pg_class WHERE relkind='r' AND relname IN ('Campaign','CommunicationConsent','CampaignSuppression','CampaignDelivery')`).map(r => r.relname);
  check('2. existing Campaign reused + 3 new CRM tables present', tables.length === 4);

  // 3) feature-locked tenant → 403.
  const lockList = await call('GET', '/v1/crm/campaigns', lockTok);
  check('3. campaign_automation feature gate (403)', lockList.statusCode === 403 && JSON.parse(lockList.body).feature === 'campaign_automation');

  // 4) Campaign creation.
  const created = await call('POST', '/v1/crm/campaigns', aTok, { name: 'Reactivation', campaignType: 'inactive_patient_reactivation', audienceType: 'inactive_patients', channel: 'sms' });
  const campaign = JSON.parse(created.body);
  check('4. campaign creation works (201) + mobile-ready fields', created.statusCode === 201 && campaign.requiresApproval === true && Array.isArray(campaign.allowedActions) && campaign.deepLinkTarget === `campaign/${campaign.id}`);

  // 5) Audience builder deterministic (1 eligible, 1 suppressed, 1 no-contact).
  const preview = JSON.parse((await call('GET', '/v1/crm/audiences/inactive_patients/preview?channel=sms', aTok)).body);
  check('5. audience deterministic (eligible/suppressed/missingContact)', preview.total >= 3 && preview.eligible >= 1 && preview.suppressed >= 1 && preview.missingContact >= 1);

  // 12) Draft requires approval; launch before approval blocked.
  const draft = JSON.parse((await call('POST', `/v1/crm/campaigns/${campaign.id}/draft`, aTok)).body);
  const earlyLaunch = await call('POST', `/v1/crm/campaigns/${campaign.id}/launch`, aTok);
  check('12. rule-based draft requires approval; launch blocked pre-approval', draft.draftSource === 'rule_based' && draft.requiresApproval === true && earlyLaunch.statusCode === 409);

  await call('POST', `/v1/crm/campaigns/${campaign.id}/approve`, aTok);

  // 6) Provider missing → setup_required, nothing sent, stays DRAFT.
  const savedSid = env.TWILIO_ACCOUNT_SID, savedTok = env.TWILIO_AUTH_TOKEN, savedFrom = env.TWILIO_FROM_NUMBER;
  (env as any).TWILIO_ACCOUNT_SID = undefined; (env as any).TWILIO_AUTH_TOKEN = undefined; (env as any).TWILIO_FROM_NUMBER = undefined;
  const setupLaunch = JSON.parse((await call('POST', `/v1/crm/campaigns/${campaign.id}/launch`, aTok)).body);
  check('6. provider missing → setup_required, nothing sent', setupLaunch.setupRequired === true && setupLaunch.summary.sent === 0 && setupLaunch.summary.setupRequired >= 1);

  // 7) Mock provider (dev) → sent.
  (env as any).TWILIO_ACCOUNT_SID = 'mock_sid'; (env as any).TWILIO_AUTH_TOKEN = 'mock_tok'; (env as any).TWILIO_FROM_NUMBER = '+15550000000';
  const sentLaunch = JSON.parse((await call('POST', `/v1/crm/campaigns/${campaign.id}/launch`, aTok)).body);
  check('7. dev mock provider marks sent (eligible) + suppressed/skipped truthful', sentLaunch.summary.sent >= 1 && sentLaunch.summary.suppressed >= 1 && sentLaunch.summary.skipped >= 1);

  // 3b) Consent opt-out actually suppressed the opted-out recipient's delivery.
  const optDelivery = await ownerDb.campaignDelivery.findFirst({ where: { tenantId: tA.id, campaignId: campaign.id, patientId: pOpt.id } });
  check('3. consent opt-out suppresses delivery', optDelivery?.status === 'suppressed');

  // 8 + 9 + 11) Idempotent: rerun does not duplicate rows or resend sent ones.
  const countBefore = await ownerDb.campaignDelivery.count({ where: { tenantId: tA.id, campaignId: campaign.id } });
  const sentRow = await ownerDb.campaignDelivery.findFirst({ where: { tenantId: tA.id, campaignId: campaign.id, status: 'sent' } });
  const rerun = JSON.parse((await call('POST', `/v1/crm/campaigns/${campaign.id}/launch`, aTok)).body);
  const countAfter = await ownerDb.campaignDelivery.count({ where: { tenantId: tA.id, campaignId: campaign.id } });
  const sentRowAfter = await ownerDb.campaignDelivery.findUnique({ where: { id: sentRow!.id } });
  check('8/9/11. rerun idempotent: no duplicate rows, no resend of sent recipients', countBefore === countAfter && rerun.summary.sent >= 1 && sentRowAfter?.sentAt?.getTime() === sentRow?.sentAt?.getTime());

  // 10) Re-processing (duplicate trigger) does not flip a sent delivery's state.
  check('10. duplicate launch does not regress sent delivery state', sentRowAfter?.status === 'sent');

  // 13) Unauthorized role (PROVIDER) cannot launch.
  const provLaunch = await call('POST', `/v1/crm/campaigns/${campaign.id}/launch`, aProvider);
  check('13. PROVIDER cannot launch campaign (403)', provLaunch.statusCode === 403);

  // 14) BILLING can manage a payment follow-up campaign.
  await ownerDb.depositRequirement.create({ data: { tenantId: tA.id, branchId: tA.branchId, patientId: pElig.id, status: 'required', requiredAmount: 50, reason: 'deposit', mode: 'mock' } });
  const billCamp = JSON.parse((await call('POST', '/v1/crm/campaigns', aBilling, { name: 'Deposit followup', campaignType: 'unpaid_deposit_followup', audienceType: 'unpaid_deposit_followup', channel: 'sms' })).body);
  await call('POST', `/v1/crm/campaigns/${billCamp.id}/approve`, aBilling);
  const billLaunch = await call('POST', `/v1/crm/campaigns/${billCamp.id}/launch`, aBilling);
  check('14. BILLING manages payment follow-up campaign', billLaunch.statusCode === 200 && JSON.parse(billLaunch.body).summary.sent >= 1);

  // Fixtures for failed-payment audience + empty-slot opportunity.
  await ownerDb.paymentRequest.create({ data: { tenantId: tA.id, branchId: tA.branchId, patientId: pOpt.id, amount: 75, status: 'failed', reason: 'deposit', mode: 'mock' } });
  await ownerDb.appointmentRequest.create({ data: { tenantId: tA.id, branchId: tA.branchId, status: 'PENDING_REVIEW', source: 'ai_receptionist', collectedPhone: '+15551110009' } });

  // Failed-payment audience is deterministic.
  const failPreview = JSON.parse((await call('GET', '/v1/crm/audiences/failed_payment_recovery/preview?channel=sms', aTok)).body);
  check('4b. failed_payment_recovery audience returns real candidates', failPreview.total >= 1);

  // 16) Opportunity scan connects audiences → signal + recommendation + event.
  const scan = JSON.parse((await call('POST', '/v1/crm/opportunities/scan', aTok)).body);
  const oppSignal = await ownerDb.operationalSignal.findFirst({ where: { tenantId: tA.id, signalType: 'inactive_patient_opportunity' } });
  const oppRec = await ownerDb.aIRecommendation.findFirst({ where: { tenantId: tA.id, recommendationType: 'reactivate_inactive_patient' } });
  const oppEvent = await ownerDb.businessEvent.findFirst({ where: { tenantId: tA.id, eventType: 'patient.reactivation.recommended' } });
  check('16. opportunities connect to OperationalSignal + AIRecommendation + event', scan.requiresHumanReview === true && !!oppSignal && !!oppRec && oppRec?.requiresHumanReview === true && !!oppEvent);

  // 16b) Failed-payment + empty-slot opportunities also created.
  const failSignal = await ownerDb.operationalSignal.findFirst({ where: { tenantId: tA.id, signalType: 'failed_payment_followup_needed' } });
  const slotSignal = await ownerDb.operationalSignal.findFirst({ where: { tenantId: tA.id, signalType: 'empty_slot_fill_opportunity' } });
  const slotRec = await ownerDb.aIRecommendation.findFirst({ where: { tenantId: tA.id, recommendationType: 'fill_open_slot' } });
  check('16b. failed-payment + empty-slot opportunities created', !!failSignal && !!slotSignal && !!slotRec);

  // 17) Briefing surfaces real campaign opportunities.
  const briefing = JSON.parse((await call('GET', '/v1/briefing', aTok)).body);
  check('17. briefing includes real campaign opportunities', briefing.summary.inactivePatients >= 1 && typeof briefing.summary.campaignDeliveryFailures === 'number' && typeof briefing.summary.pendingCampaignApprovals === 'number');

  // 18) No PHI-heavy fields in campaign business-event payloads.
  const launchEvent = await ownerDb.businessEvent.findFirst({ where: { tenantId: tA.id, eventType: 'campaign.launched' } });
  const phi = ['phone', 'email', 'firstName', 'lastName', '+1555'].some(k => JSON.stringify(launchEvent?.payload ?? {}).includes(k));
  check('18. no PHI-heavy fields in campaign event payloads', !phi);

  // 15) Tenant isolation.
  const crossGet = await call('GET', `/v1/crm/campaigns/${campaign.id}`, bTok);
  const bList = JSON.parse((await call('GET', '/v1/crm/campaigns', bTok)).body);
  check('15. tenant B cannot access tenant A campaigns', crossGet.statusCode === 404 && !bList.some((c: any) => c.id === campaign.id));

  // 19) Audit rows for sensitive campaign actions.
  const actions = new Set((await ownerDb.auditEvent.findMany({ where: { tenantId: tA.id }, select: { action: true } })).map(a => a.action));
  check('19. audit rows for campaign.created/approved/launched + consent/suppression', ['campaign.created', 'campaign.approved', 'campaign.launched'].every(a => actions.has(a)));

  // 20) Mobile-ready fields on delivery log.
  const deliveries = JSON.parse((await call('GET', `/v1/crm/campaigns/${campaign.id}/deliveries`, aTok)).body);
  const d0 = deliveries[0];
  check('20. mobile-ready fields on deliveries', !!d0 && 'deliveryId' in d0 && 'status' in d0 && 'channel' in d0 && 'destinationMasked' in d0 && 'deepLinkTarget' in d0);

  // Consent + suppression endpoints audited.
  await call('POST', '/v1/crm/consent', aTok, { patientId: pElig.id, channel: 'email', status: 'opted_out' });
  await call('POST', '/v1/crm/suppressions', aTok, { patientId: pElig.id, channel: 'voice', reason: 'requested' });
  const actions2 = new Set((await ownerDb.auditEvent.findMany({ where: { tenantId: tA.id }, select: { action: true } })).map(a => a.action));
  check('19b. consent.updated + suppression.created audited', actions2.has('consent.updated') && actions2.has('suppression.created'));

  (env as any).TWILIO_ACCOUNT_SID = savedSid; (env as any).TWILIO_AUTH_TOKEN = savedTok; (env as any).TWILIO_FROM_NUMBER = savedFrom;

  await app.close();
  for (const t of [tA, tB, tLock]) await ownerDb.tenant.delete({ where: { id: t.id } }).catch(() => {});
  await ownerDb.$disconnect();
  console.log(`\n${fail === 0 ? 'ALL CRM CAMPAIGN CHECKS PASSED' : `${fail} FAILED`}`);
  process.exit(fail === 0 ? 0 : 1);
}

await main();
