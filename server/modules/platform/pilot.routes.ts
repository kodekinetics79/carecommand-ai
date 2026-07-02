import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { buildPilotChecklist, createPilotShareToken } from '../../lib/pilotStatus';
import { platformAuditEvent, requirePlatformAccess } from '../../lib/platformAuth';
import {
  analyzePilotImport,
  buildPreviewSample,
  buildPilotTemplateCsv,
  type PilotEntityType,
  type PilotImportRow,
  type PilotFieldSpec,
  PILOT_ENTITY_SPECS,
} from '../../lib/pilotImport';

const pilotAdmin = requirePlatformAccess('PLATFORM_ADMIN');
const uuid = z.string().uuid();
const entityTypeSchema = z.enum(['patients', 'appointments', 'insurance']);
const importBodySchema = z.object({
  csvText: z.string().trim().min(1).max(2_000_000),
  mapping: z.record(z.string(), z.string()).default({}),
});
const presetBodySchema = z.object({
  entityType: entityTypeSchema,
  name: z.string().trim().min(2).max(80),
  mapping: z.record(z.string(), z.string()).default({}),
  isDefault: z.boolean().default(false),
});
const shareBodySchema = z.object({
  label: z.string().trim().min(2).max(120).optional(),
  expiresInDays: z.coerce.number().int().min(1).max(90).default(14),
});
const patientLifecycleStages = new Set(['NEW', 'ACTIVE', 'AT_RISK', 'INACTIVE', 'LOST', 'RETAINED']);
const appointmentStatuses = new Set(['CONFIRMED', 'RISKY', 'ARRIVED', 'NO_SHOW', 'CANCELED', 'COMPLETED', 'WAITLIST']);
const appointmentChannels = new Set(['WHATSAPP', 'SMS', 'EMAIL', 'PUSH', 'CALL', 'VIDEO']);

function safeEnumValue(value: string | null | undefined, allowed: Set<string>, fallback: string) {
  if (!value) return fallback;
  const normalized = value.trim().toUpperCase();
  return allowed.has(normalized) ? normalized : fallback;
}

function safeNumberValue(value: string | null | undefined, fallback: number) {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeBoolValue(value: string | null | undefined, fallback: boolean) {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'active'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'inactive'].includes(normalized)) return false;
  return fallback;
}

function rowHasFatalIssues(row: PilotImportRow): boolean {
  return row.status === 'error';
}

