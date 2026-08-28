/* eslint-disable @typescript-eslint/no-explicit-any -- dev verification script */
/**
 * Auth Hardening Phase A verification.
 *   npx tsx server/modules/auth/auth.verify.ts
 * Proves lockout, no-leak, password reset (hashed/single-use/expiry), MFA TOTP,
 * requireMfa login gating, access-token lifetime, audit writes, truthful reports,
 * and that existing login still works.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import { buildApp } from '../../app';
import { generatePasswordHash, decryptSecret } from '../../lib/security';
import { generateTotp } from '../../lib/totp';
import { recomputeEntitlements } from '../../lib/entitlements';

const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL }) });
let fail = 0;
const check = (l: string, ok: boolean) => { console.log(`${ok ? '✓' : '✗'} ${l}`); if (!ok) fail++; };
const PW = 'Correct-Horse-8';

async function main() {
  const tA = randomUUID(); const tB = randomUUID();
  await ownerDb.tenant.create({ data: { id: tA, name: 'Auth A', slug: `autha-${tA.slice(0, 8)}` } });
  await ownerDb.tenant.create({ data: { id: tB, name: 'Auth B', slug: `authb-${tB.slice(0, 8)}` } });
  await ownerDb.tenantSecurityPolicy.create({ data: { tenantId: tA, failedLoginLockout: true, requireMfa: false, sessionTimeoutMinutes: 30 } });
  await ownerDb.tenantSecurityPolicy.create({ data: { tenantId: tB, failedLoginLockout: false, requireMfa: true, sessionTimeoutMinutes: 15 } });
  // Give tenant A an Enterprise subscription so the compliance reports (now
  // feature-gated by compliance_readiness) are reachable for the report checks.
  const enterprisePlan = await ownerDb.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  if (enterprisePlan) { await ownerDb.tenantSubscription.create({ data: { tenantId: tA, planId: enterprisePlan.id, status: 'ACTIVE', startedAt: new Date() } }); await recomputeEntitlements(tA); }
  const hash = await generatePasswordHash(PW);
  const mkUser = (tenantId: string, tag: string) => ownerDb.user.create({ data: { tenantId, role: 'ADMIN', email: `${tag}-${randomUUID().slice(0, 8)}@auth.test`, displayName: tag, active: true, passwordHash: hash, passwordChangedAt: new Date() } });
  const uValid = await mkUser(tA, 'valid');
  const uLock = await mkUser(tA, 'lock');
  const uPolicy = await mkUser(tB, 'policy');

  const app = await buildApp();
  // Unique source IP per request avoids the per-IP login rate limit (lockout is
  // per-user/DB and unaffected); trustProxy honours x-forwarded-for.
  let ipN = 0;
  const ip = () => { ipN += 1; return `10.${(ipN >> 16) & 255}.${(ipN >> 8) & 255}.${ipN & 255}`; };
  const post = (url: string, payload: unknown, headers?: Record<string, string>) => app.inject({ method: 'POST', url: `/v1/auth${url}`, headers: { 'x-forwarded-for': ip(), ...headers }, payload: payload as object });
  const get = (url: string, headers?: Record<string, string>) => app.inject({ method: 'GET', url: `/v1/auth${url}`, headers: { 'x-forwarded-for': ip(), ...headers } });
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  // 1) Existing/valid login works
  const r = await post('/login', { email: uValid.email, password: PW });
  const validBody = JSON.parse(r.body);
  check('valid login → 200 + accessToken', r.statusCode === 200 && !!validBody.accessToken);
  const accessToken = validBody.accessToken;

  // 2) Failed login tracked
  await post('/login', { email: uLock.email, password: 'wrong-password-x' });
  let dbUser = await ownerDb.user.findUnique({ where: { id: uLock.id } });
  check('failed login increments failedLoginCount', (dbUser?.failedLoginCount ?? 0) === 1);

  // 3) Lockout triggers at threshold (policy on). 4 more fails → 5 total → locked.
  for (let i = 0; i < 4; i++) await post('/login', { email: uLock.email, password: 'wrong-password-x' });
  dbUser = await ownerDb.user.findUnique({ where: { id: uLock.id } });
  check('lockout sets lockedUntil after threshold', !!dbUser?.lockedUntil && dbUser.lockedUntil > new Date());
  // Correct password while locked → still generic 401
  const lockedResp = await post('/login', { email: uLock.email, password: PW });
  check('login blocked while locked (401)', lockedResp.statusCode === 401);

  // 4) No user-existence leak: locked vs non-existent return identical generic error
  const nonexist = await post('/login', { email: `ghost-${randomUUID()}@auth.test`, password: PW });
  check('lockout response == non-existent response (no leak)', lockedResp.statusCode === nonexist.statusCode && JSON.parse(lockedResp.body).message === JSON.parse(nonexist.body).message);

  // 5) Password reset — hashed at rest, dev token returned, single-use, expiry
  const reqResp = await post('/password-reset/request', { email: uLock.email });
  const reqBody = JSON.parse(reqResp.body);
  check('reset request returns dev token (no email provider)', reqResp.statusCode === 200 && typeof reqBody.devToken === 'string' && reqBody.emailDelivered === false);
  const tokenRow = await ownerDb.passwordResetToken.findFirst({ where: { userId: uLock.id, usedAt: null }, orderBy: { createdAt: 'desc' } });
  check('reset token stored HASHED (raw token not in DB)', !!tokenRow && tokenRow.tokenHash !== reqBody.devToken && tokenRow.tokenHash.length === 64);
  // weak password rejected
  const weak = await post('/password-reset/confirm', { token: reqBody.devToken, newPassword: 'short' });
  check('reset rejects sub-policy password (400)', weak.statusCode === 400);
  // confirm with strong password
  const confirm = await post('/password-reset/confirm', { token: reqBody.devToken, newPassword: 'New-Strong-Pw-9' });
  check('reset confirm succeeds (200)', confirm.statusCode === 200);
  const usedRow = await ownerDb.passwordResetToken.findUnique({ where: { id: tokenRow!.id } });
  check('reset token marked single-use (usedAt set)', !!usedRow?.usedAt);
  const reuse = await post('/password-reset/confirm', { token: reqBody.devToken, newPassword: 'Another-Pw-10' });
  check('reused reset token rejected (400)', reuse.statusCode === 400);
  // reset cleared lockout + changed password → login works with new password
  const reLogin = await post('/login', { email: uLock.email, password: 'New-Strong-Pw-9' });
  check('login works after reset (lock cleared, new password)', reLogin.statusCode === 200);
  // expired token rejected
  const rawExpired = (JSON.parse((await post('/password-reset/request', { email: uLock.email })).body) as any).devToken;
  await ownerDb.passwordResetToken.updateMany({ where: { userId: uLock.id, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const expiredConfirm = await post('/password-reset/confirm', { token: rawExpired, newPassword: 'Yet-Another-11' });
  check('expired reset token rejected (400)', expiredConfirm.statusCode === 400);

  // 6) MFA setup + verify (authenticated user)
  const setup = await post('/mfa/setup', {}, bearer(accessToken));
  const setupBody = JSON.parse(setup.body);
  check('mfa setup returns base32 secret + otpauth uri, not yet enabled', setup.statusCode === 200 && /^[A-Z2-7]+$/.test(setupBody.secret) && setupBody.otpauthUri.startsWith('otpauth://') && setupBody.enabled === false);
  // secret encrypted at rest
  const afterSetup = await ownerDb.user.findUnique({ where: { id: uValid.id } });
  check('MFA secret encrypted at rest (gcm$… + decrypts)', !!afterSetup?.mfaSecretEnc && afterSetup.mfaSecretEnc.startsWith('gcm$') && decryptSecret(afterSetup.mfaSecretEnc) === setupBody.secret);
  // wrong code rejected
  const badCode = await post('/mfa/verify', { code: '000000' }, bearer(accessToken));
  check('mfa verify rejects wrong code (401)', badCode.statusCode === 401);
  // correct code enables
  const goodCode = generateTotp(setupBody.secret);
  const verifyOk = await post('/mfa/verify', { code: goodCode }, bearer(accessToken));
  check('mfa verify with correct code enables MFA', verifyOk.statusCode === 200);
  const statusResp = JSON.parse((await get('/mfa/status', bearer(accessToken))).body);
  check('mfa status shows enabled', statusResp.enabled === true);

  // 7) Enrolled user → login returns mfa_required, then challenge issues session
  const loginMfa = await post('/login', { email: uValid.email, password: PW });
  const loginMfaBody = JSON.parse(loginMfa.body);
  check('enrolled user login → mfa_required + mfaToken (no session yet)', loginMfaBody.status === 'mfa_required' && !!loginMfaBody.mfaToken && !loginMfaBody.accessToken);
  const challenge = await post('/mfa/verify', { code: generateTotp(setupBody.secret) }, bearer(loginMfaBody.mfaToken));
  const challengeBody = JSON.parse(challenge.body);
  check('mfa challenge issues full session', challenge.statusCode === 200 && !!challengeBody.accessToken);

  // 8) requireMfa policy: user without MFA → mfa_setup_required
  const setupReq = await post('/login', { email: uPolicy.email, password: PW });
  const setupReqBody = JSON.parse(setupReq.body);
  check('requireMfa + no MFA → mfa_setup_required', setupReqBody.status === 'mfa_setup_required' && !!setupReqBody.mfaToken);
  // complete forced setup with the setup token → session issued
  const forcedSetup = JSON.parse((await post('/mfa/setup', {}, bearer(setupReqBody.mfaToken))).body);
  const forcedVerify = await post('/mfa/verify', { code: generateTotp(forcedSetup.secret) }, bearer(setupReqBody.mfaToken));
  check('forced MFA setup → verify issues session', forcedVerify.statusCode === 200 && !!JSON.parse(forcedVerify.body).accessToken);

  // 9) Access-token lifetime honoured (tenant A = 30 min)
  const sessInfo = JSON.parse((await get('/session-info', bearer(accessToken))).body);
  check('access-token lifetime reflects tenant policy (30 min)', sessInfo.accessTokenTtlMinutes === 30 && sessInfo.accountLockoutEnabled === true);

  // 10) Audit events recorded
  const actions = (await ownerDb.auditEvent.findMany({ where: { tenantId: { in: [tA, tB] } }, select: { action: true } })).map(a => a.action);
  const has = (a: string) => actions.includes(a);
  check('audit: failed login + lockout', has('auth.login.failed') && has('auth.login.lockout'));
  check('audit: reset requested + completed', has('auth.password.reset.requested') && has('auth.password.reset.completed'));
  check('audit: mfa setup + enabled + challenge', has('auth.mfa.setup') && has('auth.mfa.enabled') && has('auth.login.mfaChallenge'));

  // 11) Compliance reports now truthful (MFA integrated, real adoption; lockout enforced)
  // Use a fresh OWNER token in tenant A via dev-token? dev-token is fixed dev tenant. Query report via app with an access token for uValid (ADMIN).
  const reportTok = challengeBody.accessToken;
  const mfaReport = JSON.parse((await app.inject({ method: 'GET', url: '/v1/compliance/reports/mfa', headers: bearer(reportTok) })).body);
  check('mfa report integrated=true with real adoption', mfaReport.integrated === true && mfaReport.method === 'TOTP' && mfaReport.mfaEnabledUsers >= 1 && typeof mfaReport.adoptionPct === 'number');
  const pwReport = JSON.parse((await app.inject({ method: 'GET', url: '/v1/compliance/reports/password-policy', headers: bearer(reportTok) })).body);
  check('password-policy report shows lockout enforced + threshold', pwReport.lockoutEnabled === true && pwReport.lockoutThreshold === 5);

  // 12) No RLS on auth tables
  const rls = new Set((await ownerDb.$queryRaw<Array<{ relname: string }>>`SELECT relname FROM pg_class WHERE relkind='r' AND relrowsecurity=true`).map(r => r.relname));
  check('no RLS on User / PasswordResetToken', !rls.has('User') && !rls.has('PasswordResetToken'));

  await app.close();
  await ownerDb.tenant.delete({ where: { id: tA } }).catch(() => {});
  await ownerDb.tenant.delete({ where: { id: tB } }).catch(() => {});
  await ownerDb.$disconnect();
  console.log(`\n${fail === 0 ? 'ALL AUTH-HARDENING CHECKS PASSED' : `${fail} FAILED`}`);
  process.exit(fail === 0 ? 0 : 1);
}

await main();
