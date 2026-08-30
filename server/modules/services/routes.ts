import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { requireRoles } from '../../plugins/roles';
import { requireFeature } from '../../lib/entitlements';
import { optionalPromptText } from '../../lib/receptionist/promptSafety';

// ===========================================================================
// Minimal tenant-scoped Service Catalog. Appointments may reference a catalog
// item; deposit rules may be linked per service. RLS-ready (tenantId on every
// query) but RLS not enabled in this phase. Gated by the appointments feature.
// ===========================================================================

const uuid = z.string().uuid();
const writeRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER');
const featureGate = requireFeature('appointments');

function mapItem(row: { id: string; name: string; category: string; defaultDurationMinutes: number; defaultAppointmentValue: unknown; depositRuleId: string | null; active: boolean; createdAt: Date; updatedAt: Date; spokenDescription: string | null; bookableByVoice: boolean; voiceDurationMinutes: number | null; priceFrom: unknown }) {
  return {
    id: row.id, name: row.name, category: row.category,
    defaultDurationMinutes: row.defaultDurationMinutes,
    defaultAppointmentValue: row.defaultAppointmentValue == null ? null : Number(row.defaultAppointmentValue),
    depositRuleId: row.depositRuleId, active: row.active,
    // Voice-receptionist facts (the AI receptionist's services list renders from these).
    spokenDescription: row.spokenDescription,
    bookableByVoice: row.bookableByVoice,
    voiceDurationMinutes: row.voiceDurationMinutes,
    priceFrom: row.priceFrom == null ? null : Number(row.priceFrom),
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

export const serviceCatalogRoutes: FastifyPluginAsync = async app => {
  app.addHook('preHandler', featureGate);

  app.get('/', async request => {
    const rows = await db.serviceCatalogItem.findMany({ where: { tenantId: request.auth.tenantId }, orderBy: [{ active: 'desc' }, { name: 'asc' }] });
    return rows.map(mapItem);
  });

  const createInput = z.object({
    name: z.string().trim().min(2).max(160),
    category: z.string().trim().min(2).max(80).default('general'),
    defaultDurationMinutes: z.coerce.number().int().min(5).max(480).default(30),
    defaultAppointmentValue: z.coerce.number().min(0).max(1_000_000).optional().nullable(),
    depositRuleId: uuid.optional().nullable(),
    active: z.boolean().default(true),
    // Voice-receptionist facts; prompt-safe text (no template syntax or override phrasing).
    spokenDescription: optionalPromptText(300),
    bookableByVoice: z.boolean().optional(),
    voiceDurationMinutes: z.coerce.number().int().min(5).max(480).optional().nullable(),
    priceFrom: z.coerce.number().min(0).max(1_000_000).optional().nullable(),
  });

  app.post('/', { preHandler: writeRoles }, async (request, reply) => {
    const input = createInput.parse(request.body);
    if (input.depositRuleId) {
      const rule = await db.depositRule.findFirst({ where: { id: input.depositRuleId, tenantId: request.auth.tenantId }, select: { id: true } });
      if (!rule) throw app.httpErrors.badRequest('depositRuleId does not belong to this tenant');
    }
    const existing = await db.serviceCatalogItem.findFirst({ where: { tenantId: request.auth.tenantId, name: input.name }, select: { id: true } });
    if (existing) throw app.httpErrors.conflict('A service with this name already exists');
    const row = await db.serviceCatalogItem.create({
      data: {
        tenantId: request.auth.tenantId, name: input.name, category: input.category, defaultDurationMinutes: input.defaultDurationMinutes, defaultAppointmentValue: input.defaultAppointmentValue ?? undefined, depositRuleId: input.depositRuleId ?? undefined, active: input.active,
        spokenDescription: input.spokenDescription ?? undefined, bookableByVoice: input.bookableByVoice ?? false,
        voiceDurationMinutes: input.voiceDurationMinutes ?? undefined, priceFrom: input.priceFrom ?? undefined,
      },
    });
    await audit(request, { action: 'serviceCatalog.created', resource: 'serviceCatalogItem', resourceId: row.id, metadata: { name: row.name } });
    return reply.code(201).send(mapItem(row));
  });

  app.patch('/:id', { preHandler: writeRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const input = createInput.partial().parse(request.body);
    const existing = await db.serviceCatalogItem.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Service not found');
    if (input.depositRuleId) {
      const rule = await db.depositRule.findFirst({ where: { id: input.depositRuleId, tenantId: request.auth.tenantId }, select: { id: true } });
      if (!rule) throw app.httpErrors.badRequest('depositRuleId does not belong to this tenant');
    }
    const row = await db.serviceCatalogItem.update({
      where: { id },
      data: {
        name: input.name, category: input.category, defaultDurationMinutes: input.defaultDurationMinutes,
        defaultAppointmentValue: input.defaultAppointmentValue ?? undefined,
        depositRuleId: input.depositRuleId === null ? null : input.depositRuleId ?? undefined,
        active: input.active,
        spokenDescription: input.spokenDescription,
        bookableByVoice: input.bookableByVoice,
        voiceDurationMinutes: input.voiceDurationMinutes,
        priceFrom: input.priceFrom,
      },
    });
    await audit(request, { action: 'serviceCatalog.updated', resource: 'serviceCatalogItem', resourceId: id });
    return mapItem(row);
  });
};
