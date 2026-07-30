import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { audit } from '../../lib/audit';
import { cursorPage, paginationSchema } from '../../lib/pagination';
import { requirePermission } from '../../lib/permissions';
import { assertBranchAccess, branchScope } from '../../lib/scope';
import { runWithTenantContext } from '../../lib/tenantContext';

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
  externalRef: z.string().trim().max(120).optional(),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  // Front-desk demographic capture / identity verification. Optional, date-only.
  dateOfBirth: z.coerce.date().refine(v => v <= new Date(), { message: 'dateOfBirth cannot be in the future' }).optional(),
  email: z.string().email().optional(),
  phone: z.string().trim().max(40).optional(),
  lifecycleStage: z.enum(['NEW', 'ACTIVE', 'AT_RISK', 'INACTIVE', 'LOST', 'RETAINED']).default('NEW'),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
});

// Edit is a partial correction: every field optional, but at least one required
// so an empty PATCH is a 400 rather than a silent no-op. branchId is intentionally
// not editable here (moving a patient across branches is a separate operation).
const patientUpdateInput = z.object({
  externalRef: z.string().trim().max(120).optional(),
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  dateOfBirth: z.coerce.date().refine(v => v <= new Date(), { message: 'dateOfBirth cannot be in the future' }).optional(),
  email: z.string().email().optional(),
  phone: z.string().trim().max(40).optional(),
  lifecycleStage: z.enum(['NEW', 'ACTIVE', 'AT_RISK', 'INACTIVE', 'LOST', 'RETAINED']).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
}).refine(input => Object.keys(input).length > 0, {
  message: 'At least one field must be provided to update',
});

export const patientRoutes: FastifyPluginAsync = async app => {
  app.get('/', { preHandler: canReadPatients }, async request => {
    const query = patientQuery.parse(request.query);
    const rows = await runWithTenantContext(request.auth.tenantId, tx => tx.patient.findMany({
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
        ] : undefined,
      },
      orderBy: { id: 'asc' },
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : 0,
      take: query.limit + 1,
    }));
    const page = cursorPage(rows, query.limit);
    // HIPAA access accounting for a PHI list read (id-only, no PHI in the log).
    await audit(request, { action: 'patient.list', resource: 'patient', metadata: { count: page.data.length } });
    return page;
  });

  app.get('/:id', { preHandler: canReadPatients }, async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const patient = await runWithTenantContext(request.auth.tenantId, tx => tx.patient.findFirst({
      where: { id, tenantId: request.auth.tenantId, deletedAt: null, ...branchScope(request) },
      include: {
        appointments: { where: { deletedAt: null }, orderBy: { startsAt: 'desc' }, take: 20 },
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
    const input = patientInput.parse(request.body);
    assertBranchAccess(request, input.branchId);
    const branch = await runWithTenantContext(request.auth.tenantId, tx => tx.branch.findFirst({ where: { id: input.branchId, tenantId: request.auth.tenantId } }));
    if (!branch) throw app.httpErrors.badRequest('Branch does not belong to this tenant');

    const patient = await runWithTenantContext(request.auth.tenantId, tx => tx.patient.create({
      data: { tenantId: request.auth.tenantId, ...input },
    }));
    await audit(request, { action: 'patient.created', resource: 'patient', resourceId: patient.id });
    return reply.code(201).send(patient);
  });

  // ----- Correct a patient record (name / contact / demographics) -------------
  app.patch('/:id', { preHandler: canWritePatients }, async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = patientUpdateInput.parse(request.body);
    const patient = await runWithTenantContext(request.auth.tenantId, tx => tx.patient.findFirst({
      where: { id, tenantId: request.auth.tenantId, deletedAt: null, ...branchScope(request) },
    }));
    if (!patient) throw app.httpErrors.notFound('Patient not found');

    const updated = await runWithTenantContext(request.auth.tenantId, tx => tx.patient.update({
      where: { id: patient.id },
      data: {
        externalRef: input.externalRef,
        firstName: input.firstName,
        lastName: input.lastName,
        dateOfBirth: input.dateOfBirth,
        email: input.email,
        phone: input.phone,
        lifecycleStage: input.lifecycleStage,
        tags: input.tags,
      },
    }));
    await audit(request, { action: 'patient.updated', resource: 'patient', resourceId: patient.id, metadata: { fields: Object.keys(input) } });
    return updated;
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
