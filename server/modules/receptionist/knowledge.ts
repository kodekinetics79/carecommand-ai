import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { runWithTenantContext } from '../../lib/tenantContext';
import { recordWorkflowEvent } from '../../lib/intelligence';
import {
  emptyKnowledgeDocument,
  knowledgeDocumentSchema,
  knowledgeHash,
  parseKnowledgeDocument,
  validateKnowledge,
  type KnowledgeDocument,
} from '../../lib/receptionist/knowledge';
import { Prisma } from '../../generated/prisma/client';
import { idParam, writeRoles, receptionistRead, lockReceptionistConfiguration, auditReceptionistMutation } from './shared';

// ===========================================================================
// Clinic knowledge: a draft anyone with receptionist:manage can edit, and an
// approved snapshot the prompt renders. Approval is the governance act that
// produces the hash and the approver; nothing unapproved is ever spoken.
// ===========================================================================

function view(row: {
  clinicId: string;
  draft: Prisma.JsonValue;
  draftRevision: number;
  approved: Prisma.JsonValue | null;
  approvedRevision: number | null;
  approvedHash: string | null;
  approvedAt: Date | null;
  approvedBy?: { id: string; displayName: string } | null;
} | null, clinicId: string) {
  const draft = row ? parseKnowledgeDocument(row.draft) ?? emptyKnowledgeDocument() : emptyKnowledgeDocument();
  const approved = row?.approved ? parseKnowledgeDocument(row.approved) : null;
  const validation = validateKnowledge(draft);
  return {
    clinicId,
    draft,
    draftRevision: row?.draftRevision ?? 0,
    approved,
    approvedRevision: row?.approvedRevision ?? null,
    approvedHash: row?.approvedHash ?? null,
    approvedAt: row?.approvedAt?.toISOString() ?? null,
    approvedBy: row?.approvedBy ?? null,
    // "dirty" means the agent is speaking older wording than the draft shows.
    dirty: Boolean(row && row.approvedRevision !== null && row.draftRevision !== row.approvedRevision),
    validation,
  };
}

const selection = {
  clinicId: true, draft: true, draftRevision: true, approved: true, approvedRevision: true,
  approvedHash: true, approvedAt: true,
  approvedBy: { select: { id: true, displayName: true } },
} as const;

export const knowledgeRoutes: FastifyPluginAsync = async app => {
  async function assertClinic(tenantId: string, clinicId: string) {
    const clinic = await db.receptionistClinic.findFirst({ where: { id: clinicId, tenantId }, select: { id: true } });
    if (!clinic) throw app.httpErrors.notFound('Clinic not found');
  }

  app.get('/clinics/:id/knowledge', { preHandler: receptionistRead }, async request => {
    const { id } = idParam.parse(request.params);
    await assertClinic(request.auth.tenantId, id);
    const row = await db.receptionistClinicKnowledge.findFirst({ where: { tenantId: request.auth.tenantId, clinicId: id }, select: selection });
    return view(row, id);
  });

  app.put('/clinics/:id/knowledge', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const input = z.object({ expectedRevision: z.number().int().min(0), draft: knowledgeDocumentSchema }).strict().parse(request.body);
    await assertClinic(request.auth.tenantId, id);
    const result = await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockReceptionistConfiguration(tx, request.auth.tenantId);
      const existing = await tx.receptionistClinicKnowledge.findFirst({ where: { tenantId: request.auth.tenantId, clinicId: id }, select: { id: true, draftRevision: true } });
      const currentRevision = existing?.draftRevision ?? 0;
      if (input.expectedRevision !== currentRevision) return { stale: true as const, currentRevision };
      const draft = input.draft as unknown as Prisma.InputJsonValue;
      const row = existing
        ? await tx.receptionistClinicKnowledge.update({
          where: { id: existing.id },
          data: { draft, draftRevision: currentRevision + 1, updatedByUserId: request.auth.userId },
          select: selection,
        })
        : await tx.receptionistClinicKnowledge.create({
          data: { tenantId: request.auth.tenantId, clinicId: id, draft, draftRevision: 1, updatedByUserId: request.auth.userId },
          select: selection,
        });
      await auditReceptionistMutation(tx, request, {
        action: 'receptionistKnowledge.saved', resource: 'receptionistClinicKnowledge', resourceId: id,
        metadata: { clinicId: id, draftRevision: row.draftRevision },
      });
      return { stale: false as const, row };
    });
    if (result.stale) {
      return reply.code(409).send({
        error: 'STALE_REVISION',
        message: 'Someone else saved this knowledge document while you were editing it. Reload to see their changes.',
        currentRevision: result.currentRevision,
      });
    }
    return view(result.row, id);
  });

  app.post('/clinics/:id/knowledge/approve', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const input = z.object({ expectedRevision: z.number().int().min(1) }).strict().parse(request.body);
    await assertClinic(request.auth.tenantId, id);
    const result = await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockReceptionistConfiguration(tx, request.auth.tenantId);
      const existing = await tx.receptionistClinicKnowledge.findFirst({ where: { tenantId: request.auth.tenantId, clinicId: id }, select: { id: true, draft: true, draftRevision: true } });
      if (!existing) throw app.httpErrors.notFound('No knowledge document exists for this clinic yet.');
      if (input.expectedRevision !== existing.draftRevision) return { stale: true as const, currentRevision: existing.draftRevision };
      const draft = parseKnowledgeDocument(existing.draft);
      if (!draft) return { invalid: true as const, issues: [{ path: '', message: 'The stored draft is not a valid knowledge document.' }] };
      const validation = validateKnowledge(draft);
      if (!validation.ok) return { invalid: true as const, issues: validation.issues };
      const approvedAt = new Date();
      // Stamp the approver onto each FAQ answer: the snapshot is the evidence
      // of who authorised those exact words.
      const snapshot: KnowledgeDocument = {
        ...draft,
        faq: draft.faq.map(item => ({ ...item, approvedByUserId: request.auth.userId, approvedAt: approvedAt.toISOString() })),
      };
      const row = await tx.receptionistClinicKnowledge.update({
        where: { id: existing.id },
        data: {
          approved: snapshot as unknown as Prisma.InputJsonValue,
          approvedRevision: existing.draftRevision,
          approvedHash: knowledgeHash(snapshot),
          approvedByUserId: request.auth.userId,
          approvedAt,
        },
        select: selection,
      });
      await auditReceptionistMutation(tx, request, {
        action: 'receptionistKnowledge.approved', resource: 'receptionistClinicKnowledge', resourceId: id,
        metadata: { clinicId: id, approvedRevision: row.approvedRevision, approvedHash: row.approvedHash },
      });
      return { stale: false as const, invalid: false as const, row };
    });
    if ('stale' in result && result.stale) {
      return reply.code(409).send({ error: 'STALE_REVISION', message: 'The draft changed while you were reviewing it. Reload and approve again.', currentRevision: result.currentRevision });
    }
    if ('invalid' in result && result.invalid) {
      return reply.code(422).send({ error: 'KNOWLEDGE_INVALID', message: 'This document cannot be approved yet.', validation: { ok: false, issues: result.issues } });
    }
    await recordWorkflowEvent(request.auth.tenantId, {
      eventType: 'receptionist.knowledge.approved', entityType: 'receptionistClinic', entityId: id,
      sourceModule: 'receptionist', payload: { clinicId: id, approvedRevision: result.row.approvedRevision },
    });
    return view(result.row, id);
  });
};
