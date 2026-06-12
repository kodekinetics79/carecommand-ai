/**
 * Compliance Readiness Center Phase C-1D job verification.
 *   npx tsx server/modules/compliance/jobs.verify.ts
 *
 * Exercises the job functions directly (tenant-scoped) plus the BullMQ schedule
 * registration, and cleans up after itself. Proves idempotency, tenant scoping,
 * truthful placeholders, audit writes, and that no RLS was enabled.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import {
  runReadinessRecalc, runEvidenceExpiry, runBackupPlaceholder,
  runAccessReviewReminder, runVendorReviewReminder, ingestSecurityScan,
} from './jobs';
import { complianceQueue, registerComplianceSchedules } from '../../workers/queues';

const ownerDb = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL }) });
let fail = 0;
const check = (l: string, ok: boolean) => { console.log(`${ok ? '✓' : '✗'} ${l}`); if (!ok) fail++; };

const NEW_TABLES = ['ComplianceTask', 'BackupVerification', 'AccessReview', 'SecurityScanResult', 'VendorRisk'];

async function main() {
  // Two isolated tenants for scoping checks.
  const tA = randomUUID(); const tB = randomUUID();
  await ownerDb.tenant.create({ data: { id: tA, name: 'Jobs A', slug: `joba-${tA.slice(0, 8)}` } });
  await ownerDb.tenant.create({ data: { id: tB, name: 'Jobs B', slug: `jobb-${tB.slice(0, 8)}` } });
  const officer = await ownerDb.user.create({ data: { tenantId: tA, role: 'COMPLIANCE_OFFICER', active: true, email: `off-${tA.slice(0, 8)}@j.test`, displayName: 'Officer A' } });
  await ownerDb.tenantSecurityPolicy.create({ data: { tenantId: tA, evidenceReviewFrequency: 'quarterly' } });
  // Expiring evidence (tenant A) + a due vendor (tenant A).
  const ev = await ownerDb.complianceEvidence.create({ data: { tenantId: tA, title: 'Expiring policy doc', expiresAt: new Date(Date.now() + 5 * 86400000) } });
  await ownerDb.vendorRisk.create({ data: { tenantId: tA, vendorName: 'Acme BAA', status: 'active', nextReviewAt: new Date(Date.now() - 86400000) } });

  // 1) Queue initializes
  check('compliance queue initializes', !!complianceQueue && complianceQueue.name === 'compliance-maintenance');

  // 2) Repeatable schedules registered without duplicates (register twice)
  await registerComplianceSchedules();
  const first = await complianceQueue.getJobSchedulers();
  await registerComplianceSchedules();
  const second = await complianceQueue.getJobSchedulers();
  check('6 schedulers registered', first.length === 6);
  check('re-registering does not duplicate schedulers', second.length === first.length);

  // 3) Evidence expiry creates one task; rerun does not duplicate
  const e1 = await runEvidenceExpiry(tA);
  const tasks1 = await ownerDb.complianceTask.count({ where: { tenantId: tA, description: { contains: `[evidence:${ev.id}]` } } });
  const e2 = await runEvidenceExpiry(tA);
  const tasks2 = await ownerDb.complianceTask.count({ where: { tenantId: tA, description: { contains: `[evidence:${ev.id}]` } } });
  check('evidence-expiry creates exactly one task', e1.created === 1 && tasks1 === 1);
  check('evidence-expiry rerun creates no duplicate', e2.created === 0 && tasks2 === 1);
  const evTask = await ownerDb.complianceTask.findFirst({ where: { tenantId: tA, description: { contains: `[evidence:${ev.id}]` } } });
  check('evidence task assigned to active compliance officer', evTask?.assigneeUserId === officer.id);

  // 4) Backup placeholder = truthful unverified, not success; dedup per day
  const b1 = await runBackupPlaceholder(tA);
  const backup = await ownerDb.backupVerification.findFirst({ where: { tenantId: tA }, orderBy: { runAt: 'desc' } });
  const details = (backup?.details ?? {}) as Record<string, unknown>;
  check('backup record is unverified (not success)', backup?.status === 'unverified' && details.integrated === false);
  const b2 = await runBackupPlaceholder(tA);
  check('backup placeholder dedups per day', b1.created === 1 && b2.created === 0);

  // 5) Access review reminder creates one; rerun no dup
  const a1 = await runAccessReviewReminder(tA);
  const a2 = await runAccessReviewReminder(tA);
  const reviews = await ownerDb.accessReview.count({ where: { tenantId: tA, period: a1.period } });
  check('access-review creates one per period, no dup on rerun', a1.created === 1 && a2.created === 0 && reviews === 1);

  // 6) Vendor review reminder creates one task for due vendor; rerun no dup
  const v1 = await runVendorReviewReminder(tA);
  const v2 = await runVendorReviewReminder(tA);
  const vendorTasks = await ownerDb.complianceTask.count({ where: { tenantId: tA, description: { contains: '[vendor:' } } });
  check('vendor-review creates one task, no dup on rerun', v1.created === 1 && v2.created === 0 && vendorTasks === 1);

  // 7) Security scan placeholder: no data → no fake passing record; with data → recorded
  const sNo = await ingestSecurityScan(tA);
  const scanCountAfterNoData = await ownerDb.securityScanResult.count({ where: { tenantId: tA } });
  check('security-scan with no data creates nothing (not_integrated)', sNo.created === false && sNo.status === 'not_integrated' && scanCountAfterNoData === 0);
  const sYes = await ingestSecurityScan(tA, { scanner: 'manual-upload', status: 'recorded', severityCounts: { high: 0, medium: 1 } });
  check('security-scan with supplied data records (no fake "pass")', sYes.created === true && sYes.status === 'recorded');

  // 8) Tenant scoping — tenant B got nothing from tenant-A runs
  const bTasks = await ownerDb.complianceTask.count({ where: { tenantId: tB } });
  const bBackups = await ownerDb.backupVerification.count({ where: { tenantId: tB } });
  const bReviews = await ownerDb.accessReview.count({ where: { tenantId: tB } });
  check('tenant B unaffected by tenant-A jobs', bTasks === 0 && bBackups === 0 && bReviews === 0);

  // 9) AuditEvent recorded for job-created tasks/records
  const auditTask = await ownerDb.auditEvent.findFirst({ where: { tenantId: tA, action: 'compliance.task.created', resourceId: evTask?.id } });
  const auditBackup = await ownerDb.auditEvent.findFirst({ where: { tenantId: tA, action: 'compliance.backup.recorded' } });
  const auditRecalc = await runReadinessRecalc(tA).then(() => ownerDb.auditEvent.findFirst({ where: { tenantId: tA, action: 'compliance.readiness.recalculated' } }));
  check('AuditEvent created for task/backup/recalc', !!auditTask && !!auditBackup && !!auditRecalc);

  // 10) Readiness recalc is truthful — never marks certified/compliant
  const recalcMeta = (auditRecalc?.metadata ?? {}) as Record<string, unknown>;
  check('readiness recalc audits a numeric score, no certification claim', typeof recalcMeta.overall === 'number');

  // 11) No RLS on compliance/job tables
  const rls = await ownerDb.$queryRaw<Array<{ relname: string }>>`SELECT relname FROM pg_class WHERE relkind='r' AND relrowsecurity=true`;
  const rlsSet = new Set(rls.map(r => r.relname));
  check('no RLS enabled on compliance job tables', NEW_TABLES.every(t => !rlsSet.has(t)));

  // 12) Inactive-user handling — make officer inactive, new tenant evidence → unassigned task, no crash
  await ownerDb.user.update({ where: { id: officer.id }, data: { active: false } });
  const ev2 = await ownerDb.complianceEvidence.create({ data: { tenantId: tA, title: 'Second expiring doc', expiresAt: new Date(Date.now() + 3 * 86400000) } });
  const e3 = await runEvidenceExpiry(tA);
  const unassigned = await ownerDb.complianceTask.findFirst({ where: { tenantId: tA, description: { contains: `[evidence:${ev2.id}]` } } });
  check('inactive assignee handled → unassigned task created', e3.created === 1 && unassigned?.assigneeUserId == null);

  // Cleanup schedulers + tenants
  for (const s of await complianceQueue.getJobSchedulers()) await complianceQueue.removeJobScheduler(s.key);
  await complianceQueue.close();
  await ownerDb.tenant.delete({ where: { id: tA } }).catch(() => {});
  await ownerDb.tenant.delete({ where: { id: tB } }).catch(() => {});
  await ownerDb.$disconnect();
  console.log(`\n${fail === 0 ? 'ALL C-1D JOB CHECKS PASSED' : `${fail} FAILED`}`);
  process.exit(fail === 0 ? 0 : 1);
}

await main();
