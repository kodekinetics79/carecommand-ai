import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { runWithTenantContext } from '../../lib/tenantContext';
import { validateIanaTimezone } from '../../lib/scheduling';
import { Prisma } from '../../generated/prisma/client';
import { recordWorkflowEvent } from '../../lib/intelligence';
import { promptText, optionalPromptText, httpUrl } from '../../lib/receptionist/promptSafety';
import { countryDefaultLanguage, isSupportedAgentLanguage, isSupportedCountry } from '../../lib/receptionist/catalog';
import { loadHoursSource, bundleHoursConfigured } from '../../lib/receptionist/hoursSource';
import { resolveApprovedLocalePack } from '../../lib/receptionist/localePacks/resolve';
import { transferReadiness } from '../../lib/receptionist/transferReadiness';
import { uuid, idParam, writeRoles, receptionistRead, e164Phone, optionalE164Phone, iso2Country, languageTag, isActiveIntakeContractError, isReceptionistDestinationConflict, lockReceptionistConfiguration, auditReceptionistMutation } from './shared';

/** The location timezone is always the branch timezone; it is never stored. */
function serializeLocation<T extends { branch?: { timezone: string; name: string } | null }>(location: T, clinicTimezone: string) {
  const { branch, ...rest } = location as T & { branch?: { timezone: string; name: string } | null };
  return {
    ...rest,
    timezone: branch?.timezone ?? clinicTimezone,
    timezoneSource: branch ? ({ kind: 'branch' as const, name: branch.name }) : ({ kind: 'clinic' as const, name: null }),
  };
}

