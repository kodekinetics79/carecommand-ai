import { db } from '../../lib/db';
import type { Prisma } from '../../generated/prisma/client';
import { forEachActiveJobTenant } from '../../lib/jobTenantResolver';

// ===========================================================================
// Compliance Readiness Center — background job logic (Phase C-1D).
// Pure, queue-agnostic functions so they can be driven by BullMQ and exercised
// directly by tests. Every read/write is explicitly scoped by tenantId (the
// compliance tables are not RLS-enabled yet). All job-created records are
// recorded in the append-only AuditEvent. Nothing here claims certification or
// fabricates passing evidence/scans.
// ===========================================================================

const STATUS_WEIGHT: Record<string, number> = { IMPLEMENTED: 1, IN_PROGRESS: 0.5, NOT_IMPLEMENTED: 0 };
const OPEN_TASK = ['OPEN', 'IN_PROGRESS'] as const;

// Jobs have no request context, so they write AuditEvent directly (actorUserId
// null = system actor) — mirroring the autopilot worker's audit pattern.
async function auditJob(tenantId: string, action: string, resource: string, resourceId: string | null, metadata?: Prisma.InputJsonObject) {
  await db.auditEvent.create({
    data: { tenantId, actorUserId: null, action, resource, resourceId: resourceId ?? undefined, userAgent: 'compliance-job', metadata },
  });
}

