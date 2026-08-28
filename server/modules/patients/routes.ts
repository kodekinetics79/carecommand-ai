import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { audit } from '../../lib/audit';
import { cursorPage, paginationSchema } from '../../lib/pagination';
import { requirePermission } from '../../lib/permissions';
import { assertBranchAccess, branchScope } from '../../lib/scope';
import { runWithTenantContext } from '../../lib/tenantContext';
import { Prisma } from '../../generated/prisma/client';

// Patient mutations now gate on the action permission `patient:write` (default
// matrix: OWNER/ADMIN/MANAGER/FRONT_DESK — preserving prior role membership)
// rather than a hardcoded role list, so a tenant's custom role grants/revokes
// are actually enforced here. Read routes remain open to any authenticated user.
const canWritePatients = requirePermission('patient:write');
// PHI reads now ENFORCE `patient:read` (previously a cosmetic toggle) and are
// audited (HIPAA access accounting). Read RBAC is enforced server-side, never
// frontend-only.
const canReadPatients = requirePermission('patient:read');
// Full PHI export is least-privilege (owner/admin/compliance) and audited as an
// access disclosure — see the data-export route below.
const canExportPatients = requirePermission('patient:export');

const patientQuery = paginationSchema.extend({
  branchId: z.string().uuid().optional(),
  search: z.string().trim().max(120).optional(),
  lifecycleStage: z.enum(['NEW', 'ACTIVE', 'AT_RISK', 'INACTIVE', 'LOST', 'RETAINED']).optional(),
});

const patientInput = z.object({
  branchId: z.string().uuid(),
  externalRef: z.string().trim().min(1).max(120).optional(),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  // Front-desk demographic capture / identity verification. Optional, date-only.
  dateOfBirth: z.coerce.date().refine(v => v <= new Date(), { message: 'dateOfBirth cannot be in the future' }).optional(),
  email: z.string().email().trim().toLowerCase().optional(),
  phone: z.string().trim().max(40).optional(),
  lifecycleStage: z.enum(['NEW', 'ACTIVE', 'AT_RISK', 'INACTIVE', 'LOST', 'RETAINED']).default('NEW'),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
});

// Edit is a partial correction: every field optional, but at least one required
// so an empty PATCH is a 400 rather than a silent no-op. branchId is intentionally
// not editable here (moving a patient across branches is a separate operation).
const patientUpdateInput = z.object({
  externalRef: z.string().trim().min(1).max(120).optional(),
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  dateOfBirth: z.coerce.date().refine(v => v <= new Date(), { message: 'dateOfBirth cannot be in the future' }).optional(),
  email: z.string().email().trim().toLowerCase().optional(),
  phone: z.string().trim().max(40).optional(),
  lifecycleStage: z.enum(['NEW', 'ACTIVE', 'AT_RISK', 'INACTIVE', 'LOST', 'RETAINED']).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
}).refine(input => Object.keys(input).length > 0, {
  message: 'At least one field must be provided to update',
});

type PatientIdentity = {
  externalRef?: string | null;
  firstName: string;
  lastName: string;
  dateOfBirth?: Date | null;
  email?: string | null;
  phone?: string | null;
};

const canonicalText = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const canonicalPhone = (value?: string | null) => value?.replace(/\D/g, '') || null;
const canonicalDate = (value?: Date | null) => value ? value.toISOString().slice(0, 10) : null;

function identityKeys(tenantId: string, identity: PatientIdentity) {
  const name = `${canonicalText(identity.firstName)}|${canonicalText(identity.lastName)}`;
  const keys = [
    identity.externalRef ? `external:${canonicalText(identity.externalRef)}` : null,
    identity.email ? `email-name:${canonicalText(identity.email)}|${name}` : null,
    canonicalPhone(identity.phone) ? `phone-name:${canonicalPhone(identity.phone)}|${name}` : null,
    canonicalDate(identity.dateOfBirth) ? `dob-name:${canonicalDate(identity.dateOfBirth)}|${name}` : null,
  ].filter((key): key is string => Boolean(key));
  return [...new Set(keys)].sort().map(key => `patient.identity:${tenantId}:${key}`);
}

