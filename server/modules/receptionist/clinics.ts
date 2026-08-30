import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { runWithTenantContext } from '../../lib/tenantContext';
import { validateIanaTimezone } from '../../lib/scheduling';
import { Prisma } from '../../generated/prisma/client';
import { uuid, idParam, writeRoles, e164Phone, optionalE164Phone, isActiveIntakeContractError, isReceptionistDestinationConflict, lockReceptionistConfiguration, auditReceptionistMutation } from './shared';

const timezoneInput = z.string().trim().min(2).max(80).refine(value => {
  try { validateIanaTimezone(value); return true; } catch { return false; }
}, 'Timezone must be a valid IANA timezone identifier');

const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Time must use 24-hour HH:mm format');

const hoursWindow = z.object({ open: z.boolean(), start: clockTime.optional(), end: clockTime.optional() }).strict()
  .superRefine((value, ctx) => {
    if (!value.open) return;
    if (!value.start || !value.end) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Open days require start and end times.' });
    } else if (value.start >= value.end) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Working-hours end time must be after start time.' });
    }
  });

const workingHoursInput = z.object({
  sunday: hoursWindow.optional(), monday: hoursWindow.optional(), tuesday: hoursWindow.optional(),
  wednesday: hoursWindow.optional(), thursday: hoursWindow.optional(), friday: hoursWindow.optional(),
  saturday: hoursWindow.optional(),
}).strict();

function withPrismaWorkingHours<T extends { workingHours?: unknown }>(input: T) {
  const { workingHours, ...rest } = input;
  if (workingHours === undefined) return rest;
  return { ...rest, workingHours: workingHours === null ? Prisma.DbNull : workingHours };
}

