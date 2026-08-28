/* eslint-disable @typescript-eslint/no-explicit-any -- dev verification script */
/**
 * AI Receptionist outbound calling verification (Phase A).
 *   npx tsx server/modules/receptionist/outbound.verify.ts
 *
 * Proves entitlement gating, honest setup_required, mock launch storing the
 * external call id, signed-webhook handoff (link/create + AppointmentRequest +
 * safe direct booking), idempotency, tenant isolation, and audit trail.
 */
import 'dotenv/config';
import { randomUUID, createHmac } from 'node:crypto';

// Configure a MOCK Retell so launches succeed without network/real creds, while
// never faking success for real config. Must be set before env.ts parses.
process.env.RETELL_API_KEY = (process.env.RETELL_API_KEY ?? '').startsWith('mock') ? process.env.RETELL_API_KEY! : 'mock_verify_secret';
process.env.RETELL_AGENT_ID ||= 'agent_verify';
process.env.RETELL_FROM_NUMBER ||= '+15550100000';

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
  await ownerDb.tenant.create({ data: { id, name: `Rcp ${tag}`, slug: `rcp-${tag}-${id.slice(0, 8)}` } });
  const user = await ownerDb.user.create({ data: { tenantId: id, role: 'OWNER', active: true, email: `${tag}-${id.slice(0, 8)}@rcp.test`, displayName: tag } });
  const plan = await ownerDb.subscriptionPlan.findUnique({ where: { key: planKey } });
  await ownerDb.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id);
  const clinic = await ownerDb.receptionistClinic.create({ data: { tenantId: id, name: `${tag} clinic`, phone: '+1 555 000 0000' } });
  const branch = await ownerDb.branch.create({ data: { tenantId: id, name: `${tag} branch`, location: 'Main St' } });
  return { id, userId: user.id, clinicId: clinic.id, branchId: branch.id };
}

