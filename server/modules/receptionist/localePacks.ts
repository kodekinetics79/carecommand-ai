import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { runWithTenantContext } from '../../lib/tenantContext';
import { recordWorkflowEvent } from '../../lib/intelligence';
import { PLATFORM_LOCALE_PACKS, platformLocalePack, platformLocalePackHash } from '../../lib/receptionist/localePacks/defaults';
import {
  isLocalePackStrings,
  localePackEvidenceHash,
  localePackStringsSchema,
  mergeLocalePackStrings,
  validateLocalePackStrings,
} from '../../lib/receptionist/localePacks/render';
import type { LocalePackStrings } from '../../lib/receptionist/localePacks/types';
import { Prisma } from '../../generated/prisma/client';
import { idParam, uuid, writeRoles, receptionistRead, ownerAdminRoles, iso2Country, languageTag, lockReceptionistConfiguration, auditReceptionistMutation } from './shared';

// ===========================================================================
// Locale packs. A pack is adopted from a platform default (or cloned from an
// existing pack) as a DRAFT, edited, then approved by an OWNER/ADMIN who
// acknowledges the exact evidence hash they read. Approved content is
// immutable: a change is a new version, and approving one retires the
// previous approved pack for the same (language, country).
// ===========================================================================

const packSelect = {
  id: true, language: true, country: true, version: true, status: true, source: true,
  baseDefaultVersion: true, strings: true, evidenceHash: true, approvedAt: true, retiredAt: true,
  createdAt: true, updatedAt: true,
  approvedBy: { select: { id: true, displayName: true } },
} as const;

type PackRow = Prisma.ReceptionistLocalePackGetPayload<{ select: typeof packSelect }>;

function view(row: PackRow, boundActiveCampaigns = 0) {
  return {
    id: row.id,
    language: row.language,
    country: row.country,
    version: row.version,
    status: row.status,
    source: row.source,
    baseDefaultVersion: row.baseDefaultVersion,
    strings: row.strings,
    evidenceHash: row.evidenceHash,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedBy: row.approvedBy,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    boundActiveCampaigns,
  };
}

