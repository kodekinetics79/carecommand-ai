import type { FastifyPluginAsync } from 'fastify';
import type { Prisma } from '../../generated/prisma/client';
import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { db } from '../../lib/db';
import { platformDb } from '../../lib/platformDb';
import { buildPilotChecklist, hashPilotShareToken } from '../../lib/pilotStatus';
import { createPlatformAuditEvent, platformAuditEvent, requirePlatformAccess } from '../../lib/platformAuth';
import { enterTenantContext } from '../../lib/tenantContext';
import { env } from '../../config/env';
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

function stablePilotValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stablePilotValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, stablePilotValue(nested)]));
  }
  return value;
}

interface PilotOperationIdentity { operationId: string; idempotencyKeyHash: string }

class PilotIdempotencyConflict extends Error {
  statusCode = 409;
  code = 'pilot_idempotency_conflict';
}

class PilotNoValidRows extends Error {
  statusCode = 400;
  code = 'no_valid_rows';
}

function pilotOperationIdentity(
  request: import('fastify').FastifyRequest,
  tenantId: string,
  action: string,
  input: unknown,
): PilotOperationIdentity {
  const rawKey = request.headers['idempotency-key'];
  const key = z.string().trim().min(16).max(128).parse(Array.isArray(rawKey) ? rawKey[0] : rawKey);
  const idempotencyKeyHash = createHash('sha256').update(key).digest('hex');
  const operationId = createHash('sha256').update(JSON.stringify(stablePilotValue({
    actorId: request.platformUser?.id,
    tenantId,
    action,
    idempotencyKeyHash,
    input,
  }))).digest('hex');
  return { operationId, idempotencyKeyHash };
}

async function writePilotPlatformIntent(
  request: import('fastify').FastifyRequest,
  tenantId: string,
  action: string,
  identity: PilotOperationIdentity,
  metadata: Prisma.InputJsonObject,
) {
  const { operationId, idempotencyKeyHash } = identity;
  const actorId = request.platformUser?.id;
  await platformDb.$transaction(async tx => {
    const claimKey = `pilot.intent-claim:${actorId}:${tenantId}:${idempotencyKeyHash}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${claimKey}, 0))`;
    const existing = await tx.platformAuditEvent.findFirst({
      where: {
        platformUserId: actorId,
        tenantId,
        metadata: { path: ['idempotencyKeyHash'], equals: idempotencyKeyHash },
      },
      select: { metadata: true },
    });
    if (existing) {
      const savedOperationId = existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, unknown>).operationId
        : null;
      if (savedOperationId === operationId) return;
      throw new PilotIdempotencyConflict('Idempotency-Key was already used with a different pilot operation payload');
    }
    await createPlatformAuditEvent(tx, request, `${action}.requested`, { type: 'tenant', id: tenantId, tenantId }, {
      ...metadata,
      operationId,
      idempotencyKeyHash,
      phase: 'intent',
    });
  });
}

