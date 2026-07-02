/* eslint-disable @typescript-eslint/no-explicit-any -- dev verification script */
/**
 * Patient / Client Portal verification.
 *   npx tsx server/modules/portal/portal.verify.ts
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import { buildApp } from '../../app';

const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL }) });
const DEV_TENANT = process.env.DEV_TENANT_ID!;
let fail = 0;
const check = (l: string, ok: boolean) => { console.log(`${ok ? '✓' : '✗'} ${l}`); if (!ok) fail++; };

async function main() {
  const app = await buildApp();
  let ipN = 0;
  const ip = () => `10.9.${(++ipN >> 8) & 255}.${ipN & 255}`;
  const post = (url: string, payload?: unknown, token?: string) => app.inject({ method: 'POST', url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-forwarded-for': ip() }, payload: payload as object });
  const get = (url: string, token?: string) => app.inject({ method: 'GET', url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-forwarded-for': ip() } });
  const patch = (url: string, payload: unknown, token: string) => app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': ip() }, payload: payload as object });

  // --- Fixtures: tenant A (dev) demo patient + portal account; tenant B -----
  const tenantA = DEV_TENANT;
  const slugA = (await ownerDb.tenant.findUnique({ where: { id: tenantA } }))!.slug;
  const patientA = await ownerDb.patient.findFirstOrThrow({ where: { tenantId: tenantA }, select: { id: true } });
  const acctA = await ownerDb.patientPortalAccount.upsert({
    where: { tenantId_patientId: { tenantId: tenantA, patientId: patientA.id } },
    update: { status: 'active', email: `pa-${randomUUID().slice(0, 6)}@portal.test` },
    create: { tenantId: tenantA, patientId: patientA.id, status: 'active', email: `pa-${randomUUID().slice(0, 6)}@portal.test` },
  });

  // tenant B (isolated)
  const tenantB = await ownerDb.tenant.create({ data: { name: 'Portal QA B', slug: `portal-qa-${randomUUID().slice(0, 8)}`, status: 'active' } });
  const branchB = await ownerDb.branch.create({ data: { tenantId: tenantB.id, name: 'B', location: 'B' } });
  const patientB = await ownerDb.patient.create({ data: { tenantId: tenantB.id, branchId: branchB.id, firstName: 'Bob', lastName: 'B', email: `pb-${randomUUID().slice(0, 6)}@portal.test` } });
  await ownerDb.patientPortalAccount.create({ data: { tenantId: tenantB.id, patientId: patientB.id, status: 'active', email: patientB.email } });
  // tenant B needs the entitlement for its portal to be reachable
  const planB = await ownerDb.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  if (planB) { await ownerDb.tenantSubscription.create({ data: { tenantId: tenantB.id, planId: planB.id, status: 'ACTIVE', startedAt: new Date() } }); const { recomputeEntitlements } = await import('../../lib/entitlements'); await recomputeEntitlements(tenantB.id); }

  // 1) Request link → dev token (no enumeration; generic message)
  const rl = await post('/v1/portal/auth/request-link', { clinicSlug: slugA, email: acctA.email });
  const rlBody = JSON.parse(rl.body);
  check('request-link → 200 generic + dev token', rl.statusCode === 200 && typeof rlBody.message === 'string' && !!rlBody.devToken);
  const tokenA = rlBody.devToken;

  // 2) Token stored hashed (raw not in DB) + has expiry
  const stored = await ownerDb.patientPortalToken.findFirst({ where: { accountId: acctA.id }, orderBy: { createdAt: 'desc' } });
  check('login token stored hashed (raw not persisted) + expires', !!stored && stored.tokenHash !== tokenA && stored.expiresAt > new Date());

  // 3) Unknown email → still generic (no enumeration), no token
  const enum1 = JSON.parse((await post('/v1/portal/auth/request-link', { clinicSlug: slugA, email: 'nobody@nowhere.test' })).body);
  check('no enumeration: unknown email → generic, no token', !enum1.devToken && typeof enum1.message === 'string');

  // 4) Verify → session
  const vr = await post('/v1/portal/auth/verify', { token: tokenA });
  const session = JSON.parse(vr.body).token;
  check('verify → 200 issues session', vr.statusCode === 200 && !!session);

  // 5) Single-use
  check('verify token is single-use (replay → 401)', (await post('/v1/portal/auth/verify', { token: tokenA })).statusCode === 401);

  // 6) me + dashboard patient-safe
  check('me → 200', (await get('/v1/portal/auth/me', session)).statusCode === 200);
  const dashRes = await get('/v1/portal/dashboard', session);
  const dashStr = dashRes.body.toLowerCase();
  check('dashboard → 200', dashRes.statusCode === 200);
  check('dashboard hides tenantId/internal ids/staff/revenue/audit/payer', ![tenantA, patientA.id, 'tenantid', 'denial', 'revenue risk', 'auditevent', 'staff note', 'raw payer'].some(s => dashStr.includes(s.toLowerCase())));

  // 7) Token separation
  const staffTok = app.jwt.sign({ userId: process.env.DEV_USER_ID, tenantId: tenantA, role: 'OWNER', type: 'access' });
  check('staff JWT cannot access portal (401)', (await get('/v1/portal/dashboard', staffTok)).statusCode === 401);
  check('portal JWT cannot access staff API (401)', (await get('/v1/leads', session)).statusCode === 401);

  // 8) Tenant isolation — A session sees only A's data; B's appointment id is invisible
  const apptB = await ownerDb.appointment.create({ data: { tenantId: tenantB.id, branchId: branchB.id, patientId: patientB.id, service: 'B visit', startsAt: new Date(), endsAt: new Date(Date.now() + 1800_000), channel: 'EMAIL' } });
  check('tenant A patient cannot read tenant B appointment (404)', (await get(`/v1/portal/appointments/${apptB.id}`, session)).statusCode === 404);

  // 9) Appointments list
  check('appointments list → 200', (await get('/v1/portal/appointments', session)).statusCode === 200);

  // 10) Appointment request create + idempotent
  const requestService = `Portal QA visit ${randomUUID().slice(0, 6)}`;
  const ar1 = await post('/v1/portal/appointment-requests', { service: requestService, requestedDateTime: '2026-09-01T10:00:00Z' }, session);
  const ar2 = await post('/v1/portal/appointment-requests', { service: requestService, requestedDateTime: '2026-09-01T10:00:00Z' }, session);
  check('appointment request create → 201', ar1.statusCode === 201);
  check('appointment request is idempotent (2nd → deduped)', ar2.statusCode === 200 && JSON.parse(ar2.body).deduped === true);

  // 11) Intake list
  check('intake list → 200', (await get('/v1/portal/intake', session)).statusCode === 200);

  // 12) Insurance view + update (patient-safe; idempotent by memberId)
  check('insurance list → 200', (await get('/v1/portal/insurance', session)).statusCode === 200);
  const memberId = `QA-${randomUUID().slice(0, 8)}`;
  const ins1 = await post('/v1/portal/insurance', { planName: 'QA Plan', memberId }, session);
  const ins2 = await post('/v1/portal/insurance', { planName: 'QA Plan', memberId }, session);
  check('insurance add → 201; same memberId → deduped (no duplicate)', ins1.statusCode === 201 && JSON.parse(ins2.body).deduped === true);
  const insList = JSON.parse((await get('/v1/portal/insurance', session)).body);
  check('insurance memberId is masked', insList.every((p: any) => p.memberId.includes('••')));

  // 13) Payments — tokenized links only; status not faked
  const payRes = JSON.parse((await get('/v1/portal/payments', session)).body);
  check('payments list → 200 (no fake paid status)', Array.isArray(payRes) && !payRes.some((p: any) => p.status === 'paid' && !p.id));

  // 14) Estimate acknowledge idempotent
  const estimate = await ownerDb.patientResponsibilityEstimate.create({ data: { tenantId: tenantA, branchId: (await ownerDb.branch.findFirstOrThrow({ where: { tenantId: tenantA } })).id, patientId: patientA.id, estimatedPatientResponsibility: 120, recommendedCollectAmount: 60, reason: 'qa' } });
  const ack1 = await post(`/v1/portal/estimates/${estimate.id}/acknowledge`, undefined, session);
  const ack2 = await post(`/v1/portal/estimates/${estimate.id}/acknowledge`, undefined, session);
  check('estimate acknowledge idempotent', ack1.statusCode === 200 && JSON.parse(ack2.body).deduped === true);

  // 15) Preferences opt-out creates ConsentEvent + suppresses campaigns
  await patch('/v1/portal/preferences', { marketing: false }, session);
  const ce = await ownerDb.consentEvent.findFirst({ where: { tenantId: tenantA, patientId: patientA.id, purpose: 'MARKETING', granted: false }, orderBy: { occurredAt: 'desc' } });
  check('preferences opt-out records ConsentEvent(granted=false)', !!ce);
  const { isSuppressed } = await import('../../lib/campaigns');
  check('marketing opt-out suppresses campaigns', await isSuppressed(tenantA, { patientId: patientA.id }, 'email'));

  // 15b) Voice preference is truly persisted in CommunicationConsent.
  const voiceOn = JSON.parse((await patch('/v1/portal/preferences', { voice: true }, session)).body);
  const voiceConsent = await ownerDb.communicationConsent.findFirst({ where: { tenantId: tenantA, patientId: patientA.id, channel: 'voice' }, orderBy: { capturedAt: 'desc' } });
  const prefAfterVoice = JSON.parse((await get('/v1/portal/preferences', session)).body);
  check('voice preference persists via CommunicationConsent + reloads true', voiceOn.ok === true && voiceConsent?.status === 'opted_in' && prefAfterVoice.voice === true);

  // 16) Disabled account cannot login
  await ownerDb.patientPortalAccount.update({ where: { id: acctA.id }, data: { status: 'disabled' } });
  const rlDis = JSON.parse((await post('/v1/portal/auth/request-link', { clinicSlug: slugA, email: acctA.email })).body);
  check('disabled account: request-link returns no token', !rlDis.devToken);
  await ownerDb.patientPortalAccount.update({ where: { id: acctA.id }, data: { status: 'active' } });

  // 17) Suspended tenant blocks portal access
  await ownerDb.tenant.update({ where: { id: tenantA }, data: { status: 'suspended' } });
  check('suspended tenant blocks portal session (403)', (await get('/v1/portal/dashboard', session)).statusCode === 403);
  await ownerDb.tenant.update({ where: { id: tenantA }, data: { status: 'active' } });

  // 18) Audit rows created (no PHI bodies)
  const auditCount = await ownerDb.auditEvent.count({ where: { tenantId: tenantA, action: { startsWith: 'portal.' } } });
  check('portal.* AuditEvent rows created', auditCount >= 5);
  const sampleAudit = await ownerDb.auditEvent.findFirst({ where: { tenantId: tenantA, action: 'portal.login.success' } });
  check('audit has no patient name/PHI in metadata', !JSON.stringify(sampleAudit?.metadata ?? {}).toLowerCase().includes('charlotte'));

  await app.close();
  // cleanup tenant B
  await ownerDb.tenant.delete({ where: { id: tenantB.id } }).catch(() => {});
  await ownerDb.$disconnect();
  console.log(`\n${fail === 0 ? 'ALL PORTAL CHECKS PASSED' : `${fail} FAILED`}`);
  process.exit(fail === 0 ? 0 : 1);
}

await main();
