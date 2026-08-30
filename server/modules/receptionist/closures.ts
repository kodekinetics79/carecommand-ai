import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { runWithTenantContext } from '../../lib/tenantContext';
import { recordWorkflowEvent } from '../../lib/intelligence';
import { promptText } from '../../lib/receptionist/promptSafety';
import { CATALOG_LIMITS } from '../../lib/receptionist/catalog';
import { idParam, uuid, writeRoles, receptionistRead, isoDate, lockReceptionistConfiguration, auditReceptionistMutation } from './shared';

// ===========================================================================
// Planned closures. Dates are clinic-local calendar dates, never instants, so
// a holiday does not shift with the caller's timezone. Overlapping closures
// are allowed and unioned by the hours engine.
// ===========================================================================

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function view(row: {
  id: string; clinicId: string; locationId: string | null; startsOn: Date; endsOn: Date;
  startTime: string | null; endTime: string | null; reason: string; internalNote: string | null;
  createdAt: Date; updatedAt: Date;
}) {
  return {
    ...row,
    startsOn: dateOnly(row.startsOn),
    endsOn: dateOnly(row.endsOn),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const selection = {
  id: true, clinicId: true, locationId: true, startsOn: true, endsOn: true,
  startTime: true, endTime: true, reason: true, internalNote: true, createdAt: true, updatedAt: true,
} as const;

// Partial-day closures are a pilot cut: the columns and the engine support
// them, the API refuses them so the UI cannot create half-supported state.
const closureFields = {
  locationId: uuid.optional().nullable(),
  startsOn: isoDate,
  endsOn: isoDate,
  startTime: z.null().optional(),
  endTime: z.null().optional(),
  reason: promptText(CATALOG_LIMITS.closureReasonMax).pipe(z.string().min(2)),
  internalNote: z.string().trim().max(500).optional().nullable(),
};

// Zod refuses .partial() on an object that carries a superRefine, so the
// cross-field range rules live here and are applied to both shapes.
function rangeIssue(startsOn: string, endsOn: string): string | null {
  if (endsOn < startsOn) return 'The closure must end on or after it starts.';
  if ((Date.parse(endsOn) - Date.parse(startsOn)) / 86_400_000 > CATALOG_LIMITS.closureMaxDays) {
    return `A closure cannot span more than ${CATALOG_LIMITS.closureMaxDays} days.`;
  }
  return null;
}

const closureBody = z.object(closureFields).strict();
const closurePatchBody = z.object(closureFields).partial().strict();

export const closureRoutes: FastifyPluginAsync = async app => {
  async function assertClinic(tenantId: string, clinicId: string) {
    const clinic = await db.receptionistClinic.findFirst({ where: { id: clinicId, tenantId }, select: { id: true } });
    if (!clinic) throw app.httpErrors.notFound('Clinic not found');
  }

  app.get('/clinics/:id/closures', { preHandler: receptionistRead }, async request => {
    const { id } = idParam.parse(request.params);
    const query = z.object({ from: isoDate.optional(), to: isoDate.optional() }).parse(request.query);
    await assertClinic(request.auth.tenantId, id);
    const rows = await db.receptionistClosure.findMany({
      where: {
        tenantId: request.auth.tenantId, clinicId: id,
        ...(query.from ? { endsOn: { gte: new Date(query.from) } } : {}),
        ...(query.to ? { startsOn: { lte: new Date(query.to) } } : {}),
      },
      orderBy: [{ startsOn: 'asc' }, { id: 'asc' }],
      select: selection,
    });
    return rows.map(view);
  });

  app.post('/clinics/:id/closures', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const input = closureBody.parse(request.body);
    const invalidRange = rangeIssue(input.startsOn, input.endsOn);
    if (invalidRange) throw app.httpErrors.badRequest(invalidRange);
    await assertClinic(request.auth.tenantId, id);
    const row = await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockReceptionistConfiguration(tx, request.auth.tenantId);
      if (input.locationId) {
        const location = await tx.receptionistLocation.findFirst({ where: { id: input.locationId, tenantId: request.auth.tenantId, clinicId: id }, select: { id: true } });
        if (!location) throw app.httpErrors.badRequest('location_not_in_clinic: that location belongs to a different clinic.');
      }
      const created = await tx.receptionistClosure.create({
        data: {
          tenantId: request.auth.tenantId,
          clinicId: id,
          locationId: input.locationId ?? null,
          startsOn: new Date(input.startsOn),
          endsOn: new Date(input.endsOn),
          reason: input.reason,
          internalNote: input.internalNote ?? null,
          createdByUserId: request.auth.userId,
        },
        select: selection,
      });
      await auditReceptionistMutation(tx, request, {
        action: 'receptionistClosure.created', resource: 'receptionistClosure', resourceId: created.id,
        metadata: { clinicId: id, locationId: created.locationId, startsOn: dateOnly(created.startsOn), endsOn: dateOnly(created.endsOn) },
      });
      return created;
    });
    await recordWorkflowEvent(request.auth.tenantId, { eventType: 'receptionist.clinic.hours_changed', entityType: 'receptionistClinic', entityId: id, sourceModule: 'receptionist', payload: { clinicId: id, closureId: row.id } });
    return reply.code(201).send(view(row));
  });

  app.patch('/closures/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = closurePatchBody.parse(request.body);
    const row = await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockReceptionistConfiguration(tx, request.auth.tenantId);
      const existing = await tx.receptionistClosure.findFirst({ where: { id, tenantId: request.auth.tenantId }, select: selection });
      if (!existing) throw app.httpErrors.notFound('Closure not found');
      const startsOn = input.startsOn ?? dateOnly(existing.startsOn);
      const endsOn = input.endsOn ?? dateOnly(existing.endsOn);
      const invalidRange = rangeIssue(startsOn, endsOn);
      if (invalidRange) throw app.httpErrors.badRequest(invalidRange);
      if (input.locationId) {
        const location = await tx.receptionistLocation.findFirst({ where: { id: input.locationId, tenantId: request.auth.tenantId, clinicId: existing.clinicId }, select: { id: true } });
        if (!location) throw app.httpErrors.badRequest('location_not_in_clinic: that location belongs to a different clinic.');
      }
      const updated = await tx.receptionistClosure.update({
        where: { id },
        data: {
          ...(input.locationId !== undefined ? { locationId: input.locationId } : {}),
          ...(input.startsOn !== undefined ? { startsOn: new Date(input.startsOn) } : {}),
          ...(input.endsOn !== undefined ? { endsOn: new Date(input.endsOn) } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.internalNote !== undefined ? { internalNote: input.internalNote } : {}),
        },
        select: selection,
      });
      await auditReceptionistMutation(tx, request, {
        action: 'receptionistClosure.updated', resource: 'receptionistClosure', resourceId: id,
        metadata: { clinicId: updated.clinicId, startsOn: dateOnly(updated.startsOn), endsOn: dateOnly(updated.endsOn) },
      });
      return updated;
    });
    await recordWorkflowEvent(request.auth.tenantId, { eventType: 'receptionist.clinic.hours_changed', entityType: 'receptionistClinic', entityId: row.clinicId, sourceModule: 'receptionist', payload: { clinicId: row.clinicId, closureId: row.id } });
    return view(row);
  });

  app.delete('/closures/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const clinicId = await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockReceptionistConfiguration(tx, request.auth.tenantId);
      const existing = await tx.receptionistClosure.findFirst({ where: { id, tenantId: request.auth.tenantId }, select: { id: true, clinicId: true } });
      if (!existing) throw app.httpErrors.notFound('Closure not found');
      await tx.receptionistClosure.delete({ where: { id } });
      await auditReceptionistMutation(tx, request, { action: 'receptionistClosure.deleted', resource: 'receptionistClosure', resourceId: id, metadata: { clinicId: existing.clinicId } });
      return existing.clinicId;
    });
    await recordWorkflowEvent(request.auth.tenantId, { eventType: 'receptionist.clinic.hours_changed', entityType: 'receptionistClinic', entityId: clinicId, sourceModule: 'receptionist', payload: { clinicId } });
    return reply.code(204).send();
  });
};
