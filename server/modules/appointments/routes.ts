import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { cursorPage, paginationSchema } from '../../lib/pagination';
import { requirePermission } from '../../lib/permissions';
import { assertBranchAccess, branchScope } from '../../lib/scope';
import { evaluateDepositForAppointment, getAppointmentPaymentSummaries, handleAppointmentCancellationDeposit } from '../../lib/deposits';
import { recordWorkflowEvent } from '../../lib/intelligence';
import { findSlotConflict, isDoubleBookConflictError, resolveSchedulingService } from '../../lib/scheduling';
import { runWithTenantContext } from '../../lib/tenantContext';
import { APPOINTMENT_NOTE_MAX, appendAppointmentNote, appointmentNoteSelect } from '../../lib/appointmentNotes';

const uuid = z.string().uuid();

// PHI reads now ENFORCE `appointment:read` (previously a cosmetic toggle) and are
// audited. Lifecycle status transitions gate on `appointment:write`.
const canReadAppointments = requirePermission('appointment:read');
const canWriteAppointments = requirePermission('appointment:write');

// Staff-advanceable lifecycle transitions and the states each may originate from.
// Terminal states (CANCELED, COMPLETED) are absent as sources, so e.g.
// completed→scheduled or cancelled→completed are rejected. Cancellation has its
// own route (PATCH /:id/cancel) with deposit handling.
const STATUS_TRANSITIONS: Record<'ARRIVED' | 'NO_SHOW' | 'COMPLETED', ReadonlyArray<string>> = {
  ARRIVED: ['CONFIRMED', 'RISKY', 'WAITLIST'],
  NO_SHOW: ['CONFIRMED', 'RISKY', 'WAITLIST'],
  COMPLETED: ['ARRIVED', 'CONFIRMED', 'RISKY'],
};
const STAFF_CANCELLABLE_STATUSES = ['CONFIRMED', 'RISKY', 'WAITLIST', 'ARRIVED'] as const;
const STAFF_RESCHEDULABLE_STATUSES = ['CONFIRMED', 'RISKY', 'WAITLIST', 'NO_SHOW'] as const;

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
  serviceCatalogItemId: z.string().uuid().optional(),
  service: z.string().trim().min(2).max(160),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  // Historical/terminal states must be reached through explicit lifecycle
  // transitions, never injected while creating a new appointment.
  status: z.enum(['CONFIRMED', 'WAITLIST']).default('CONFIRMED'),
  channel: z.enum(['WHATSAPP', 'SMS', 'EMAIL', 'PUSH', 'CALL', 'VIDEO']),
  value: z.coerce.number().min(0).max(1_000_000).default(0),
  notes: z.string().trim().max(2000).optional(),
}).refine(input => input.endsAt > input.startsAt, {
  message: 'endsAt must be after startsAt',
  path: ['endsAt'],
});

