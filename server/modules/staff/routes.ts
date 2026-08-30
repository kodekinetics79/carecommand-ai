import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { cursorPage, paginationSchema } from '../../lib/pagination';
import { branchScope, assertBranchAccess } from '../../lib/scope';
import { getRequestPermissions, requirePermission } from '../../lib/permissions';
import { runWithTenantContext } from '../../lib/tenantContext';
import { audit } from '../../lib/audit';
import {
  LIVE_TASK_STATUSES, parseReceptionistTask, receptionistTaskMetadata, TASK_OUTCOME_CODES,
  type ReceptionistTaskMetadata,
} from '../../lib/receptionist/frontDeskTask';
import { projectTaskRow, taskListInclude, type TaskRowWithRelations } from '../../lib/receptionist/taskProjection';
import type { Prisma } from '../../generated/prisma/client';

const staffQuery = paginationSchema.extend({
  branchId: z.string().uuid().optional(),
});

// Finishing a receptionist task means saying what happened to the caller, so a
// queue row can never be cleared without an outcome anyone can read later.
const taskStatusInput = z.object({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELED']),
  outcomeCode: z.enum(TASK_OUTCOME_CODES).optional(),
  outcomeNote: z.string().trim().max(500).optional(),
  appointmentId: z.string().uuid().optional(),
}).strict();

const taskNoteInput = z.object({ text: z.string().trim().min(1).max(500) }).strict();
const MAX_STAFF_NOTES = 50;

const taskAssignmentInput = z.object({
  assignedToId: z.string().uuid().nullable(),
});