async function lockPilotOperation(tx: Prisma.TransactionClient, operationId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'pilot.operation:' + operationId}, 0))`;
}

function deterministicPilotShareToken(operationId: string): { token: string; hash: string } {
  const token = createHmac('sha256', env.JWT_SECRET).update(`pilot-status-operation:${operationId}`).digest('hex').slice(0, 48);
  return { token, hash: hashPilotShareToken(token) };
}

async function loadOrCreateBranch(tenantId: string, branchName: string | null | undefined, client: typeof db | Prisma.TransactionClient = db) {
  const normalized = branchName?.trim();
  if (!normalized) {
    const existing = await client.branch.findFirst({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
    if (!existing) throw new Error('Tenant has no branch yet');
    return existing;
  }
  const existing = await client.branch.findFirst({ where: { tenantId, name: { equals: normalized, mode: 'insensitive' } } });
  if (existing) return existing;
  return client.branch.create({ data: { tenantId, name: normalized, location: normalized } });
}

async function writePilotTenantAudit(
  tx: Prisma.TransactionClient,
  request: import('fastify').FastifyRequest,
  tenantId: string,
  action: string,
  metadata: Prisma.InputJsonObject,
) {
  await tx.auditEvent.create({
    data: {
      tenantId,
      actorUserId: null,
      action,
      resource: 'platformPilot',
      resourceId: tenantId,
      requestId: request.id,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
      metadata: { ...metadata, platformUserId: request.platformUser?.id ?? null },
    },
  });
}

function pilotReceiptResponse<T>(metadata: Prisma.JsonValue | null): T | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const receipt = (metadata as Record<string, unknown>).receipt;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  const value = receipt as Record<string, unknown>;
  return value.version === 1 && value.response && typeof value.response === 'object' && !Array.isArray(value.response)
    ? value.response as T
    : null;
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
  app.addHook('preHandler', async (request, reply) => {
    const parsed = z.object({ tenantId: uuid }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_tenant', message: 'A valid tenant scope is required.' });
    const actor = request.platformUser;
    // Legacy static platform tokens are deliberately not database actors. A
    // persisted, active platform identity is required before selecting a
    // tenant scope for import/checklist operations.
    if (!actor || actor.legacy) {
      return reply.code(403).send({ error: 'platform_identity_required', message: 'A persisted platform identity is required.' });
    }
    enterTenantContext({
      tenantId: parsed.data.tenantId,
      actorId: actor.id,
      actorRole: actor.role,
      source: 'platform',
      requestId: request.id,
    });
  });

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
    const identity = pilotOperationIdentity(request, tenantId, 'pilot.import.preset.saved', { ...body, mapping });
    const { operationId } = identity;
    await writePilotPlatformIntent(request, tenantId, 'pilot.import.preset.saved', identity, {
      entityType: body.entityType, name: body.name, isDefault: body.isDefault,
    });
    const presetResponse = await db.$transaction(async tx => {
      await lockPilotOperation(tx, operationId);
      const completed = await tx.auditEvent.findFirst({
        where: { tenantId, action: 'pilot.import.preset.saved', metadata: { path: ['operationId'], equals: operationId } },
        select: { metadata: true },
      });
      if (completed) {
        const response = pilotReceiptResponse<{
          id: string; tenantId: string; entityType: PilotEntityType; name: string; isDefault: boolean;
          mapping: Prisma.JsonValue; createdAt: string; updatedAt: string;
        }>(completed.metadata);
        if (response) return response;
      }
      if (body.isDefault) {
        await tx.pilotImportPreset.updateMany({ where: { tenantId, entityType: body.entityType, isDefault: true }, data: { isDefault: false } });
      }
      const preset = await tx.pilotImportPreset.upsert({
        where: { tenantId_entityType_name: { tenantId, entityType: body.entityType, name: body.name } },
        update: { mapping, isDefault: body.isDefault },
        create: { tenantId, entityType: body.entityType, name: body.name, mapping, isDefault: body.isDefault },
      });
      const response = {
        id: preset.id,
        tenantId: preset.tenantId,
        entityType: preset.entityType as PilotEntityType,
        name: preset.name,
        isDefault: preset.isDefault,
        mapping: preset.mapping,
        createdAt: preset.createdAt.toISOString(),
        updatedAt: preset.updatedAt.toISOString(),
      };
      await writePilotTenantAudit(tx, request, tenantId, 'pilot.import.preset.saved', {
        entityType: body.entityType, name: body.name, isDefault: body.isDefault, operationId,
        idempotencyKeyHash: identity.idempotencyKeyHash,
        receipt: { version: 1, response },
      });
      return response;
    });
    return reply.code(201).send(presetResponse);
  });

  app.delete('/tenants/:tenantId/pilot-import/presets/:presetId', async (request, reply) => {
    const { tenantId, presetId } = z.object({ tenantId: uuid, presetId: uuid }).parse(request.params);
    const identity = pilotOperationIdentity(request, tenantId, 'pilot.import.preset.deleted', { presetId });
    const { operationId } = identity;
    await writePilotPlatformIntent(request, tenantId, 'pilot.import.preset.deleted', identity, { presetId });
    await db.$transaction(async tx => {
      await lockPilotOperation(tx, operationId);
      const preset = await tx.pilotImportPreset.findFirst({ where: { id: presetId, tenantId }, select: { id: true, entityType: true, name: true } });
      // DELETE is replay-safe: a retry after a lost response observes the
      // completed absence while holding the same operation lock.
      if (!preset) return;
      await tx.pilotImportPreset.delete({ where: { id: presetId } });
      await writePilotTenantAudit(tx, request, tenantId, 'pilot.import.preset.deleted', { entityType: preset.entityType, name: preset.name, operationId });
    });
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
      publicUrlAvailable: false,
      url: null,
    }));
  });

  app.post('/tenants/:tenantId/pilot-status-links', async (request, reply) => {
    const { tenantId } = z.object({ tenantId: uuid }).parse(request.params);
    const body = shareBodySchema.parse(request.body);
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true, slug: true } });
    if (!tenant) return reply.code(404).send({ error: 'not_found', message: 'Tenant not found' });
    const identity = pilotOperationIdentity(request, tenantId, 'pilot.status_link.created', body);
    const { operationId } = identity;
    await writePilotPlatformIntent(request, tenantId, 'pilot.status_link.created', identity, {
      label: body.label?.trim() || null, expiresInDays: body.expiresInDays,
    });
    const { token, hash } = deterministicPilotShareToken(operationId);
    const storedResponse = await db.$transaction(async tx => {
      await lockPilotOperation(tx, operationId);
      const completed = await tx.auditEvent.findFirst({
        where: { tenantId, action: 'pilot.status_link.created', metadata: { path: ['operationId'], equals: operationId } },
        select: { metadata: true },
      });
      const replay = pilotReceiptResponse<{
        id: string; tenantId: string; label: string | null; expiresAt: string;
        publicUrlPrefix: string; clinicName: string; clinicSlug: string;
      }>(completed?.metadata ?? null);
      if (replay) return replay;
      const existing = await tx.pilotStatusShare.findUnique({ where: { tokenHash: hash } });
      if (existing) {
        return {
          id: existing.id, tenantId: existing.tenantId, label: existing.label,
          expiresAt: existing.expiresAt.toISOString(), publicUrlPrefix: process.env.PUBLIC_APP_URL ?? '',
          clinicName: tenant.name, clinicSlug: tenant.slug,
        };
      }
      const expiresAt = new Date(Date.now() + body.expiresInDays * 86400000);
      const row = await tx.pilotStatusShare.create({
        data: {
          tenantId,
          tokenHash: hash,
          label: body.label?.trim() || null,
          expiresAt,
          createdById: request.platformUser?.legacy ? null : request.platformUser?.id,
        },
      });
      const response = {
        id: row.id, tenantId: row.tenantId, label: row.label, expiresAt: row.expiresAt.toISOString(),
        publicUrlPrefix: process.env.PUBLIC_APP_URL ?? '', clinicName: tenant.name, clinicSlug: tenant.slug,
      };
      await writePilotTenantAudit(tx, request, tenantId, 'pilot.status_link.created', {
        label: row.label, expiresAt: row.expiresAt.toISOString(), operationId,
        idempotencyKeyHash: identity.idempotencyKeyHash,
        receipt: { version: 1, response },
      });
      return response;
    });
    return reply.code(201).send({
      id: storedResponse.id,
      tenantId: storedResponse.tenantId,
      label: storedResponse.label,
      expiresAt: storedResponse.expiresAt,
      token,
      url: `${storedResponse.publicUrlPrefix}/pilot/${token}`,
      clinicName: storedResponse.clinicName,
      clinicSlug: storedResponse.clinicSlug,
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

  app.post('/tenants/:tenantId/pilot-import/:entityType/commit', async request => {
    const { tenantId, entityType } = z.object({ tenantId: uuid, entityType: entityTypeSchema }).parse(request.params);
    const body = importBodySchema.parse(request.body);
    const sourceDigest = createHash('sha256').update(body.csvText).digest('hex');
    const submittedMappingDigest = createHash('sha256').update(JSON.stringify(stablePilotValue(body.mapping))).digest('hex');
    const identity = pilotOperationIdentity(request, tenantId, 'pilot.import.committed', { entityType, sourceDigest, submittedMappingDigest });
    const { operationId } = identity;
    await writePilotPlatformIntent(request, tenantId, 'pilot.import.committed', identity, {
      entityType, sourceDigest, submittedMappingDigest,
    });

    const preset = await loadPresetMapping(tenantId, entityType);
    const mapping = { ...preset.mapping, ...body.mapping };
    const analysis = analyzePilotImport(entityType, body.csvText, mapping);
    const validRows = analysis.rows.filter(row => !rowHasFatalIssues(row));
    const mappingDigest = createHash('sha256').update(JSON.stringify(stablePilotValue(mapping))).digest('hex');
    const presetResponse = preset.preset ? { id: preset.preset.id, name: preset.preset.name, isDefault: preset.preset.isDefault } : null;
    type ImportReceipt = {
      results: { created: number; updated: number; skipped: number; warnings: number };
      mapping: Record<string, string>;
      preset: { id: string; name: string; isDefault: boolean } | null;
    };

    const receipt = await db.$transaction(async tx => {
    await lockPilotOperation(tx, operationId);
    const completed = await tx.auditEvent.findFirst({
      where: {
        tenantId,
        action: 'pilot.import.committed',
        metadata: { path: ['operationId'], equals: operationId },
      },
      select: { metadata: true },
    });
    const replay = pilotReceiptResponse<ImportReceipt>(completed?.metadata ?? null);
    if (replay) return replay;
    if (validRows.length === 0) throw new PilotNoValidRows('No rows are ready to import.');
    const committed = { created: 0, updated: 0, skipped: 0, warnings: analysis.summary.warnings };
    for (const row of validRows) {
      if (entityType === 'patients') {
        const branch = await loadOrCreateBranch(tenantId, row.values.branchName, tx);
        const firstName = row.values.firstName?.trim();
        const lastName = row.values.lastName?.trim();
        if (!firstName || !lastName) { committed.skipped++; continue; }
        const email = row.values.email?.trim() || null;
        const phone = row.values.phone?.trim() || null;
        const lifecycleStage = safeEnumValue(row.values.lifecycleStage, patientLifecycleStages, 'NEW') as never;
        const tags = row.values.tags ? row.values.tags.split(/[;,|]/).map(v => v.trim()).filter(Boolean) : [];
        // A stable generated ref makes rows that intentionally omit an external
        // source key safe to replay after a lost response or process crash.
        const externalRef = row.values.externalRef?.trim() || `pilot-${operationId.slice(0, 24)}-${row.index}`;
        const existing = externalRef ? await tx.patient.findUnique({ where: { tenantId_externalRef: { tenantId, externalRef } } }) : null;
        if (existing) {
          await tx.patient.update({
            where: { id: existing.id },
            data: { branchId: branch.id, firstName, lastName, ...(email ? { email } : {}), ...(phone ? { phone } : {}), lifecycleStage, tags },
          });
          committed.updated++;
        } else {
          await tx.patient.create({ data: { tenantId, branchId: branch.id, firstName, lastName, externalRef, ...(email ? { email } : {}), ...(phone ? { phone } : {}), lifecycleStage, tags } });
          committed.created++;
        }
        continue;
      }

      if (entityType === 'appointments') {
        const patientRef = row.values.patientExternalRef?.trim();
        const service = row.values.service?.trim();
        const startsAt = row.values.startsAt ? new Date(row.values.startsAt) : null;
        const endsAt = row.values.endsAt ? new Date(row.values.endsAt) : null;
        if (!patientRef || !service || !startsAt || !endsAt) { committed.skipped++; continue; }
        const patient = await tx.patient.findUnique({ where: { tenantId_externalRef: { tenantId, externalRef: patientRef } }, select: { id: true, branchId: true } });
        if (!patient) { committed.skipped++; continue; }
        const branch = await loadOrCreateBranch(tenantId, row.values.branchName, tx);
        const status = safeEnumValue(row.values.status, appointmentStatuses, 'CONFIRMED') as never;
        const channel = safeEnumValue(row.values.channel, appointmentChannels, 'EMAIL') as never;
        const value = safeNumberValue(row.values.value, 0);
        const providerRef = row.values.providerRef?.trim() || null;
        const notes = row.values.notes?.trim() || null;
        const existing = await tx.appointment.findFirst({ where: { tenantId, patientId: patient.id, startsAt, service } });
        if (existing) {
          await tx.appointment.update({
            where: { id: existing.id },
            data: { branchId: branch.id, endsAt, status, channel, value, ...(providerRef ? { providerRef } : { providerRef: null }), ...(notes ? { notes } : { notes: null }) },
          });
          committed.updated++;
        } else {
          await tx.appointment.create({
            data: { tenantId, branchId: branch.id, patientId: patient.id, service, startsAt, endsAt, status, channel, value, ...(providerRef ? { providerRef } : {}), ...(notes ? { notes } : {}) },
          });
          committed.created++;
        }
        continue;
      }

      if (entityType === 'insurance') {
        const patientRef = row.values.patientExternalRef?.trim();
        const planName = row.values.planName?.trim();
        const memberId = row.values.memberId?.trim();
        if (!patientRef || !planName || !memberId) { committed.skipped++; continue; }
        const patient = await tx.patient.findUnique({ where: { tenantId_externalRef: { tenantId, externalRef: patientRef } }, select: { id: true, branchId: true } });
        if (!patient) { committed.skipped++; continue; }
        const branch = await loadOrCreateBranch(tenantId, row.values.branchName, tx);
        const payerName = row.values.payerName?.trim() || 'Imported Payer';
        const payer = await tx.insurancePayer.upsert({
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
        const existing = await tx.patientInsurancePolicy.findFirst({ where: { tenantId, patientId: patient.id, memberId, planName }, orderBy: { updatedAt: 'desc' } });
        if (existing) {
          await tx.patientInsurancePolicy.update({
            where: { id: existing.id },
            data: { branchId: branch.id, payerId: payer.id, verificationStatus, active, ...(subscriberName ? { subscriberName } : {}), ...(relationship ? { relationship } : {}), ...(groupNumber ? { groupNumber } : {}), ...(payerReference ? { payerReference } : {}) },
          });
          committed.updated++;
        } else {
          await tx.patientInsurancePolicy.create({
            data: { tenantId, branchId: branch.id, patientId: patient.id, payerId: payer.id, planName, memberId, verificationStatus, active, ...(subscriberName ? { subscriberName } : {}), ...(relationship ? { relationship } : {}), ...(groupNumber ? { groupNumber } : {}), ...(payerReference ? { payerReference } : {}) },
          });
          committed.created++;
        }
        continue;
      }
    }
    await writePilotTenantAudit(tx, request, tenantId, 'pilot.import.committed', {
      entityType, summary: committed, totalRows: analysis.summary.total, validRows: validRows.length,
      operationId, sourceDigest, mappingDigest,
      idempotencyKeyHash: identity.idempotencyKeyHash,
      receipt: { version: 1, response: { results: committed, mapping, preset: presetResponse } },
    });
    return { results: committed, mapping, preset: presetResponse };
    });
    const responseAnalysis = analyzePilotImport(entityType, body.csvText, receipt.mapping);
    const responseValidRows = responseAnalysis.rows.filter(row => !rowHasFatalIssues(row));
    return {
      entityType,
      preset: receipt.preset,
      summary: { ...receipt.results, total: responseAnalysis.summary.total, validRows: responseValidRows.length, invalidRows: responseAnalysis.summary.invalid },
      preview: responseAnalysis.rows.slice(0, 10).map(row => ({ index: row.index, status: row.status, issues: row.issues, sample: buildPreviewSample(row) })),
    };
  });
};
