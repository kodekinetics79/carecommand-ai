import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db } from '../../lib/db';
import { booleanString } from '../../lib/booleanString';
import { audit } from '../../lib/audit';
import { env } from '../../config/env';
import { requireRoles } from '../../plugins/roles';
import { requireFeature } from '../../lib/entitlements';
import type { Prisma } from '../../generated/prisma/client';
import { runWithTenantContext } from '../../lib/tenantContext';

const PASSWORD_MIN_LENGTH = env.PASSWORD_MIN_LENGTH;
const LOCKOUT_THRESHOLD = env.AUTH_LOCKOUT_THRESHOLD;
const LOCKOUT_DURATION_MINUTES = env.AUTH_LOCKOUT_DURATION_MINUTES;

// ===========================================================================
// Compliance Readiness Center — backend APIs (Phase C-1B).
// RBAC: OWNER/ADMIN/COMPLIANCE_OFFICER write; AUDITOR read-only; all other
// roles 403. Tenant scoping is enforced in app code via request.auth.tenantId
// (these tables are not RLS-enabled yet). No certification language; truthful
// placeholders for unintegrated systems (MFA, backups, scanners, deployments).
// ===========================================================================

const complianceRead = requireRoles('OWNER', 'ADMIN', 'COMPLIANCE_OFFICER', 'AUDITOR');
const complianceWrite = requireRoles('OWNER', 'ADMIN', 'COMPLIANCE_OFFICER');

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });

const CONTROL_STATUSES = ['IMPLEMENTED', 'IN_PROGRESS', 'NOT_IMPLEMENTED', 'NOT_APPLICABLE'] as const;
const REVIEW_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;
const RISK_STATUSES = ['OPEN', 'MITIGATING', 'ACCEPTED', 'CLOSED'] as const;

const STATUS_WEIGHT: Record<string, number> = { IMPLEMENTED: 1, IN_PROGRESS: 0.5, NOT_IMPLEMENTED: 0 };

// Validate that any referenced user id belongs to the caller's tenant.
async function assertTenantUser(app: FastifyInstance, tenantId: string, userId?: string | null) {
  if (!userId) return;
  const user = await db.user.findFirst({ where: { id: userId, tenantId }, select: { id: true } });
  if (!user) throw app.httpErrors.badRequest('Referenced user is not in this tenant');
}

async function assertTenantControls(app: FastifyInstance, tenantId: string, controlIds: string[]) {
  if (!controlIds.length) return;
  const found = await db.complianceControl.findMany({ where: { tenantId, id: { in: controlIds } }, select: { id: true } });
  if (found.length !== new Set(controlIds).size) throw app.httpErrors.badRequest('One or more controls are not in this tenant');
}

// Append a tamper-EVIDENT (not immutable) version row: rowHash chains off the
// previous rowHash so any later edit/removal of history is detectable.
async function appendEvidenceVersion(
  tx: Prisma.TransactionClient,
  tenantId: string,
  evidenceId: string,
  changeType: string,
  contentHash: string | null,
  actorUserId: string,
  metadata?: Prisma.InputJsonObject,
) {
  const last = await tx.complianceEvidenceVersion.findFirst({ where: { evidenceId }, orderBy: { version: 'desc' } });
  const version = (last?.version ?? 0) + 1;
  const prevHash = last?.rowHash ?? null;
  const content = contentHash ?? '';
  const rowHash = createHash('sha256').update(`${evidenceId}|${version}|${changeType}|${content}|${prevHash ?? ''}`).digest('hex');
  await tx.complianceEvidenceVersion.create({
    data: { tenantId, evidenceId, version, changeType, contentHash: content, prevHash, rowHash, actorUserId, metadata },
  });
}

function tenant(request: FastifyRequest) {
  return request.auth.tenantId;
}