// Prefer an active COMPLIANCE_OFFICER, then ADMIN, then OWNER. Inactive users
// are never selected; tenants with no eligible user yield an unassigned task.
async function pickAssignee(tenantId: string): Promise<string | null> {
  const candidates = await db.user.findMany({
    where: { tenantId, active: true, role: { in: ['COMPLIANCE_OFFICER', 'ADMIN', 'OWNER'] } },
    select: { id: true, role: true },
  });
  const pref = ['COMPLIANCE_OFFICER', 'ADMIN', 'OWNER'];
  return candidates.sort((a, b) => pref.indexOf(a.role) - pref.indexOf(b.role))[0]?.id ?? null;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function reviewWindowDays(frequency: string | undefined): number {
  switch ((frequency ?? '').toLowerCase()) {
    case 'monthly': return 30;
    case 'quarterly': return 90;
    case 'semiannual': case 'biannual': return 182;
    case 'annual': case 'yearly': return 365;
    default: return 30;
  }
}

function isoWeek(date = new Date()): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// --- 1) Daily readiness recalculation --------------------------------------
// No score-persistence model exists (the dashboard derives scores live), so we
// recompute and AUDIT the result rather than inventing a table. Truthful only.
export async function runReadinessRecalc(only?: string) {
  const results: Array<{ tenantId: string; overall: number }> = [];
  await forEachActiveJobTenant(only, 'worker:compliance:readiness', async tenantId => {
    const [frameworks, controls] = await Promise.all([
      db.complianceFramework.findMany({ where: { tenantId }, select: { id: true, key: true, weight: true } }),
      db.complianceControl.findMany({ where: { tenantId }, select: { frameworkId: true, status: true } }),
    ]);
    const scoreFor = (fid?: string) => {
      const subset = fid ? controls.filter(c => c.frameworkId === fid) : controls;
      const eligible = subset.filter(c => c.status !== 'NOT_APPLICABLE');
      if (!eligible.length) return 0;
      return Math.round((eligible.reduce((s, c) => s + (STATUS_WEIGHT[c.status] ?? 0), 0) / eligible.length) * 100);
    };
    const perFramework = frameworks.map(f => ({ key: f.key, score: scoreFor(f.id) }));
    const weightTotal = frameworks.reduce((s, f) => s + f.weight, 0) || 1;
    const overall = Math.round(frameworks.reduce((s, f) => s + scoreFor(f.id) * f.weight, 0) / weightTotal);
    await auditJob(tenantId, 'compliance.readiness.recalculated', 'complianceReadiness', null, { overall, perFramework });
    results.push({ tenantId, overall });
  });
  return results;
}

// --- 2) Daily evidence expiry check ----------------------------------------
export async function runEvidenceExpiry(only?: string) {
  let created = 0;
  await forEachActiveJobTenant(only, 'worker:compliance:evidence-expiry', async tenantId => {
    const policy = await db.tenantSecurityPolicy.findUnique({ where: { tenantId }, select: { evidenceReviewFrequency: true } });
    const window = new Date();
    window.setDate(window.getDate() + reviewWindowDays(policy?.evidenceReviewFrequency));
    const expiring = await db.complianceEvidence.findMany({
      where: { tenantId, deletedAt: null, expiresAt: { not: null, lte: window } },
      include: { controlEvidence: { select: { controlId: true }, take: 1 } },
    });
    for (const ev of expiring) {
      const marker = `[evidence:${ev.id}]`;
      const dup = await db.complianceTask.findFirst({ where: { tenantId, status: { in: [...OPEN_TASK] }, description: { contains: marker } } });
      if (dup) continue;
      const assigneeUserId = await pickAssignee(tenantId);
      const task = await db.complianceTask.create({
        data: {
          tenantId,
          title: `Review expiring evidence: ${ev.title}`,
          description: `Evidence expires ${ev.expiresAt?.toISOString().slice(0, 10)}. ${marker}`,
          controlId: ev.controlEvidence[0]?.controlId,
          dueAt: ev.expiresAt ?? undefined,
          assigneeUserId: assigneeUserId ?? undefined,
          status: 'OPEN',
        },
      });
      if (!assigneeUserId) console.warn('[compliance-job] evidence-expiry: no eligible assignee; created an unassigned task');
      await auditJob(tenantId, 'compliance.task.created', 'complianceTask', task.id, { source: 'evidence-expiry', evidenceId: ev.id, assigned: Boolean(assigneeUserId) });
      created += 1;
    }
  });
  return { created };
}

// --- 3) Daily backup verification placeholder ------------------------------
// Truthful placeholder only: records UNVERIFIED with integrated:false. Never
// claims a successful/verified backup. One record per tenant per day.
export async function runBackupPlaceholder(only?: string) {
  let created = 0;
  await forEachActiveJobTenant(only, 'worker:compliance:backup', async tenantId => {
    const existing = await db.backupVerification.findFirst({ where: { tenantId, runAt: { gte: startOfToday() } } });
    if (existing) return;
    const row = await db.backupVerification.create({
      data: { tenantId, type: 'database', status: 'unverified', details: { integrated: false, reason: 'Backup provider not integrated' } },
    });
    await auditJob(tenantId, 'compliance.backup.recorded', 'backupVerification', row.id, { status: 'unverified', integrated: false });
    created += 1;
  });
  return { created };
}

// --- 4) Weekly access review reminder --------------------------------------
export async function runAccessReviewReminder(only?: string) {
  let created = 0;
  const period = isoWeek();
  await forEachActiveJobTenant(only, 'worker:compliance:access-review', async tenantId => {
    const existing = await db.accessReview.findFirst({ where: { tenantId, period } });
    if (existing) return;
    const reviewerUserId = await pickAssignee(tenantId);
    const row = await db.accessReview.create({
      data: { tenantId, period, reviewerUserId: reviewerUserId ?? undefined, status: 'pending', startedAt: new Date() },
    });
    if (!reviewerUserId) console.warn('[compliance-job] access-review: no eligible reviewer; created an unassigned review');
    await auditJob(tenantId, 'compliance.accessReview.created', 'accessReview', row.id, { period, assigned: Boolean(reviewerUserId) });
    created += 1;
  });
  return { created, period };
}

// --- 5) Monthly vendor risk review reminder --------------------------------
export async function runVendorReviewReminder(only?: string) {
  let created = 0;
  const now = new Date();
  await forEachActiveJobTenant(only, 'worker:compliance:vendor-review', async tenantId => {
    const due = await db.vendorRisk.findMany({ where: { tenantId, status: 'active', nextReviewAt: { not: null, lte: now } } });
    for (const vendor of due) {
      const marker = `[vendor:${vendor.id}]`;
      const dup = await db.complianceTask.findFirst({ where: { tenantId, status: { in: [...OPEN_TASK] }, description: { contains: marker } } });
      if (dup) continue;
      const assigneeUserId = await pickAssignee(tenantId);
      const task = await db.complianceTask.create({
        data: {
          tenantId,
          title: `Vendor risk review due: ${vendor.vendorName}`,
          description: `Vendor review due ${vendor.nextReviewAt?.toISOString().slice(0, 10)}. ${marker}`,
          dueAt: vendor.nextReviewAt ?? undefined,
          assigneeUserId: assigneeUserId ?? undefined,
          status: 'OPEN',
        },
      });
      await auditJob(tenantId, 'compliance.task.created', 'complianceTask', task.id, { source: 'vendor-review', vendorId: vendor.id, assigned: Boolean(assigneeUserId) });
      created += 1;
    }
  });
  return { created };
}

// --- 6) Security scan ingestion placeholder --------------------------------
// Only records a result when real scan data is supplied. With no data it does
// NOT fabricate a passing scan — it reports not_integrated.
export interface SecurityScanInput {
  scanner: string;
  status?: string;
  severityCounts?: Prisma.InputJsonObject;
  reportUrl?: string;
}

export async function ingestSecurityScan(tenantId: string, data?: SecurityScanInput) {
  if (!data || !data.scanner) {
    return { created: false, integrated: false, status: 'not_integrated' as const };
  }
  const row = await db.securityScanResult.create({
    data: {
      tenantId,
      scanner: data.scanner,
      status: data.status ?? 'recorded',
      severityCounts: data.severityCounts,
      reportUrl: data.reportUrl,
    },
  });
  await auditJob(tenantId, 'compliance.securityScan.ingested', 'securityScanResult', row.id, { scanner: data.scanner, status: row.status });
  return { created: true, integrated: true, id: row.id, status: row.status };
}
