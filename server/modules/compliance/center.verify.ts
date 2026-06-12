/* eslint-disable @typescript-eslint/no-explicit-any -- dev verification script: ergonomic access to dynamic JSON responses */
/**
 * Compliance Readiness Center Phase C-1B API verification.
 *   npx tsx server/modules/compliance/center.verify.ts
 *
 * Uses buildApp() + app.inject() (in-process, no network) with real DB users so
 * RBAC runs against actual UserRole records. Owner connection seeds fixtures.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import { buildApp } from '../../app';

const ownerUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: ownerUrl }) });

let failures = 0;
function check(label: string, ok: boolean) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures += 1;
}

const TENANT_A = process.env.DEV_TENANT_ID ?? '11111111-1111-4111-8111-111111111111';
const TENANT_B = randomUUID();

type Body = Record<string, unknown> | undefined;

async function main() {
  // Fixtures: Tenant B + users in A and B.
  await ownerDb.tenant.create({ data: { id: TENANT_B, name: 'C1B Tenant B', slug: `c1b-${TENANT_B.slice(0, 8)}` } });
  const bEvidence = await ownerDb.complianceEvidence.create({ data: { tenantId: TENANT_B, title: 'B-only evidence' } });

  const mkUser = (tenantId: string, role: string) =>
    ownerDb.user.create({ data: { tenantId, role: role as never, email: `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@c1b.test`, displayName: `${role} user`, active: true } });
  const owner = await mkUser(TENANT_A, 'OWNER');
  const officerA = await mkUser(TENANT_A, 'COMPLIANCE_OFFICER');
  const auditorA = await mkUser(TENANT_A, 'AUDITOR');
  const normalA = await mkUser(TENANT_A, 'FRONT_DESK');
  const officerB = await mkUser(TENANT_B, 'COMPLIANCE_OFFICER');
  const createdUserIds = [owner.id, officerA.id, auditorA.id, normalA.id, officerB.id];

  const app = await buildApp();
  const token = (u: { id: string; tenantId: string; role: string }) => app.jwt.sign({ userId: u.id, tenantId: u.tenantId, role: u.role, type: 'access' });
  async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, u: { id: string; tenantId: string; role: string }, payload?: Body) {
    const res = await app.inject({ method, url: `/v1/compliance${url}`, headers: { authorization: `Bearer ${token(u)}` }, payload });
    let json: unknown = undefined;
    try { json = res.body ? JSON.parse(res.body) : undefined; } catch { /* non-json */ }
    return { status: res.statusCode, json } as { status: number; json: any };
  }

  // 1) OWNER/ADMIN read + write.
  check('OWNER dashboard 200', (await call('GET', '/dashboard', owner)).status === 200);
  const firstControl = (await call('GET', '/controls', owner)).json[0];
  check('OWNER controls list non-empty', !!firstControl?.id);
  check('OWNER can PATCH a control', (await call('PATCH', `/controls/${firstControl.id}`, owner, { notes: 'reviewed by test' })).status === 200);

  // 2) COMPLIANCE_OFFICER read + write (create evidence linked to a control).
  const created = await call('POST', '/evidence', officerA, { title: 'Policy doc', contentHash: 'hash-v1', controlIds: [firstControl.id] });
  check('OFFICER can POST evidence (201)', created.status === 201 && !!created.json?.id);
  const evidenceId = created.json.id as string;

  // 3) AUDITOR read-only.
  check('AUDITOR can GET evidence (200)', (await call('GET', '/evidence', auditorA)).status === 200);
  check('AUDITOR POST evidence denied (403)', (await call('POST', '/evidence', auditorA, { title: 'nope' })).status === 403);
  check('AUDITOR PATCH control denied (403)', (await call('PATCH', `/controls/${firstControl.id}`, auditorA, { notes: 'x' })).status === 403);

  // 4) Normal role denied everywhere in the module.
  check('FRONT_DESK dashboard denied (403)', (await call('GET', '/dashboard', normalA)).status === 403);
  check('FRONT_DESK evidence denied (403)', (await call('GET', '/evidence', normalA)).status === 403);

  // 5) Tenant isolation.
  const aList = await call('GET', '/evidence', officerA);
  check('Tenant A cannot see Tenant B evidence in list', !aList.json.some((e: { id: string }) => e.id === bEvidence.id));
  check('Tenant A PATCH of Tenant B evidence → 404', (await call('PATCH', `/evidence/${bEvidence.id}`, officerA, { title: 'hijack' })).status === 404);
  check('Tenant B officer sees own evidence', (await call('GET', '/evidence', officerB)).json.some((e: { id: string }) => e.id === bEvidence.id));

  // 6) Evidence soft delete (default list excludes; includeDeleted shows it).
  await call('PATCH', `/evidence/${evidenceId}`, officerA, { contentHash: 'hash-v2', reviewStatus: 'APPROVED' });
  check('DELETE evidence → 204', (await call('DELETE', `/evidence/${evidenceId}`, officerA)).status === 204);
  const afterDelete = await call('GET', '/evidence', officerA);
  check('soft-deleted evidence hidden by default', !afterDelete.json.some((e: { id: string }) => e.id === evidenceId));
  const withDeleted = await call('GET', '/evidence?includeDeleted=true', officerA);
  check('soft-deleted evidence visible with includeDeleted', withDeleted.json.some((e: { id: string; deletedAt: string | null }) => e.id === evidenceId && e.deletedAt));
  const rawEvidence = await ownerDb.complianceEvidence.findUnique({ where: { id: evidenceId } });
  check('evidence not hard-deleted (row still exists)', !!rawEvidence && rawEvidence.deletedAt !== null);

  // 7) Version chain (created → updated → reviewed/deleted), prevHash links rowHash.
  const versions = (await call('GET', `/evidence/${evidenceId}/versions`, officerA)).json as Array<{ version: number; changeType: string; prevHash: string | null; rowHash: string }>;
  check('version chain has >= 3 entries', versions.length >= 3);
  check('v1 is created with no prevHash', versions[0]?.changeType === 'created' && versions[0]?.prevHash === null);
  const chained = versions.slice(1).every((v, i) => v.prevHash === versions[i].rowHash);
  check('each version chains off the previous rowHash', chained);
  check('final version is delete', versions[versions.length - 1]?.changeType === 'deleted');

  // 8) AuditEvent written for sensitive writes.
  const auditCreate = await ownerDb.auditEvent.findFirst({ where: { tenantId: TENANT_A, action: 'compliance.evidence.created', resourceId: evidenceId } });
  const auditDelete = await ownerDb.auditEvent.findFirst({ where: { tenantId: TENANT_A, action: 'compliance.evidence.deleted', resourceId: evidenceId } });
  check('AuditEvent recorded for evidence.created', !!auditCreate);
  check('AuditEvent recorded for evidence.deleted', !!auditDelete);

  // 9) Dashboard truthful percentages.
  const dash = (await call('GET', '/dashboard', owner)).json;
  const pctOk = [dash.soc2ReadinessPct, dash.hipaaAlignmentPct, dash.internalBaselinePct, dash.overallReadinessScore].every((p: number) => typeof p === 'number' && p >= 0 && p <= 100);
  check('dashboard scores are valid percentages', pctOk);
  check('dashboard MFA truthfully not enforced', dash.mfaStatus?.enforced === false && dash.mfaStatus?.integrated === false);
  check('dashboard backup truthfully unverified', dash.backupStatus?.integrated === false);

  // 10) Reports show truthful not-integrated where applicable.
  const mfa = (await call('GET', '/reports/mfa', owner)).json;
  check('MFA report not_integrated', mfa.integrated === false && mfa.status === 'not_integrated' && mfa.adoptionPct === 0);
  const backup = (await call('GET', '/reports/backup-status', owner)).json;
  check('backup report unverified/not-integrated', backup.integrated === false);
  const scans = (await call('GET', '/reports/security-scans', owner)).json;
  check('security-scans report not_integrated', scans.integrated === false && scans.status === 'not_integrated');
  const deploy = (await call('GET', '/reports/deployment-history', owner)).json;
  check('deployment-history not_integrated (schema migrations proxy)', deploy.integrated === false && Array.isArray(deploy.schemaMigrations));
  const pwd = (await call('GET', '/reports/password-policy', owner)).json;
  check('password-policy truthful (no expiry/lockout/history)', pwd.expiryDays === null && pwd.lockoutEnabled === false && pwd.historyEnforced === false);

  // Cleanup.
  await app.close();
  await ownerDb.complianceEvidenceVersion.deleteMany({ where: { tenantId: TENANT_A, evidenceId } });
  await ownerDb.complianceControlEvidence.deleteMany({ where: { tenantId: TENANT_A, evidenceId } });
  await ownerDb.complianceEvidence.deleteMany({ where: { id: evidenceId } });
  // NOTE: AuditEvent is append-only (enforced by a DB trigger). Deleting a user
  // who authored audit rows triggers a blocked SetNull, so fall back to
  // deactivating those test users — the audit immutability is intentional.
  try {
    await ownerDb.user.deleteMany({ where: { id: { in: createdUserIds } } });
  } catch {
    await ownerDb.user.updateMany({ where: { id: { in: createdUserIds } }, data: { active: false } });
  }
  await ownerDb.tenant.delete({ where: { id: TENANT_B } }).catch(() => {});
  await ownerDb.$disconnect();

  console.log(`\n${failures === 0 ? 'ALL C-1B API CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