export const staffRoutes: FastifyPluginAsync = async app => {
  /** Every task reply goes through the same masking the queue list uses. */
  async function projectForRequest(request: FastifyRequest, task: TaskRowWithRelations) {
    const permissions = await getRequestPermissions(request);
    return projectTaskRow(task, {
      canReadArtifacts: permissions.has('receptionist:call-artifacts:read'),
      canReadPatient: permissions.has('patient:read'),
    });
  }

  app.get('/overview', { preHandler: requirePermission('staff:read') }, async request => {
    const query = staffQuery.parse(request.query);
    const rows = await db.staffProfile.findMany({
      where: {
        tenantId: request.auth.tenantId,
        ...branchScope(request),
        branchId: request.auth.branchId ?? query.branchId,
      },
      orderBy: [{ bookingConversionRate: 'desc' }, { responseTime: 'asc' }],
      cursor: query.cursor ? { id: query.cursor } : undefined,
      skip: query.cursor ? 1 : 0,
      take: query.limit + 1,
      include: {
        branch: { select: { name: true } },
        user: { select: { displayName: true } },
      },
    });

    return cursorPage(rows, query.limit);
  });

  app.patch('/tasks/:id/status', { preHandler: requirePermission('staff:task-status') }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = taskStatusInput.parse(request.body);
    const result = await runWithTenantContext(request.auth.tenantId, async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`staff-task:${request.auth.tenantId}:${params.id}`}::text, 0))::text AS locked`;
      const existing = await tx.staffTask.findFirst({ where: { id: params.id, tenantId: request.auth.tenantId } });
      if (!existing) return { kind: 'not_found' as const };
      if (existing.branchId) assertBranchAccess(request, existing.branchId);
      if ((existing.status === 'COMPLETED' || existing.status === 'CANCELED') && existing.status !== input.status) {
        return { kind: 'terminal' as const };
      }
      // Same shape on every path so the queue can replace a row from any reply.
      const taskInclude = taskListInclude;
      if (existing.status === input.status) {
        const unchanged = await tx.staffTask.findFirstOrThrow({ where: { id: existing.id, tenantId: request.auth.tenantId }, include: taskInclude });
        return { kind: 'updated' as const, task: unchanged };
      }
      const receptionist = parseReceptionistTask(existing);
      const terminal = input.status === 'COMPLETED' || input.status === 'CANCELED';
      // Cancelling always needs a reason; completing a receptionist task does
      // too, because "done" with no outcome tells the next person nothing.
      if (input.status === 'CANCELED' && !input.outcomeCode) return { kind: 'outcome_required' as const };
      if (input.status === 'COMPLETED' && receptionist && !input.outcomeCode) return { kind: 'outcome_required' as const };
      if (input.outcomeCode === 'booked') {
        if (!input.appointmentId) return { kind: 'appointment_required' as const };
        const appointment = await tx.appointment.findFirst({
          where: { id: input.appointmentId, tenantId: request.auth.tenantId, deletedAt: null },
          select: { id: true },
        });
        if (!appointment) return { kind: 'appointment_invalid' as const };
      }
      const metadata: ReceptionistTaskMetadata | null = receptionist && input.appointmentId
        ? { ...receptionist, appointmentId: input.appointmentId }
        : null;
      const task = await tx.staffTask.update({
        where: { id: existing.id },
        data: {
          status: input.status,
          ...(terminal ? { completedAt: new Date() } : {}),
          ...(input.outcomeCode ? { outcomeCode: input.outcomeCode } : {}),
          ...(input.outcomeNote ? { outcomeNote: input.outcomeNote } : {}),
          ...(metadata ? { metadata: metadata as unknown as Prisma.InputJsonObject } : {}),
        },
        include: taskInclude,
      });
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'task.status.updated', resource: 'staffTask', resourceId: task.id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
        // The note text itself is caller content; only its existence is audited.
        metadata: {
          fromStatus: existing.status, toStatus: input.status,
          outcomeCode: input.outcomeCode ?? null, hasNote: Boolean(input.outcomeNote),
          appointmentId: input.appointmentId ?? null, kind: receptionist?.kind ?? null,
        },
      } });
      return { kind: 'updated' as const, task };
    });
    if (result.kind === 'not_found') throw app.httpErrors.notFound('Task not found');
    if (result.kind === 'terminal') throw app.httpErrors.conflict('Completed or canceled tasks are final and cannot be reopened');
    if (result.kind === 'outcome_required') throw app.httpErrors.badRequest('Record what happened: an outcome code is required to close this task');
    if (result.kind === 'appointment_required') throw app.httpErrors.badRequest('An outcome of "booked" requires the appointment it was booked into');
    if (result.kind === 'appointment_invalid') throw app.httpErrors.badRequest('The appointment does not exist in this tenant');
    return reply.send(await projectForRequest(request, result.task));
  });

  // ----- Task detail ------------------------------------------------------
  // The pilot has no separate /contact route: the caller's real number is
  // disclosed here to a `receptionist:call-artifacts:read` holder, and THAT
  // disclosure is the audited event. Everyone else sees the masked projection.
  app.get('/tasks/:id', { preHandler: requirePermission('staff:read') }, async request => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = await db.staffTask.findFirst({
      where: { id: params.id, tenantId: request.auth.tenantId },
      include: taskListInclude,
    });
    if (!row) throw app.httpErrors.notFound('Task not found');
    if (row.branchId) assertBranchAccess(request, row.branchId);
    const permissions = await getRequestPermissions(request);
    const canReadArtifacts = permissions.has('receptionist:call-artifacts:read');
    const projected = projectTaskRow(row, { canReadArtifacts, canReadPatient: permissions.has('patient:read') });
    const meta = parseReceptionistTask(row);
    if (!meta || !canReadArtifacts) return projected;
    const contact = {
      callerName: meta.callerName,
      callbackPhone: meta.callbackPhone,
      verifiedPhone: meta.verifiedPhone,
      requestedCallbackPhone: meta.requestedCallbackPhone,
    };
    if (contact.callbackPhone || contact.verifiedPhone || contact.requestedCallbackPhone) {
      await audit(request, {
        action: 'task.contact.revealed', resource: 'staffTask', resourceId: row.id,
        metadata: { kind: meta.kind, purpose: 'click_to_call' },
      });
    }
    return { ...projected, contact };
  });

  // ----- Acknowledge ------------------------------------------------------
  // Acknowledgment is the promise the AI could not make: a human has seen this.
  // Idempotent, so a double click never rewrites who saw it first.
  app.patch('/tasks/:id/acknowledge', { preHandler: requirePermission('staff:task-status') }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const lockKey = `staff-task:${request.auth.tenantId}:${params.id}`;
    const result = await runWithTenantContext(request.auth.tenantId, async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}::text, 0))::text AS locked`;
      const existing = await tx.staffTask.findFirst({ where: { id: params.id, tenantId: request.auth.tenantId } });
      if (!existing) return { kind: 'not_found' as const };
      if (existing.branchId) assertBranchAccess(request, existing.branchId);
      if (!(LIVE_TASK_STATUSES as readonly string[]).includes(existing.status)) return { kind: 'terminal' as const };
      if (existing.acknowledgedAt) {
        const unchanged = await tx.staffTask.findFirstOrThrow({ where: { id: existing.id, tenantId: request.auth.tenantId }, include: taskListInclude });
        return { kind: 'updated' as const, task: unchanged };
      }
      const now = new Date();
      const task = await tx.staffTask.update({
        where: { id: existing.id },
        data: { acknowledgedAt: now, acknowledgedById: request.auth.userId },
        include: taskListInclude,
      });
      const meta = parseReceptionistTask(existing);
      if (meta?.kind === 'emergency') {
        await tx.operationalSignal.updateMany({
          where: { tenantId: request.auth.tenantId, entityType: 'staffTask', entityId: existing.id, status: 'open' },
          data: { status: 'acknowledged' },
        });
        await tx.businessEvent.create({ data: {
          tenantId: request.auth.tenantId, eventType: 'receptionist.safety.emergency.acknowledged',
          entityType: 'staffTask', entityId: existing.id, sourceModule: 'receptionist',
          payload: { secondsSinceCreated: Math.round((now.getTime() - existing.createdAt.getTime()) / 1000) },
        } });
      }
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'task.acknowledged', resource: 'staffTask', resourceId: existing.id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
        metadata: {
          kind: meta?.kind ?? null,
          secondsSinceCreated: Math.round((now.getTime() - existing.createdAt.getTime()) / 1000),
          withinSla: existing.dueAt ? now.getTime() <= existing.dueAt.getTime() : null,
        },
      } });
      return { kind: 'updated' as const, task };
    });
    if (result.kind === 'not_found') throw app.httpErrors.notFound('Task not found');
    if (result.kind === 'terminal') throw app.httpErrors.conflict('A completed or canceled task cannot be acknowledged');
    return reply.send(await projectForRequest(request, result.task));
  });

  // ----- Staff notes (append-only inside the task) ------------------------
  app.post('/tasks/:id/notes', { preHandler: requirePermission('staff:task-status') }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = taskNoteInput.parse(request.body);
    const lockKey = `staff-task:${request.auth.tenantId}:${params.id}`;
    const result = await runWithTenantContext(request.auth.tenantId, async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}::text, 0))::text AS locked`;
      const existing = await tx.staffTask.findFirst({ where: { id: params.id, tenantId: request.auth.tenantId } });
      if (!existing) return { kind: 'not_found' as const };
      if (existing.branchId) assertBranchAccess(request, existing.branchId);
      if (!(LIVE_TASK_STATUSES as readonly string[]).includes(existing.status)) return { kind: 'terminal' as const };
      const current = parseReceptionistTask(existing)
        ?? receptionistTaskMetadata.parse({ workflow: 'receptionist_safety', kind: 'message' });
      if (current.staffNotes.length >= MAX_STAFF_NOTES) return { kind: 'note_limit' as const };
      const next: ReceptionistTaskMetadata = {
        ...current,
        staffNotes: [...current.staffNotes, { text: input.text, at: new Date().toISOString(), byUserId: request.auth.userId }],
      };
      const task = await tx.staffTask.update({
        where: { id: existing.id },
        data: { metadata: next as unknown as Prisma.InputJsonObject },
        include: taskListInclude,
      });
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'task.note.appended', resource: 'staffTask', resourceId: existing.id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
        metadata: { hasNote: true, noteCount: next.staffNotes.length },
      } });
      return { kind: 'updated' as const, task };
    });
    if (result.kind === 'not_found') throw app.httpErrors.notFound('Task not found');
    if (result.kind === 'terminal') throw app.httpErrors.conflict('A completed or canceled task cannot take new notes');
    if (result.kind === 'note_limit') throw app.httpErrors.conflict('This task already holds the maximum number of staff notes');
    return reply.send(await projectForRequest(request, result.task));
  });

  // People a task can actually be handed to. Gated on staff:write because only a
  // caller who may assign to someone else needs the roster; a caller who can
  // only take work themselves never sees it.
  app.get('/assignees', { preHandler: requirePermission('staff:write') }, async request => {
    const rows = await db.user.findMany({
      where: {
        tenantId: request.auth.tenantId,
        active: true,
        // A branch-restricted caller may only hand work to someone who can see
        // that branch: their own branch, or a tenant-wide (unscoped) user.
        ...(request.auth.branchId ? { OR: [{ branchId: request.auth.branchId }, { branchId: null }] } : {}),
      },
      orderBy: [{ displayName: 'asc' }],
      take: 200,
      select: { id: true, displayName: true, role: true, branchId: true },
    });
    return rows;
  });

  // Assignment. Until now nothing in the product could put a name on a task, so
  // every row read "Unassigned" forever. Taking a task yourself needs only the
  // grant that already lets you move its status; handing work to someone else is
  // a different act and needs staff:write.
  app.patch('/tasks/:id/assignment', { preHandler: requirePermission('staff:task-status') }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = taskAssignmentInput.parse(request.body);
    const permissions = await getRequestPermissions(request);
    const canAssignOthers = permissions.has('staff:write');

    const result = await runWithTenantContext(request.auth.tenantId, async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`staff-task:${request.auth.tenantId}:${params.id}`}::text, 0))::text AS locked`;
      const existing = await tx.staffTask.findFirst({ where: { id: params.id, tenantId: request.auth.tenantId } });
      if (!existing) return { kind: 'not_found' as const };
      if (existing.branchId) assertBranchAccess(request, existing.branchId);
      if (existing.status === 'COMPLETED' || existing.status === 'CANCELED') return { kind: 'terminal' as const };

      const claimingSelf = input.assignedToId === request.auth.userId;
      const releasingOwn = input.assignedToId === null && existing.assignedToId === request.auth.userId;
      if (!canAssignOthers && !claimingSelf && !releasingOwn) return { kind: 'forbidden' as const };

      if (input.assignedToId) {
        const assignee = await tx.user.findFirst({
          where: { id: input.assignedToId, tenantId: request.auth.tenantId, active: true },
          select: { id: true, branchId: true },
        });
        if (!assignee) return { kind: 'invalid_assignee' as const };
        // A branch-scoped user's own queue filters to their branch, so assigning
        // them another branch's task would file work they can never see.
        if (assignee.branchId && existing.branchId && assignee.branchId !== existing.branchId) {
          return { kind: 'branch_mismatch' as const };
        }
      }

      if (existing.assignedToId === input.assignedToId) {
        const unchanged = await tx.staffTask.findFirstOrThrow({
          where: { id: existing.id, tenantId: request.auth.tenantId },
          include: { branch: { select: { name: true } }, assignedTo: { select: { displayName: true } } },
        });
        return { kind: 'updated' as const, task: unchanged };
      }

      const task = await tx.staffTask.update({
        where: { id: existing.id },
        data: { assignedToId: input.assignedToId },
        include: { branch: { select: { name: true } }, assignedTo: { select: { displayName: true } } },
      });
      await tx.auditEvent.create({ data: {
        tenantId: request.auth.tenantId, actorUserId: request.auth.userId,
        action: 'task.assignment.updated', resource: 'staffTask', resourceId: task.id,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
        metadata: { fromAssignedToId: existing.assignedToId, toAssignedToId: input.assignedToId, selfClaim: claimingSelf },
      } });
      return { kind: 'updated' as const, task };
    });

    if (result.kind === 'not_found') throw app.httpErrors.notFound('Task not found');
    if (result.kind === 'terminal') throw app.httpErrors.conflict('Completed or canceled tasks are final and cannot be reassigned');
    if (result.kind === 'forbidden') throw app.httpErrors.forbidden('Your role can take a task itself but cannot assign work to another person');
    if (result.kind === 'invalid_assignee') throw app.httpErrors.badRequest('Assignee must be an active user in the authenticated tenant');
    if (result.kind === 'branch_mismatch') throw app.httpErrors.badRequest('Assignee is restricted to a different branch and would not see this task');
    return reply.send(result.task);
  });
};
