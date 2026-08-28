/* eslint-disable @typescript-eslint/no-explicit-any -- dev verification script */
/**
 * CRM Campaign / Reactivation engine verification.
 *   npx tsx server/modules/campaigns/campaigns.verify.ts
 *
 * Proves: insurance carry-forward (eligibility by appointmentId), model reuse,
 * consent/suppression gating, campaign CRUD, deterministic audiences, provider
 * setup_required vs dev-mock provider acceptance, delivery idempotency/rerun, approval gating,
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
const { runScheduledCampaigns, isWithinQuietHours } = await import('../../modules/campaigns/jobs');
const { createHmac } = await import('node:crypto');

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
  const exactPreview = async (campaignId: string, token: string) =>
    JSON.parse((await call('GET', `/v1/crm/campaigns/${campaignId}/launch-preview`, token)).body);
  const approveExact = async (campaignId: string, token: string) => {
    const reviewed = await exactPreview(campaignId, token);
    return call('POST', `/v1/crm/campaigns/${campaignId}/approve`, token, { previewFingerprint: reviewed.fingerprint, confirmExactAudienceTemplateProvider: true });
  };
  const launchExact = async (campaignId: string, token: string) => {
    const reviewed = await exactPreview(campaignId, token);
    return call('POST', `/v1/crm/campaigns/${campaignId}/launch`, token, { previewFingerprint: reviewed.fingerprint, confirmExactAudienceTemplateProvider: true });
  };
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
  const earlyLaunch = await call('POST', `/v1/crm/campaigns/${campaign.id}/launch`, aTok, { previewFingerprint: '0'.repeat(64), confirmExactAudienceTemplateProvider: true });
  check('12. rule-based draft requires approval; launch blocked pre-approval', draft.draftSource === 'rule_based' && draft.requiresApproval === true && earlyLaunch.statusCode === 409);

  await approveExact(campaign.id, aTok);

  // 6) Provider missing → setup_required, nothing sent, stays DRAFT.
  const savedSid = env.TWILIO_ACCOUNT_SID, savedTok = env.TWILIO_AUTH_TOKEN, savedFrom = env.TWILIO_FROM_NUMBER;
  (env as any).TWILIO_ACCOUNT_SID = undefined; (env as any).TWILIO_AUTH_TOKEN = undefined; (env as any).TWILIO_FROM_NUMBER = undefined;
  const setupLaunch = JSON.parse((await launchExact(campaign.id, aTok)).body);
  check('6. provider missing → setup_required, nothing accepted', setupLaunch.setupRequired === true && setupLaunch.summary.accepted === 0 && setupLaunch.summary.setupRequired >= 1);

  // 7) Mock provider (dev) → accepted, not delivered.
  (env as any).TWILIO_ACCOUNT_SID = 'mock_sid'; (env as any).TWILIO_AUTH_TOKEN = 'mock_tok'; (env as any).TWILIO_FROM_NUMBER = '+15550000000';
  const sentLaunch = JSON.parse((await launchExact(campaign.id, aTok)).body);
  check('7. dev mock provider records accepted (not delivered) + suppressed/skipped truthful', sentLaunch.summary.accepted >= 1 && sentLaunch.summary.suppressed >= 1 && sentLaunch.summary.skipped >= 1);

  // 3b) Consent opt-out actually suppressed the opted-out recipient's delivery.
  const optDelivery = await ownerDb.campaignDelivery.findFirst({ where: { tenantId: tA.id, campaignId: campaign.id, patientId: pOpt.id } });
  check('3. consent opt-out suppresses delivery', optDelivery?.status === 'suppressed');

  // 8 + 9 + 11) Idempotent: rerun does not duplicate rows or resubmit accepted ones.
  const countBefore = await ownerDb.campaignDelivery.count({ where: { tenantId: tA.id, campaignId: campaign.id } });
  const sentRow = await ownerDb.campaignDelivery.findFirst({ where: { tenantId: tA.id, campaignId: campaign.id, status: 'accepted' } });
  const rerun = JSON.parse((await launchExact(campaign.id, aTok)).body);
  const countAfter = await ownerDb.campaignDelivery.count({ where: { tenantId: tA.id, campaignId: campaign.id } });
  const sentRowAfter = await ownerDb.campaignDelivery.findUnique({ where: { id: sentRow!.id } });
  check('8/9/11. rerun idempotent: no duplicate rows, no resubmit of accepted recipients', countBefore === countAfter && rerun.summary.accepted >= 1 && sentRowAfter?.providerAcceptedAt?.getTime() === sentRow?.providerAcceptedAt?.getTime());

  // 10) Re-processing (duplicate trigger) does not regress accepted evidence.
  check('10. duplicate launch does not regress accepted delivery state', sentRowAfter?.status === 'accepted');

  // 13) Unauthorized role (PROVIDER) cannot launch.
  const provLaunch = await call('POST', `/v1/crm/campaigns/${campaign.id}/launch`, aProvider);
  check('13. PROVIDER cannot launch campaign (403)', provLaunch.statusCode === 403);

  // 14) BILLING can manage a payment follow-up campaign.
  await ownerDb.depositRequirement.create({ data: { tenantId: tA.id, branchId: tA.branchId, patientId: pElig.id, status: 'required', requiredAmount: 50, reason: 'deposit', mode: 'mock' } });
  const billCamp = JSON.parse((await call('POST', '/v1/crm/campaigns', aBilling, { name: 'Deposit followup', campaignType: 'unpaid_deposit_followup', audienceType: 'unpaid_deposit_followup', channel: 'sms' })).body);
  await approveExact(billCamp.id, aBilling);
  const billLaunch = await launchExact(billCamp.id, aBilling);
  check('14. BILLING manages payment follow-up campaign', billLaunch.statusCode === 200 && JSON.parse(billLaunch.body).summary.accepted >= 1);

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
  const revokedConsent = await call('POST', '/v1/crm/consent', aTok, { patientId: pElig.id, channel: 'email', status: 'opted_out' });
  const incompleteGrant = await call('POST', '/v1/crm/consent', aTok, { patientId: pElig.id, channel: 'email', status: 'opted_in' });
  const crossTenantGrant = await call('POST', '/v1/crm/consent', bTok, {
    patientId: pElig.id, channel: 'email', status: 'opted_in', outreachPurpose: 'inactive_patient_reactivation',
    policyVersion: 'email-reactivation-2026-08-01', disclosureTextHash: 'b'.repeat(64), evidenceReference: 'written-form:qa',
    captureMethod: 'written', evidenceSource: 'patient_written', jurisdiction: 'US-NY',
  });
  const versionedGrant = await call('POST', '/v1/crm/consent', aTok, {
    patientId: pElig.id, channel: 'email', status: 'opted_in', outreachPurpose: 'inactive_patient_reactivation',
    policyVersion: 'email-reactivation-2026-08-01', disclosureTextHash: 'b'.repeat(64), evidenceReference: 'written-form:qa',
    captureMethod: 'written', evidenceSource: 'patient_written', jurisdiction: 'US-NY',
  });
  await call('POST', '/v1/crm/suppressions', aTok, { patientId: pElig.id, channel: 'voice', reason: 'requested' });
  const actions2 = new Set((await ownerDb.auditEvent.findMany({ where: { tenantId: tA.id }, select: { action: true } })).map(a => a.action));
  check('19b. nonvoice revocation/grant are explicit, tenant-bound, and audited atomically', revokedConsent.statusCode === 201 && incompleteGrant.statusCode === 400 && crossTenantGrant.statusCode === 404 && versionedGrant.statusCode === 201 && actions2.has('communication.authority.revoked') && actions2.has('communication.authority.granted') && actions2.has('suppression.created'));

  (env as any).TWILIO_ACCOUNT_SID = savedSid; (env as any).TWILIO_AUTH_TOKEN = savedTok; (env as any).TWILIO_FROM_NUMBER = savedFrom;

  // ===== Post-CRM audit gate closures ======================================
  // A2) Provider readiness exposes truthful fields + no secret values.
  const prov = JSON.parse((await call('GET', '/v1/crm/provider-status', aTok)).body);
  const provStr = JSON.stringify(prov);
  const noSecrets = ['mock_sid', 'mock_tok', savedSid, savedTok].every(v => !v || !provStr.includes(String(v)));
  check('A2. provider-status truthfully blocks live campaign dispatch + no secret values', typeof prov.smsConfigured === 'boolean' && Array.isArray(prov.missingEnvKeys) && Array.isArray(prov.supportedChannels) && ['unconfigured', 'mock_dev', 'configured_pending_provider', 'live_supported'].includes(prov.providerMode.sms) && prov.liveSendingSupported === false && prov.liveCampaignDispatchActivated === false && prov.schedulerEnforced === true && noSecrets);

  // A3) Delivery webhook: no provider secret configured → provider_not_integrated.
  const wh = await app.inject({ method: 'POST', url: '/v1/crm/webhooks/delivery', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip() }, payload: JSON.stringify({ providerMessageId: 'x', status: 'delivered' }) });
  check('A3. delivery webhook returns provider_not_integrated when unconfigured', wh.statusCode === 501 && JSON.parse(wh.body).status === 'provider_not_integrated');

  // A5) Legacy ConsentEvent opt-out (granted=false) suppresses delivery.
  const pLegacy = await ownerDb.patient.create({ data: { tenantId: tA.id, branchId: tA.branchId, firstName: 'Lana', lastName: 'Legacy', phone: '+15551110100', lastVisitAt: old, lifecycleStage: 'AT_RISK' } });
  await ownerDb.consentEvent.create({ data: { tenantId: tA.id, patientId: pLegacy.id, purpose: 'SMS', granted: false, source: 'patient' } });
  const legacyCamp = JSON.parse((await call('POST', '/v1/crm/campaigns', aTok, { name: 'Legacy consent', campaignType: 'inactive_patient_reactivation', audienceType: 'inactive_patients', channel: 'sms' })).body);
  await approveExact(legacyCamp.id, aTok);
  await launchExact(legacyCamp.id, aTok);
  const legacyDelivery = await ownerDb.campaignDelivery.findFirst({ where: { tenantId: tA.id, campaignId: legacyCamp.id, patientId: pLegacy.id } });
  check('A5. legacy ConsentEvent opt-out suppresses delivery (safely mapped channel)', legacyDelivery?.status === 'suppressed');

  // A6) MARKETING opt-out suppresses ALL channels (cross-channel).
  const pMkt = await ownerDb.patient.create({ data: { tenantId: tA.id, branchId: tA.branchId, firstName: 'Mara', lastName: 'Mkt', phone: '+15551110200', email: 'mara@x.test', lastVisitAt: old, lifecycleStage: 'AT_RISK' } });
  await ownerDb.consentEvent.create({ data: { tenantId: tA.id, patientId: pMkt.id, purpose: 'MARKETING', granted: false, source: 'patient' } });
  const mktCamp = JSON.parse((await call('POST', '/v1/crm/campaigns', aTok, { name: 'Mkt optout', campaignType: 'inactive_patient_reactivation', audienceType: 'inactive_patients', channel: 'email' })).body);
  await approveExact(mktCamp.id, aTok);
  await launchExact(mktCamp.id, aTok);
  const mktDelivery = await ownerDb.campaignDelivery.findFirst({ where: { tenantId: tA.id, campaignId: mktCamp.id, patientId: pMkt.id } });
  check('A6. MARKETING opt-out suppresses all channels (email)', mktDelivery?.status === 'suppressed');

  // A7) Per-recipient delivery BusinessEvents (PHI-safe: no destination).
  const sentDeliv = await ownerDb.campaignDelivery.findFirst({ where: { tenantId: tA.id, status: 'accepted' } });
  const perRecipEvent = sentDeliv ? await ownerDb.businessEvent.findFirst({ where: { tenantId: tA.id, eventType: 'campaign.delivery.accepted', entityId: sentDeliv.id } }) : null;
  const evtStr = JSON.stringify(perRecipEvent?.payload ?? {});
  check('A7. per-recipient delivery event exists + no PHI (no destination)', !!perRecipEvent && !evtStr.includes('@') && !evtStr.includes('+1555'));

  // A8) Real signed, idempotent delivery webhook updates status by providerMessageId.
  (env as any).CAMPAIGN_WEBHOOK_SECRET = 'whsec_campaign_test';
  const liveDeliv = await ownerDb.campaignDelivery.findFirst({ where: { tenantId: tA.id, status: 'accepted', providerMessageId: { not: null } } });
  const evtId = `evt_${randomUUID().slice(0, 10)}`;
  const raw = JSON.stringify({ eventId: evtId, providerMessageId: liveDeliv!.providerMessageId, status: 'failed' });
  const sig = createHmac('sha256', 'whsec_campaign_test').update(raw).digest('hex');
  const badSig = await app.inject({ method: 'POST', url: '/v1/crm/webhooks/delivery', headers: { 'content-type': 'application/json', 'x-provider-signature': 'deadbeef', 'x-forwarded-for': ip() }, payload: raw });
  const wh1 = await app.inject({ method: 'POST', url: '/v1/crm/webhooks/delivery', headers: { 'content-type': 'application/json', 'x-provider-signature': sig, 'x-forwarded-for': ip() }, payload: raw });
  const wh2 = await app.inject({ method: 'POST', url: '/v1/crm/webhooks/delivery', headers: { 'content-type': 'application/json', 'x-provider-signature': sig, 'x-forwarded-for': ip() }, payload: raw });
  const updatedDeliv = await ownerDb.campaignDelivery.findUnique({ where: { id: liveDeliv!.id } });
  check('A8. signed idempotent delivery webhook updates status (bad sig 401, dup acknowledged)', badSig.statusCode === 401 && wh1.statusCode === 200 && JSON.parse(wh2.body).duplicate === true && updatedDeliv?.status === 'failed');
  (env as any).CAMPAIGN_WEBHOOK_SECRET = undefined;

  // A9) Scheduler: approved SCHEDULED + due campaign dispatches once (idempotent).
  (env as any).TWILIO_ACCOUNT_SID = 'mock_sid'; (env as any).TWILIO_AUTH_TOKEN = 'mock_tok'; (env as any).TWILIO_FROM_NUMBER = '+15550000000';
  const schedCamp = JSON.parse((await call('POST', '/v1/crm/campaigns', aTok, { name: 'Scheduled', campaignType: 'inactive_patient_reactivation', audienceType: 'inactive_patients', channel: 'sms' })).body);
  await ownerDb.campaign.update({ where: { id: schedCamp.id }, data: { scheduledAt: new Date(Date.now() - 60000) } });
  await approveExact(schedCamp.id, aTok); // exact preview authority → SCHEDULED
  const run1 = await runScheduledCampaigns(new Date());
  const afterRun = await ownerDb.campaign.findUnique({ where: { id: schedCamp.id } });
  const deliv1 = await ownerDb.campaignDelivery.count({ where: { tenantId: tA.id, campaignId: schedCamp.id } });
  await runScheduledCampaigns(new Date());
  const deliv2 = await ownerDb.campaignDelivery.count({ where: { tenantId: tA.id, campaignId: schedCamp.id } });
  const schedAudit = await ownerDb.auditEvent.findFirst({ where: { tenantId: tA.id, action: 'campaign.scheduled_run', resourceId: schedCamp.id } });
  check('A9. scheduler dispatches due approved campaign once (idempotent + audited)', run1.dispatched >= 1 && afterRun?.status === 'ACTIVE' && deliv1 === deliv2 && !!schedAudit && isWithinQuietHours({ start: '00:00', end: '23:59' }, new Date()) === true);
  (env as any).TWILIO_ACCOUNT_SID = savedSid; (env as any).TWILIO_AUTH_TOKEN = savedTok; (env as any).TWILIO_FROM_NUMBER = savedFrom;

  // A10) Real open-slot detection from appointment gaps (non-zero, deterministic).
  const openSlots = await (await import('../../lib/campaigns')).countOpenSlots(tA.id, 7);
  check('A10. real open-slot detection returns slots from appointment gaps', openSlots > 0);

  // A11) AI draft is rule_based when no LLM provider configured (dev).
  const draftCamp = JSON.parse((await call('POST', '/v1/crm/campaigns', aTok, { name: 'Draft test', campaignType: 'review_request', audienceType: 'review_request', channel: 'sms' })).body);
  const draftRes = JSON.parse((await call('POST', `/v1/crm/campaigns/${draftCamp.id}/draft`, aTok)).body);
  check('A11. AI draft is rule_based without configured LLM provider', draftRes.draftSource === 'rule_based' && draftRes.requiresApproval === true);

  await app.close();
  for (const t of [tA, tB, tLock]) await ownerDb.tenant.delete({ where: { id: t.id } }).catch(() => {});
  await ownerDb.$disconnect();
  console.log(`\n${fail === 0 ? 'ALL CRM CAMPAIGN CHECKS PASSED' : `${fail} FAILED`}`);
  process.exit(fail === 0 ? 0 : 1);
}

await main();
