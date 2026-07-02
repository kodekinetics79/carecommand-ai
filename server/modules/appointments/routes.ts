import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { cursorPage, paginationSchema } from '../../lib/pagination';
import { requireRoles } from '../../plugins/roles';
import { assertBranchAccess, branchScope } from '../../lib/scope';
import { evaluateDepositForAppointment, getAppointmentPaymentSummaries, handleAppointmentCancellationDeposit } from '../../lib/deposits';
import { recordWorkflowEvent } from '../../lib/intelligence';

const uuid = z.string().uuid();

const appointmentQuery = paginationSchema.extend({
  branchId: z.string().uuid().optional(),
  patientId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  status: z.enum(['CONFIRMED', 'RISKY', 'ARRIVED', 'NO_SHOW', 'CANCELED', 'COMPLETED', 'WAITLIST']).optional(),
});

const appointmentInput = z.object({
  branchId: z.string().uuid(),
  patientId: z.string().uuid(),
  // Canonical provider link — when supplied, this appointment participates in
  // cross-path conflict detection (portal self-book, scheduling module).
  providerProfileId: z.string().uuid().optional(),
  providerRef: z.string().trim().max(120).optional(),
  service: z.string().trim().min(2).max(160),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  status: z.enum(['CONFIRMED', 'RISKY', 'ARRIVED', 'NO_SHOW', 'CANCELED', 'COMPLETED', 'WAITLIST']).default('CONFIRMED'),
  channel: z.enum(['WHATSAPP', 'SMS', 'EMAIL', 'PUSH', 'CALL', 'VIDEO']),
  value: z.coerce.number().min(0).max(1_000_000).default(0),
  notes: z.string().trim().max(2000).optional(),
}).refine(input => input.endsAt > input.startsAt, {
  message: 'endsAt must be after startsAt',
  path: ['endsAt'],
});

