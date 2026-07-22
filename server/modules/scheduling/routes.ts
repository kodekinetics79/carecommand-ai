import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { requirePermission } from '../../lib/permissions';
import { assertBranchAccess } from '../../lib/scope';
import { recordWorkflowEvent } from '../../lib/intelligence';
import { computeProviderSlots, findSlotConflict, getSchedulingPolicy, isDoubleBookConflictError } from '../../lib/scheduling';

// ===========================================================================
// Provider scheduling — recurring availability, one-off time-off, open-slot
// queries, and conflict-safe booking. Backend-owned slot math (lib/scheduling.ts)
// so no client can fabricate availability. This is the foundation that patient
// self-scheduling (portal) will book against.
// ===========================================================================

const uuid = z.string().uuid();
const providerParam = z.object({ providerId: uuid });
const dateISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');

const canManageSchedule = requirePermission('schedule:manage');
const canBook = requirePermission('appointment:write');

const windowSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
  slotMinutes: z.number().int().min(5).max(240).default(30),
}).refine(w => w.endMinute > w.startMinute, { message: 'endMinute must be after startMinute' });

export const schedulingRoutes: FastifyPluginAsync = async app => {
  /** Load a provider in the caller's tenant (+ branch guard), or 404. */
  async function loadProvider(request: FastifyRequest, providerId: string) {
    const provider = await db.providerProfile.findFirst({
      where: { id: providerId, tenantId: request.auth.tenantId },
      select: { id: true, branchId: true, userId: true },
    });
    if (!provider) throw app.httpErrors.notFound('Provider not found');
    assertBranchAccess(request, provider.branchId);
    return provider;
  }

  // ----- Self-scheduling policy (per tenant) --------------------------------
  app.get('/policy', async request => getSchedulingPolicy(request.auth.tenantId));

  app.put('/policy', { preHandler: canManageSchedule }, async request => {
    const input = z.object({
      selfBookEnabled: z.boolean().optional(),
      requireEligibilityForSelfBook: z.boolean().optional(),
      requireIntakeForSelfBook: z.boolean().optional(),
      maxHorizonDays: z.number().int().min(1).max(365).optional(),
      minNoticeHours: z.number().int().min(0).max(720).optional(),
    }).parse(request.body);
    await db.schedulingPolicy.upsert({
      where: { tenantId: request.auth.tenantId },
      update: input,
      create: { tenantId: request.auth.tenantId, ...input },
    });
    await audit(request, { action: 'schedule.policy.updated', resource: 'schedulingPolicy', resourceId: request.auth.tenantId, metadata: input });
    return getSchedulingPolicy(request.auth.tenantId);
  });

  // ----- Weekly availability (replace-all) ----------------------------------
  app.put('/providers/:providerId/availability', { preHandler: canManageSchedule }, async request => {
    const { providerId } = providerParam.parse(request.params);
    const { windows } = z.object({ windows: z.array(windowSchema).max(50) }).parse(request.body);
    const provider = await loadProvider(request, providerId);

    await db.$transaction([
      db.providerAvailability.deleteMany({ where: { tenantId: request.auth.tenantId, providerProfileId: providerId } }),
      db.providerAvailability.createMany({
        data: windows.map(w => ({ tenantId: request.auth.tenantId, branchId: provider.branchId, providerProfileId: providerId, dayOfWeek: w.dayOfWeek, startMinute: w.startMinute, endMinute: w.endMinute, slotMinutes: w.slotMinutes })),
        skipDuplicates: true,
      }),
    ]);
    await audit(request, { action: 'schedule.availability.updated', resource: 'providerProfile', resourceId: providerId, metadata: { windows: windows.length } });
    const saved = await db.providerAvailability.findMany({ where: { tenantId: request.auth.tenantId, providerProfileId: providerId }, orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }] });
    return { providerId, windows: saved };
  });

  app.get('/providers/:providerId/availability', async request => {
    const { providerId } = providerParam.parse(request.params);
    await loadProvider(request, providerId);
    const windows = await db.providerAvailability.findMany({ where: { tenantId: request.auth.tenantId, providerProfileId: providerId }, orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }] });
    return { providerId, windows };
  });

  // ----- Time off -----------------------------------------------------------
  app.post('/providers/:providerId/time-off', { preHandler: canManageSchedule }, async (request, reply) => {
    const { providerId } = providerParam.parse(request.params);
    const body = z.object({ startsAt: z.coerce.date(), endsAt: z.coerce.date(), reason: z.string().trim().max(240).optional() })
      .refine(b => b.endsAt > b.startsAt, { message: 'endsAt must be after startsAt' })
      .parse(request.body);
    await loadProvider(request, providerId);
    const row = await db.providerTimeOff.create({ data: { tenantId: request.auth.tenantId, providerProfileId: providerId, startsAt: body.startsAt, endsAt: body.endsAt, reason: body.reason } });
    await audit(request, { action: 'schedule.time_off.created', resource: 'providerProfile', resourceId: providerId, metadata: { timeOffId: row.id } });
    return reply.code(201).send(row);
  });

  // ----- Open slots (read) --------------------------------------------------
  app.get('/providers/:providerId/slots', async request => {
    const { providerId } = providerParam.parse(request.params);
    const query = z.object({ date: dateISO, durationMin: z.coerce.number().int().min(5).max(240).optional() }).parse(request.query);
    await loadProvider(request, providerId);
    const slots = await computeProviderSlots({ tenantId: request.auth.tenantId, providerProfileId: providerId, dateISO: query.date, durationMin: query.durationMin });
    return { providerId, date: query.date, slots: slots.map(s => ({ startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString() })) };
  });

  // ----- Conflict-safe booking ----------------------------------------------
  app.post('/providers/:providerId/book', { preHandler: canBook }, async (request, reply) => {
    const { providerId } = providerParam.parse(request.params);
    const body = z.object({
      patientId: uuid,
      startsAt: z.coerce.date(),
      durationMin: z.number().int().min(5).max(240).default(30),
      service: z.string().trim().min(1).max(160),
      channel: z.enum(['WHATSAPP', 'SMS', 'EMAIL', 'PUSH', 'CALL', 'VIDEO']).default('EMAIL'),
    }).parse(request.body);
    const provider = await loadProvider(request, providerId);

    const patient = await db.patient.findFirst({ where: { id: body.patientId, tenantId: request.auth.tenantId, branchId: provider.branchId, deletedAt: null }, select: { id: true } });
    if (!patient) throw app.httpErrors.badRequest('Patient not found in this provider\'s clinic');

    const endsAt = new Date(body.startsAt.getTime() + body.durationMin * 60_000);

    // Conflict check + create in one transaction so the slot can't be double-booked
    // between check and insert. The DB exclusion constraint is the final guard if a
    // concurrent booking still races past the in-transaction check.
    let result: { conflict: Awaited<ReturnType<typeof findSlotConflict>> } | { appointment: Awaited<ReturnType<typeof db.appointment.create>> };
    try {
      result = await db.$transaction(async tx => {
        const conflict = await findSlotConflict({ tenantId: request.auth.tenantId, providerProfileId: providerId, startsAt: body.startsAt, durationMin: body.durationMin }, tx);
        if (conflict) return { conflict } as const;
        const appointment = await tx.appointment.create({
          data: {
            tenantId: request.auth.tenantId, branchId: provider.branchId, patientId: body.patientId,
            providerProfileId: providerId, providerRef: providerId, service: body.service, startsAt: body.startsAt, endsAt,
            status: 'CONFIRMED', channel: body.channel,
          },
        });
        return { appointment } as const;
      });
    } catch (error) {
      if (isDoubleBookConflictError(error)) return reply.code(409).send({ error: 'slot_unavailable', reason: 'already_booked' });
      throw error;
    }

    if ('conflict' in result) {
      return reply.code(409).send({ error: 'slot_unavailable', reason: result.conflict });
    }

    await audit(request, { action: 'appointment.booked', resource: 'appointment', resourceId: result.appointment.id, metadata: { providerId, startsAt: body.startsAt.toISOString() } });
    await recordWorkflowEvent(request.auth.tenantId, { eventType: 'appointment.created', entityType: 'appointment', entityId: result.appointment.id, sourceModule: 'scheduling', payload: { providerId, branchId: provider.branchId } });
    return reply.code(201).send(result.appointment);
  });
};