export const localePackRoutes: FastifyPluginAsync = async app => {
  app.get('/locale-packs', { preHandler: receptionistRead }, async request => {
    const rows = await db.receptionistLocalePack.findMany({
      where: { tenantId: request.auth.tenantId },
      orderBy: [{ language: 'asc' }, { country: 'asc' }, { version: 'desc' }],
      select: packSelect,
    });
    const bound = await db.receptionistCampaign.groupBy({
      by: ['attestedLocalePackId'],
      where: { tenantId: request.auth.tenantId, status: 'ACTIVE', attestedLocalePackId: { not: null } },
      _count: { _all: true },
    });
    const counts = new Map(bound.map(item => [item.attestedLocalePackId, item._count._all]));
    return {
      packs: rows.map(row => view(row, counts.get(row.id) ?? 0)),
      defaults: PLATFORM_LOCALE_PACKS.map(pack => ({
        language: pack.language, country: pack.country, version: pack.version,
        strings: pack.strings, evidenceHash: platformLocalePackHash(pack),
      })),
    };
  });

  app.post('/locale-packs', { preHandler: writeRoles }, async (request, reply) => {
    const input = z.object({
      language: languageTag,
      country: iso2Country,
      from: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('platform_default') }).strict(),
        z.object({ kind: z.literal('pack'), packId: uuid }).strict(),
      ]),
      strings: localePackStringsSchema.partial().optional(),
    }).strict().parse(request.body);

    const row = await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockReceptionistConfiguration(tx, request.auth.tenantId);
      let base: LocalePackStrings;
      let baseDefaultVersion: number | null;
      let source: 'platform_default' | 'tenant';
      if (input.from.kind === 'platform_default') {
        const platform = platformLocalePack(input.language, input.country);
        if (!platform) throw app.httpErrors.conflict('DEFAULT_NOT_AVAILABLE: no platform default exists for this language and country. Clone an existing pack and supply the wording instead.');
        base = platform.strings;
        baseDefaultVersion = platform.version;
        source = 'platform_default';
      } else {
        const origin = await tx.receptionistLocalePack.findFirst({ where: { id: input.from.packId, tenantId: request.auth.tenantId }, select: { strings: true, baseDefaultVersion: true } });
        if (!origin || !isLocalePackStrings(origin.strings)) throw app.httpErrors.notFound('Source locale pack not found');
        base = origin.strings;
        baseDefaultVersion = origin.baseDefaultVersion;
        source = 'tenant';
      }
      const strings = mergeLocalePackStrings(base, input.strings as Partial<LocalePackStrings> | undefined);
      const latest = await tx.receptionistLocalePack.findFirst({
        where: { tenantId: request.auth.tenantId, language: input.language, country: input.country },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const created = await tx.receptionistLocalePack.create({
        data: {
          tenantId: request.auth.tenantId,
          language: input.language,
          country: input.country,
          version: (latest?.version ?? 0) + 1,
          status: 'DRAFT',
          source,
          baseDefaultVersion,
          strings: strings as unknown as Prisma.InputJsonValue,
          evidenceHash: localePackEvidenceHash(strings),
          createdByUserId: request.auth.userId,
        },
        select: packSelect,
      });
      await auditReceptionistMutation(tx, request, {
        action: 'receptionistLocalePack.created', resource: 'receptionistLocalePack', resourceId: created.id,
        metadata: { language: created.language, country: created.country, version: created.version, evidenceHash: created.evidenceHash },
      });
      return created;
    });
    return reply.code(201).send(view(row));
  });

  app.patch('/locale-packs/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const input = z.object({
      expectedUpdatedAt: z.string().datetime().optional(),
      strings: localePackStringsSchema.partial(),
    }).strict().parse(request.body);
    const result = await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockReceptionistConfiguration(tx, request.auth.tenantId);
      const existing = await tx.receptionistLocalePack.findFirst({ where: { id, tenantId: request.auth.tenantId }, select: { ...packSelect, status: true } });
      if (!existing) throw app.httpErrors.notFound('Locale pack not found');
      // Approved wording is evidence: a call was disclosed with these exact
      // words. Editing it in place would invalidate the consent hashes.
      if (existing.status !== 'DRAFT') return { immutable: true as const };
      if (input.expectedUpdatedAt && existing.updatedAt.toISOString() !== new Date(input.expectedUpdatedAt).toISOString()) {
        return { stale: true as const, current: view(existing) };
      }
      if (!isLocalePackStrings(existing.strings)) throw app.httpErrors.internalServerError('Stored locale pack strings are malformed');
      const strings = mergeLocalePackStrings(existing.strings, input.strings as Partial<LocalePackStrings>);
      const row = await tx.receptionistLocalePack.update({
        where: { id },
        data: { strings: strings as unknown as Prisma.InputJsonValue, evidenceHash: localePackEvidenceHash(strings) },
        select: packSelect,
      });
      await auditReceptionistMutation(tx, request, {
        action: 'receptionistLocalePack.updated', resource: 'receptionistLocalePack', resourceId: id,
        metadata: { evidenceHash: row.evidenceHash },
      });
      return { row };
    });
    if ('immutable' in result) return reply.code(409).send({ error: 'PACK_IMMUTABLE', message: 'An approved or retired locale pack cannot be edited. Create a new version instead.' });
    if ('stale' in result) return reply.code(409).send({ error: 'STALE_REVISION', message: 'Someone else edited this pack while you were working. Reload to see their changes.', current: result.current });
    return view(result.row);
  });

  app.post('/locale-packs/:id/approve', { preHandler: [writeRoles, ownerAdminRoles] }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const input = z.object({ acknowledgedEvidenceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request.body);
    const result = await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockReceptionistConfiguration(tx, request.auth.tenantId);
      const existing = await tx.receptionistLocalePack.findFirst({ where: { id, tenantId: request.auth.tenantId }, select: packSelect });
      if (!existing) throw app.httpErrors.notFound('Locale pack not found');
      if (existing.status !== 'DRAFT') return { immutable: true as const };
      // The approver signs off on the exact words they were shown.
      if (existing.evidenceHash !== input.acknowledgedEvidenceHash) return { mismatch: true as const, evidenceHash: existing.evidenceHash };
      if (!isLocalePackStrings(existing.strings)) throw app.httpErrors.internalServerError('Stored locale pack strings are malformed');
      const validation = validateLocalePackStrings(existing.strings);
      if (!validation.ok) return { invalid: true as const, issues: validation.issues };
      const approvedAt = new Date();
      // Exactly one approved pack per (language, country): the previous one is
      // retired in the same transaction as the partial unique index requires.
      await tx.receptionistLocalePack.updateMany({
        where: { tenantId: request.auth.tenantId, language: existing.language, country: existing.country, status: 'APPROVED' },
        data: { status: 'RETIRED', retiredAt: approvedAt },
      });
      const row = await tx.receptionistLocalePack.update({
        where: { id },
        data: { status: 'APPROVED', approvedByUserId: request.auth.userId, approvedAt },
        select: packSelect,
      });
      await auditReceptionistMutation(tx, request, {
        action: 'receptionistLocalePack.approved', resource: 'receptionistLocalePack', resourceId: id,
        metadata: { language: row.language, country: row.country, version: row.version, evidenceHash: row.evidenceHash },
      });
      return { row };
    });
    if ('immutable' in result) return reply.code(409).send({ error: 'PACK_IMMUTABLE', message: 'Only a draft locale pack can be approved.' });
    if ('mismatch' in result) return reply.code(409).send({ error: 'EVIDENCE_HASH_MISMATCH', message: 'This pack changed since you reviewed it. Reload and read the current wording before approving.', evidenceHash: result.evidenceHash });
    if ('invalid' in result) return reply.code(422).send({ error: 'PACK_INVALID', message: 'This wording cannot be approved yet.', validation: { ok: false, issues: result.issues } });
    await recordWorkflowEvent(request.auth.tenantId, {
      eventType: 'receptionist.locale_pack.approved', entityType: 'receptionistLocalePack', entityId: id,
      sourceModule: 'receptionist', payload: { language: result.row.language, country: result.row.country, version: result.row.version },
    });
    return view(result.row);
  });

  app.patch('/locale-packs/:id/status', { preHandler: [writeRoles, ownerAdminRoles] }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const input = z.object({ status: z.literal('RETIRED') }).strict().parse(request.body);
    const result = await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockReceptionistConfiguration(tx, request.auth.tenantId);
      const existing = await tx.receptionistLocalePack.findFirst({ where: { id, tenantId: request.auth.tenantId }, select: packSelect });
      if (!existing) throw app.httpErrors.notFound('Locale pack not found');
      if (existing.status === 'RETIRED') return { row: existing };
      const bound = await tx.receptionistCampaign.count({ where: { tenantId: request.auth.tenantId, status: 'ACTIVE', attestedLocalePackId: id } });
      // Retiring wording a live campaign is bound to would leave that campaign
      // speaking words no one can look up.
      if (bound > 0) return { inUse: true as const, boundActiveCampaigns: bound };
      const row = await tx.receptionistLocalePack.update({
        where: { id }, data: { status: input.status, retiredAt: new Date() }, select: packSelect,
      });
      await auditReceptionistMutation(tx, request, {
        action: 'receptionistLocalePack.retired', resource: 'receptionistLocalePack', resourceId: id,
        metadata: { language: row.language, country: row.country, version: row.version },
      });
      return { row };
    });
    if ('inUse' in result) return reply.code(409).send({ error: 'PACK_IN_USE', message: 'An active campaign is bound to this locale pack. Pause it before retiring the wording.', boundActiveCampaigns: result.boundActiveCampaigns });
    return view(result.row);
  });
};