export const clinicRoutes: FastifyPluginAsync = async app => {
  // ===== Clinics ==========================================================
  const clinicCreate = z.object({
    name: z.string().trim().min(2).max(160),
    phone: e164Phone,
    logoUrl: z.string().trim().max(500).optional().nullable(),
    website: z.string().trim().max(300).optional().nullable(),
    addressLine: z.string().trim().max(300).optional().nullable(),
    timezone: timezoneInput.optional(),
    defaultLanguage: z.string().trim().min(2).max(20).optional(),
    complianceDisclosure: z.string().trim().min(4).max(600).optional(),
    humanFallbackNumber: optionalE164Phone,
    doNotContactPolicy: z.string().trim().min(4).max(600).optional(),
    workingHours: workingHoursInput.optional().nullable(),
    active: z.boolean().optional(),
  });
  const clinicUpdate = clinicCreate.partial();

  app.get('/clinics', { preHandler: writeRoles }, async request => {
    return db.receptionistClinic.findMany({
      where: { tenantId: request.auth.tenantId },
      orderBy: { createdAt: 'asc' },
      include: {
        locations: { orderBy: { createdAt: 'asc' } },
        agents: { orderBy: { createdAt: 'asc' } },
        _count: { select: { campaigns: true } },
      },
    });
  });

  app.post('/clinics', { preHandler: writeRoles }, async (request, reply) => {
    const input = clinicCreate.parse(request.body);
    let row;
    try {
      row = await runWithTenantContext(request.auth.tenantId, async tx => {
        await lockReceptionistConfiguration(tx, request.auth.tenantId);
        const duplicate = await tx.receptionistClinic.findFirst({
          where: {
            tenantId: request.auth.tenantId,
            OR: [
              { name: { equals: input.name, mode: 'insensitive' } },
              ...(input.active !== false ? [{ phone: input.phone, active: true }] : []),
            ],
          },
          select: { id: true, name: true, phone: true, active: true },
        });
        if (duplicate) {
          throw app.httpErrors.conflict(
            duplicate.phone === input.phone && duplicate.active
              ? 'This inbound destination is already assigned to an active receptionist clinic.'
              : 'A receptionist clinic with this name already exists in this tenant.',
          );
        }
        const created = await tx.receptionistClinic.create({
          data: { tenantId: request.auth.tenantId, ...withPrismaWorkingHours(input) } as Prisma.ReceptionistClinicUncheckedCreateInput,
        });
        await auditReceptionistMutation(tx, request, { action: 'receptionistClinic.created', resource: 'receptionistClinic', resourceId: created.id, metadata: { active: created.active } });
        return created;
      });
    } catch (error) {
      if (isReceptionistDestinationConflict(error)) throw app.httpErrors.conflict('This inbound destination is already assigned to an active receptionist clinic.');
      throw error;
    }
    return reply.code(201).send(row);
  });

  app.patch('/clinics/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = clinicUpdate.parse(request.body);
    try {
      return await runWithTenantContext(request.auth.tenantId, async tx => {
        await lockReceptionistConfiguration(tx, request.auth.tenantId);
        const existing = await tx.receptionistClinic.findFirst({ where: { id, tenantId: request.auth.tenantId } });
        if (!existing) throw app.httpErrors.notFound('Clinic not found');
        const merged = { ...existing, ...input };
        if (!merged.active) {
          const [activeCampaigns, runningOutbound, activeCalls] = await Promise.all([
            tx.receptionistCampaign.count({ where: { tenantId: request.auth.tenantId, clinicId: id, status: 'ACTIVE' } }),
            tx.receptionistOutboundCampaign.count({ where: { tenantId: request.auth.tenantId, clinicId: id, status: { in: ['SCHEDULED', 'RUNNING'] } } }),
            tx.receptionistCallLog.count({ where: { tenantId: request.auth.tenantId, clinicId: id, outcome: 'IN_PROGRESS', endedAt: null } }),
          ]);
          if (activeCampaigns || runningOutbound || activeCalls) throw app.httpErrors.conflict('Pause campaigns and finish active calls before deactivating this clinic.');
        }
        const duplicate = await tx.receptionistClinic.findFirst({
          where: {
            tenantId: request.auth.tenantId,
            id: { not: id },
            OR: [
              { name: { equals: merged.name, mode: 'insensitive' } },
              ...(merged.active ? [{ phone: merged.phone, active: true }] : []),
            ],
          },
          select: { name: true, phone: true, active: true },
        });
        if (duplicate) {
          throw app.httpErrors.conflict(
            duplicate.phone === merged.phone && duplicate.active
              ? 'This inbound destination is already assigned to an active receptionist clinic.'
              : 'A receptionist clinic with this name already exists in this tenant.',
          );
        }
        const row = await tx.receptionistClinic.update({
          where: { id },
          data: withPrismaWorkingHours(input) as Prisma.ReceptionistClinicUncheckedUpdateInput,
        });
        await auditReceptionistMutation(tx, request, { action: 'receptionistClinic.updated', resource: 'receptionistClinic', resourceId: id, metadata: { active: row.active } });
        return row;
      });
    } catch (error) {
      if (isReceptionistDestinationConflict(error)) throw app.httpErrors.conflict('This inbound destination is already assigned to an active receptionist clinic.');
      throw error;
    }
  });

  app.delete('/clinics/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockReceptionistConfiguration(tx, request.auth.tenantId);
      const existing = await tx.receptionistClinic.findFirst({ where: { id, tenantId: request.auth.tenantId } });
      if (!existing) throw app.httpErrors.notFound('Clinic not found');
      const [locations, agents, campaigns, outboundCampaigns, calls] = await Promise.all([
        tx.receptionistLocation.count({ where: { tenantId: request.auth.tenantId, clinicId: id } }),
        tx.receptionistAgent.count({ where: { tenantId: request.auth.tenantId, clinicId: id } }),
        tx.receptionistCampaign.count({ where: { tenantId: request.auth.tenantId, clinicId: id } }),
        tx.receptionistOutboundCampaign.count({ where: { tenantId: request.auth.tenantId, clinicId: id } }),
        tx.receptionistCallLog.count({ where: { tenantId: request.auth.tenantId, clinicId: id } }),
      ]);
      if (locations || agents || campaigns || outboundCampaigns || calls) {
        throw app.httpErrors.conflict('This clinic has receptionist history or dependent configuration. Deactivate it to preserve audit lineage.');
      }
      await tx.receptionistClinic.delete({ where: { id } });
      await auditReceptionistMutation(tx, request, { action: 'receptionistClinic.deleted', resource: 'receptionistClinic', resourceId: id });
    });
    return reply.code(204).send();
  });

  // ===== Locations ========================================================
  app.get('/scheduling-branches', { preHandler: writeRoles }, async request => {
    return db.branch.findMany({
      where: { tenantId: request.auth.tenantId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, location: true, timezone: true, active: true },
    });
  });

  const locationCreate = z.object({
    clinicId: uuid,
    branchId: uuid,
    name: z.string().trim().min(2).max(160),
    address: z.string().trim().min(2).max(300),
    phone: optionalE164Phone,
    timezone: timezoneInput.optional().nullable(),
    workingHours: workingHoursInput.optional().nullable(),
    active: z.boolean().optional(),
  });
  const locationUpdate = locationCreate.partial().omit({ clinicId: true });

  app.get('/locations', { preHandler: writeRoles }, async request => {
    const query = z.object({ clinicId: uuid.optional() }).parse(request.query);
    return db.receptionistLocation.findMany({
      where: { tenantId: request.auth.tenantId, ...(query.clinicId ? { clinicId: query.clinicId } : {}) },
      orderBy: { createdAt: 'asc' },
    });
  });

  app.post('/locations', { preHandler: writeRoles }, async (request, reply) => {
    const input = locationCreate.parse(request.body);
    try {
      const row = await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockReceptionistConfiguration(tx, request.auth.tenantId);
      const clinic = await tx.receptionistClinic.findFirst({ where: { id: input.clinicId, tenantId: request.auth.tenantId, active: true } });
      if (!clinic) throw app.httpErrors.badRequest('Location must belong to an active receptionist clinic in this tenant.');
      const branch = await tx.branch.findFirst({ where: { id: input.branchId, tenantId: request.auth.tenantId, active: true }, select: { id: true } });
      if (!branch) throw app.httpErrors.badRequest('Location must map to an active scheduling branch in this tenant.');
      const duplicate = await tx.receptionistLocation.findFirst({ where: { tenantId: request.auth.tenantId, clinicId: input.clinicId, name: { equals: input.name, mode: 'insensitive' } }, select: { id: true } });
      if (duplicate) throw app.httpErrors.conflict('A location with this name already exists for the clinic.');
      const created = await tx.receptionistLocation.create({
        data: { tenantId: request.auth.tenantId, ...withPrismaWorkingHours(input) } as Prisma.ReceptionistLocationUncheckedCreateInput,
      });
      await auditReceptionistMutation(tx, request, { action: 'receptionistLocation.created', resource: 'receptionistLocation', resourceId: created.id, metadata: { clinicId: created.clinicId, active: created.active } });
      return created;
      });
      return reply.code(201).send(row);
    } catch (error) {
      if (isActiveIntakeContractError(error)) throw app.httpErrors.conflict('Pause active campaigns before changing their attested location configuration.');
      throw error;
    }
  });

  app.patch('/locations/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = locationUpdate.parse(request.body);
    try {
      return await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockReceptionistConfiguration(tx, request.auth.tenantId);
      const existing = await tx.receptionistLocation.findFirst({ where: { id, tenantId: request.auth.tenantId } });
      if (!existing) throw app.httpErrors.notFound('Location not found');
      const merged = { ...existing, ...input };
      if (merged.active) {
        const [clinic, branch] = await Promise.all([
          tx.receptionistClinic.findFirst({ where: { id: existing.clinicId, tenantId: request.auth.tenantId, active: true }, select: { id: true } }),
          merged.branchId ? tx.branch.findFirst({ where: { id: merged.branchId, tenantId: request.auth.tenantId, active: true }, select: { id: true } }) : null,
        ]);
        if (!clinic) throw app.httpErrors.conflict('An active location requires an active receptionist clinic.');
        if (!branch) throw app.httpErrors.conflict('An active location requires an active scheduling branch in this tenant.');
      } else {
        const activeCampaign = await tx.receptionistCampaign.findFirst({ where: { tenantId: request.auth.tenantId, status: 'ACTIVE', eligibleLocationIds: { has: id } }, select: { id: true } });
        if (activeCampaign) throw app.httpErrors.conflict('Remove this location from active campaigns before deactivating it.');
      }
      const duplicate = await tx.receptionistLocation.findFirst({ where: { tenantId: request.auth.tenantId, clinicId: existing.clinicId, id: { not: id }, name: { equals: merged.name, mode: 'insensitive' } }, select: { id: true } });
      if (duplicate) throw app.httpErrors.conflict('A location with this name already exists for the clinic.');
      const row = await tx.receptionistLocation.update({
        where: { id },
        data: withPrismaWorkingHours(input) as Prisma.ReceptionistLocationUncheckedUpdateInput,
      });
      await auditReceptionistMutation(tx, request, { action: 'receptionistLocation.updated', resource: 'receptionistLocation', resourceId: id, metadata: { clinicId: row.clinicId, active: row.active } });
      return row;
      });
    } catch (error) {
      if (isActiveIntakeContractError(error)) throw app.httpErrors.conflict('Pause active campaigns before changing their attested location configuration.');
      throw error;
    }
  });

  app.delete('/locations/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    try {
      await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockReceptionistConfiguration(tx, request.auth.tenantId);
      const existing = await tx.receptionistLocation.findFirst({ where: { id, tenantId: request.auth.tenantId } });
      if (!existing) throw app.httpErrors.notFound('Location not found');
      const campaign = await tx.receptionistCampaign.findFirst({ where: { tenantId: request.auth.tenantId, eligibleLocationIds: { has: id } }, select: { id: true } });
      if (campaign) throw app.httpErrors.conflict('Remove this location from receptionist campaigns before deleting it.');
      await tx.receptionistLocation.delete({ where: { id } });
      await auditReceptionistMutation(tx, request, { action: 'receptionistLocation.deleted', resource: 'receptionistLocation', resourceId: id, metadata: { clinicId: existing.clinicId } });
      });
      return reply.code(204).send();
    } catch (error) {
      if (isActiveIntakeContractError(error)) throw app.httpErrors.conflict('Pause active campaigns before changing their attested location configuration.');
      throw error;
    }
  });
};