export const complianceCenterRoutes: FastifyPluginAsync = async app => {
  // Feature gate: the Compliance Readiness Center requires the
  // compliance_readiness entitlement (in addition to the per-route RBAC below).
  app.addHook('preHandler', requireFeature('compliance_readiness'));

  // ===== Dashboard =========================================================
  app.get('/dashboard', { preHandler: complianceRead }, async request => {
    const tenantId = tenant(request);
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + 30);

    const [frameworks, controls, risks, incidents, latestBackup, recentAudit, controlEvidenceLinks, expiringEvidence, activeUsers, mfaUsers, secPolicy] = await Promise.all([
      db.complianceFramework.findMany({ where: { tenantId } }),
      db.complianceControl.findMany({ where: { tenantId }, select: { id: true, frameworkId: true, status: true } }),
      db.complianceRisk.findMany({ where: { tenantId }, select: { status: true } }),
      db.securityIncident.findMany({ where: { tenantId }, select: { status: true } }),
      db.backupVerification.findFirst({ where: { tenantId }, orderBy: { runAt: 'desc' } }),
      db.auditEvent.findMany({ where: { tenantId }, orderBy: { occurredAt: 'desc' }, take: 10, include: { actorUser: { select: { displayName: true } } } }),
      db.complianceControlEvidence.findMany({ where: { tenantId, evidence: { deletedAt: null } }, select: { controlId: true } }),
      db.complianceEvidence.count({ where: { tenantId, deletedAt: null, expiresAt: { not: null, gte: new Date(), lte: horizon } } }),
      db.user.count({ where: { tenantId, active: true } }),
      db.user.count({ where: { tenantId, active: true, mfaEnabled: true } }),
      db.tenantSecurityPolicy.findUnique({ where: { tenantId } }),
    ]);

    const scoreFor = (frameworkId?: string) => {
      const subset = frameworkId ? controls.filter(c => c.frameworkId === frameworkId) : controls;
      const eligible = subset.filter(c => c.status !== 'NOT_APPLICABLE');
      if (!eligible.length) return 0;
      const total = eligible.reduce((sum, c) => sum + (STATUS_WEIGHT[c.status] ?? 0), 0);
      return Math.round((total / eligible.length) * 100);
    };
    const byKey = (key: string) => {
      const fw = frameworks.find(f => f.key === key);
      return fw ? scoreFor(fw.id) : 0;
    };

    const frameworkScores = frameworks.map(f => ({ key: f.key, name: f.name, score: scoreFor(f.id) }));
    const weightTotal = frameworks.reduce((sum, f) => sum + f.weight, 0) || 1;
    const overall = Math.round(frameworks.reduce((sum, f) => sum + scoreFor(f.id) * f.weight, 0) / weightTotal);

    const controlsWithEvidence = new Set(controlEvidenceLinks.map(l => l.controlId));
    const missingEvidence = controls.filter(c => c.status !== 'NOT_APPLICABLE' && !controlsWithEvidence.has(c.id)).length;

    return {
      overallReadinessScore: overall,
      frameworks: frameworkScores,
      soc2ReadinessPct: byKey('soc2_readiness'),
      hipaaAlignmentPct: byKey('hipaa_alignment'),
      internalBaselinePct: byKey('internal_baseline'),
      openRisks: risks.filter(r => r.status === 'OPEN' || r.status === 'MITIGATING').length,
      notImplementedControls: controls.filter(c => c.status === 'NOT_IMPLEMENTED').length,
      missingEvidenceCount: missingEvidence,
      expiringEvidenceCount: expiringEvidence,
      recentAuditEvents: recentAudit.map(e => ({
        id: e.id, action: e.action, resource: e.resource, resourceId: e.resourceId,
        actor: e.actorUser?.displayName ?? 'System', occurredAt: e.occurredAt.toISOString(),
      })),
      securityIncidents: {
        total: incidents.length,
        open: incidents.filter(i => i.status === 'open').length,
        resolved: incidents.filter(i => i.status === 'resolved').length,
      },
      backupStatus: latestBackup
        ? { integrated: latestBackup.status === 'verified', status: latestBackup.status, lastRunAt: latestBackup.runAt.toISOString() }
        : { integrated: false, status: 'unverified', lastRunAt: null },
      mfaStatus: {
        integrated: true,
        enforced: secPolicy?.requireMfa ?? false,
        adoptionPct: activeUsers > 0 ? Math.round((mfaUsers / activeUsers) * 100) : 0,
        enrolledUsers: mfaUsers,
        totalUsers: activeUsers,
        note: secPolicy?.requireMfa ? 'TOTP MFA is enforced by tenant policy.' : 'TOTP MFA is available but not enforced by policy.',
      },
    };
  });

  // ===== Controls ==========================================================
  app.get('/controls', { preHandler: complianceRead }, async request => {
    const query = z.object({ frameworkKey: z.string().optional(), status: z.enum(CONTROL_STATUSES).optional(), categoryKey: z.string().optional() }).parse(request.query);
    return db.complianceControl.findMany({
      where: {
        tenantId: tenant(request),
        ...(query.status ? { status: query.status } : {}),
        ...(query.categoryKey ? { categoryKey: query.categoryKey } : {}),
        ...(query.frameworkKey ? { framework: { key: query.frameworkKey } } : {}),
      },
      orderBy: [{ categoryKey: 'asc' }, { controlKey: 'asc' }],
      include: { framework: { select: { key: true, name: true } } },
    });
  });

  app.patch('/controls/:id', { preHandler: complianceWrite }, async request => {
    const { id } = idParam.parse(request.params);
    const body = z.object({
      status: z.enum(CONTROL_STATUSES).optional(),
      ownerUserId: uuid.nullable().optional(),
      notes: z.string().max(2000).nullable().optional(),
      lastReviewedAt: z.coerce.date().nullable().optional(),
    }).parse(request.body);
    const existing = await db.complianceControl.findFirst({ where: { id, tenantId: tenant(request) } });
    if (!existing) throw app.httpErrors.notFound('Control not found');
    await assertTenantUser(app, tenant(request), body.ownerUserId ?? undefined);
    const row = await db.complianceControl.update({ where: { id }, data: body });
    await audit(request, { action: 'compliance.control.updated', resource: 'complianceControl', resourceId: id, metadata: { status: body.status ?? existing.status } });
    return row;
  });

  // ===== Evidence (metadata/link/hash only; soft delete; version chain) ====
  app.get('/evidence', { preHandler: complianceRead }, async request => {
    // booleanString, not z.coerce.boolean(): the latter coerces "false" → true.
    const query = z.object({ includeDeleted: booleanString(false), reviewStatus: z.enum(REVIEW_STATUSES).optional() }).parse(request.query);
    return db.complianceEvidence.findMany({
      where: {
        tenantId: tenant(request),
        ...(query.includeDeleted ? {} : { deletedAt: null }),
        ...(query.reviewStatus ? { reviewStatus: query.reviewStatus } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: { controlEvidence: { select: { controlId: true } }, _count: { select: { versions: true } } },
    });
  });

  const evidenceCreate = z.object({
    title: z.string().trim().min(2).max(200),
    description: z.string().max(2000).optional(),
    ownerUserId: uuid.optional(),
    reviewStatus: z.enum(REVIEW_STATUSES).default('PENDING'),
    sourceType: z.string().trim().max(40).default('manual'),
    externalUrl: z.string().trim().max(500).optional(),
    contentHash: z.string().trim().max(128).optional(),
    auditorNotes: z.string().max(2000).optional(),
    expiresAt: z.coerce.date().optional(),
    controlIds: z.array(uuid).default([]),
  });

  app.post('/evidence', { preHandler: complianceWrite }, async (request, reply) => {
    const input = evidenceCreate.parse(request.body);
    const tenantId = tenant(request);
    await assertTenantUser(app, tenantId, input.ownerUserId);
    await assertTenantControls(app, tenantId, input.controlIds);
    const row = await db.$transaction(async tx => {
      const evidence = await tx.complianceEvidence.create({
        data: {
          tenantId, title: input.title, description: input.description, ownerUserId: input.ownerUserId,
          reviewStatus: input.reviewStatus, sourceType: input.sourceType, externalUrl: input.externalUrl,
          contentHash: input.contentHash, auditorNotes: input.auditorNotes, expiresAt: input.expiresAt,
        },
      });
      for (const controlId of new Set(input.controlIds)) {
        await tx.complianceControlEvidence.create({ data: { tenantId, controlId, evidenceId: evidence.id } });
      }
      await appendEvidenceVersion(tx, tenantId, evidence.id, 'created', input.contentHash ?? null, request.auth.userId);
      return evidence;
    });
    await audit(request, { action: 'compliance.evidence.created', resource: 'complianceEvidence', resourceId: row.id });
    return reply.code(201).send(row);
  });

  app.patch('/evidence/:id', { preHandler: complianceWrite }, async request => {
    const { id } = idParam.parse(request.params);
    const input = z.object({
      title: z.string().trim().min(2).max(200).optional(),
      description: z.string().max(2000).nullable().optional(),
      ownerUserId: uuid.nullable().optional(),
      reviewStatus: z.enum(REVIEW_STATUSES).optional(),
      sourceType: z.string().trim().max(40).optional(),
      externalUrl: z.string().trim().max(500).nullable().optional(),
      contentHash: z.string().trim().max(128).nullable().optional(),
      auditorNotes: z.string().max(2000).nullable().optional(),
      expiresAt: z.coerce.date().nullable().optional(),
      controlIds: z.array(uuid).optional(),
    }).parse(request.body);
    const tenantId = tenant(request);
    const existing = await db.complianceEvidence.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!existing) throw app.httpErrors.notFound('Evidence not found');
    await assertTenantUser(app, tenantId, input.ownerUserId ?? undefined);
    if (input.controlIds) await assertTenantControls(app, tenantId, input.controlIds);

    const reviewed = input.reviewStatus && input.reviewStatus !== existing.reviewStatus;
    const { controlIds, ...evidenceData } = input;
    const row = await db.$transaction(async tx => {
      const updated = await tx.complianceEvidence.update({
        where: { id },
        data: { ...evidenceData, ...(reviewed ? { reviewedAt: new Date() } : {}) },
      });
      if (controlIds) {
        await tx.complianceControlEvidence.deleteMany({ where: { tenantId, evidenceId: id } });
        for (const controlId of new Set(controlIds)) {
          await tx.complianceControlEvidence.create({ data: { tenantId, controlId, evidenceId: id } });
        }
      }
      await appendEvidenceVersion(tx, tenantId, id, reviewed ? 'reviewed' : 'updated', updated.contentHash, request.auth.userId);
      return updated;
    });
    await audit(request, {
      action: reviewed ? 'compliance.evidence.reviewed' : 'compliance.evidence.updated',
      resource: 'complianceEvidence', resourceId: id,
      metadata: reviewed ? { reviewStatus: input.reviewStatus } : undefined,
    });
    return row;
  });

  app.delete('/evidence/:id', { preHandler: complianceWrite }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const tenantId = tenant(request);
    const existing = await db.complianceEvidence.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!existing) throw app.httpErrors.notFound('Evidence not found');
    await db.$transaction(async tx => {
      await tx.complianceEvidence.update({ where: { id }, data: { deletedAt: new Date() } });
      await appendEvidenceVersion(tx, tenantId, id, 'deleted', existing.contentHash, request.auth.userId);
    });
    await audit(request, { action: 'compliance.evidence.deleted', resource: 'complianceEvidence', resourceId: id, metadata: { softDelete: true } });
    return reply.code(204).send();
  });

  app.get('/evidence/:id/versions', { preHandler: complianceRead }, async request => {
    const { id } = idParam.parse(request.params);
    const existing = await db.complianceEvidence.findFirst({ where: { id, tenantId: tenant(request) }, select: { id: true } });
    if (!existing) throw app.httpErrors.notFound('Evidence not found');
    return db.complianceEvidenceVersion.findMany({ where: { tenantId: tenant(request), evidenceId: id }, orderBy: { version: 'asc' } });
  });

  // ===== Risks =============================================================
  app.get('/risks', { preHandler: complianceRead }, async request => {
    const query = z.object({ status: z.enum(RISK_STATUSES).optional() }).parse(request.query);
    return db.complianceRisk.findMany({
      where: { tenantId: tenant(request), ...(query.status ? { status: query.status } : {}) },
      orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
    });
  });

  app.post('/risks', { preHandler: complianceWrite }, async (request, reply) => {
    const input = z.object({
      title: z.string().trim().min(2).max(200),
      description: z.string().max(2000).optional(),
      categoryKey: z.string().trim().min(2).max(60),
      likelihood: z.string().trim().max(20).default('medium'),
      impact: z.string().trim().max(20).default('medium'),
      score: z.number().int().min(0).max(100).default(0),
      status: z.enum(RISK_STATUSES).default('OPEN'),
      ownerUserId: uuid.optional(),
      mitigationPlan: z.string().max(2000).optional(),
    }).parse(request.body);
    await assertTenantUser(app, tenant(request), input.ownerUserId);
    const row = await db.complianceRisk.create({ data: { tenantId: tenant(request), ...input } });
    await audit(request, { action: 'compliance.risk.created', resource: 'complianceRisk', resourceId: row.id });
    return reply.code(201).send(row);
  });

  app.patch('/risks/:id', { preHandler: complianceWrite }, async request => {
    const { id } = idParam.parse(request.params);
    const input = z.object({
      title: z.string().trim().min(2).max(200).optional(),
      description: z.string().max(2000).nullable().optional(),
      categoryKey: z.string().trim().min(2).max(60).optional(),
      likelihood: z.string().trim().max(20).optional(),
      impact: z.string().trim().max(20).optional(),
      score: z.number().int().min(0).max(100).optional(),
      status: z.enum(RISK_STATUSES).optional(),
      ownerUserId: uuid.nullable().optional(),
      mitigationPlan: z.string().max(2000).nullable().optional(),
    }).parse(request.body);
    const existing = await db.complianceRisk.findFirst({ where: { id, tenantId: tenant(request) } });
    if (!existing) throw app.httpErrors.notFound('Risk not found');
    await assertTenantUser(app, tenant(request), input.ownerUserId ?? undefined);
    const row = await db.complianceRisk.update({ where: { id }, data: input });
    await audit(request, { action: 'compliance.risk.updated', resource: 'complianceRisk', resourceId: id, metadata: { status: input.status ?? existing.status } });
    return row;
  });

  // ===== Audit logs (reuse AuditEvent) =====================================
  app.get('/audit-logs', { preHandler: complianceRead }, async request => {
    const query = z.object({
      action: z.string().trim().optional(),
      resource: z.string().trim().optional(),
      actorUserId: uuid.optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(request.query);
    const rows = await db.auditEvent.findMany({
      where: {
        tenantId: tenant(request),
        ...(query.action ? { action: query.action } : {}),
        ...(query.resource ? { resource: query.resource } : {}),
        ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
        ...(query.from || query.to ? { occurredAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: query.limit,
      include: { actorUser: { select: { displayName: true, email: true, role: true } } },
    });
    return rows.map(e => ({
      id: e.id, action: e.action, resource: e.resource, resourceId: e.resourceId,
      actor: e.actorUser?.displayName ?? 'System', actorRole: e.actorUser?.role ?? null,
      ipAddress: e.ipAddress, occurredAt: e.occurredAt.toISOString(), metadata: e.metadata ?? null,
    }));
  });

  // ===== Reports (real data where available; truthful placeholders else) ===
  app.get('/reports/mfa', { preHandler: complianceRead }, async request => {
    const tenantId = tenant(request);
    const [totalUsers, mfaEnabledUsers, policy] = await Promise.all([
      db.user.count({ where: { tenantId, active: true } }),
      db.user.count({ where: { tenantId, active: true, mfaEnabled: true } }),
      db.tenantSecurityPolicy.findUnique({ where: { tenantId } }),
    ]);
    return {
      integrated: true,
      status: 'integrated',
      method: 'TOTP',
      enforced: policy?.requireMfa ?? false,
      totalUsers,
      mfaEnabledUsers,
      adoptionPct: totalUsers > 0 ? Math.round((mfaEnabledUsers / totalUsers) * 100) : 0,
      note: policy?.requireMfa
        ? 'TOTP MFA is enforced by tenant policy; users without verified MFA must enroll at login.'
        : 'TOTP MFA is available; adoption reflects users with a verified authenticator.',
    };
  });

  app.get('/reports/password-policy', { preHandler: complianceRead }, async request => {
    const policy = await db.tenantSecurityPolicy.findUnique({ where: { tenantId: tenant(request) } });
    const lockoutEnabled = policy?.failedLoginLockout ?? false;
    const expiryDays = policy?.passwordExpiryDays ?? null;
    return {
      integrated: true,
      hashing: 'scrypt',
      minLength: PASSWORD_MIN_LENGTH,
      expiryDays,
      expiryEnforced: typeof expiryDays === 'number' && expiryDays > 0,
      lockoutEnabled,
      lockoutThreshold: lockoutEnabled ? LOCKOUT_THRESHOLD : null,
      lockoutDurationMinutes: lockoutEnabled ? LOCKOUT_DURATION_MINUTES : null,
      historyEnforced: false,
      note: 'Account lockout and password expiry are enforced when enabled in the tenant security policy. Password history is not enforced.',
    };
  });

  app.get('/reports/access-review', { preHandler: complianceRead }, async request => {
    const tenantId = tenant(request);
    const [reviews, users] = await Promise.all([
      db.accessReview.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 20 }),
      db.user.findMany({ where: { tenantId }, select: { id: true, displayName: true, email: true, role: true, active: true, lastLoginAt: true } }),
    ]);
    return {
      integrated: true,
      reviews,
      userCount: users.length,
      activeUsers: users.filter(u => u.active).length,
      users: users.map(u => ({ ...u, lastLoginAt: u.lastLoginAt?.toISOString() ?? null })),
    };
  });

  app.get('/reports/role-changes', { preHandler: complianceRead }, async request => {
    const rows = await db.auditEvent.findMany({
      where: { tenantId: tenant(request), action: 'admin.user.roleChanged' },
      orderBy: { occurredAt: 'desc' }, take: 100,
      include: { actorUser: { select: { displayName: true } } },
    });
    return { integrated: true, changes: rows.map(e => ({ id: e.id, resourceId: e.resourceId, actor: e.actorUser?.displayName ?? 'System', occurredAt: e.occurredAt.toISOString(), metadata: e.metadata ?? null })) };
  });

  app.get('/reports/login-activity', { preHandler: complianceRead }, async request => {
    const rows = await db.auditEvent.findMany({
      where: { tenantId: tenant(request), action: { in: ['auth.login.success', 'auth.login.failed', 'auth.logout', 'auth.session.revoked',
          // Credential changes are security activity. Without these a password
          // change or an admin-initiated reset is audited but invisible in the
          // very report an auditor opens to review account activity.
          'auth.password.changed', 'auth.password.change.failed',
          'auth.password.reset.requested', 'controlPlane.user.passwordReset',
          'controlPlane.session.revoked'] } },
      orderBy: { occurredAt: 'desc' }, take: 100,
      include: { actorUser: { select: { displayName: true, email: true } } },
    });
    return {
      integrated: true,
      events: rows.map(e => ({ id: e.id, status: e.action.endsWith('failed') ? 'failed' : 'success', action: e.action, actor: e.actorUser?.displayName ?? null, ipAddress: e.ipAddress, occurredAt: e.occurredAt.toISOString() })),
    };
  });

  app.get('/reports/backup-status', { preHandler: complianceRead }, async request => {
    const rows = await db.backupVerification.findMany({ where: { tenantId: tenant(request) }, orderBy: { runAt: 'desc' }, take: 30 });
    if (!rows.length) return { integrated: false, status: 'unverified', records: [], note: 'No automated backup verification integration yet.' };
    return { integrated: rows.some(r => r.status === 'verified'), status: rows[0].status, records: rows.map(r => ({ id: r.id, runAt: r.runAt.toISOString(), type: r.type, status: r.status, location: r.location })) };
  });

  app.get('/reports/deployment-history', { preHandler: complianceRead }, async () => {
    // No deployment-tracking integration; surface schema-migration history as a
    // truthful proxy, explicitly flagged as not a full deployment record.
    const migrations = await db.$queryRaw<Array<{ migration_name: string; finished_at: Date | null }>>`
      SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY finished_at DESC NULLS LAST LIMIT 20`;
    return { integrated: false, status: 'not_integrated', note: 'Deployment tracking is not integrated; showing schema migration history only.', schemaMigrations: migrations.map(m => ({ name: m.migration_name, appliedAt: m.finished_at?.toISOString() ?? null })) };
  });

  app.get('/reports/security-scans', { preHandler: complianceRead }, async request => {
    const rows = await db.securityScanResult.findMany({ where: { tenantId: tenant(request) }, orderBy: { scanAt: 'desc' }, take: 20 });
    if (!rows.length) return { integrated: false, status: 'not_integrated', results: [], note: 'No security scanner integration yet.' };
    return { integrated: true, status: rows[0].status, results: rows };
  });

  app.get('/reports/incident-response', { preHandler: complianceRead }, async request => {
    const rows = await db.securityIncident.findMany({ where: { tenantId: tenant(request) }, orderBy: { detectedAt: 'desc' }, take: 50 });
    return {
      integrated: rows.length > 0,
      total: rows.length,
      open: rows.filter(r => r.status === 'open').length,
      resolved: rows.filter(r => r.status === 'resolved').length,
      incidents: rows.map(r => ({ id: r.id, title: r.title, severity: r.severity, status: r.status, detectedAt: r.detectedAt.toISOString(), resolvedAt: r.resolvedAt?.toISOString() ?? null })),
      note: rows.length ? undefined : 'No incidents recorded; no formal incident-response automation yet.',
    };
  });

  // ===== Security policy ===================================================
  app.get('/security-policy', { preHandler: complianceRead }, async request => {
    const tenantId = tenant(request);
    const existing = await db.tenantSecurityPolicy.findUnique({ where: { tenantId } });
    if (existing) return existing;
    return db.tenantSecurityPolicy.create({ data: { tenantId } });
  });

  app.put('/security-policy', { preHandler: complianceWrite }, async request => {
    const input = z.object({
      requireMfa: z.boolean().optional(),
      passwordExpiryDays: z.number().int().min(0).max(3650).nullable().optional(),
      sessionTimeoutMinutes: z.number().int().min(1).max(1440).optional(),
      failedLoginLockout: z.boolean().optional(),
      allowedIpRanges: z.array(z.string().trim().max(64)).optional(),
      dataRetentionDays: z.number().int().min(1).max(36500).optional(),
      backupFrequency: z.string().trim().max(40).optional(),
      evidenceReviewFrequency: z.string().trim().max(40).optional(),
    }).parse(request.body);
    const tenantId = tenant(request);
    const row = await runWithTenantContext(tenantId, async tx => {
      const existing = await tx.tenantSecurityPolicy.findUnique({ where: { tenantId } });
      const enablingMfa = input.requireMfa === true && !existing?.requireMfa;
      const revokedAt = enablingMfa ? new Date() : undefined;
      if (enablingMfa) {
        await tx.user.updateMany({
          where: { tenantId },
          data: { refreshTokenHash: null, refreshTokenExpiresAt: null },
        });
      }
      const updated = await tx.tenantSecurityPolicy.upsert({
        where: { tenantId },
        update: { ...input, sessionsRevokedAt: revokedAt },
        create: { tenantId, ...input, sessionsRevokedAt: revokedAt },
      });
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorUserId: request.auth.userId,
          action: 'compliance.securityPolicy.updated',
          resource: 'tenantSecurityPolicy',
          resourceId: updated.id,
          requestId: request.id,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
          metadata: input as Prisma.InputJsonObject,
        },
      });
      return updated;
    });
    return row;
  });

  // ===== Vendors ===========================================================
  app.get('/vendors', { preHandler: complianceRead }, async request =>
    db.vendorRisk.findMany({ where: { tenantId: tenant(request) }, orderBy: { createdAt: 'desc' } }));

  app.post('/vendors', { preHandler: complianceWrite }, async (request, reply) => {
    const input = z.object({
      vendorName: z.string().trim().min(2).max(160),
      category: z.string().trim().max(80).optional(),
      dataAccessLevel: z.string().trim().max(80).optional(),
      baaStatus: z.string().trim().max(40).default('unknown'),
      riskTier: z.string().trim().max(40).default('medium'),
      lastReviewedAt: z.coerce.date().optional(),
      nextReviewAt: z.coerce.date().optional(),
      status: z.string().trim().max(40).default('active'),
      notes: z.string().max(2000).optional(),
    }).parse(request.body);
    const row = await db.vendorRisk.create({ data: { tenantId: tenant(request), ...input } });
    await audit(request, { action: 'compliance.vendor.created', resource: 'vendorRisk', resourceId: row.id });
    return reply.code(201).send(row);
  });

  app.patch('/vendors/:id', { preHandler: complianceWrite }, async request => {
    const { id } = idParam.parse(request.params);
    const input = z.object({
      vendorName: z.string().trim().min(2).max(160).optional(),
      category: z.string().trim().max(80).nullable().optional(),
      dataAccessLevel: z.string().trim().max(80).nullable().optional(),
      baaStatus: z.string().trim().max(40).optional(),
      riskTier: z.string().trim().max(40).optional(),
      lastReviewedAt: z.coerce.date().nullable().optional(),
      nextReviewAt: z.coerce.date().nullable().optional(),
      status: z.string().trim().max(40).optional(),
      notes: z.string().max(2000).nullable().optional(),
    }).parse(request.body);
    const existing = await db.vendorRisk.findFirst({ where: { id, tenantId: tenant(request) } });
    if (!existing) throw app.httpErrors.notFound('Vendor not found');
    const row = await db.vendorRisk.update({ where: { id }, data: input });
    await audit(request, { action: 'compliance.vendor.updated', resource: 'vendorRisk', resourceId: id });
    return row;
  });

  // ===== Incidents =========================================================
  app.get('/incidents', { preHandler: complianceRead }, async request =>
    db.securityIncident.findMany({ where: { tenantId: tenant(request) }, orderBy: { detectedAt: 'desc' } }));

  app.post('/incidents', { preHandler: complianceWrite }, async (request, reply) => {
    const input = z.object({
      title: z.string().trim().min(2).max(200),
      severity: z.string().trim().max(20).default('low'),
      status: z.string().trim().max(20).default('open'),
      detectedAt: z.coerce.date().optional(),
      summary: z.string().max(4000).optional(),
      affectedScope: z.string().max(500).optional(),
      reportedByUserId: uuid.optional(),
    }).parse(request.body);
    await assertTenantUser(app, tenant(request), input.reportedByUserId);
    const row = await db.securityIncident.create({ data: { tenantId: tenant(request), ...input } });
    await audit(request, { action: 'compliance.incident.created', resource: 'securityIncident', resourceId: row.id, metadata: { severity: input.severity } });
    return reply.code(201).send(row);
  });

  app.patch('/incidents/:id', { preHandler: complianceWrite }, async request => {
    const { id } = idParam.parse(request.params);
    const input = z.object({
      title: z.string().trim().min(2).max(200).optional(),
      severity: z.string().trim().max(20).optional(),
      status: z.string().trim().max(20).optional(),
      resolvedAt: z.coerce.date().nullable().optional(),
      summary: z.string().max(4000).nullable().optional(),
      affectedScope: z.string().max(500).nullable().optional(),
    }).parse(request.body);
    const existing = await db.securityIncident.findFirst({ where: { id, tenantId: tenant(request) } });
    if (!existing) throw app.httpErrors.notFound('Incident not found');
    const row = await db.securityIncident.update({ where: { id }, data: input });
    await audit(request, { action: 'compliance.incident.updated', resource: 'securityIncident', resourceId: id, metadata: { status: input.status ?? existing.status } });
    return row;
  });

  // ===== Access reviews ====================================================
  app.get('/access-reviews', { preHandler: complianceRead }, async request =>
    db.accessReview.findMany({ where: { tenantId: tenant(request) }, orderBy: { createdAt: 'desc' } }));

  app.post('/access-reviews', { preHandler: complianceWrite }, async (request, reply) => {
    const input = z.object({
      period: z.string().trim().min(2).max(40),
      reviewerUserId: uuid.optional(),
      status: z.string().trim().max(20).default('pending'),
      startedAt: z.coerce.date().optional(),
    }).parse(request.body);
    await assertTenantUser(app, tenant(request), input.reviewerUserId);
    const row = await db.accessReview.create({ data: { tenantId: tenant(request), ...input } });
    await audit(request, { action: 'compliance.accessReview.created', resource: 'accessReview', resourceId: row.id });
    return reply.code(201).send(row);
  });

  app.patch('/access-reviews/:id', { preHandler: complianceWrite }, async request => {
    const { id } = idParam.parse(request.params);
    const input = z.object({
      period: z.string().trim().min(2).max(40).optional(),
      reviewerUserId: uuid.nullable().optional(),
      status: z.string().trim().max(20).optional(),
      findings: z.record(z.string(), z.unknown()).optional(),
      startedAt: z.coerce.date().nullable().optional(),
      completedAt: z.coerce.date().nullable().optional(),
    }).parse(request.body);
    const existing = await db.accessReview.findFirst({ where: { id, tenantId: tenant(request) } });
    if (!existing) throw app.httpErrors.notFound('Access review not found');
    await assertTenantUser(app, tenant(request), input.reviewerUserId ?? undefined);
    const { findings, ...rest } = input;
    const row = await db.accessReview.update({
      where: { id },
      data: { ...rest, ...(findings !== undefined ? { findings: findings as Prisma.InputJsonObject } : {}) },
    });
    await audit(request, { action: 'compliance.accessReview.updated', resource: 'accessReview', resourceId: id, metadata: { status: input.status ?? existing.status } });
    return row;
  });
};
