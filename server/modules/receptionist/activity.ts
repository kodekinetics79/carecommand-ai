import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { hasReceptionistPermission, RECEPTIONIST_PERMISSIONS } from '../../lib/receptionist/accessControl';
import { runWithTenantContext } from '../../lib/tenantContext';
import { Prisma } from '../../generated/prisma/client';
import { lockDncDestinationFence } from '../../lib/receptionist/dncFence';
import { uuid, idParam, writeRoles, bookingReviewRoles, callArtifactRead, ownerAdminRoles, optionalE164Phone } from './shared';
import { cursorPage } from '../../lib/pagination';
import { maskDestination } from '../../lib/campaigns';
import { maskProviderId } from '../../lib/receptionist/liveCallUat';
import { hasPermission, requirePermission } from '../../lib/permissions';
import { bookCanonicalAppointment } from '../../lib/booking';
import { appointmentNoteSelect } from '../../lib/appointmentNotes';
import { getSchedulingPolicy, isDoubleBookConflictError, resolveSchedulingService, clinicLocalMinuteToUtc } from '../../lib/scheduling';
import {
  parseReceptionistTask, RECEPTIONIST_TASK_WORKFLOW,
  type ReceptionistTaskKind,
} from '../../lib/receptionist/frontDeskTask';
import { assertBranchAccess } from '../../lib/scope';

const LIVE_TASK_STATUS = ['OPEN', 'IN_PROGRESS'] as const;
const PENDING_REQUEST_STATUS = ['PENDING_REVIEW', 'MISSING_INFO'] as const;

// D12: a cancelled appointment must not block re-booking the caller forever.
// Only a live appointment proves the call already produced one.
const LIVE_APPOINTMENT_STATUS = ['CONFIRMED', 'RISKY', 'ARRIVED', 'COMPLETED', 'WAITLIST'] as const;

// ===========================================================================
// D1 (P0, patient safety) — what a booking is entitled to close.
//
// Booking an appointment used to COMPLETE every live receptionist task on the
// call: `updateMany` filtered `workflow` and had NO `kind` filter. So a caller
// who mentioned chest pain and also asked for a slot had the EMERGENCY cleared
// off the queue by an unrelated booking click — `acknowledgedAt` still null, the
// critical OperationalSignal still open, and no way back, because a terminal
// task cannot be reopened.
//
// A booking closes exactly the work the booking did:
//   - `booking_review`  — the review this route just performed;
//   - `message` / `missed_call` — only when the task points at THIS request.
// It never closes `emergency`, `human_handoff` or `identity_locked`: those are
// promises a human has to keep, and nothing but a human may keep them.
// ===========================================================================
const BOOKING_CLOSES_ALWAYS: readonly ReceptionistTaskKind[] = ['booking_review'];
const BOOKING_CLOSES_WHEN_LINKED: readonly ReceptionistTaskKind[] = ['message', 'missed_call'];
/** Never closed by a booking, at any time, for any reason. */
export const BOOKING_NEVER_CLOSES: readonly ReceptionistTaskKind[] = [
  'emergency', 'human_handoff', 'identity_locked',
  'call_denied', 'ai_declined', 'tool_failure', 'deployment_attention',
];

/** True when booking `appointmentRequestId` genuinely closes this task. */
export function bookingClosesTask(
  meta: { kind: ReceptionistTaskKind; appointmentRequestId: string | null },
  appointmentRequestId: string,
): boolean {
  if (BOOKING_NEVER_CLOSES.includes(meta.kind)) return false;
  if (BOOKING_CLOSES_ALWAYS.includes(meta.kind)) return true;
  return BOOKING_CLOSES_WHEN_LINKED.includes(meta.kind) && meta.appointmentRequestId === appointmentRequestId;
}

const csvEnum = <T extends string>(values: readonly T[]) => z.string()
  .transform(value => value.split(',').map(part => part.trim()).filter(Boolean))
  .pipe(z.array(z.enum(values as unknown as [T, ...T[]])).min(1));

/** The clinic's own calendar day, not the server's. */
function clinicDayRangeUtc(timezone: string, days: number, now = new Date()): { from: Date; to: Date } {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const endOfToday = clinicLocalMinuteToUtc(today, 24 * 60, timezone) ?? now;
  const startDay = new Date(endOfToday.getTime() - days * 24 * 60 * 60_000);
  const startISO = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(startDay);
  const from = clinicLocalMinuteToUtc(startISO, 0, timezone) ?? startDay;
  return { from, to: endOfToday };
}

/**
 * C2 stamps `ReceptionistCallLog.outsideHours` at webhook time. Until that
 * migration lands the after-hours rate is UNAVAILABLE, never a fake zero.
 */