async function lockPatientIdentity(tx: Prisma.TransactionClient, tenantId: string, identity: PatientIdentity) {
  // Each canonical identifier is locked independently and in sorted order.
  // Thus adding/removing an unrelated payload field cannot evade serialization,
  // and requests sharing more than one key cannot deadlock each other.
  for (const key of identityKeys(tenantId, identity)) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text, 0))::text AS locked`;
  }
}

async function findIdentityCollision(
  tx: Prisma.TransactionClient,
  tenantId: string,
  identity: PatientIdentity,
  excludeId?: string,
) {
  const externalRef = identity.externalRef ? canonicalText(identity.externalRef) : null;
  const firstName = canonicalText(identity.firstName);
  const lastName = canonicalText(identity.lastName);
  const rows = await tx.patient.findMany({
    where: {
      tenantId,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      OR: [
        ...(externalRef ? [{ externalRef: { equals: identity.externalRef!, mode: 'insensitive' as const } }] : []),
        {
          deletedAt: null,
          firstName: { equals: identity.firstName, mode: 'insensitive' },
          lastName: { equals: identity.lastName, mode: 'insensitive' },
        },
      ],
    },
    select: { id: true, deletedAt: true, externalRef: true, firstName: true, lastName: true, dateOfBirth: true, email: true, phone: true },
  });
  for (const row of rows) {
    if (externalRef && row.externalRef && canonicalText(row.externalRef) === externalRef) {
      return { id: row.id, reason: row.deletedAt ? 'archived_external_ref' as const : 'external_ref' as const };
    }
    const sameName = canonicalText(row.firstName) === firstName && canonicalText(row.lastName) === lastName;
    if (!sameName || row.deletedAt) continue;
    if (identity.email && row.email && canonicalText(identity.email) === canonicalText(row.email)) return { id: row.id, reason: 'email_name' as const };
    if (canonicalPhone(identity.phone) && canonicalPhone(identity.phone) === canonicalPhone(row.phone)) return { id: row.id, reason: 'phone_name' as const };
    if (canonicalDate(identity.dateOfBirth) && canonicalDate(identity.dateOfBirth) === canonicalDate(row.dateOfBirth)) return { id: row.id, reason: 'dob_name' as const };
  }
  return null;
}

function identityConflict(app: Parameters<FastifyPluginAsync>[0], reason?: string) {
  return app.httpErrors.conflict(reason === 'archived_external_ref'
    ? 'This external reference belongs to an archived patient. Restore or reconcile that record before reusing the identifier.'
    : 'A possible duplicate patient already exists. Review the existing record before continuing.');
}

export const patientRoutes: FastifyPluginAsync = async app => {
  app.get('/', { preHandler: canReadPatients }, async request => {
    const query = patientQuery.parse(request.query);
    const phoneSearch = query.search?.replace(/\D/g, '');
    const rows = await runWithTenantContext(request.auth.tenantId, async tx => {
      // Compatibility path for legacy formatted phones. It is strictly tenant
      // and branch scoped. Full canonical searches are exact; a 10-digit local
      // NANP search may match a stored value with a 1-3 digit country code. A future
      // schema-council migration should backfill/index a canonical phone column;
      // until then this avoids a cross-tenant or unbounded global scan.
      const legacyPhoneIds = phoneSearch && phoneSearch.length >= 7
        ? await tx.$queryRaw<Array<{ id: string }>>`
            SELECT p.id FROM "Patient" p
            WHERE p."tenantId" = ${request.auth.tenantId}::uuid
              AND p."deletedAt" IS NULL
              AND (${request.auth.branchId ?? query.branchId ?? null}::uuid IS NULL OR p."branchId" = ${request.auth.branchId ?? query.branchId ?? null}::uuid)
              AND (
                regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g') = ${phoneSearch}
                OR (
                  length(${phoneSearch}) = 10
                  AND length(regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g')) BETWEEN 11 AND 13
                  AND right(regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g'), length(${phoneSearch})) = ${phoneSearch}
                )
              )
            LIMIT ${query.limit + 1}
          `
        : [];
      return tx.patient.findMany({
      where: {
        tenantId: request.auth.tenantId,
        deletedAt: null,
        ...branchScope(request),
        branchId: request.auth.branchId ?? query.branchId,
        lifecycleStage: query.lifecycleStage,
        OR: query.search ? [
          { firstName: { contains: query.search, mode: 'insensitive' } },
          { lastName: { contains: query.search, mode: 'insensitive' } },
          { email: { contains: query.search, mode: 'insensitive' } },
          { phone: { contains: query.search, mode: 'insensitive' } },
          ...(legacyPhoneIds.length > 0 ? [{ id: { in: legacyPhoneIds.map(row => row.id) } }] : []),
          { externalRef: { contains: query.search, mode: 'insensitive' } },
        ] : undefined,
      },
      orderBy: { id: 'asc' },
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : 0,
      take: query.limit + 1,
      include: { _count: { select: { appointments: { where: { deletedAt: null } } } } },
      });
    });
    const page = cursorPage(rows, query.limit);
    // HIPAA access accounting for a PHI list read (id-only, no PHI in the log).
    await audit(request, { action: 'patient.list', resource: 'patient', metadata: { count: page.data.length } });
    return page;
  });

  app.get('/summary', { preHandler: canReadPatients }, async request => {
    const branchId = request.auth.branchId ?? null;
    const summary = await runWithTenantContext(request.auth.tenantId, async tx => {
      const where = { tenantId: request.auth.tenantId, deletedAt: null, ...branchScope(request) };
      const aggregate = await tx.patient.aggregate({
        where,
        _count: { _all: true },
        _avg: { lifetimeValue: true },
        _sum: { outstandingBalance: true },
      });
      const lifecycle = await tx.patient.groupBy({ by: ['lifecycleStage'], where, _count: { _all: true } });
      const branches = await tx.patient.groupBy({ by: ['branchId'], where, _count: { _all: true } });
      const highRiskCount = await tx.patient.count({ where: { ...where, churnRisk: { gte: 60 } } });
      const highLifetimeValueCount = await tx.patient.count({ where: { ...where, lifetimeValue: { gt: 4000 } } });
      const consentRows = await tx.$queryRaw<Array<{ purpose: string; granted_count: bigint }>>`
        WITH scoped_patients AS (
          SELECT p.id FROM "Patient" p
          WHERE p."tenantId" = ${request.auth.tenantId}::uuid
            AND p."deletedAt" IS NULL
            AND (${branchId}::uuid IS NULL OR p."branchId" = ${branchId}::uuid)
        ), latest AS (
          SELECT DISTINCT ON (c."patientId", c.purpose)
            c."patientId", c.purpose, c.granted
          FROM "ConsentEvent" c
          JOIN scoped_patients p ON p.id = c."patientId"
          WHERE c."tenantId" = ${request.auth.tenantId}::uuid
          ORDER BY c."patientId", c.purpose, c."occurredAt" DESC, c.id DESC
        )
        SELECT purpose::text, count(*) FILTER (WHERE granted)::bigint AS granted_count
        FROM latest GROUP BY purpose
      `;
      return { aggregate, lifecycle, branches, highRiskCount, highLifetimeValueCount, consentRows };
    });
    const total = summary.aggregate._count._all;
    const consentCounts = Object.fromEntries(summary.consentRows.map(row => [row.purpose, Number(row.granted_count)]));
    await audit(request, { action: 'patient.summary', resource: 'patient', metadata: { count: total, scope: branchId ? 'assigned_branch' : 'tenant' } });
    return {
      scope: branchId ? 'assigned_branch' : 'tenant',
      asOf: new Date().toISOString(),
      patientCount: total,
      activeRetainedCount: summary.lifecycle.filter(row => row.lifecycleStage === 'ACTIVE' || row.lifecycleStage === 'RETAINED').reduce((sum, row) => sum + row._count._all, 0),
      highRiskCount: summary.highRiskCount,
      highLifetimeValueCount: summary.highLifetimeValueCount,
      averageLifetimeValue: Number(summary.aggregate._avg.lifetimeValue ?? 0),
      outstandingBalance: Number(summary.aggregate._sum.outstandingBalance ?? 0),
      lifecycleCounts: Object.fromEntries(summary.lifecycle.map(row => [row.lifecycleStage, row._count._all])),
      branchCounts: Object.fromEntries(summary.branches.map(row => [row.branchId, row._count._all])),
      activeConsentCounts: consentCounts,
      marketingConsentRate: total > 0 ? Math.round(((consentCounts.MARKETING ?? 0) / total) * 100) : null,
    };
  });

  app.get('/:id', { preHandler: canReadPatients }, async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const patient = await runWithTenantContext(request.auth.tenantId, tx => tx.patient.findFirst({
      where: { id, tenantId: request.auth.tenantId, deletedAt: null, ...branchScope(request) },
      include: {
        appointments: { where: { deletedAt: null }, orderBy: { startsAt: 'desc' }, take: 20 },
        _count: { select: { appointments: { where: { deletedAt: null } } } },
        consentEvents: { orderBy: { occurredAt: 'desc' } },
        patientInsurancePolicies: {
          where: { tenantId: request.auth.tenantId, active: true },
          orderBy: { updatedAt: 'desc' },
          take: 1,
          include: { payer: { select: { name: true } } },
        },
        eligibilityVerifications: {
          where: { tenantId: request.auth.tenantId },
          orderBy: { checkedAt: 'desc' },
          take: 20,
          include: { payer: { select: { name: true } }, policy: { select: { memberId: true, groupNumber: true } }, appointment: { select: { service: true, startsAt: true } } },
        },
        priorAuthorizations: {
          where: { tenantId: request.auth.tenantId },
          orderBy: [{ dueAt: 'asc' }, { updatedAt: 'desc' }],
          take: 10,
          include: { payer: { select: { name: true } } },
        },
      },
    }));
    if (!patient) throw app.httpErrors.notFound('Patient not found');
    // Audit only an actual disclosure (a 404 above discloses nothing). Id-only.
    await audit(request, { action: 'patient.read', resource: 'patient', resourceId: patient.id });
    return patient;
  });

  app.post('/', { preHandler: canWritePatients }, async (request, reply) => {
    const parsed = patientInput.parse(request.body);
    const input = { ...parsed, phone: parsed.phone ? `${parsed.phone.trim().startsWith('+') ? '+' : ''}${parsed.phone.replace(/\D/g, '')}` : undefined };
    assertBranchAccess(request, input.branchId);
    try {
      const patient = await runWithTenantContext(request.auth.tenantId, async tx => {
        const branch = await tx.branch.findFirst({ where: { id: input.branchId, tenantId: request.auth.tenantId, active: true }, select: { id: true } });
        if (!branch) throw app.httpErrors.badRequest('Branch must be active and belong to this tenant');
        await lockPatientIdentity(tx, request.auth.tenantId, input);
        const duplicate = await findIdentityCollision(tx, request.auth.tenantId, input);
        if (duplicate) throw identityConflict(app, duplicate.reason);
        const created = await tx.patient.create({ data: { tenantId: request.auth.tenantId, ...input } });
        await tx.auditEvent.create({ data: {
          tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
          action: 'patient.created', resource: 'patient', resourceId: created.id,
          requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
        } });
        return created;
      });
      return reply.code(201).send(patient);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw identityConflict(app);
      throw error;
    }
  });

  // ----- Correct a patient record (name / contact / demographics) -------------
  app.patch('/:id', { preHandler: canWritePatients }, async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const parsed = patientUpdateInput.parse(request.body);
    const input = { ...parsed, ...(parsed.phone !== undefined ? { phone: `${parsed.phone.trim().startsWith('+') ? '+' : ''}${parsed.phone.replace(/\D/g, '')}` } : {}) };
    const patient = await runWithTenantContext(request.auth.tenantId, tx => tx.patient.findFirst({
      where: { id, tenantId: request.auth.tenantId, deletedAt: null, ...branchScope(request) },
    }));
    if (!patient) throw app.httpErrors.notFound('Patient not found');

    const identity = { ...patient, ...input };
    try {
      return await runWithTenantContext(request.auth.tenantId, async tx => {
        await lockPatientIdentity(tx, request.auth.tenantId, identity);
        const duplicate = await findIdentityCollision(tx, request.auth.tenantId, identity, patient.id);
        if (duplicate) throw identityConflict(app, duplicate.reason);
        const updated = await tx.patient.update({ where: { id: patient.id }, data: input });
        await tx.auditEvent.create({ data: {
          tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
          action: 'patient.updated', resource: 'patient', resourceId: patient.id,
          requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
          metadata: { fields: Object.keys(input) },
        } });
        return updated;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw identityConflict(app);
      throw error;
    }
  });

  // ----- Soft-delete a patient (deletedAt convention; never hard-delete PHI) --
  app.delete('/:id', { preHandler: canWritePatients }, async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const patient = await runWithTenantContext(request.auth.tenantId, tx => tx.patient.findFirst({
      where: { id, tenantId: request.auth.tenantId, deletedAt: null, ...branchScope(request) },
    }));
    if (!patient) throw app.httpErrors.notFound('Patient not found');

    const futureAppointments = await runWithTenantContext(request.auth.tenantId, tx => tx.appointment.count({
      where: { tenantId: request.auth.tenantId, patientId: patient.id, deletedAt: null, startsAt: { gte: new Date() }, status: { notIn: ['CANCELED', 'NO_SHOW', 'COMPLETED'] } },
    }));
    if (futureAppointments > 0) throw app.httpErrors.conflict('Resolve or cancel future appointments before deactivating this patient');

    // Revoke portal access in the same transaction as the soft delete. Existing
    // portal JWTs are also rejected by the active-patient checks.
    await runWithTenantContext(request.auth.tenantId, async tx => {
      await tx.patient.update({ where: { id: patient.id }, data: { deletedAt: new Date() } });
      await tx.patientPortalAccount.updateMany({ where: { tenantId: request.auth.tenantId, patientId: patient.id }, data: { status: 'disabled' } });
    });
    await audit(request, { action: 'patient.deleted', resource: 'patient', resourceId: patient.id });
    return { deleted: true, id: patient.id };
  });

  app.post('/:id/consents', { preHandler: canWritePatients }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z.object({
      purpose: z.enum(['SMS', 'WHATSAPP', 'EMAIL', 'MARKETING']),
      granted: z.boolean(),
      source: z.string().trim().min(2).max(120),
      metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    }).parse(request.body);
    const patient = await runWithTenantContext(request.auth.tenantId, tx => tx.patient.findFirst({
      where: { id, tenantId: request.auth.tenantId, deletedAt: null, ...branchScope(request) },
    }));
    if (!patient) throw app.httpErrors.notFound('Patient not found');

    const consent = await runWithTenantContext(request.auth.tenantId, tx => tx.consentEvent.create({
      data: { tenantId: request.auth.tenantId, patientId: patient.id, ...input },
    }));
    await audit(request, { action: 'patient.consent.recorded', resource: 'patient', resourceId: patient.id, metadata: { purpose: input.purpose, granted: input.granted } });
    return reply.code(201).send(consent);
  });

  // ----- HIPAA right-of-access / data-subject export (read-only, audited) -----
  // Compiles a patient's record across PHI domains into a single export. Gated by
  // patient:export (owner/admin/compliance by default), tenant- + branch-scoped,
  // and logged as a disclosure (accounting-of-disclosures evidence). Returns 404
  // for another tenant's patient (no cross-tenant existence leak).
  app.get('/:id/data-export', { preHandler: canExportPatients }, async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const CAP = 1000; // bound each category to keep an export finite
    const patient = await runWithTenantContext(request.auth.tenantId, tx => tx.patient.findFirst({
      where: { id, tenantId: request.auth.tenantId, deletedAt: null, ...branchScope(request) },
      include: {
        appointments: { where: { deletedAt: null }, take: CAP },
        appointmentRequests: { take: CAP },
        consentEvents: { take: CAP },
        communicationConsents: { take: CAP },
        patientConsentRecords: { take: CAP },
        patientInsurancePolicies: { take: CAP },
        eligibilityVerifications: { take: CAP },
        priorAuthorizations: { take: CAP },
        patientResponsibilityEstimates: { take: CAP },
        paymentRequests: { take: CAP },
        paymentTransactions: { take: CAP },
        intakePackets: { include: { sections: true }, take: CAP },
      },
    }));
    if (!patient) throw app.httpErrors.notFound('Patient not found');

    const { appointments, appointmentRequests, consentEvents, communicationConsents, patientConsentRecords,
      patientInsurancePolicies, eligibilityVerifications, priorAuthorizations, patientResponsibilityEstimates,
      paymentRequests, paymentTransactions, intakePackets, ...demographics } = patient;

    const records = {
      appointments,
      appointmentRequests,
      consents: { events: consentEvents, communications: communicationConsents, records: patientConsentRecords },
      insurance: { policies: patientInsurancePolicies, eligibility: eligibilityVerifications, priorAuthorizations, responsibilityEstimates: patientResponsibilityEstimates },
      payments: { requests: paymentRequests, transactions: paymentTransactions },
      intake: intakePackets,
    };
    const counts = {
      appointments: appointments.length,
      appointmentRequests: appointmentRequests.length,
      consentEvents: consentEvents.length,
      communicationConsents: communicationConsents.length,
      patientConsentRecords: patientConsentRecords.length,
      insurancePolicies: patientInsurancePolicies.length,
      eligibilityVerifications: eligibilityVerifications.length,
      priorAuthorizations: priorAuthorizations.length,
      responsibilityEstimates: patientResponsibilityEstimates.length,
      paymentRequests: paymentRequests.length,
      paymentTransactions: paymentTransactions.length,
      intakePackets: intakePackets.length,
    };

    // Disclosure accounting: who exported which patient, when (no PHI in the log).
    await audit(request, { action: 'patient.data_exported', resource: 'patient', resourceId: id, metadata: { counts } });

    return {
      exportType: 'patient_data_access',
      standard: 'HIPAA right-of-access (45 CFR 164.524)',
      generatedAt: new Date().toISOString(),
      generatedByUserId: request.auth.userId,
      patient: demographics,
      records,
      counts,
    };
  });

  app.post('/:id/follow-up-task', { preHandler: canWritePatients }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z.object({
      title: z.string().trim().min(2).max(240).optional(),
      priority: z.string().trim().min(2).max(40).default('high'),
      dueAt: z.coerce.date().optional(),
    }).parse(request.body ?? {});
    const patient = await runWithTenantContext(request.auth.tenantId, tx => tx.patient.findFirst({
      where: { id, tenantId: request.auth.tenantId, deletedAt: null, ...branchScope(request) },
    }));
    if (!patient) throw app.httpErrors.notFound('Patient not found');

    const task = await runWithTenantContext(request.auth.tenantId, tx => tx.staffTask.create({
      data: {
        tenantId: request.auth.tenantId,
        branchId: patient.branchId,
        title: input.title ?? `Follow up with ${patient.firstName} ${patient.lastName}`,
        priority: input.priority,
        dueAt: input.dueAt ?? new Date(Date.now() + 1000 * 60 * 60 * 24),
      },
    }));
    await audit(request, { action: 'patient.followup.task_created', resource: 'patient', resourceId: patient.id, metadata: { taskId: task.id } });
    return reply.code(201).send(task);
  });
};