class StaleRevisionError extends Error {
  constructor(readonly current: unknown) { super('stale_revision'); }
}

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
  // country + timezone are hard-required (M22): the emergency number, phone
  // formatting and every spoken time depend on them, and a silent default
  // would be a fabricated tenant-facing value. defaultLanguage is derived from
  // the country when omitted.
  const clinicCreate = z.object({
    name: promptText(160).pipe(z.string().min(2)),
    phone: e164Phone,
    country: iso2Country.refine(isSupportedCountry, 'Country is not supported yet'),
    timezone: timezoneInput,
    defaultLanguage: languageTag.refine(isSupportedAgentLanguage, 'Language is not supported by the voice provider').optional(),
    logoUrl: httpUrl,
    website: httpUrl,
    addressLine: optionalPromptText(300),
    complianceDisclosure: optionalPromptText(600),
    humanFallbackNumber: optionalE164Phone,
    doNotContactPolicy: optionalPromptText(600),
    workingHours: workingHoursInput.optional().nullable(),
    active: z.boolean().optional(),
  }).strict();
  const clinicUpdate = clinicCreate.partial().extend({
    expectedUpdatedAt: z.string().datetime().optional(),
  }).strict();

  async function clinicReadiness(tenantId: string, clinic: { id: string; phone: string; country: string | null; defaultLanguage: string; humanFallbackNumber: string | null }) {
    const [agents, bundle, knowledge] = await Promise.all([
      db.receptionistAgent.findMany({ where: { tenantId, clinicId: clinic.id, active: true }, select: { language: true } }),
      loadHoursSource(db, { tenantId, clinicId: clinic.id }),
      db.receptionistClinicKnowledge.findFirst({ where: { tenantId, clinicId: clinic.id }, select: { approvedRevision: true, draftRevision: true } }),
    ]);
    // One active agent decides the spoken language; otherwise the clinic default.
    const language = agents.length === 1 ? agents[0].language : clinic.defaultLanguage;
    const pack = clinic.country ? await resolveApprovedLocalePack(db, { tenantId, language, country: clinic.country }) : null;
    const hoursConfigured = bundle ? bundleHoursConfigured(bundle) : false;
    const transfer = transferReadiness(clinic, { inboundLineNumbers: bundle?.locations.map(location => location.phone) ?? [] });
    const blockers: string[] = [];
    if (!clinic.country) blockers.push('clinic_country_missing');
    if (!hoursConfigured) blockers.push('clinic_hours_missing');
    if (!pack) blockers.push('locale_pack_unapproved');
    if (!agents.length) blockers.push('no_active_agent');
    if (transfer.reason === 'loops_to_agent') blockers.push('transfer_loops_to_agent');
    return {
      transferReady: transfer.ready,
      transferReason: transfer.reason,
      country: clinic.country,
      countryConfirmed: clinic.country !== null,
      hoursConfigured,
      localePack: pack
        ? { language: pack.language, country: pack.country, status: 'APPROVED' as const, packId: pack.id, evidenceHash: pack.evidenceHash }
        : { language, country: clinic.country, status: 'MISSING' as const, packId: null, evidenceHash: null },
      knowledge: knowledge
        ? {
          status: knowledge.approvedRevision === null ? 'DRAFT' as const : 'APPROVED' as const,
          approvedRevision: knowledge.approvedRevision,
          dirty: knowledge.approvedRevision !== null && knowledge.draftRevision !== knowledge.approvedRevision,
        }
        : { status: 'MISSING' as const, approvedRevision: null, dirty: false },
      blockers,
    };
  }

  app.get('/clinics', { preHandler: receptionistRead }, async request => {
    const rows = await db.receptionistClinic.findMany({
      where: { tenantId: request.auth.tenantId },
      orderBy: { createdAt: 'asc' },
      include: {
        locations: { orderBy: { createdAt: 'asc' }, include: { branch: { select: { timezone: true, name: true } } } },
        agents: { orderBy: { createdAt: 'asc' } },
        _count: { select: { campaigns: true } },
      },
    });
    return Promise.all(rows.map(async clinic => ({
      ...clinic,
      locations: clinic.locations.map(location => serializeLocation(location, clinic.timezone)),
      readiness: await clinicReadiness(request.auth.tenantId, clinic),
    })));
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
        // A supported country always implies a default language; deriving it
        // here keeps the hard-required input to country + timezone.
        const defaultLanguage = input.defaultLanguage ?? countryDefaultLanguage(input.country);
        if (!defaultLanguage) throw app.httpErrors.badRequest('No default language is configured for this country; choose one explicitly.');
        const created = await tx.receptionistClinic.create({
          data: { tenantId: request.auth.tenantId, ...withPrismaWorkingHours(input), defaultLanguage } as Prisma.ReceptionistClinicUncheckedCreateInput,
        });
        await auditReceptionistMutation(tx, request, { action: 'receptionistClinic.created', resource: 'receptionistClinic', resourceId: created.id, metadata: { active: created.active } });
        return created;
      });
    } catch (error) {
      if (isReceptionistDestinationConflict(error)) throw app.httpErrors.conflict('This inbound destination is already assigned to an active receptionist clinic.');
      throw error;
    }
    return reply.code(201).send({ ...row, readiness: await clinicReadiness(request.auth.tenantId, row) });
  });

  app.patch('/clinics/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { expectedUpdatedAt, ...input } = clinicUpdate.parse(request.body);
    const changed = { hours: false, timezone: false, phone: false };
    try {
      const updated = await runWithTenantContext(request.auth.tenantId, async tx => {
        await lockReceptionistConfiguration(tx, request.auth.tenantId);
        const existing = await tx.receptionistClinic.findFirst({ where: { id, tenantId: request.auth.tenantId } });
        if (!existing) throw app.httpErrors.notFound('Clinic not found');
        // Last-writer-wins would silently discard another editor's work on a
        // whole-draft form, so a stale write is refused with the current row.
        if (expectedUpdatedAt && existing.updatedAt.toISOString() !== new Date(expectedUpdatedAt).toISOString()) {
          throw new StaleRevisionError(existing);
        }
        changed.hours = input.workingHours !== undefined;
        changed.timezone = input.timezone !== undefined && input.timezone !== existing.timezone;
        changed.phone = input.phone !== undefined && input.phone !== existing.phone;
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
      // Emitted after commit: the hours/timezone/phone a caller hears changed,
      // which the front desk and the deployment drift checks care about.
      if (changed.hours) await recordWorkflowEvent(request.auth.tenantId, { eventType: 'receptionist.clinic.hours_changed', entityType: 'receptionistClinic', entityId: id, sourceModule: 'receptionist', payload: { clinicId: id } });
      if (changed.timezone) await recordWorkflowEvent(request.auth.tenantId, { eventType: 'receptionist.clinic.timezone_changed', entityType: 'receptionistClinic', entityId: id, sourceModule: 'receptionist', payload: { clinicId: id, timezone: updated.timezone } });
      if (changed.phone) await recordWorkflowEvent(request.auth.tenantId, { eventType: 'receptionist.clinic.phone_changed', entityType: 'receptionistClinic', entityId: id, sourceModule: 'receptionist', payload: { clinicId: id } });
      return { ...updated, readiness: await clinicReadiness(request.auth.tenantId, updated) };
    } catch (error) {
      if (error instanceof StaleRevisionError) {
        return reply.code(409).send({
          error: 'STALE_REVISION',
          message: 'Someone else saved this clinic while you were editing it. Reload to see their changes.',
          current: error.current,
        });
      }
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
      const [locations, agents, campaigns, outboundCampaigns, calls, requests] = await Promise.all([
        tx.receptionistLocation.count({ where: { tenantId: request.auth.tenantId, clinicId: id } }),
        tx.receptionistAgent.count({ where: { tenantId: request.auth.tenantId, clinicId: id } }),
        tx.receptionistCampaign.count({ where: { tenantId: request.auth.tenantId, clinicId: id } }),
        tx.receptionistOutboundCampaign.count({ where: { tenantId: request.auth.tenantId, clinicId: id } }),
        tx.receptionistCallLog.count({ where: { tenantId: request.auth.tenantId, clinicId: id } }),
        tx.receptionistAppointmentRequest.count({ where: { tenantId: request.auth.tenantId, clinicId: id } }),
      ]);
      if (locations || agents || campaigns || outboundCampaigns || calls || requests) {
        throw app.httpErrors.conflict('This clinic has receptionist history or dependent configuration. Deactivate it to preserve audit lineage.');
      }
      await tx.receptionistClinic.delete({ where: { id } });
      await auditReceptionistMutation(tx, request, { action: 'receptionistClinic.deleted', resource: 'receptionistClinic', resourceId: id });
    });
    return reply.code(204).send();
  });

  // ===== Locations ========================================================
  app.get('/scheduling-branches', { preHandler: receptionistRead }, async request => {
    return db.branch.findMany({
      where: { tenantId: request.auth.tenantId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, location: true, timezone: true, active: true },
    });
  });

  // No timezone input: it is derived from the branch, so divergence is
  // impossible rather than merely rejected (M23).
  const locationCreate = z.object({
    clinicId: uuid,
    branchId: uuid,
    name: promptText(160).pipe(z.string().min(2)),
    address: promptText(300).pipe(z.string().min(2)),
    phone: optionalE164Phone,
    accessNotes: optionalPromptText(600),
    workingHours: workingHoursInput.optional().nullable(),
    active: z.boolean().optional(),
  }).strict();
  const locationUpdate = locationCreate.partial().omit({ clinicId: true });

  app.get('/locations', { preHandler: receptionistRead }, async request => {
    const query = z.object({ clinicId: uuid.optional() }).parse(request.query);
    const rows = await db.receptionistLocation.findMany({
      where: { tenantId: request.auth.tenantId, ...(query.clinicId ? { clinicId: query.clinicId } : {}) },
      orderBy: { createdAt: 'asc' },
      include: { branch: { select: { timezone: true, name: true } }, clinic: { select: { timezone: true } } },
    });
    return rows.map(({ clinic, ...location }) => serializeLocation(location, clinic.timezone));
  });

  app.post('/locations', { preHandler: writeRoles }, async (request, reply) => {
    if (request.body && typeof request.body === 'object' && 'timezone' in request.body) {
      throw app.httpErrors.badRequest('location_timezone_derived: a location uses its scheduling branch timezone and cannot set its own.');
    }
    const input = locationCreate.parse(request.body);
    try {
      const row = await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockReceptionistConfiguration(tx, request.auth.tenantId);
      const clinic = await tx.receptionistClinic.findFirst({ where: { id: input.clinicId, tenantId: request.auth.tenantId, active: true }, select: { id: true, timezone: true } });
      if (!clinic) throw app.httpErrors.badRequest('Location must belong to an active receptionist clinic in this tenant.');
      const branch = await tx.branch.findFirst({ where: { id: input.branchId, tenantId: request.auth.tenantId, active: true }, select: { id: true } });
      if (!branch) throw app.httpErrors.badRequest('Location must map to an active scheduling branch in this tenant.');
      const duplicate = await tx.receptionistLocation.findFirst({ where: { tenantId: request.auth.tenantId, clinicId: input.clinicId, name: { equals: input.name, mode: 'insensitive' } }, select: { id: true } });
      if (duplicate) throw app.httpErrors.conflict('A location with this name already exists for the clinic.');
      const created = await tx.receptionistLocation.create({
        data: { tenantId: request.auth.tenantId, ...withPrismaWorkingHours(input) } as Prisma.ReceptionistLocationUncheckedCreateInput,
        include: { branch: { select: { timezone: true, name: true } } },
      });
      await auditReceptionistMutation(tx, request, { action: 'receptionistLocation.created', resource: 'receptionistLocation', resourceId: created.id, metadata: { clinicId: created.clinicId, active: created.active } });
      return serializeLocation(created, clinic.timezone);
      });
      return reply.code(201).send(row);
    } catch (error) {
      if (isActiveIntakeContractError(error)) throw app.httpErrors.conflict('Pause active campaigns before changing their attested location configuration.');
      throw error;
    }
  });

  app.patch('/locations/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    if (request.body && typeof request.body === 'object' && 'timezone' in request.body) {
      throw app.httpErrors.badRequest('location_timezone_derived: a location uses its scheduling branch timezone and cannot set its own.');
    }
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
        include: { branch: { select: { timezone: true, name: true } }, clinic: { select: { timezone: true } } },
      });
      await auditReceptionistMutation(tx, request, { action: 'receptionistLocation.updated', resource: 'receptionistLocation', resourceId: id, metadata: { clinicId: row.clinicId, active: row.active } });
      const { clinic: parent, ...location } = row;
      return serializeLocation(location, parent.timezone);
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
