import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { hasReceptionistPermission, RECEPTIONIST_PERMISSIONS } from '../../lib/receptionist/accessControl';
import { runWithTenantContext } from '../../lib/tenantContext';
import { Prisma } from '../../generated/prisma/client';
import { lockDncDestinationFence } from '../../lib/receptionist/dncFence';
import { uuid, idParam, writeRoles, bookingReviewRoles, callArtifactRead, ownerAdminRoles, optionalE164Phone } from './shared';

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
  // ===== Appointment requests (read) ======================================
  app.get('/appointment-requests', { preHandler: callArtifactRead }, async request => {
    const query = z.object({
      clinicId: uuid.optional(),
      campaignId: uuid.optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).parse(request.query);
    return db.receptionistAppointmentRequest.findMany({
      where: {
        tenantId: request.auth.tenantId,
        ...(query.clinicId ? { clinicId: query.clinicId } : {}),
        ...(query.campaignId ? { campaignId: query.campaignId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      include: { campaign: { select: { id: true, name: true } } },
    });
  });

  app.patch('/appointment-requests/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = z.object({
      status: z.enum(['PENDING', 'CONFIRMED', 'CANCELED', 'COMPLETED', 'NO_SLOTS']).optional(),
      bookedSlot: z.string().trim().max(120).optional().nullable(),
      notes: z.string().trim().max(1000).optional().nullable(),
    }).parse(request.body);
    const existing = await db.receptionistAppointmentRequest.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Appointment request not found');
    const row = await db.receptionistAppointmentRequest.update({ where: { id }, data: input });
    await audit(request, { action: 'receptionistAppointmentRequest.updated', resource: 'receptionistAppointmentRequest', resourceId: id });
    return row;
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
        providerCallId: log.retellCallId,
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

  // ===== Call logs (read) =================================================
  app.get('/call-logs', { preHandler: callArtifactRead }, async request => {
    const query = z.object({
      clinicId: uuid.optional(),
      campaignId: uuid.optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }).parse(request.query);
    const rows = await db.receptionistCallLog.findMany({
      where: {
        tenantId: request.auth.tenantId,
        ...(query.clinicId ? { clinicId: query.clinicId } : {}),
        ...(query.campaignId ? { campaignId: query.campaignId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      include: { campaign: { select: { id: true, name: true } } },
    });
    const canReadRecordings = await hasReceptionistPermission(request, RECEPTIONIST_PERMISSIONS.RECORDINGS_READ);
    await audit(request, {
      action: 'receptionistCallLog.listRead',
      resource: 'receptionistCallLog',
      metadata: { count: rows.length, recordingsDisclosed: canReadRecordings },
    });
    return rows.map(row => ({
      ...row,
      recordingAvailable: Boolean(row.recordingUrl),
      recordingUrl: canReadRecordings ? row.recordingUrl : null,
    }));
  });

  app.get('/call-logs/:id', { preHandler: callArtifactRead }, async request => {
    const { id } = idParam.parse(request.params);
    const row = await db.receptionistCallLog.findFirst({
      where: { id, tenantId: request.auth.tenantId },
      include: {
        campaign: { select: { id: true, name: true } },
        reviewedBy: { select: { id: true, displayName: true } },
        signedOffBy: { select: { id: true, displayName: true } },
        appointments: { select: { id: true, service: true, startsAt: true, status: true }, orderBy: { createdAt: 'desc' } },
        appointmentRequests: {
          select: { id: true, requestedService: true, requestedDateTime: true, status: true, bookedAppointmentId: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!row) throw app.httpErrors.notFound('Call log not found');
    const canReadRecording = await hasReceptionistPermission(request, RECEPTIONIST_PERMISSIONS.RECORDINGS_READ);
    const canSignOffReview = await hasReceptionistPermission(request, RECEPTIONIST_PERMISSIONS.MANAGE);
    const usableRecordingUrl = typeof row.recordingUrl === 'string' && /^https:\/\//i.test(row.recordingUrl)
      ? row.recordingUrl
      : null;
    const handoffReferences = await db.staffTask.findMany({
      where: {
        tenantId: request.auth.tenantId,
        AND: [
          { metadata: { path: ['workflow'], equals: 'receptionist_safety' } },
          { OR: [
            { metadata: { path: ['callLogId'], equals: row.id } },
            ...(row.retellCallId ? [{ metadata: { path: ['callId'], equals: row.retellCallId } }] : []),
          ] },
        ],
      },
      select: { id: true, title: true, status: true, priority: true, dueAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    await audit(request, {
      action: 'receptionistCallLog.read',
      resource: 'receptionistCallLog',
      resourceId: row.id,
      metadata: { recordingDisclosed: canReadRecording && Boolean(row.recordingUrl) },
    });
    return {
      ...row,
      providerSummary: row.transcriptSummary ? {
        text: row.transcriptSummary,
        source: 'PROVIDER_CALL_ANALYSIS',
        sourceCallId: row.retellCallId,
      } : null,
      recordingAvailable: Boolean(usableRecordingUrl),
      recordingAccess: row.recordingPurgedAt
        ? 'purged'
        : !usableRecordingUrl
          ? 'not_available'
          : canReadRecording ? 'available' : 'restricted',
      recordingUrl: canReadRecording ? usableRecordingUrl : null,
      reviewCapabilities: { canEdit: true, canSignOff: canSignOffReview },
      handoffReferences,
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

  // ===== Overview (dashboard metrics) =====================================
  app.get('/overview', async request => {
    const tenantId = request.auth.tenantId;
    const [clinics, campaigns, callLogs, requests, optOuts] = await Promise.all([
      db.receptionistClinic.count({ where: { tenantId } }),
      db.receptionistCampaign.findMany({ where: { tenantId }, select: { status: true } }),
      db.receptionistCallLog.findMany({ where: { tenantId }, select: { outcome: true, durationSeconds: true } }),
      db.receptionistAppointmentRequest.count({ where: { tenantId } }),
      db.receptionistOptOut.count({ where: { tenantId, revokedAt: null } }),
    ]);
    const booked = callLogs.filter(call => call.outcome === 'BOOKED').length;
    const totalCalls = callLogs.length;
    const avgDuration = totalCalls
      ? Math.round(callLogs.reduce((sum, call) => sum + call.durationSeconds, 0) / totalCalls)
      : 0;
    return {
      clinics,
      activeCampaigns: campaigns.filter(campaign => campaign.status === 'ACTIVE').length,
      totalCampaigns: campaigns.length,
      totalCalls,
      booked,
      bookingRate: totalCalls ? Math.round((booked / totalCalls) * 100) : 0,
      appointmentRequests: requests,
      optOuts,
      avgDurationSeconds: avgDuration,
    };
  });
};
