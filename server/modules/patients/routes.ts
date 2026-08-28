import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { cursorPage, paginationSchema } from '../../lib/pagination';
import { requirePermission } from '../../lib/permissions';
import { assertBranchAccess, branchScope } from '../../lib/scope';

// Patient mutations now gate on the action permission `patient:write` (default
// matrix: OWNER/ADMIN/MANAGER/FRONT_DESK — preserving prior role membership)
// rather than a hardcoded role list, so a tenant's custom role grants/revokes
// are actually enforced here. Read routes remain open to any authenticated user.
const canWritePatients = requirePermission('patient:write');
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
  email: z.string().email().optional(),
  phone: z.string().trim().max(40).optional(),
  lifecycleStage: z.enum(['NEW', 'ACTIVE', 'AT_RISK', 'INACTIVE', 'LOST', 'RETAINED']).default('NEW'),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
});

export const patientRoutes: FastifyPluginAsync = async app => {
  app.get('/', async request => {
    const query = patientQuery.parse(request.query);
    const rows = await db.patient.findMany({
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
    });
    return cursorPage(rows, query.limit);
  });

  app.get('/:id', async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const patient = await db.patient.findFirst({
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
    });
    if (!patient) throw app.httpErrors.notFound('Patient not found');
    return patient;
  });

  app.post('/', { preHandler: canWritePatients }, async (request, reply) => {
    const input = patientInput.parse(request.body);
    assertBranchAccess(request, input.branchId);
    const branch = await db.branch.findFirst({ where: { id: input.branchId, tenantId: request.auth.tenantId } });
    if (!branch) throw app.httpErrors.badRequest('Branch does not belong to this tenant');

    const patient = await db.patient.create({
      data: { tenantId: request.auth.tenantId, ...input },
    });
    await audit(request, { action: 'patient.created', resource: 'patient', resourceId: patient.id });
    return reply.code(201).send(patient);
  });

  app.post('/:id/consents', { preHandler: canWritePatients }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z.object({
      purpose: z.enum(['SMS', 'WHATSAPP', 'EMAIL', 'MARKETING']),
      granted: z.boolean(),
      source: z.string().trim().min(2).max(120),
      metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    }).parse(request.body);
    const patient = await db.patient.findFirst({
      where: { id, tenantId: request.auth.tenantId, deletedAt: null, ...branchScope(request) },
    });
    if (!patient) throw app.httpErrors.notFound('Patient not found');

    const consent = await db.consentEvent.create({
      data: { tenantId: request.auth.tenantId, patientId: patient.id, ...input },
    });
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
    const patient = await db.patient.findFirst({
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
    });
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
    const patient = await db.patient.findFirst({
      where: { id, tenantId: request.auth.tenantId, deletedAt: null, ...branchScope(request) },
    });
    if (!patient) throw app.httpErrors.notFound('Patient not found');

    const task = await db.staffTask.create({
      data: {
        tenantId: request.auth.tenantId,
        branchId: patient.branchId,
        title: input.title ?? `Follow up with ${patient.firstName} ${patient.lastName}`,
        priority: input.priority,
        dueAt: input.dueAt ?? new Date(Date.now() + 1000 * 60 * 60 * 24),
      },
    });
    await audit(request, { action: 'patient.followup.task_created', resource: 'patient', resourceId: patient.id, metadata: { taskId: task.id } });
    return reply.code(201).send(task);
  });
};