async function main() {
  const tEnt = await setupTenant('ent', 'enterprise');   // has ai_receptionist
  const tB = await setupTenant('b', 'enterprise');        // isolation peer
  const tLock = await setupTenant('lock', 'starter');     // no ai_receptionist

  const app = await buildApp();
  let ipN = 0;
  const ip = () => `10.31.${(++ipN >> 8) & 255}.${ipN & 255}`;
  const tok = (userId: string, tenantId: string) => app.jwt.sign({ userId, tenantId, role: 'OWNER', type: 'access' });
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, t: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${t}`, 'x-forwarded-for': ip() }, payload: payload as object });
  const entTok = tok(tEnt.userId, tEnt.id);
  const bTok = tok(tB.userId, tB.id);
  const lockTok = tok(tLock.userId, tLock.id);

  // 1) Non-entitled tenant → 403 feature_locked on an outbound route.
  const locked = await call('GET', '/v1/receptionist/outbound-campaigns', lockTok);
  check('1. non-entitled tenant gets 403 feature_locked', locked.statusCode === 403 && JSON.parse(locked.body).feature === 'ai_receptionist');

  // 2) Entitled tenant can create an outbound campaign (request-only).
  const reqCampaignRes = await call('POST', '/v1/receptionist/outbound-campaigns', entTok, {
    clinicId: tEnt.clinicId, name: 'Reactivation', script: 'Hi, calling from the clinic about scheduling.',
    requiredFields: ['firstName', 'lastName', 'phone'], bookingMode: 'APPOINTMENT_REQUEST_ONLY', consentText: 'This call may be recorded.',
  });
  check('2. entitled tenant creates campaign (201)', reqCampaignRes.statusCode === 201);
  const reqCampaign = JSON.parse(reqCampaignRes.body);

  // 3) setup_required is honest: with Retell unconfigured, no fake success.
  const savedKey = env.RETELL_API_KEY;
  (env as any).RETELL_API_KEY = undefined;
  const beforeLogs = await ownerDb.receptionistCallLog.count({ where: { tenantId: tEnt.id } });
  const setupRes = await call('POST', `/v1/receptionist/outbound-campaigns/${reqCampaign.id}/call`, entTok, { phone: '+1 555 111 2222' });
  const setupBody = JSON.parse(setupRes.body);
  const afterLogs = await ownerDb.receptionistCallLog.count({ where: { tenantId: tEnt.id } });
  check('3. unconfigured Retell returns setup_required (no fake call, no call log)', setupBody.status === 'setup_required' && setupBody.missing.length > 0 && afterLogs === beforeLogs);
  (env as any).RETELL_API_KEY = savedKey;

  // 4) Mocked launch stores the external call id on the call attempt.
  const launchRes = await call('POST', `/v1/receptionist/outbound-campaigns/${reqCampaign.id}/call`, entTok, { phone: '+1 555 222 3333', firstName: 'Jordan' });
  const launchBody = JSON.parse(launchRes.body);
  const launchedLog = launchBody.callLogId ? await ownerDb.receptionistCallLog.findUnique({ where: { id: launchBody.callLogId } }) : null;
  check('4. mock launch returns launched + stores external call id', launchBody.status === 'launched' && launchBody.mock === true && launchedLog?.retellCallId === launchBody.callId && launchedLog?.outboundCampaignId === reqCampaign.id);

  // --- Webhook helper: signs the raw body with the Retell key (HMAC-SHA256) --
  async function seedCall(tenant: { id: string; clinicId: string }, campaignId: string, callId: string) {
    return ownerDb.receptionistCallLog.create({ data: { tenantId: tenant.id, clinicId: tenant.clinicId, outboundCampaignId: campaignId, retellCallId: callId, callerPhone: '+1 555 900 0000', direction: 'outbound', outcome: 'IN_PROGRESS' } });
  }
  async function postWebhook(clinicId: string, callId: string, custom: Record<string, unknown>) {
    const raw = JSON.stringify({ event: 'call_analyzed', call: { call_id: callId, from_number: '+1 555 900 0000', call_analysis: { call_summary: 'Scheduling discussed', user_sentiment: 'Positive', custom_analysis_data: custom } } });
    const sig = createHmac('sha256', env.RETELL_API_KEY!).update(raw).digest('hex');
    return app.inject({ method: 'POST', url: `/v1/receptionist/webhooks/retell?clinicId=${clinicId}`, headers: { 'content-type': 'application/json', 'x-retell-signature': sig, 'x-forwarded-for': ip() }, payload: raw });
  }

  // 5) Signed webhook updates the existing call log.
  const callId5 = `mock_call_${randomUUID().slice(0, 12)}`;
  const seeded5 = await seedCall(tEnt, reqCampaign.id, callId5);
  const wh5 = await postWebhook(tEnt.clinicId, callId5, { outcome: 'BOOKED', first_name: 'Dana', last_name: 'Lee', phone: '+1 555 900 0000', preferred_service: 'Cleaning' });
  const updated5 = await ownerDb.receptionistCallLog.findUnique({ where: { id: seeded5.id } });
  check('5. signed webhook updates call log (200, outcome set)', wh5.statusCode === 200 && updated5?.outcome === 'BOOKED');

  // 6) Duplicate webhook → no duplicate AppointmentRequest.
  await postWebhook(tEnt.clinicId, callId5, { outcome: 'BOOKED', first_name: 'Dana', last_name: 'Lee', phone: '+1 555 900 0000', preferred_service: 'Cleaning' });
  const dupCount = await ownerDb.appointmentRequest.count({ where: { tenantId: tEnt.id, callLogId: seeded5.id } });
  check('6. duplicate webhook creates no duplicate appointment request', dupCount === 1);

  // 7) Request-only mode with sufficient fields → PENDING_REVIEW request.
  const req7 = await ownerDb.appointmentRequest.findFirst({ where: { tenantId: tEnt.id, callLogId: seeded5.id } });
  check('7. sufficient fields create PENDING_REVIEW request (request-only mode)', req7?.status === 'PENDING_REVIEW');

  // 8) Missing required field → MISSING_INFO.
  const campEmailRes = await call('POST', '/v1/receptionist/outbound-campaigns', entTok, {
    clinicId: tEnt.clinicId, name: 'Needs email', script: 'Scheduling call.', requiredFields: ['firstName', 'lastName', 'phone', 'email'], bookingMode: 'APPOINTMENT_REQUEST_ONLY',
  });
  const campEmail = JSON.parse(campEmailRes.body);
  const callId8 = `mock_call_${randomUUID().slice(0, 12)}`;
  const seeded8 = await seedCall(tEnt, campEmail.id, callId8);
  await postWebhook(tEnt.clinicId, callId8, { outcome: 'BOOKED', first_name: 'Sam', last_name: 'Wu', phone: '+1 555 900 0000' });
  const req8 = await ownerDb.appointmentRequest.findFirst({ where: { tenantId: tEnt.id, callLogId: seeded8.id } });
  check('8. missing required field yields MISSING_INFO + names the field', req8?.status === 'MISSING_INFO' && req8?.missingFields.includes('email'));

  // 9) Direct booking only when valid (branch + parseable time + free slot); else PENDING_REVIEW.
  const directRes = await call('POST', '/v1/receptionist/outbound-campaigns', entTok, {
    clinicId: tEnt.clinicId, name: 'Direct book', script: 'Scheduling call.', requiredFields: ['firstName', 'lastName', 'phone'],
    bookingMode: 'DIRECT_BOOKING_IF_SLOT_AVAILABLE', defaultBranchId: tEnt.branchId, defaultService: 'Consultation',
  });
  const direct = JSON.parse(directRes.body);
  const slot = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
  const callId9a = `mock_call_${randomUUID().slice(0, 12)}`;
  const seeded9a = await seedCall(tEnt, direct.id, callId9a);
  await postWebhook(tEnt.clinicId, callId9a, { outcome: 'BOOKED', first_name: 'Ava', last_name: 'Ng', phone: '+1 555 444 5555', preferred_datetime: slot });
  const req9a = await ownerDb.appointmentRequest.findFirst({ where: { tenantId: tEnt.id, callLogId: seeded9a.id } });
  const booked = req9a?.bookedAppointmentId ? await ownerDb.appointment.findUnique({ where: { id: req9a.bookedAppointmentId } }) : null;
  check('9a. valid direct booking books an appointment (status BOOKED)', req9a?.status === 'BOOKED' && !!booked && booked?.branchId === tEnt.branchId);

  // Conflict at the same slot → falls back to staff review.
  const callId9b = `mock_call_${randomUUID().slice(0, 12)}`;
  const seeded9b = await seedCall(tEnt, direct.id, callId9b);
  await postWebhook(tEnt.clinicId, callId9b, { outcome: 'BOOKED', first_name: 'Eli', last_name: 'Park', phone: '+1 555 666 7777', preferred_datetime: slot });
  const req9b = await ownerDb.appointmentRequest.findFirst({ where: { tenantId: tEnt.id, callLogId: seeded9b.id } });
  check('9b. conflicting slot falls back to PENDING_REVIEW (no double-book)', req9b?.status === 'PENDING_REVIEW' && !req9b?.bookedAppointmentId);

  // 10) Tenant isolation — B cannot see A's campaigns or booking requests.
  const bCampaigns = JSON.parse((await call('GET', '/v1/receptionist/outbound-campaigns', bTok)).body);
  const bRequests = JSON.parse((await call('GET', '/v1/receptionist/booking-requests', bTok)).body);
  check('10. tenant B sees none of tenant A campaigns/requests', bCampaigns.length === 0 && bRequests.length === 0);
  const aRequests = JSON.parse((await call('GET', '/v1/receptionist/booking-requests', entTok)).body);
  check('10b. tenant A sees its own booking requests', aRequests.length >= 4);

  // 11) Audit trail rows written for the key actions.
  const actions = new Set((await ownerDb.auditEvent.findMany({ where: { tenantId: tEnt.id }, select: { action: true } })).map(a => a.action));
  check('11. audit rows for campaign.created / call.launched / webhook.received / appointmentRequest.created / appointment.booked',
    actions.has('receptionist.campaign.created') && actions.has('receptionist.call.launched') && actions.has('receptionist.webhook.received') && actions.has('receptionist.appointmentRequest.created') && actions.has('receptionist.appointment.booked'));

  // 12) Webhook signature still enforced — bad signature rejected.
  const badRaw = JSON.stringify({ event: 'call_analyzed', call: { call_id: 'x' } });
  const badWh = await app.inject({ method: 'POST', url: `/v1/receptionist/webhooks/retell?clinicId=${tEnt.clinicId}`, headers: { 'content-type': 'application/json', 'x-retell-signature': 'deadbeef', 'x-forwarded-for': ip() }, payload: badRaw });
  check('12. webhook rejects an invalid signature (401)', badWh.statusCode === 401);

  // 13) New tables are RLS-ready but RLS not enabled yet.
  const rls = new Set((await ownerDb.$queryRaw<Array<{ relname: string }>>`SELECT relname FROM pg_class WHERE relkind='r' AND relrowsecurity=true`).map(r => r.relname));
  check('13. no RLS enabled on new outbound tables', !rls.has('ReceptionistOutboundCampaign') && !rls.has('ReceptionistCallTarget') && !rls.has('AppointmentRequest'));

  await app.close();
  for (const t of [tEnt, tB, tLock]) await ownerDb.tenant.delete({ where: { id: t.id } }).catch(() => {});
  await ownerDb.$disconnect();
  console.log(`\n${fail === 0 ? 'ALL OUTBOUND RECEPTIONIST CHECKS PASSED' : `${fail} FAILED`}`);
  process.exit(fail === 0 ? 0 : 1);
}

await main();