export const appointmentRoutes: FastifyPluginAsync = async app => {
  app.get('/', { preHandler: canReadAppointments }, async request => {
    const query = appointmentQuery.parse(request.query);
    const rows = await runWithTenantContext(request.auth.tenantId, tx => tx.appointment.findMany({
      where: {
        tenantId: request.auth.tenantId,
        deletedAt: null,
        ...branchScope(request),
        branchId: request.auth.branchId ?? query.branchId,
        patientId: query.patientId,
        status: query.status,
        startsAt: query.from || query.to ? { gte: query.from, lte: query.to } : undefined,
      },
      // Include only the labels the schedule needs. A canonical appointment
      // stores a ProviderProfile UUID; sending that UUID as `providerRef` made
      // the customer-facing timeline print an internal identifier instead of
      // the clinician's name.
      include: {
        patient: { select: { firstName: true, lastName: true } },
        providerProfile: { select: { user: { select: { displayName: true } } } },
      },
      orderBy: { id: 'asc' },
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : 0,
      take: query.limit + 1,
    }));
    const page = cursorPage(rows, query.limit);
    // Attach appointment-checkout payment/deposit status (batched, no N+1).
    const summaries = await getAppointmentPaymentSummaries(request.auth.tenantId, page.data.map(a => a.id));
    // HIPAA access accounting for a PHI list read (id-only, no PHI in the log).
    await audit(request, { action: 'appointment.list', resource: 'appointment', metadata: { count: page.data.length } });
    return {
      ...page,
      data: page.data.map(({ patient, providerProfile, ...a }) => ({
        ...a,
        patientName: `${patient.firstName} ${patient.lastName}`.trim(),
        providerName: providerProfile?.user.displayName ?? null,
        payment: summaries.get(a.id) ?? null,
      })),
    };
  });

  // ----- Single-appointment detail read (PHI: patient identity) --------------
  app.get('/:id', { preHandler: canReadAppointments }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const appointment = await runWithTenantContext(request.auth.tenantId, tx => tx.appointment.findFirst({
      where: { id, tenantId: request.auth.tenantId, deletedAt: null, ...branchScope(request) },
      include: {
        patient: { select: { id: true, firstName: true, lastName: true } },
        providerProfile: { select: { user: { select: { displayName: true } } } },
        // Append-only note history (C4). The scalar `notes` string is untouched.
        noteEntries: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: appointmentNoteSelect },
      },
    }));
    if (!appointment) throw app.httpErrors.notFound('Appointment not found');
    const summaries = await getAppointmentPaymentSummaries(request.auth.tenantId, [appointment.id]);
    // Audit only an actual disclosure (a 404 above discloses nothing). Id-only.
    await audit(request, { action: 'appointment.read', resource: 'appointment', resourceId: appointment.id });
    const patientName = appointment.patient ? `${appointment.patient.firstName} ${appointment.patient.lastName}`.trim() : null;
    const providerName = appointment.providerProfile?.user.displayName ?? null;
    return { ...appointment, patientName, providerName, payment: summaries.get(appointment.id) ?? null };
  });

  // ----- Append a note (immutable history; never edits the scalar `notes`) ---
  app.patch('/:id/notes', { preHandler: canWriteAppointments }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const body = z.object({ text: z.string().trim().min(1).max(APPOINTMENT_NOTE_MAX) }).strict().parse(request.body);
    const result = await runWithTenantContext(request.auth.tenantId, async tx => {
      const appointment = await tx.appointment.findFirst({
        where: { id, tenantId: request.auth.tenantId, deletedAt: null },
        select: { id: true, branchId: true },
      });
      if (!appointment) return null;
      assertBranchAccess(request, appointment.branchId);
      const appended = await appendAppointmentNote(tx, {
        tenantId: request.auth.tenantId, appointmentId: appointment.id, text: body.text,
        actorType: 'staff', actorUserId: request.auth.userId,
      });
      if (!appended) return null;
      // Minimum necessary: the audit row records that a note exists, never its text.
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'appointment.notes.appended', resource: 'appointment', resourceId: appointment.id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
        metadata: { hasNote: true, noteCount: appended.noteCount, actorType: 'staff' },
      } });
      const full = await tx.appointment.findUniqueOrThrow({
        where: { id: appointment.id },
        include: { noteEntries: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: appointmentNoteSelect } },
      });
      return full;
    });
    if (!result) throw app.httpErrors.notFound('Appointment not found');
    return result;
  });

  app.post('/', { preHandler: canWriteAppointments }, async (request, reply) => {
    const input = appointmentInput.parse(request.body);
    assertBranchAccess(request, input.branchId);
    const patient = await runWithTenantContext(request.auth.tenantId, tx => tx.patient.findFirst({
      where: { id: input.patientId, branchId: input.branchId, tenantId: request.auth.tenantId, deletedAt: null },
    }));
    if (!patient) throw app.httpErrors.badRequest('Patient and branch must belong to this tenant');

    const service = await resolveSchedulingService({
      tenantId: request.auth.tenantId,
      serviceCatalogItemId: input.serviceCatalogItemId,
      service: input.service,
      fallbackDurationMin: Math.round((input.endsAt.getTime() - input.startsAt.getTime()) / 60_000),
    });
    if (!service) throw app.httpErrors.badRequest('Select an active service before booking');

    // Guard the provider FK against cross-tenant references (IDOR).
    if (input.providerProfileId) {
      const provider = await runWithTenantContext(request.auth.tenantId, tx => tx.providerProfile.findFirst({ where: { id: input.providerProfileId, tenantId: request.auth.tenantId, branchId: input.branchId }, select: { id: true } }));
      if (!provider) throw app.httpErrors.badRequest('Provider does not belong to this tenant and branch');
    }

    // When a provider is linked, this create participates in cross-path conflict
    // detection: the DB-level exclusion constraint (see migration) is the final
    // guard against a race, and a pre-check gives a clean 409 in the common case.
    let appointment: Awaited<ReturnType<typeof db.appointment.create>>;
    try {
      if (input.providerProfileId) {
        const conflict = await runWithTenantContext(request.auth.tenantId, tx => findSlotConflict({ tenantId: request.auth.tenantId, providerProfileId: input.providerProfileId!, startsAt: input.startsAt, durationMin: service.durationMin }, tx));
        if (conflict) return reply.code(409).send({ error: conflict, message: `Slot unavailable: ${conflict}` });
      }
      appointment = await runWithTenantContext(request.auth.tenantId, tx => tx.appointment.create({
        data: { tenantId: request.auth.tenantId, ...input, service: service.name, serviceCatalogItemId: service.id, endsAt: new Date(input.startsAt.getTime() + service.durationMin * 60_000) },
      }));
    } catch (error) {
      // Lost the race to a concurrent booking → the exclusion constraint fires.
      if (isDoubleBookConflictError(error)) return reply.code(409).send({ error: 'already_booked', message: 'Provider is already booked for this time' });
      throw error;
    }
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
  app.patch('/:id/cancel', { preHandler: canWriteAppointments }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const reason = z.object({ reason: z.string().trim().max(240).optional() }).parse(request.body ?? {});
    const appointment = await runWithTenantContext(request.auth.tenantId, tx => tx.appointment.findFirst({ where: { id, tenantId: request.auth.tenantId, deletedAt: null } }));
    if (!appointment) throw app.httpErrors.notFound('Appointment not found');
    assertBranchAccess(request, appointment.branchId);
    if (appointment.status === 'CANCELED') throw app.httpErrors.conflict('Appointment is already cancelled');
    if (!STAFF_CANCELLABLE_STATUSES.includes(appointment.status as (typeof STAFF_CANCELLABLE_STATUSES)[number])) {
      throw app.httpErrors.conflict(`An appointment in ${appointment.status} status cannot be cancelled`);
    }

    const changed = await runWithTenantContext(request.auth.tenantId, tx => tx.appointment.updateMany({
      where: { id, tenantId: request.auth.tenantId, status: appointment.status, deletedAt: null },
      data: { status: 'CANCELED' },
    }));
    if (changed.count !== 1) throw app.httpErrors.conflict('Appointment changed concurrently; refresh and retry');
    // Void unpaid deposit requirements; paid ones are flagged for MANUAL refund.
    const depositOutcome = await handleAppointmentCancellationDeposit(request.auth.tenantId, id, request.auth.userId);
    await audit(request, { action: 'appointment.cancelled', resource: 'appointment', resourceId: id, metadata: { reason: reason.reason ?? null, needsManualRefund: depositOutcome.needsManualRefund } });
    await recordWorkflowEvent(request.auth.tenantId, { eventType: 'appointment.cancelled', entityType: 'appointment', entityId: id, sourceModule: 'appointments', payload: { needsManualRefund: depositOutcome.needsManualRefund } });

    const summaries = await getAppointmentPaymentSummaries(request.auth.tenantId, [id]);
    return { id, status: 'CANCELED', deposit: depositOutcome, payment: summaries.get(id) ?? null };
  });

  // ----- Reschedule: preserve / idempotently re-evaluate the deposit -------
  app.patch('/:id/reschedule', { preHandler: canWriteAppointments }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const body = z.object({ startsAt: z.coerce.date(), endsAt: z.coerce.date() }).refine(b => b.endsAt > b.startsAt, { message: 'endsAt must be after startsAt', path: ['endsAt'] }).parse(request.body);
    const appointment = await runWithTenantContext(request.auth.tenantId, tx => tx.appointment.findFirst({ where: { id, tenantId: request.auth.tenantId, deletedAt: null } }));
    if (!appointment) throw app.httpErrors.notFound('Appointment not found');
    assertBranchAccess(request, appointment.branchId);
    if (!STAFF_RESCHEDULABLE_STATUSES.includes(appointment.status as (typeof STAFF_RESCHEDULABLE_STATUSES)[number])) {
      throw app.httpErrors.conflict(`An appointment in ${appointment.status} status cannot be rescheduled`);
    }

    // Don't drop this appointment onto another for the same provider. Pre-check
    // (excluding self) for a clean 409; the DB exclusion constraint is the final
    // guard against a concurrent move. Provider-less appointments keep their prior
    // unconstrained behavior.
    const nextStatus = appointment.status === 'NO_SHOW' ? 'CONFIRMED' : appointment.status;
    if (appointment.providerProfileId) {
      const service = await resolveSchedulingService({ tenantId: request.auth.tenantId, serviceCatalogItemId: appointment.serviceCatalogItemId, service: appointment.service, fallbackDurationMin: Math.round((body.endsAt.getTime() - body.startsAt.getTime()) / 60_000) });
      if (!service) throw app.httpErrors.conflict('Appointment service requires staff review');
      const conflict = await runWithTenantContext(request.auth.tenantId, tx => findSlotConflict({ tenantId: request.auth.tenantId, providerProfileId: appointment.providerProfileId!, startsAt: body.startsAt, durationMin: service.durationMin, excludeAppointmentId: appointment.id }, tx));
      if (conflict) return reply.code(409).send({ error: conflict, message: `Slot unavailable: ${conflict}` });
      body.endsAt = new Date(body.startsAt.getTime() + service.durationMin * 60_000);
    }

    let updated: Awaited<ReturnType<typeof db.appointment.update>>;
    try {
      updated = await runWithTenantContext(request.auth.tenantId, async tx => {
        const changed = await tx.appointment.updateMany({
          where: { id, tenantId: request.auth.tenantId, status: appointment.status, deletedAt: null },
          data: { startsAt: body.startsAt, endsAt: body.endsAt, status: nextStatus },
        });
        if (changed.count !== 1) throw app.httpErrors.conflict('Appointment changed concurrently; refresh and retry');
        return tx.appointment.findUniqueOrThrow({ where: { id } });
      });
    } catch (error) {
      if (isDoubleBookConflictError(error)) throw app.httpErrors.conflict('Provider is already booked for this time');
      throw error;
    }
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

  // ----- Lifecycle status transitions (check-in / no-show / complete) --------
  // Advances an appointment through the staff-visible lifecycle with validated
  // transitions. Cancellation stays on its own deposit-aware route.
  app.patch('/:id/status', { preHandler: canWriteAppointments }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const { status } = z.object({ status: z.enum(['ARRIVED', 'NO_SHOW', 'COMPLETED']) }).parse(request.body);
    const appointment = await runWithTenantContext(request.auth.tenantId, tx => tx.appointment.findFirst({ where: { id, tenantId: request.auth.tenantId, deletedAt: null } }));
    if (!appointment) throw app.httpErrors.notFound('Appointment not found');
    assertBranchAccess(request, appointment.branchId);

    const allowedFrom = STATUS_TRANSITIONS[status];
    if (!allowedFrom.includes(appointment.status)) {
      throw app.httpErrors.conflict(`Cannot transition appointment from ${appointment.status} to ${status}`);
    }

    const updated = await runWithTenantContext(request.auth.tenantId, async tx => {
      const changed = await tx.appointment.updateMany({
        where: { id, tenantId: request.auth.tenantId, status: appointment.status, deletedAt: null },
        data: { status },
      });
      if (changed.count !== 1) throw app.httpErrors.conflict('Appointment changed concurrently; refresh and retry');

      // Completing a visit is the only moment the product learns a patient was
      // actually seen, and nothing wrote it down. Patient.lastVisitAt stayed NULL
      // for everyone while three separate audiences read it to decide who has
      // lapsed — reactivation campaigns (lib/campaigns.ts), automation rules, and
      // the lapsed-patient count on operations. With it always NULL those fall
      // through to `createdAt < cutoff`, so a patient seen yesterday looks
      // identical to one never seen at all, and a pilot's first reactivation
      // campaign phones people who were just in the chair.
      //
      // Stamped with the appointment's own start, not "now": completing
      // yesterday's list this morning records yesterday, which is what happened.
      // Only ever moved forward, so back-filling an old visit cannot erase a more
      // recent one. Same transaction as the status change, so the visit record
      // and the fact it is derived from can never disagree.
      if (status === 'COMPLETED') await tx.patient.updateMany({
        where: {
          id: appointment.patientId,
          tenantId: request.auth.tenantId,
          OR: [{ lastVisitAt: null }, { lastVisitAt: { lt: appointment.startsAt } }],
        },
        data: { lastVisitAt: appointment.startsAt },
      });

      return tx.appointment.findUniqueOrThrow({ where: { id } });
    });
    await audit(request, { action: 'appointment.status_changed', resource: 'appointment', resourceId: id, metadata: { from: appointment.status, to: status } });
    // Feed the intelligence loop the one transition it already models (no-show).
    if (status === 'NO_SHOW') {
      await recordWorkflowEvent(request.auth.tenantId, { eventType: 'appointment.no_show', entityType: 'appointment', entityId: id, sourceModule: 'appointments', payload: { from: appointment.status } });
    }

    const summaries = await getAppointmentPaymentSummaries(request.auth.tenantId, [id]);
    return { ...updated, payment: summaries.get(id) ?? null };
  });
};