export const appointmentRoutes: FastifyPluginAsync = async app => {
  app.get('/', async request => {
    const query = appointmentQuery.parse(request.query);
    const rows = await db.appointment.findMany({
      where: {
        tenantId: request.auth.tenantId,
        deletedAt: null,
        ...branchScope(request),
        branchId: request.auth.branchId ?? query.branchId,
        patientId: query.patientId,
        status: query.status,
        startsAt: query.from || query.to ? { gte: query.from, lte: query.to } : undefined,
      },
      orderBy: { id: 'asc' },
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : 0,
      take: query.limit + 1,
    });
    const page = cursorPage(rows, query.limit);
    // Attach appointment-checkout payment/deposit status (batched, no N+1).
    const summaries = await getAppointmentPaymentSummaries(request.auth.tenantId, page.data.map(a => a.id));
    return { ...page, data: page.data.map(a => ({ ...a, payment: summaries.get(a.id) ?? null })) };
  });

  app.post('/', { preHandler: requireRoles('OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK') }, async (request, reply) => {
    const input = appointmentInput.parse(request.body);
    assertBranchAccess(request, input.branchId);
    const patient = await db.patient.findFirst({
      where: { id: input.patientId, branchId: input.branchId, tenantId: request.auth.tenantId, deletedAt: null },
    });
    if (!patient) throw app.httpErrors.badRequest('Patient and branch must belong to this tenant');

    // Guard the provider FK against cross-tenant references (IDOR).
    if (input.providerProfileId) {
      const provider = await db.providerProfile.findFirst({ where: { id: input.providerProfileId, tenantId: request.auth.tenantId }, select: { id: true } });
      if (!provider) throw app.httpErrors.badRequest('Provider does not belong to this tenant');
    }

    const appointment = await db.appointment.create({
      data: { tenantId: request.auth.tenantId, ...input },
    });
    await audit(request, { action: 'appointment.created', resource: 'appointment', resourceId: appointment.id });

    // Appointment Checkout: evaluate deposit rules and link a requirement if one
    // applies (best-effort; no-op when payments_deposits isn't entitled, and
    // idempotent so reschedules/retries never duplicate the requirement).
    let depositEvaluation = null;
    try {
      depositEvaluation = await evaluateDepositForAppointment(request.auth.tenantId, appointment.id, { actorUserId: request.auth.userId });
    } catch (error) {
      request.log.error({ err: error }, 'Deposit evaluation on booking failed');
    }
    await recordWorkflowEvent(request.auth.tenantId, { eventType: 'appointment.created', entityType: 'appointment', entityId: appointment.id, sourceModule: 'appointments', payload: { branchId: appointment.branchId, value: Number(appointment.value), depositRequired: depositEvaluation?.applied ?? false } });
    return reply.code(201).send({ ...appointment, depositEvaluation });
  });

  // ----- Cancel: void unpaid deposits (never fake a refund) ----------------
  app.patch('/:id/cancel', { preHandler: requireRoles('OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK') }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const reason = z.object({ reason: z.string().trim().max(240).optional() }).parse(request.body ?? {});
    const appointment = await db.appointment.findFirst({ where: { id, tenantId: request.auth.tenantId, deletedAt: null } });
    if (!appointment) throw app.httpErrors.notFound('Appointment not found');
    assertBranchAccess(request, appointment.branchId);
    if (appointment.status === 'CANCELED') throw app.httpErrors.conflict('Appointment is already cancelled');

    await db.appointment.update({ where: { id }, data: { status: 'CANCELED' } });
    // Void unpaid deposit requirements; paid ones are flagged for MANUAL refund.
    const depositOutcome = await handleAppointmentCancellationDeposit(request.auth.tenantId, id, request.auth.userId);
    await audit(request, { action: 'appointment.cancelled', resource: 'appointment', resourceId: id, metadata: { reason: reason.reason ?? null, needsManualRefund: depositOutcome.needsManualRefund } });
    await recordWorkflowEvent(request.auth.tenantId, { eventType: 'appointment.cancelled', entityType: 'appointment', entityId: id, sourceModule: 'appointments', payload: { needsManualRefund: depositOutcome.needsManualRefund } });

    const summaries = await getAppointmentPaymentSummaries(request.auth.tenantId, [id]);
    return { id, status: 'CANCELED', deposit: depositOutcome, payment: summaries.get(id) ?? null };
  });

  // ----- Reschedule: preserve / idempotently re-evaluate the deposit -------
  app.patch('/:id/reschedule', { preHandler: requireRoles('OWNER', 'ADMIN', 'MANAGER', 'FRONT_DESK') }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const body = z.object({ startsAt: z.coerce.date(), endsAt: z.coerce.date() }).refine(b => b.endsAt > b.startsAt, { message: 'endsAt must be after startsAt', path: ['endsAt'] }).parse(request.body);
    const appointment = await db.appointment.findFirst({ where: { id, tenantId: request.auth.tenantId, deletedAt: null } });
    if (!appointment) throw app.httpErrors.notFound('Appointment not found');
    assertBranchAccess(request, appointment.branchId);
    if (appointment.status === 'CANCELED') throw app.httpErrors.conflict('A cancelled appointment cannot be rescheduled');

    const updated = await db.appointment.update({ where: { id }, data: { startsAt: body.startsAt, endsAt: body.endsAt, status: appointment.status === 'NO_SHOW' ? 'CONFIRMED' : appointment.status } });
    // Idempotent: an existing requirement is preserved (never duplicated).
    let depositEvaluation = null;
    try {
      depositEvaluation = await evaluateDepositForAppointment(request.auth.tenantId, id, { actorUserId: request.auth.userId });
    } catch (error) {
      request.log.error({ err: error }, 'Deposit re-evaluation on reschedule failed');
    }
    await audit(request, { action: 'appointment.rescheduled', resource: 'appointment', resourceId: id, metadata: { startsAt: body.startsAt.toISOString() } });
    await recordWorkflowEvent(request.auth.tenantId, { eventType: 'appointment.rescheduled', entityType: 'appointment', entityId: id, sourceModule: 'appointments', payload: { startsAt: body.startsAt.toISOString() } });

    const summaries = await getAppointmentPaymentSummaries(request.auth.tenantId, [id]);
    return { ...updated, depositEvaluation, payment: summaries.get(id) ?? null };
  });
};