let outsideHoursColumn: boolean | null = null;
async function hasOutsideHoursColumn(): Promise<boolean> {
  if (outsideHoursColumn !== null) return outsideHoursColumn;
  const rows = await db.$queryRaw<Array<{ present: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ReceptionistCallLog' AND column_name = 'outsideHours'
    ) AS present
  `;
  outsideHoursColumn = rows[0]?.present ?? false;
  return outsideHoursColumn;
}

const operationalNotesInput = z.object({
  summary: z.string().trim().max(2_000).optional().nullable(),
  correction: z.string().trim().max(2_000).optional().nullable(),
  callerIntent: z.string().trim().max(500).optional().nullable(),
  actionsTaken: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  followUpNotes: z.string().trim().max(1_000).optional().nullable(),
}).strict();

const callReviewInput = z.object({
  operation: z.enum(['SAVE_DRAFT', 'MARK_REVIEWED', 'SIGN_OFF']),
  expectedRevision: z.number().int().min(0),
  operationalNotes: operationalNotesInput,
  unresolvedActionItems: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  acknowledgeUnresolvedActions: z.literal(true).optional(),
}).strict();

export const activityRoutes: FastifyPluginAsync = async app => {
  // ===== Appointment requests (core AppointmentRequest) ====================
  // The only request table. Scoped by the source call's clinic — the core model
  // has no clinic column of its own, only `callLog.clinicId`.
  const requestListQuery = z.object({
    clinicId: uuid.optional(),
    campaignId: uuid.optional(),
    status: csvEnum(['PENDING_REVIEW', 'BOOKED', 'REJECTED', 'MISSING_INFO', 'DUPLICATE'] as const).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    cursor: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  });

  app.get('/appointment-requests', { preHandler: callArtifactRead }, async request => {
    const query = requestListQuery.parse(request.query);
    const rows = await db.appointmentRequest.findMany({
      where: {
        tenantId: request.auth.tenantId,
        status: { in: query.status ?? [...PENDING_REQUEST_STATUS] },
        ...(query.clinicId ? { callLog: { clinicId: query.clinicId } } : {}),
        ...(query.campaignId ? { campaignId: query.campaignId } : {}),
        ...(query.from || query.to ? { createdAt: { gte: query.from, lte: query.to } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : 0,
      take: query.limit + 1,
      include: {
        callLog: { select: { id: true, callerName: true, direction: true, startedAt: true, clinicId: true, patientId: true } },
        bookedAppointment: {
          select: {
            id: true, service: true, startsAt: true,
            branch: { select: { name: true, timezone: true } },
            providerProfile: { select: { user: { select: { displayName: true } } } },
          },
        },
        patient: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    const page = cursorPage(rows, query.limit);
    await audit(request, { action: 'receptionist.appointmentRequest.listRead', resource: 'appointmentRequest', metadata: { count: page.data.length } });
    return {
      ...page,
      // The raw collected payload and the unmasked number stay on the detail route.
      data: page.data.map(row => ({
        ...row,
        // The raw collected payload and the unmasked number are detail-only.
        rawCollectedFields: undefined,
        collectedPhone: undefined,
        collectedPhoneMasked: maskDestination(row.collectedPhone),
      })),
    };
  });

  // D11: this screen handed patient phone and email — plus the caller's
  // unmasked number — to AUDITOR and COMPLIANCE_OFFICER, two roles whose grants
  // deliberately exclude `patient:read`. The sibling surface (`projectTaskRow`)
  // gates the patient block correctly; this one gated on call-artifact access
  // alone. Contact detail now needs `patient:read` as well, and revealing it is
  // an audited disclosure rather than an ordinary read.
  app.get('/appointment-requests/:id', { preHandler: callArtifactRead }, async request => {
    const { id } = idParam.parse(request.params);
    const row = await db.appointmentRequest.findFirst({
      where: { id, tenantId: request.auth.tenantId },
      include: {
        callLog: { select: { id: true, callerName: true, callerPhone: true, direction: true, startedAt: true, endedAt: true, clinicId: true, outcome: true } },
        bookedAppointment: {
          select: {
            id: true, service: true, startsAt: true, status: true,
            branch: { select: { name: true, timezone: true } },
            providerProfile: { select: { user: { select: { displayName: true } } } },
          },
        },
        patient: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
        branch: { select: { id: true, name: true, timezone: true } },
      },
    });
    if (!row) throw app.httpErrors.notFound('Appointment request not found');
    const canReadPatient = await hasPermission(request, 'patient:read');
    const projected = {
      ...row,
      patient: row.patient
        ? canReadPatient
          ? row.patient
          : { id: row.patient.id, firstName: row.patient.firstName, lastName: row.patient.lastName }
        : null,
      collectedPhone: canReadPatient ? row.collectedPhone : undefined,
      collectedPhoneMasked: maskDestination(row.collectedPhone),
      callLog: row.callLog
        ? {
          ...row.callLog,
          callerPhone: canReadPatient ? row.callLog.callerPhone : undefined,
          callerPhoneMasked: maskDestination(row.callLog.callerPhone),
        }
        : null,
    };
    await audit(request, {
      action: 'receptionist.appointmentRequest.read', resource: 'appointmentRequest', resourceId: row.id,
      metadata: { contactDisclosed: canReadPatient },
    });
    return projected;
  });

  // Rejecting is a decision a person owns, so the reason is required — the
  // outbound alias keeps it optional for one cycle for older clients.
  app.patch('/appointment-requests/:id', { preHandler: bookingReviewRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = z.object({
      status: z.literal('REJECTED'),
      outcomeReason: z.string().trim().min(5).max(1000),
    }).strict().parse(request.body);
    return runWithTenantContext(request.auth.tenantId, async tx => {
      const existing = await tx.appointmentRequest.findFirst({ where: { id, tenantId: request.auth.tenantId }, select: { id: true, status: true } });
      if (!existing) throw app.httpErrors.notFound('Appointment request not found');
      if (!(PENDING_REQUEST_STATUS as readonly string[]).includes(existing.status)) {
        throw app.httpErrors.conflict('This request has already been resolved.');
      }
      const updated = await tx.appointmentRequest.update({
        where: { id: existing.id },
        data: { status: 'REJECTED', outcomeReason: input.outcomeReason },
      });
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'receptionist.appointmentRequest.rejected', resource: 'appointmentRequest', resourceId: existing.id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
        metadata: { fromStatus: existing.status, reasonRecorded: true },
      } });
      return updated;
    });
  });

  // Book it. One transaction: the canonical scheduler writes the appointment
  // (lib/booking.ts — the same path the scheduling route uses), the request is
  // linked, the source call is marked BOOKED and any open task for that call is
  // closed with outcome `booked`. Nothing here can report success without an
  // Appointment row.
  app.post('/appointment-requests/:id/book', { preHandler: [bookingReviewRoles, requirePermission('appointment:write')] }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const input = z.object({
      patientId: uuid.optional(),
      createPatient: z.object({
        firstName: z.string().trim().min(1).max(80),
        lastName: z.string().trim().min(1).max(80),
        phone: optionalE164Phone,
        email: z.string().trim().email().max(160).optional().nullable(),
      }).strict().optional(),
      providerProfileId: uuid,
      startsAt: z.coerce.date(),
      serviceCatalogItemId: uuid.optional(),
      service: z.string().trim().min(1).max(160),
      channel: z.enum(['WHATSAPP', 'SMS', 'EMAIL', 'PUSH', 'CALL', 'VIDEO']).default('CALL'),
      acknowledgeRequestDifferences: z.literal(true),
      outcomeReason: z.string().trim().max(1000).optional(),
    }).strict().refine(value => Boolean(value.patientId) !== Boolean(value.createPatient), {
      message: 'Provide either an existing patientId or createPatient, not both',
    }).parse(request.body);

    const service = await resolveSchedulingService({
      tenantId: request.auth.tenantId, serviceCatalogItemId: input.serviceCatalogItemId, service: input.service,
    });
    if (!service) throw app.httpErrors.badRequest('Select an active service before booking');
    const policy = await getSchedulingPolicy(request.auth.tenantId);

    let outcome: Awaited<ReturnType<typeof runWithTenantContext>>;
    try {
      outcome = await runWithTenantContext(request.auth.tenantId, async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receptionist-appointment-request:${request.auth.tenantId}:${id}`})::bigint)`;
        const existing = await tx.appointmentRequest.findFirst({
          where: { id, tenantId: request.auth.tenantId },
          include: { callLog: { select: { id: true, retellCallId: true } } },
        });
        if (!existing) return { kind: 'not_found' as const };
        if (!(PENDING_REQUEST_STATUS as readonly string[]).includes(existing.status)) return { kind: 'resolved' as const };

        const provider = await tx.providerProfile.findFirst({
          where: { id: input.providerProfileId, tenantId: request.auth.tenantId, active: true },
          select: { id: true, branchId: true },
        });
        if (!provider) return { kind: 'provider_invalid' as const };
        // D2: RLS is tenant-level only. Without this a FRONT_DESK user pinned to
        // branch B books a branch-A provider and writes an Appointment — and a
        // new Patient row — into a branch they may not read. Before any create.
        assertBranchAccess(request, provider.branchId);

        let patientId = input.patientId ?? null;
        let patientCreated = false;
        let crossBranchPatient = false;
        if (patientId) {
          // D12: a returning patient registered at branch A who calls branch B
          // must be bookable as themselves. Validate on tenant + branch ACCESS,
          // not branch equality — forcing `createPatient` here forks the record
          // and splits their clinical history. The caller is told it happened.
          const patient = await tx.patient.findFirst({
            where: { id: patientId, tenantId: request.auth.tenantId, deletedAt: null },
            select: { id: true, branchId: true },
          });
          if (!patient) return { kind: 'patient_invalid' as const };
          if (patient.branchId !== provider.branchId) {
            if (request.auth.branchId && request.auth.branchId !== patient.branchId) {
              return { kind: 'patient_invalid' as const };
            }
            crossBranchPatient = true;
          }
        } else {
          const created = await tx.patient.create({
            data: {
              tenantId: request.auth.tenantId, branchId: provider.branchId,
              firstName: input.createPatient!.firstName, lastName: input.createPatient!.lastName,
              phone: input.createPatient!.phone ?? null, email: input.createPatient!.email ?? null,
            },
            select: { id: true },
          });
          patientId = created.id;
          patientCreated = true;
        }
        const patient = await tx.patient.findUniqueOrThrow({ where: { id: patientId }, select: { id: true, phone: true, email: true } });

        // One appointment per source call, enforced in the database: a request
        // carrying a call may only be linked to an appointment stamped with THAT
        // call (FK on (tenantId, bookedAppointmentId, callLogId) ->
        // Appointment(tenantId, id, receptionistCallLogId)). So if the call has
        // already produced an appointment, booking a second one here could not
        // be linked to the request — it would leave an appointment nobody's
        // queue points at. Refuse, and send staff to `reconcile`, which is the
        // route for binding a request to an appointment that already exists.
        // (C3's booking sequence is what will allow several per call.)
        // D12: a CANCELED or soft-deleted appointment is not a booking the call
        // produced. Before this the probe matched ANY appointment stamped with
        // the call, so "booked, patient cancelled, rebook them" dead-ended on a
        // permanent 409 with no route forward.
        //
        // `Appointment(tenantId, receptionistCallLogId)` is unique, so the dead
        // appointment must actually give the call link up before a live one can
        // take it. Releasing it is a real write, so it is audited: the call it
        // came from stays recoverable from the audit trail and from the
        // AppointmentRequest that still points at the call.
        const onThisCall = existing.callLogId
          ? await tx.appointment.findFirst({
            where: { tenantId: request.auth.tenantId, receptionistCallLogId: existing.callLogId },
            select: { id: true, status: true, deletedAt: true },
          })
          : null;
        const terminalAppointment = onThisCall
          && (onThisCall.deletedAt !== null || !(LIVE_APPOINTMENT_STATUS as readonly string[]).includes(onThisCall.status));
        if (onThisCall && !terminalAppointment) {
          return { kind: 'call_already_booked' as const, appointmentId: onThisCall.id };
        }
        const releasedAppointmentId = terminalAppointment ? onThisCall!.id : null;
        if (releasedAppointmentId) {
          await tx.appointment.update({
            where: { id: releasedAppointmentId },
            data: { receptionistCallLogId: null },
          });
        }

        const booked = await bookCanonicalAppointment(tx, {
          tenantId: request.auth.tenantId, branchId: provider.branchId, patientId: patient.id,
          providerProfileId: provider.id, service, startsAt: input.startsAt, channel: input.channel,
          policy, patientContact: { phone: patient.phone, email: patient.email },
          receptionistCallLogId: existing.callLogId,
        });
        if ('conflict' in booked) return { kind: 'conflict' as const, reason: booked.conflict };

        const differences = [
          existing.requestedService && existing.requestedService.trim().toLocaleLowerCase() !== booked.appointment.service.trim().toLocaleLowerCase() ? 'service' : null,
          existing.requestedDateTime && existing.requestedDateTime.getTime() !== booked.appointment.startsAt.getTime() ? 'dateTime' : null,
        ].filter((value): value is string => value !== null);

        await tx.appointmentRequest.update({
          where: { id: existing.id },
          data: {
            status: 'BOOKED', bookedAppointmentId: booked.appointment.id,
            branchId: provider.branchId, patientId: patient.id,
            missingFields: [], outcomeReason: input.outcomeReason ?? null,
          },
        });
        if (existing.callLogId) {
          await tx.receptionistCallLog.updateMany({
            where: { id: existing.callLogId, tenantId: request.auth.tenantId, outcome: 'IN_PROGRESS' },
            data: { outcome: 'BOOKED' },
          });
        }
        // D1: close only the queue rows this booking genuinely closed. An
        // unacknowledged emergency from the same call stays OPEN.
        let tasksClosed = 0;
        let tasksLeftOpen = 0;
        if (existing.callLogId) {
          const live = await tx.staffTask.findMany({
            where: {
              tenantId: request.auth.tenantId, callLogId: existing.callLogId,
              status: { in: [...LIVE_TASK_STATUS] },
              metadata: { path: ['workflow'], equals: RECEPTIONIST_TASK_WORKFLOW },
            },
            select: { id: true, metadata: true },
          });
          const closable: string[] = [];
          for (const row of live) {
            const meta = parseReceptionistTask(row);
            if (meta && bookingClosesTask(meta, existing.id)) closable.push(row.id);
            else tasksLeftOpen += 1;
          }
          if (closable.length) {
            const closedAt = new Date();
            const closed = await tx.staffTask.updateMany({
              where: { id: { in: closable }, tenantId: request.auth.tenantId },
              data: {
                status: 'COMPLETED', completedAt: closedAt, outcomeCode: 'booked',
                // A row closed by this click WAS seen by this person. Leaving
                // acknowledgedAt null let a completed task keep claiming that
                // nobody had ever looked at it.
                acknowledgedAt: closedAt, acknowledgedById: request.auth.userId,
              },
            });
            tasksClosed = closed.count;
            // A closed task must not leave an open signal pointing at it.
            await tx.operationalSignal.updateMany({
              where: {
                tenantId: request.auth.tenantId, entityType: 'staffTask',
                entityId: { in: closable }, status: 'open',
              },
              data: { status: 'resolved' },
            });
          }
        }
        await tx.auditEvent.create({ data: {
          tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
          action: 'receptionist.appointmentRequest.bookedFromReview', resource: 'appointmentRequest', resourceId: existing.id,
          requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
          metadata: {
            appointmentId: booked.appointment.id, identityProof: 'staff_selected', differences,
            patientCreated, crossBranchPatient, tasksClosed, tasksLeftOpen,
            releasedAppointmentId, requestDifferencesAcknowledged: true,
          },
        } });
        await tx.businessEvent.create({ data: {
          tenantId: request.auth.tenantId, eventType: 'receptionist.appointmentRequest.booked',
          entityType: 'appointmentRequest', entityId: existing.id, sourceModule: 'receptionist',
          payload: { appointmentId: booked.appointment.id, differences, patientCreated, tasksLeftOpen },
        } });
        return {
          kind: 'booked' as const,
          appointment: booked.appointment,
          confirmationsQueued: booked.queued,
          differences,
          tasksClosed,
          // Surfaced so the desk can see that the emergency from this call is
          // still theirs to acknowledge, rather than assuming booking closed it.
          tasksLeftOpen,
          crossBranchPatient,
        };
      }) as never;
    } catch (error) {
      if (isDoubleBookConflictError(error)) {
        return reply.code(409).send({ error: 'slot_unavailable', reason: 'already_booked' });
      }
      throw error;
    }

    const result = outcome as unknown as
      | { kind: 'not_found' } | { kind: 'resolved' } | { kind: 'provider_invalid' } | { kind: 'patient_invalid' }
      | { kind: 'call_already_booked'; appointmentId: string }
      | { kind: 'conflict'; reason: string }
      | {
        kind: 'booked'; appointment: { id: string; service: string; startsAt: Date };
        confirmationsQueued: string[]; differences: string[];
        tasksClosed: number; tasksLeftOpen: number; crossBranchPatient: boolean;
      };
    if (result.kind === 'not_found') throw app.httpErrors.notFound('Appointment request not found');
    if (result.kind === 'resolved') throw app.httpErrors.conflict('This request has already been resolved.');
    if (result.kind === 'provider_invalid') throw app.httpErrors.badRequest('Select an active provider in this tenant');
    if (result.kind === 'patient_invalid') throw app.httpErrors.badRequest("Patient not found in this provider's clinic");
    if (result.kind === 'call_already_booked') {
      return reply.code(409).send({
        error: 'call_already_booked',
        appointmentId: result.appointmentId,
        message: 'This call already produced an appointment. Link this request to that appointment, or book the extra visit from the scheduler.',
      });
    }
    if (result.kind === 'conflict') return reply.code(409).send({ error: 'slot_unavailable', reason: result.reason });
    return reply.code(201).send({
      status: 'BOOKED',
      appointment: result.appointment,
      confirmationsQueued: result.confirmationsQueued,
      differences: result.differences,
      tasksClosed: result.tasksClosed,
      tasksLeftOpen: result.tasksLeftOpen,
      crossBranchPatient: result.crossBranchPatient,
    });
  });

  // Persistent, minimum-necessary reconciliation state for the Studio. This
  // is rebuilt from durable call/target safety state on every refresh; a
  // transient launch toast is never the only warning that a provider call may
  // still be live. Explicitly resolved signal/task evidence removes the row.
  app.get('/outbound-campaigns/:id/reconciliations', { preHandler: callArtifactRead }, async request => {
    const { id } = idParam.parse(request.params);
    const campaign = await db.receptionistOutboundCampaign.findFirst({
      where: { id, tenantId: request.auth.tenantId }, select: { id: true },
    });
    if (!campaign) throw app.httpErrors.notFound('Campaign not found');
    const reconciliationSignalTypes = [
      'receptionist_outbound_stop_unconfirmed_after_acceptance',
      'receptionist_outbound_provider_acceptance_unknown',
      'receptionist_outbound_local_binding_failed',
      'receptionist_provider_deployment_mismatch',
      'receptionist_outbound_provider_intent_recovery',
    ];
    const reconciliationTaskWorkflows = [
      'receptionist_outbound_reconciliation',
      'receptionist_outbound_stop_reconciliation',
      'receptionist_provider_intent_recovery',
    ];
    // Candidate discovery is driven by durable reconciliation evidence, not
    // the generic ESCALATED outcome (which is also used for ordinary handoffs
    // and incomplete booking payloads). Target lastCallLogIds are fetched
    // exactly, so a critical older row cannot fall out of a recent-log window.
    const [targets, signals, taskRows, unboundIntents] = await Promise.all([
      db.receptionistCallTarget.findMany({
        where: { tenantId: request.auth.tenantId, campaignId: id, lastOutcome: 'RECONCILIATION_REQUIRED', lastCallLogId: { not: null } },
        select: { id: true, lastCallLogId: true },
      }),
      db.operationalSignal.findMany({
        where: {
          tenantId: request.auth.tenantId, entityType: 'receptionistCallLog',
          entityId: { not: null }, signalType: { in: reconciliationSignalTypes },
        },
        select: { id: true, entityId: true, status: true }, orderBy: { createdAt: 'asc' },
      }),
      db.staffTask.findMany({
        where: {
          tenantId: request.auth.tenantId,
          OR: reconciliationTaskWorkflows.map(workflow => ({ metadata: { path: ['workflow'], equals: workflow } })),
        },
        select: { id: true, status: true, metadata: true },
        orderBy: { createdAt: 'asc' },
      }),
      db.receptionistOutboundProviderIntent.findMany({
        where: {
          tenantId: request.auth.tenantId,
          outboundCampaignId: id,
          callLog: { retellCallId: null, outcome: { in: ['IN_PROGRESS', 'ESCALATED'] } },
        },
        select: { callLogId: true },
      }),
    ]);
    const tasks = taskRows.flatMap(task => {
      const metadata = task.metadata && typeof task.metadata === 'object' && !Array.isArray(task.metadata)
        ? task.metadata as Prisma.JsonObject
        : null;
      const workflow = typeof metadata?.workflow === 'string' ? metadata.workflow : '';
      const callLogId = typeof metadata?.callLogId === 'string' ? metadata.callLogId : null;
      return callLogId && workflow.startsWith('receptionist_') && workflow.includes('reconcil')
        ? [{ id: task.id, status: task.status, callLogId }]
        : [];
    });
    const isUuid = (value: string | null): value is string => value !== null && uuid.safeParse(value).success;
    const candidateCallLogIds = [...new Set([
      ...targets.map(target => target.lastCallLogId).filter(isUuid),
      ...signals.map(signal => signal.entityId).filter(isUuid),
      ...tasks.map(task => task.callLogId).filter(isUuid),
      ...unboundIntents.map(intent => intent.callLogId),
    ])];
    const candidateLogs = candidateCallLogIds.length === 0 ? [] : await db.receptionistCallLog.findMany({
      where: {
        tenantId: request.auth.tenantId, outboundCampaignId: id,
        id: { in: candidateCallLogIds },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, retellCallId: true, targetId: true, outcome: true, createdAt: true },
    });
    const targetByCall = new Map(targets.map(target => [target.lastCallLogId!, target.id]));
    const unboundIntentCalls = new Set(unboundIntents.map(intent => intent.callLogId));
    const active = candidateLogs.flatMap(log => {
      const callSignals = signals.filter(signal => signal.entityId === log.id);
      const callTasks = tasks.filter(task => task.callLogId === log.id);
      const signalsResolved = callSignals.length > 0 && callSignals.every(signal => signal.status === 'resolved');
      const tasksResolved = callTasks.length > 0 && callTasks.every(task => task.status === 'COMPLETED');
      const durableResolution = callSignals.length > 0
        ? signalsResolved && (callTasks.length === 0 || tasksResolved)
        : tasksResolved;
      // A terminal unbound intent remains visible until the dedicated signal
      // and task evidence prove that staff reconciled provider state. The
      // immutable intent itself is retained for audit and is never deleted.
      if (durableResolution) return [];
      return [{
        localCallLogId: log.id,
        // Masked: this is the outbound reconciliation queue, which staff read.
        // The unmasked id is only ever needed by the resync that runs on the
        // server, and by support through the platform route.
        providerCallId: maskProviderId(log.retellCallId),
        targetId: log.targetId ?? targetByCall.get(log.id) ?? null,
        triggerSources: [
          ...(targetByCall.has(log.id) ? ['RECONCILIATION_REQUIRED' as const] : []),
          ...(callSignals.length > 0 ? ['RECONCILIATION_SIGNAL' as const] : []),
          ...(callTasks.length > 0 ? ['RECONCILIATION_TASK' as const] : []),
          ...(unboundIntentCalls.has(log.id) ? ['UNBOUND_PROVIDER_INTENT' as const] : []),
        ],
        signalIds: callSignals.map(signal => signal.id),
        signalStatuses: callSignals.map(signal => signal.status),
        reviewTaskIds: callTasks.map(task => task.id),
        reviewTaskStatuses: callTasks.map(task => task.status),
        createdAt: log.createdAt,
      }];
    });
    await audit(request, {
      action: 'receptionist.outboundReconciliation.listRead', resource: 'receptionistOutboundCampaign',
      resourceId: id, metadata: { activeCount: active.length },
    });
    return active;
  });

  // Staff never "mark" a request booked. They first create the appointment
  // through the canonical scheduler, then bind that exact provider-backed
  // appointment here. The request, source-call link, and audit evidence commit
  // atomically so the queue cannot claim success without an Appointment FK.
  app.post('/booking-requests/:id/reconcile', { preHandler: bookingReviewRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = z.object({
      appointmentId: uuid,
      outcomeReason: z.string().trim().min(5).max(1000),
      acknowledgeRequestDifferences: z.literal(true),
    }).strict().parse(request.body);

    return runWithTenantContext(request.auth.tenantId, async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receptionist-request-reconcile:${request.auth.tenantId}:${id}`})::bigint)`;
      const existing = await tx.appointmentRequest.findFirst({
        where: { id, tenantId: request.auth.tenantId },
        include: { callLog: { select: { retellCallId: true } } },
      });
      if (!existing) throw app.httpErrors.notFound('Request not found');
      if (existing.status === 'BOOKED') {
        if (existing.bookedAppointmentId !== input.appointmentId) {
          throw app.httpErrors.conflict('This request is already linked to a different canonical appointment.');
        }
        const replay = await tx.appointment.findFirst({
          where: { id: input.appointmentId, tenantId: request.auth.tenantId, deletedAt: null },
          select: {
            id: true, service: true, startsAt: true,
            branch: { select: { timezone: true, name: true, location: true } },
            providerProfile: { select: { user: { select: { displayName: true } } } },
          },
        });
        if (!replay) throw app.httpErrors.conflict('The linked canonical appointment is no longer available.');
        return {
          status: 'BOOKED' as const, requestId: existing.id, appointmentId: replay.id, duplicate: true,
          appointment: {
            service: replay.service, startsAt: replay.startsAt, timezone: replay.branch.timezone,
            locationName: replay.branch.name, locationAddress: replay.branch.location.trim() || null,
            providerName: replay.providerProfile?.user.displayName ?? null,
          },
        };
      }
      if (!['PENDING_REVIEW', 'MISSING_INFO'].includes(existing.status)) {
        throw app.httpErrors.conflict('A terminal appointment request cannot be reconciled to a booking.');
      }
      if (existing.source === 'ai_receptionist' && !existing.callLogId) {
        throw app.httpErrors.conflict('The AI receptionist request has no trusted source call and cannot be marked booked.');
      }

      const appointment = await tx.appointment.findFirst({
        where: {
          id: input.appointmentId, tenantId: request.auth.tenantId, deletedAt: null,
          status: { notIn: ['CANCELED', 'NO_SHOW'] },
        },
        select: {
          id: true, branchId: true, patientId: true, providerProfileId: true,
          receptionistCallLogId: true, service: true, startsAt: true,
          branch: { select: { timezone: true, name: true, location: true } },
          providerProfile: { select: { user: { select: { displayName: true } } } },
        },
      });
      if (!appointment) throw app.httpErrors.badRequest('Select an active canonical appointment.');
      if (!appointment.providerProfileId || !appointment.providerProfile?.user.displayName) {
        throw app.httpErrors.conflict('The appointment has no canonical provider and cannot reconcile this request.');
      }
      let identityProof: 'request_patient' | 'verified_call_identity' | 'appointment_source_call' | null = null;
      if (existing.patientId) {
        if (appointment.patientId !== existing.patientId) {
          throw app.httpErrors.conflict('The appointment belongs to a different patient than the request.');
        }
        identityProof = 'request_patient';
      } else if (existing.callLogId && appointment.receptionistCallLogId === existing.callLogId) {
        identityProof = 'appointment_source_call';
      } else if (existing.callLogId && existing.callLog?.retellCallId) {
        const verifiedIdentity = await tx.idempotencyKey.findUnique({
          where: { scope_key: {
            scope: 'receptionist.voice-identity',
            key: `${request.auth.tenantId}:${existing.callLog.retellCallId}`,
          } },
          select: { resultId: true },
        });
        if (verifiedIdentity?.resultId === appointment.patientId) identityProof = 'verified_call_identity';
      }
      if (!identityProof) {
        throw app.httpErrors.conflict('This request has no durable patient identity proof for the selected appointment. Verify identity or bind the canonical appointment to the exact source call before reconciling.');
      }
      if (existing.branchId && appointment.branchId !== existing.branchId) {
        throw app.httpErrors.conflict('The appointment belongs to a different branch than the request.');
      }
      if (appointment.receptionistCallLogId && appointment.receptionistCallLogId !== existing.callLogId) {
        throw app.httpErrors.conflict('The appointment is already bound to another receptionist call.');
      }
      const alreadyLinked = await tx.appointmentRequest.findFirst({
        where: { tenantId: request.auth.tenantId, bookedAppointmentId: appointment.id, id: { not: existing.id } },
        select: { id: true },
      });
      if (alreadyLinked) throw app.httpErrors.conflict('The appointment is already linked to another request.');

      const differences = [
        existing.requestedService && existing.requestedService.trim().toLocaleLowerCase() !== appointment.service.trim().toLocaleLowerCase() ? 'service' : null,
        existing.requestedDateTime && existing.requestedDateTime.getTime() !== appointment.startsAt.getTime() ? 'dateTime' : null,
      ].filter((value): value is string => value !== null);
      if (existing.callLogId && !appointment.receptionistCallLogId) {
        await tx.appointment.update({ where: { id: appointment.id }, data: { receptionistCallLogId: existing.callLogId } });
      }
      const updated = await tx.appointmentRequest.update({
        where: { id: existing.id },
        data: {
          status: 'BOOKED', bookedAppointmentId: appointment.id,
          branchId: appointment.branchId, patientId: appointment.patientId,
          missingFields: [], outcomeReason: input.outcomeReason,
        },
      });
      if (existing.callLogId) {
        await tx.receptionistCallLog.updateMany({
          where: { id: existing.callLogId, tenantId: request.auth.tenantId, outcome: 'IN_PROGRESS' },
          data: { outcome: 'BOOKED' },
        });
      }
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'receptionist.appointmentRequest.reconciledToCanonicalAppointment',
        resource: 'appointmentRequest', resourceId: existing.id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
        metadata: { appointmentId: appointment.id, differences, identityProof, reasonRecorded: true, requestDifferencesAcknowledged: true },
      } });
      await tx.businessEvent.create({ data: {
        tenantId: request.auth.tenantId, eventType: 'receptionist.appointmentRequest.reconciled',
        entityType: 'appointmentRequest', entityId: existing.id, sourceModule: 'receptionist',
        payload: { appointmentId: appointment.id, differences, identityProof },
      } });
      return {
        status: 'BOOKED' as const, requestId: updated.id, appointmentId: appointment.id, duplicate: false,
        appointment: {
          service: appointment.service, startsAt: appointment.startsAt, timezone: appointment.branch.timezone,
          locationName: appointment.branch.name, locationAddress: appointment.branch.location.trim() || null,
          providerName: appointment.providerProfile.user.displayName,
        },
      };
    });
  });

  // Delivery state is operational evidence, not a cosmetic "sent" flag. Staff
  // must be able to distinguish provider acceptance from proven delivery and
  // see ambiguous/dead-lettered confirmations that require reconciliation.
  app.get('/confirmation-deliveries', { preHandler: callArtifactRead }, async request => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(request.query);
    const rows = await db.notificationEvent.findMany({
      where: { tenantId: request.auth.tenantId, source: 'receptionist.appointment_confirmation' },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      select: {
        id: true, appointmentId: true, patientId: true, channel: true, status: true,
        attempts: true, maxAttempts: true, failureReason: true, provider: true,
        acceptedAt: true, deliveredAt: true, deadLetteredAt: true, createdAt: true,
        appointment: { select: { service: true, startsAt: true } },
        patient: { select: { firstName: true, lastName: true } },
      },
    });
    await audit(request, {
      action: 'receptionist.confirmationDelivery.listRead',
      resource: 'notificationEvent',
      metadata: { count: rows.length },
    });
    return rows.map(row => ({
      ...row,
      patientName: row.patient ? `${row.patient.firstName} ${row.patient.lastName}`.trim() : null,
      appointmentService: row.appointment?.service ?? null,
      appointmentStartsAt: row.appointment?.startsAt ?? null,
      patient: undefined,
      appointment: undefined,
    }));
  });

  // ===== Call logs as a work queue ========================================
  // Filters staff actually triage by, cursor pagination, and a projection that
  // carries no raw phone and no recording URL — both are detail-route only.
  const callLogQuery = z.object({
    clinicId: uuid.optional(),
    campaignId: uuid.optional(),
    direction: z.enum(['inbound', 'outbound']).optional(),
    outcome: csvEnum(['IN_PROGRESS', 'BOOKED', 'NOT_INTERESTED', 'NO_ANSWER', 'VOICEMAIL', 'ESCALATED', 'OPTED_OUT', 'FAILED'] as const).optional(),
    reviewStatus: csvEnum(['UNREVIEWED', 'DRAFT', 'REVIEWED', 'SIGNED_OFF'] as const).optional(),
    handoff: z.enum(['open', 'any', 'none']).optional(),
    consent: csvEnum(['UNDETERMINED', 'GRANTED', 'REFUSED', 'WITHDRAWN'] as const).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    cursor: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  });

  function callLogWhere(tenantId: string, query: z.infer<typeof callLogQuery>) {
    return {
      tenantId,
      ...(query.clinicId ? { clinicId: query.clinicId } : {}),
      ...(query.campaignId ? { campaignId: query.campaignId } : {}),
      ...(query.direction ? { direction: query.direction } : {}),
      ...(query.outcome ? { outcome: { in: query.outcome } } : {}),
      ...(query.reviewStatus ? { reviewStatus: { in: query.reviewStatus } } : {}),
      ...(query.consent ? { recordingConsentStatus: { in: query.consent } } : {}),
      ...(query.from || query.to ? { createdAt: { gte: query.from, lte: query.to } } : {}),
      ...(query.handoff === 'open' ? { staffTasks: { some: { status: { in: [...LIVE_TASK_STATUS] } } } }
        : query.handoff === 'any' ? { staffTasks: { some: {} } }
          : query.handoff === 'none' ? { staffTasks: { none: {} } } : {}),
    } satisfies Prisma.ReceptionistCallLogWhereInput;
  }

  app.get('/call-logs', { preHandler: callArtifactRead }, async request => {
    const query = callLogQuery.parse(request.query);
    const rows = await db.receptionistCallLog.findMany({
      where: callLogWhere(request.auth.tenantId, query),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : 0,
      take: query.limit + 1,
      include: {
        campaign: { select: { id: true, name: true } },
        patient: { select: { id: true, firstName: true, lastName: true } },
        appointments: { select: { id: true }, take: 1, orderBy: { createdAt: 'desc' } },
        _count: { select: { staffTasks: { where: { status: { in: [...LIVE_TASK_STATUS] } } } } },
      },
    });
    const page = cursorPage(rows, query.limit);
    await audit(request, {
      action: 'receptionistCallLog.listRead',
      resource: 'receptionistCallLog',
      metadata: { count: page.data.length, recordingsDisclosed: false },
    });
    return {
      ...page,
      data: page.data.map(row => ({
        id: row.id,
        clinicId: row.clinicId,
        campaign: row.campaign,
        // Was `retellCallId: row.retellCallId` — the supplier's name in the
        // field and the UNMASKED provider call id in the value, on a list
        // route. The browser was already masking it for display, which is the
        // tell: nobody wanted the whole id on screen, it was simply on the
        // wire anyway. The masked form is all the queue needs — it prints it,
        // and enables the resync button when it is non-null.
        providerCallRef: maskProviderId(row.retellCallId),
        callerName: row.callerName,
        callerPhoneMasked: maskDestination(row.callerPhone),
        patientId: row.patientId,
        patient: row.patient,
        direction: row.direction,
        outcome: row.outcome,
        durationSeconds: row.durationSeconds,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        reviewStatus: row.reviewStatus,
        recordingConsentStatus: row.recordingConsentStatus,
        recordingAvailable: Boolean(row.recordingUrl),
        // A list never carries a recording URL, whatever the caller may read.
        recordingUrl: null,
        openHandoffCount: row._count.staffTasks,
        bookedAppointmentId: row.appointments[0]?.id ?? null,
        transcriptSummary: row.transcriptSummary,
        createdAt: row.createdAt,
      })),
    };
  });

  // Counts for the queue header. Same filters, no rows, no PHI.
  app.get('/call-logs/summary', { preHandler: callArtifactRead }, async request => {
    const query = callLogQuery.parse(request.query);
    const where = callLogWhere(request.auth.tenantId, query);
    const [unreviewed, openHandoffs, inbound, outbound, booked, pendingRequests] = await Promise.all([
      db.receptionistCallLog.count({ where: { ...where, reviewStatus: 'UNREVIEWED' } }),
      db.receptionistCallLog.count({ where: { ...where, staffTasks: { some: { status: { in: [...LIVE_TASK_STATUS] } } } } }),
      db.receptionistCallLog.count({ where: { ...where, direction: 'inbound' } }),
      db.receptionistCallLog.count({ where: { ...where, direction: 'outbound' } }),
      db.receptionistCallLog.count({ where: { ...where, outcome: 'BOOKED' } }),
      db.appointmentRequest.count({
        where: {
          tenantId: request.auth.tenantId,
          status: { in: [...PENDING_REQUEST_STATUS] },
          ...(query.clinicId ? { callLog: { clinicId: query.clinicId } } : {}),
        },
      }),
    ]);
    return {
      unreviewed, openHandoffs, inbound, outbound, booked, pendingRequests,
      range: { from: query.from ?? null, to: query.to ?? null },
    };
  });

  app.get('/call-logs/:id', { preHandler: callArtifactRead }, async request => {
    const { id } = idParam.parse(request.params);
    const row = await db.receptionistCallLog.findFirst({
      where: { id, tenantId: request.auth.tenantId },
      include: {
        campaign: { select: { id: true, name: true } },
        reviewedBy: { select: { id: true, displayName: true } },
        signedOffBy: { select: { id: true, displayName: true } },
        patient: { select: { id: true, firstName: true, lastName: true } },
        appointments: {
          select: {
            id: true, service: true, startsAt: true, status: true, notes: true,
            noteEntries: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: appointmentNoteSelect },
          },
          orderBy: { createdAt: 'desc' },
        },
        appointmentRequests: {
          select: { id: true, requestedService: true, requestedDateTime: true, status: true, bookedAppointmentId: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!row) throw app.httpErrors.notFound('Call log not found');
    const canReadRecording = await hasReceptionistPermission(request, RECEPTIONIST_PERMISSIONS.RECORDINGS_READ);
    const canSignOffReview = await hasReceptionistPermission(request, RECEPTIONIST_PERMISSIONS.MANAGE);
    const canEditReview = await hasReceptionistPermission(request, RECEPTIONIST_PERMISSIONS.BOOKING_REVIEW);
    const usableRecordingUrl = typeof row.recordingUrl === 'string' && /^https:\/\//i.test(row.recordingUrl)
      ? row.recordingUrl
      : null;
    // The FK is authoritative now; the metadata match still finds pre-migration rows.
    const staffTasks = await db.staffTask.findMany({
      where: {
        tenantId: request.auth.tenantId,
        AND: [
          { metadata: { path: ['workflow'], equals: RECEPTIONIST_TASK_WORKFLOW } },
          { OR: [
            { callLogId: row.id },
            { metadata: { path: ['callLogId'], equals: row.id } },
            ...(row.retellCallId ? [{ metadata: { path: ['callId'], equals: row.retellCallId } }] : []),
          ] },
        ],
      },
      select: {
        id: true, title: true, status: true, priority: true, dueAt: true, createdAt: true,
        acknowledgedAt: true, completedAt: true, outcomeCode: true, metadata: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    const handoffs = staffTasks.map(({ metadata, ...task }) => ({ ...task, kind: parseReceptionistTask({ metadata })?.kind ?? null }));
    await audit(request, {
      action: 'receptionistCallLog.read',
      resource: 'receptionistCallLog',
      resourceId: row.id,
      metadata: { recordingDisclosed: canReadRecording && Boolean(row.recordingUrl) },
    });
    const { retellCallId, ...callRow } = row;
    return {
      ...callRow,
      providerCallRef: maskProviderId(retellCallId),
      providerSummary: row.transcriptSummary ? {
        text: row.transcriptSummary,
        source: 'PROVIDER_CALL_ANALYSIS',
        // Masked like the list. The detail view spread the whole Prisma row,
        // so the full provider call id shipped twice — once as `retellCallId`
        // and once here — on the screen a receptionist opens to read a call.
        sourceCallId: maskProviderId(retellCallId),
      } : null,
      recordingAvailable: Boolean(usableRecordingUrl),
      recordingAccess: row.recordingPurgedAt
        ? 'purged'
        : !usableRecordingUrl
          ? 'not_available'
          : canReadRecording ? 'available' : 'restricted',
      recordingUrl: canReadRecording ? usableRecordingUrl : null,
      // canEdit is a real permission answer now, not a hardcoded true.
      reviewCapabilities: { canEdit: canEditReview, canSignOff: canSignOffReview },
      staffTasks: handoffs,
      // One-cycle alias for clients still reading the old name.
      handoffReferences: handoffs,
    };
  });

  app.patch('/call-logs/:id/operator-review', { preHandler: bookingReviewRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const input = callReviewInput.parse(request.body);
    const canSignOff = await hasReceptionistPermission(request, RECEPTIONIST_PERMISSIONS.MANAGE);
    if (input.operation === 'SIGN_OFF' && !canSignOff) {
      return reply.code(403).send({
        error: 'insufficient_permission',
        permission: RECEPTIONIST_PERMISSIONS.MANAGE,
        message: 'Manager sign-off requires receptionist:manage.',
      });
    }
    const now = new Date();
    const status = input.operation === 'SAVE_DRAFT'
      ? 'DRAFT' as const
      : input.operation === 'MARK_REVIEWED' ? 'REVIEWED' as const : 'SIGNED_OFF' as const;
    const normalizedNotes = {
      source: 'STAFF_ENTERED',
      actorUserId: request.auth.userId,
      recordedAt: now.toISOString(),
      summary: input.operationalNotes.summary || null,
      correction: input.operationalNotes.correction || null,
      callerIntent: input.operationalNotes.callerIntent || null,
      actionsTaken: input.operationalNotes.actionsTaken,
      followUpNotes: input.operationalNotes.followUpNotes || null,
    } satisfies Prisma.InputJsonObject;
    const submittedReviewContent = {
      summary: input.operationalNotes.summary || null,
      correction: input.operationalNotes.correction || null,
      callerIntent: input.operationalNotes.callerIntent || null,
      actionsTaken: input.operationalNotes.actionsTaken,
      followUpNotes: input.operationalNotes.followUpNotes || null,
    };

    const updated = await runWithTenantContext(request.auth.tenantId, async tx => {
      const current = await tx.receptionistCallLog.findFirst({
        where: { id, tenantId: request.auth.tenantId },
        select: { id: true, reviewRevision: true, reviewStatus: true, operationalNotes: true, unresolvedActionItems: true },
      });
      if (!current) throw app.httpErrors.notFound('Call log not found');
      if (current.reviewRevision !== input.expectedRevision) {
        throw app.httpErrors.conflict('This call review changed. Reload it before saving.');
      }
      if (current.reviewStatus === 'SIGNED_OFF') {
        throw app.httpErrors.conflict('A signed-off call review is final and cannot be overwritten.');
      }
      if (input.operation === 'SIGN_OFF' && current.reviewStatus !== 'REVIEWED') {
        throw app.httpErrors.conflict('A call review must be marked reviewed before manager sign-off.');
      }
      if (input.operation === 'SIGN_OFF') {
        const stored = current.operationalNotes && typeof current.operationalNotes === 'object' && !Array.isArray(current.operationalNotes)
          ? current.operationalNotes as Record<string, unknown>
          : {};
        const storedReviewContent = {
          summary: typeof stored.summary === 'string' ? stored.summary : null,
          correction: typeof stored.correction === 'string' ? stored.correction : null,
          callerIntent: typeof stored.callerIntent === 'string' ? stored.callerIntent : null,
          actionsTaken: Array.isArray(stored.actionsTaken) ? stored.actionsTaken : [],
          followUpNotes: typeof stored.followUpNotes === 'string' ? stored.followUpNotes : null,
        };
        if (JSON.stringify(storedReviewContent) !== JSON.stringify(submittedReviewContent)
          || JSON.stringify(current.unresolvedActionItems) !== JSON.stringify(input.unresolvedActionItems)) {
          throw app.httpErrors.conflict('The submitted sign-off content differs from the reviewed revision. Reload before signing.');
        }
      }
      if (input.operation === 'SIGN_OFF' && current.unresolvedActionItems.length > 0 && input.acknowledgeUnresolvedActions !== true) {
        throw app.httpErrors.badRequest('Sign-off with unresolved actions requires explicit acknowledgement.');
      }

      const result = await tx.receptionistCallLog.update({
        where: { id },
        data: {
          ...(input.operation === 'SIGN_OFF' ? {} : {
            operationalNotes: normalizedNotes,
            unresolvedActionItems: input.unresolvedActionItems,
          }),
          reviewStatus: status,
          reviewRevision: { increment: 1 },
          ...(input.operation === 'SAVE_DRAFT' ? { reviewedByUserId: null, reviewedAt: null }
            : input.operation === 'MARK_REVIEWED' ? { reviewedByUserId: request.auth.userId, reviewedAt: now }
              : {}),
          signedOffByUserId: input.operation === 'SIGN_OFF' ? request.auth.userId : null,
          signedOffAt: input.operation === 'SIGN_OFF' ? now : null,
        },
        include: {
          reviewedBy: { select: { id: true, displayName: true } },
          signedOffBy: { select: { id: true, displayName: true } },
        },
      });
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId,
        actorUserId: request.auth.userId,
        action: `receptionistCallLog.operatorReview.${input.operation.toLowerCase()}`,
        resource: 'receptionistCallLog',
        resourceId: id,
        requestId: request.id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        metadata: {
          fromStatus: current.reviewStatus,
          toStatus: status,
          revision: current.reviewRevision + 1,
          unresolvedActionCount: input.operation === 'SIGN_OFF' ? current.unresolvedActionItems.length : input.unresolvedActionItems.length,
          source: 'staff_entered',
        },
      } });
      return result;
    });
    return updated;
  });

  // ===== Opt-outs =========================================================
  const optOutCreate = z.object({
    clinicId: uuid.optional().nullable(),
    contactPhone: optionalE164Phone,
    contactEmail: z.string().trim().email().max(160).transform(value => value.toLowerCase()).optional().nullable(),
    channel: z.enum(['VOICE', 'SMS', 'EMAIL', 'ALL']).optional(),
    reason: z.string().trim().min(3).max(300),
  }).strict().superRefine((value, ctx) => {
    if (!value.contactPhone && !value.contactEmail) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A phone number or email is required' });
    if ((value.channel === 'VOICE' || value.channel === 'SMS') && !value.contactPhone) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${value.channel} opt-outs require a phone number` });
    }
    if (value.channel === 'EMAIL' && !value.contactEmail) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'EMAIL opt-outs require an email address' });
  });
  const optOutRevocation = z.object({
    reason: z.string().trim().min(5).max(500),
    acknowledgeReactivationRisk: z.literal(true),
  }).strict();

  app.get('/opt-outs', { preHandler: callArtifactRead }, async request => {
    return db.receptionistOptOut.findMany({
      where: { tenantId: request.auth.tenantId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  });

  app.post('/opt-outs', { preHandler: writeRoles }, async (request, reply) => {
    const input = optOutCreate.parse(request.body);
    const row = await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockDncDestinationFence(tx, request.auth.tenantId, [input.contactPhone, input.contactEmail]);
      if (input.clinicId && !(await tx.receptionistClinic.findFirst({ where: { id: input.clinicId, tenantId: request.auth.tenantId }, select: { id: true } }))) {
        throw app.httpErrors.badRequest('Clinic does not belong to this tenant.');
      }
      const created = await tx.receptionistOptOut.create({ data: { tenantId: request.auth.tenantId, ...input } });
      const occurredAt = new Date();
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'receptionistOptOut.created', resource: 'receptionistOptOut', resourceId: created.id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'], occurredAt,
        metadata: { channel: created.channel, clinicId: created.clinicId, reasonRecorded: true, source: 'manual_api' },
      } });
      await tx.businessEvent.create({ data: {
        tenantId: request.auth.tenantId, eventType: 'receptionist.dnc.activated', entityType: 'receptionistOptOut',
        entityId: created.id, sourceModule: 'receptionist', occurredAt,
        payload: { channel: created.channel, clinicId: created.clinicId, source: 'manual_api' },
      } });
      return created;
    });
    return reply.code(201).send(row);
  });

  app.delete('/opt-outs/:id', { preHandler: [ownerAdminRoles, writeRoles] }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const input = optOutRevocation.parse(request.body);
    await runWithTenantContext(request.auth.tenantId, async tx => {
      const existing = await tx.receptionistOptOut.findFirst({ where: { id, tenantId: request.auth.tenantId } });
      if (!existing) throw app.httpErrors.notFound('Opt-out not found');
      await lockDncDestinationFence(tx, request.auth.tenantId, [existing.contactPhone, existing.contactEmail]);
      const revokedAt = new Date();
      const changed = await tx.receptionistOptOut.updateMany({
        where: { id, tenantId: request.auth.tenantId, revokedAt: null },
        data: { revokedAt, revokedByUserId: request.auth.userId, revocationReason: input.reason },
      });
      if (changed.count !== 1) throw app.httpErrors.conflict('Opt-out suppression has already been revoked.');
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'receptionistOptOut.revoked', resource: 'receptionistOptOut', resourceId: id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'], occurredAt: revokedAt,
        metadata: { channel: existing.channel, clinicId: existing.clinicId, reasonRecorded: true, acknowledgement: 'reactivation_risk_confirmed' },
      } });
      await tx.businessEvent.create({ data: {
        tenantId: request.auth.tenantId, eventType: 'receptionist.dnc.revoked', entityType: 'receptionistOptOut',
        entityId: id, sourceModule: 'receptionist', occurredAt: revokedAt,
        payload: { channel: existing.channel, clinicId: existing.clinicId, authorizedRole: request.auth.role, acknowledgement: 'reactivation_risk_confirmed' },
      } });
    });
    return reply.code(204).send();
  });

  // ===== Overview KPIs ====================================================
  // Every rate is defined, versioned and allowed to be null. A rate with no
  // denominator is UNAVAILABLE, never 0 — a clinic must never read "0% booked"
  // when the truth is "no answered calls yet".
  app.get('/overview', { preHandler: callArtifactRead }, async request => {
    const tenantId = request.auth.tenantId;
    const query = z.object({
      clinicId: uuid.optional(),
      period: z.enum(['today', '7d', '30d', 'custom']).default('7d'),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      direction: z.enum(['inbound', 'outbound']).optional(),
    }).parse(request.query);

    const clinic = query.clinicId
      ? await db.receptionistClinic.findFirst({ where: { id: query.clinicId, tenantId }, select: { id: true, timezone: true } })
      : await db.receptionistClinic.findFirst({ where: { tenantId }, orderBy: { createdAt: 'asc' }, select: { id: true, timezone: true } });
    if (query.clinicId && !clinic) throw app.httpErrors.notFound('Clinic not found');
    const timezone = clinic?.timezone ?? 'UTC';
    const range = query.period === 'custom' && (query.from || query.to)
      ? { from: query.from ?? new Date(0), to: query.to ?? new Date() }
      : clinicDayRangeUtc(timezone, query.period === 'today' ? 0 : query.period === '30d' ? 29 : 6);

    const callScope = {
      tenantId,
      ...(query.clinicId ? { clinicId: query.clinicId } : {}),
      ...(query.direction ? { direction: query.direction } : {}),
      createdAt: { gte: range.from, lte: range.to },
    } satisfies Prisma.ReceptionistCallLogWhereInput;
    const inboundScope = { ...callScope, direction: 'inbound' };
    const UNANSWERED = ['NO_ANSWER', 'FAILED', 'IN_PROGRESS'] as const;

    const [
      grouped, durations, inboundTotal, answeredInbound, inboundBooked, escalatedOrHandoff,
      optedOut, pendingRequests, openHandoffs, activeCampaigns, clinics, callbackTasks, outsideHoursSupported,
    ] = await Promise.all([
      db.receptionistCallLog.groupBy({ by: ['direction', 'outcome'], where: callScope, _count: { _all: true } }),
      db.receptionistCallLog.aggregate({
        where: { ...callScope, outcome: { not: 'IN_PROGRESS' }, durationSeconds: { gt: 0 } },
        _avg: { durationSeconds: true }, _count: { _all: true },
      }),
      db.receptionistCallLog.count({ where: inboundScope }),
      db.receptionistCallLog.count({ where: { ...inboundScope, outcome: { notIn: [...UNANSWERED] } } }),
      db.receptionistCallLog.count({ where: { ...inboundScope, outcome: 'BOOKED' } }),
      db.receptionistCallLog.count({ where: {
        ...inboundScope,
        outcome: { notIn: [...UNANSWERED] },
        OR: [
          { outcome: 'ESCALATED' },
          { staffTasks: { some: { AND: [
            { metadata: { path: ['workflow'], equals: RECEPTIONIST_TASK_WORKFLOW } },
            { OR: [{ metadata: { path: ['kind'], equals: 'human_handoff' } }, { metadata: { path: ['kind'], equals: 'emergency' } }] },
          ] } } },
        ],
      } }),
      db.receptionistOptOut.count({ where: { tenantId, revokedAt: null, ...(query.clinicId ? { clinicId: query.clinicId } : {}) } }),
      db.appointmentRequest.count({ where: {
        tenantId, status: { in: [...PENDING_REQUEST_STATUS] },
        ...(query.clinicId ? { callLog: { clinicId: query.clinicId } } : {}),
      } }),
      db.receptionistCallLog.count({ where: { ...callScope, staffTasks: { some: { status: { in: [...LIVE_TASK_STATUS] } } } } }),
      db.receptionistCampaign.count({ where: { tenantId, status: 'ACTIVE', ...(query.clinicId ? { clinicId: query.clinicId } : {}) } }),
      db.receptionistClinic.count({ where: { tenantId } }),
      db.staffTask.findMany({
        where: {
          tenantId,
          createdAt: { gte: range.from, lte: range.to },
          AND: [
            { metadata: { path: ['workflow'], equals: RECEPTIONIST_TASK_WORKFLOW } },
            { OR: [{ metadata: { path: ['kind'], equals: 'message' } }, { metadata: { path: ['kind'], equals: 'human_handoff' } }] },
          ],
        },
        select: { acknowledgedAt: true, dueAt: true },
      }),
      hasOutsideHoursColumn(),
    ]);

    // After-hours needs C2's stamped column; without it the answer is "unknown".
    let afterHoursPct: number | null = null;
    let afterHoursBasis = 'unavailable_no_hours';
    if (outsideHoursSupported && inboundTotal > 0) {
      const rows = await db.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM "ReceptionistCallLog"
        WHERE "tenantId" = ${tenantId}::uuid AND "direction" = 'inbound'
          AND "createdAt" >= ${range.from} AND "createdAt" <= ${range.to}
          AND "outsideHours" IS TRUE
          ${query.clinicId ? Prisma.sql`AND "clinicId" = ${query.clinicId}::uuid` : Prisma.empty}
      `;
      afterHoursPct = Number(rows[0]?.count ?? 0) / inboundTotal;
      afterHoursBasis = 'stamped_outside_hours';
    }

    const answeredCallbacks = callbackTasks.filter(task => task.acknowledgedAt && task.dueAt);
    const callbacksWithinSlaPct = callbackTasks.length === 0
      ? null
      : answeredCallbacks.filter(task => task.acknowledgedAt!.getTime() <= task.dueAt!.getTime()).length / callbackTasks.length;

    const bookedTotal = grouped.filter(row => row.outcome === 'BOOKED').reduce((sum, row) => sum + row._count._all, 0);
    const counts = {
      inbound: inboundTotal,
      outbound: grouped.filter(row => row.direction === 'outbound').reduce((sum, row) => sum + row._count._all, 0),
      answeredInbound,
      booked: bookedTotal,
      escalated: grouped.filter(row => row.outcome === 'ESCALATED').reduce((sum, row) => sum + row._count._all, 0),
      optedOut, pendingRequests, openHandoffs, activeCampaigns, clinics,
    };
    const aht = durations._count._all > 0 && durations._avg.durationSeconds !== null
      ? Math.round(durations._avg.durationSeconds)
      : null;

    return {
      period: { from: range.from, to: range.to, timezone, period: query.period },
      counts,
      rates: {
        bookingRate: answeredInbound > 0 ? inboundBooked / answeredInbound : null,
        containedPct: answeredInbound > 0 ? (answeredInbound - escalatedOrHandoff) / answeredInbound : null,
        afterHoursPct,
        callbacksWithinSlaPct,
      },
      aht,
      definitions: {
        version: 'kpi-v2',
        answeredInbound: 'Inbound calls whose outcome is not NO_ANSWER, FAILED or IN_PROGRESS.',
        bookingRate: 'Inbound BOOKED / answered inbound. Null when nothing was answered.',
        containedPct: 'Answered inbound minus calls that escalated or filed a handoff/emergency task, over answered inbound.',
        afterHours: afterHoursBasis,
        aht: 'Average call seconds, excluding in-progress and zero-second calls.',
        callbacksWithinSla: 'Message and handoff tasks acknowledged on or before their due time, over those created in the period.',
      },
      // D6: the pre-C4 scalars are GONE. They divided BOOKED by every call in
      // both directions — including the zero-second NO_ANSWER rows the live
      // audit found — and collapsed null to 0, so a clinic that had answered
      // nothing read "0% booking rate" and "0m 0s" instead of "no data yet".
      // That is the "7 calls handled / 14% booking rate" the contract froze as
      // not-capability. `counts`, `rates`, `aht` and `definitions` above are the
      // honest replacements; a rate with no denominator is null, never 0.
    };
  });
};