async function loadOrCreateBranch(tenantId: string, branchName: string | null | undefined) {
  const normalized = branchName?.trim();
  if (!normalized) {
    const existing = await db.branch.findFirst({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
    if (!existing) throw new Error('Tenant has no branch yet');
    return existing;
  }
  const existing = await db.branch.findFirst({ where: { tenantId, name: { equals: normalized, mode: 'insensitive' } } });
  if (existing) return existing;
  return db.branch.create({ data: { tenantId, name: normalized, location: normalized } });
}

function fieldSpecs(entityType: PilotEntityType): PilotFieldSpec[] {
  return PILOT_ENTITY_SPECS[entityType];
}

async function loadPresetMapping(tenantId: string, entityType: PilotEntityType) {
  const preset = await db.pilotImportPreset.findFirst({
    where: { tenantId, entityType },
    orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
  });
  return preset ? { preset, mapping: (preset.mapping ?? {}) as Record<string, string> } : { preset: null, mapping: {} as Record<string, string> };
}

export const pilotRoutes: FastifyPluginAsync = async app => {
  app.addHook('preHandler', pilotAdmin);

  app.get('/tenants/:tenantId/pilot-checklist', async (request, reply) => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const checklist = await buildPilotChecklist(tenantId);
    if (!checklist) return reply.code(404).send({ error: 'not_found', message: 'Tenant not found' });
    await platformAuditEvent(request, 'pilot.checklist.viewed', { type: 'tenant', id: tenantId, tenantId }, { readinessScore: checklist.readinessScore, readyCount: checklist.readyCount, itemCount: checklist.itemCount });
    return checklist;
  });

  app.get('/tenants/:tenantId/pilot-import/:entityType/template.csv', async (request, reply) => {
    const { tenantId, entityType } = z.object({ tenantId: uuid, entityType: entityTypeSchema }).parse(request.params);
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) return reply.code(404).send({ error: 'not_found', message: 'Tenant not found' });
    const { csv } = buildPilotTemplateCsv(entityType);
    await platformAuditEvent(request, 'pilot.import.template.downloaded', { type: 'tenant', id: tenantId, tenantId }, { entityType });
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="pilot-${entityType}-template.csv"`)
      .send(csv);
  });

  app.get('/tenants/:tenantId/pilot-import/presets', async (request, reply) => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const { entityType } = z.object({ entityType: entityTypeSchema.optional() }).parse(request.query);
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) return reply.code(404).send({ error: 'not_found', message: 'Tenant not found' });
    const rows = await db.pilotImportPreset.findMany({
      where: { tenantId, ...(entityType ? { entityType } : {}) },
      orderBy: [{ entityType: 'asc' }, { isDefault: 'desc' }, { updatedAt: 'desc' }],
    });
    return rows.map((row: { id: string; tenantId: string; entityType: string; name: string; isDefault: boolean; mapping: unknown; createdAt: Date; updatedAt: Date }) => ({
      id: row.id,
      tenantId: row.tenantId,
      entityType: row.entityType as PilotEntityType,
      name: row.name,
      isDefault: row.isDefault,
      mapping: row.mapping,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  });

  app.post('/tenants/:tenantId/pilot-import/presets', async (request, reply) => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const body = presetBodySchema.parse(request.body);
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) return reply.code(404).send({ error: 'not_found', message: 'Tenant not found' });
    const mapping = body.mapping ?? {};
    if (body.isDefault) {
      await db.pilotImportPreset.updateMany({ where: { tenantId, entityType: body.entityType, isDefault: true }, data: { isDefault: false } });
    }
    const preset = await db.pilotImportPreset.upsert({
      where: { tenantId_entityType_name: { tenantId, entityType: body.entityType, name: body.name } },
      update: { mapping, isDefault: body.isDefault },
      create: { tenantId, entityType: body.entityType, name: body.name, mapping, isDefault: body.isDefault },
    });
    await platformAuditEvent(request, 'pilot.import.preset.saved', { type: 'tenant', id: tenantId, tenantId }, { entityType: body.entityType, name: body.name, isDefault: body.isDefault });
    return reply.code(201).send({
      id: preset.id,
      tenantId: preset.tenantId,
      entityType: preset.entityType as PilotEntityType,
      name: preset.name,
      isDefault: preset.isDefault,
      mapping: preset.mapping,
      createdAt: preset.createdAt.toISOString(),
      updatedAt: preset.updatedAt.toISOString(),
    });
  });

  app.delete('/tenants/:tenantId/pilot-import/presets/:presetId', async (request, reply) => {
    const { tenantId, presetId } = z.object({ tenantId: uuid, presetId: uuid }).parse(request.params);
    const preset = await db.pilotImportPreset.findFirst({ where: { id: presetId, tenantId }, select: { id: true, entityType: true, name: true } });
    if (!preset) return reply.code(404).send({ error: 'not_found', message: 'Preset not found' });
    await db.pilotImportPreset.delete({ where: { id: presetId } });
    await platformAuditEvent(request, 'pilot.import.preset.deleted', { type: 'tenant', id: tenantId, tenantId }, { entityType: preset.entityType, name: preset.name });
    return reply.code(204).send();
  });

  app.get('/tenants/:tenantId/pilot-status-links', async (request, reply) => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) return reply.code(404).send({ error: 'not_found', message: 'Tenant not found' });
    const rows = await db.pilotStatusShare.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 20 });
    return rows.map((row: { id: string; tenantId: string; label: string | null; expiresAt: Date; lastViewedAt: Date | null; createdAt: Date; updatedAt: Date }) => ({
      id: row.id,
      tenantId: row.tenantId,
      label: row.label,
      expiresAt: row.expiresAt.toISOString(),
      lastViewedAt: row.lastViewedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      active: row.expiresAt.getTime() > Date.now(),
      url: `${process.env.PUBLIC_APP_URL ?? ''}/pilot/${row.id}`,
    }));
  });

  app.post('/tenants/:tenantId/pilot-status-links', async (request, reply) => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const body = shareBodySchema.parse(request.body);
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, slug: true } });
    if (!tenant) return reply.code(404).send({ error: 'not_found', message: 'Tenant not found' });
    const { token, hash } = createPilotShareToken();
    const expiresAt = new Date(Date.now() + body.expiresInDays * 86400000);
    const row = await db.pilotStatusShare.create({
      data: {
        tenantId,
        tokenHash: hash,
        label: body.label?.trim() || null,
        expiresAt,
        createdById: request.platformUser?.legacy ? null : request.platformUser?.id,
      },
    });
    await platformAuditEvent(request, 'pilot.status_link.created', { type: 'tenant', id: tenantId, tenantId }, { label: row.label, expiresAt: row.expiresAt.toISOString() });
    return reply.code(201).send({
      id: row.id,
      tenantId: row.tenantId,
      label: row.label,
      expiresAt: row.expiresAt.toISOString(),
      token,
      url: `${process.env.PUBLIC_APP_URL ?? ''}/pilot/${token}`,
      clinicName: tenant.name,
      clinicSlug: tenant.slug,
    });
  });

  app.post('/tenants/:tenantId/pilot-import/:entityType/preview', async (request) => {
    const { tenantId, entityType } = z.object({ tenantId: uuid, entityType: entityTypeSchema }).parse(request.params);
    const body = importBodySchema.parse(request.body);
    const preset = await loadPresetMapping(tenantId, entityType);
    const mapping = { ...preset.mapping, ...body.mapping };
    const analysis = analyzePilotImport(entityType, body.csvText, mapping);
    await platformAuditEvent(request, 'pilot.import.previewed', { type: 'tenant', id: tenantId, tenantId }, { entityType, summary: analysis.summary, headers: analysis.headers.length });
    return {
      entityType,
      headers: analysis.headers,
      fields: fieldSpecs(entityType).map(field => ({
        key: field.key,
        label: field.label,
        required: field.required,
        example: field.example ?? null,
        mappedHeader: analysis.mapping[field.key] ?? null,
      })),
      mapping: analysis.mapping,
      preset: preset.preset ? { id: preset.preset.id, name: preset.preset.name, isDefault: preset.preset.isDefault } : null,
      summary: analysis.summary,
      rows: analysis.rows.slice(0, 25).map(row => ({
        index: row.index,
        status: row.status,
        issues: row.issues,
        sample: buildPreviewSample(row),
      })),
      canCommit: analysis.summary.invalid === 0 && analysis.summary.total > 0,
    };
  });

  app.post('/tenants/:tenantId/pilot-import/:entityType/commit', async (request, reply) => {
    const { tenantId, entityType } = z.object({ tenantId: uuid, entityType: entityTypeSchema }).parse(request.params);
    const body = importBodySchema.parse(request.body);
    const preset = await loadPresetMapping(tenantId, entityType);
    const mapping = { ...preset.mapping, ...body.mapping };
    const analysis = analyzePilotImport(entityType, body.csvText, mapping);
    const validRows = analysis.rows.filter(row => !rowHasFatalIssues(row));
    if (validRows.length === 0) return reply.code(400).send({ error: 'no_valid_rows', message: 'No rows are ready to import.' });

    const results = { created: 0, updated: 0, skipped: 0, warnings: analysis.summary.warnings };

    for (const row of validRows) {
      if (entityType === 'patients') {
        const branch = await loadOrCreateBranch(tenantId, row.values.branchName);
        const firstName = row.values.firstName?.trim();
        const lastName = row.values.lastName?.trim();
        if (!firstName || !lastName) { results.skipped++; continue; }
        const email = row.values.email?.trim() || null;
        const phone = row.values.phone?.trim() || null;
        const lifecycleStage = safeEnumValue(row.values.lifecycleStage, patientLifecycleStages, 'NEW') as never;
        const tags = row.values.tags ? row.values.tags.split(/[;,|]/).map(v => v.trim()).filter(Boolean) : [];
        const externalRef = row.values.externalRef?.trim() || null;
        const existing = externalRef ? await db.patient.findUnique({ where: { tenantId_externalRef: { tenantId, externalRef } } }) : null;
        if (existing) {
          await db.patient.update({
            where: { id: existing.id },
            data: { branchId: branch.id, firstName, lastName, ...(email ? { email } : {}), ...(phone ? { phone } : {}), lifecycleStage, tags },
          });
          results.updated++;
        } else {
          await db.patient.create({ data: { tenantId, branchId: branch.id, firstName, lastName, ...(externalRef ? { externalRef } : {}), ...(email ? { email } : {}), ...(phone ? { phone } : {}), lifecycleStage, tags } });
          results.created++;
        }
        continue;
      }

      if (entityType === 'appointments') {
        const patientRef = row.values.patientExternalRef?.trim();
        const service = row.values.service?.trim();
        const startsAt = row.values.startsAt ? new Date(row.values.startsAt) : null;
        const endsAt = row.values.endsAt ? new Date(row.values.endsAt) : null;
        if (!patientRef || !service || !startsAt || !endsAt) { results.skipped++; continue; }
        const patient = await db.patient.findUnique({ where: { tenantId_externalRef: { tenantId, externalRef: patientRef } }, select: { id: true, branchId: true } });
        if (!patient) { results.skipped++; continue; }
        const branch = await loadOrCreateBranch(tenantId, row.values.branchName);
        const status = safeEnumValue(row.values.status, appointmentStatuses, 'CONFIRMED') as never;
        const channel = safeEnumValue(row.values.channel, appointmentChannels, 'EMAIL') as never;
        const value = safeNumberValue(row.values.value, 0);
        const providerRef = row.values.providerRef?.trim() || null;
        const notes = row.values.notes?.trim() || null;
        const existing = await db.appointment.findFirst({ where: { tenantId, patientId: patient.id, startsAt, service } });
        if (existing) {
          await db.appointment.update({
            where: { id: existing.id },
            data: { branchId: branch.id, endsAt, status, channel, value, ...(providerRef ? { providerRef } : { providerRef: null }), ...(notes ? { notes } : { notes: null }) },
          });
          results.updated++;
        } else {
          await db.appointment.create({
            data: { tenantId, branchId: branch.id, patientId: patient.id, service, startsAt, endsAt, status, channel, value, ...(providerRef ? { providerRef } : {}), ...(notes ? { notes } : {}) },
          });
          results.created++;
        }
        continue;
      }

      if (entityType === 'insurance') {
        const patientRef = row.values.patientExternalRef?.trim();
        const planName = row.values.planName?.trim();
        const memberId = row.values.memberId?.trim();
        if (!patientRef || !planName || !memberId) { results.skipped++; continue; }
        const patient = await db.patient.findUnique({ where: { tenantId_externalRef: { tenantId, externalRef: patientRef } }, select: { id: true, branchId: true } });
        if (!patient) { results.skipped++; continue; }
        const branch = await loadOrCreateBranch(tenantId, row.values.branchName);
        const payerName = row.values.payerName?.trim() || 'Imported Payer';
        const payer = await db.insurancePayer.upsert({
          where: { tenantId_name: { tenantId, name: payerName } },
          create: { tenantId, name: payerName, active: true, sourceProvider: 'import' },
          update: { active: true },
        });
        const verificationStatus = row.values.verificationStatus?.trim() || 'pending';
        const subscriberName = row.values.subscriberName?.trim() || null;
        const relationship = row.values.relationship?.trim() || null;
        const groupNumber = row.values.groupNumber?.trim() || null;
        const payerReference = row.values.payerReference?.trim() || null;
        const active = safeBoolValue(row.values.active, true);
        const existing = await db.patientInsurancePolicy.findFirst({ where: { tenantId, patientId: patient.id, memberId, planName }, orderBy: { updatedAt: 'desc' } });
        if (existing) {
          await db.patientInsurancePolicy.update({
            where: { id: existing.id },
            data: { branchId: branch.id, payerId: payer.id, verificationStatus, active, ...(subscriberName ? { subscriberName } : {}), ...(relationship ? { relationship } : {}), ...(groupNumber ? { groupNumber } : {}), ...(payerReference ? { payerReference } : {}) },
          });
          results.updated++;
        } else {
          await db.patientInsurancePolicy.create({
            data: { tenantId, branchId: branch.id, patientId: patient.id, payerId: payer.id, planName, memberId, verificationStatus, active, ...(subscriberName ? { subscriberName } : {}), ...(relationship ? { relationship } : {}), ...(groupNumber ? { groupNumber } : {}), ...(payerReference ? { payerReference } : {}) },
          });
          results.created++;
        }
        continue;
      }
    }

    await platformAuditEvent(request, 'pilot.import.committed', { type: 'tenant', id: tenantId, tenantId }, { entityType, summary: results, totalRows: analysis.summary.total, validRows: validRows.length });
    return {
      entityType,
      preset: preset.preset ? { id: preset.preset.id, name: preset.preset.name, isDefault: preset.preset.isDefault } : null,
      summary: { ...results, total: analysis.summary.total, validRows: validRows.length, invalidRows: analysis.summary.invalid },
      preview: analysis.rows.slice(0, 10).map(row => ({ index: row.index, status: row.status, issues: row.issues, sample: buildPreviewSample(row) })),
    };
  });
};
