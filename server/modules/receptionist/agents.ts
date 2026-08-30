import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { runWithTenantContext } from '../../lib/tenantContext';
import { isValidRetellVersionTag } from '../../lib/retell';
import { Prisma } from '../../generated/prisma/client';
import { uuid, idParam, writeRoles, callArtifactRead, isReceptionistDestinationConflict, lockReceptionistConfiguration, auditReceptionistMutation } from './shared';
import { verifyAgentProvider, type VerifyActor } from '../../lib/receptionist/agentVerification';
import { remediationFor } from '../../lib/receptionist/remediation';

const providerAgentIdInput = z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/).optional().nullable();

const providerVersionTagInput = z.string().trim().refine(isValidRetellVersionTag, {
  message: 'Deployment tag must start lowercase, use at most 20 lowercase letters, digits, hyphens or underscores, and cannot be latest, latest_published, or v<number>.',
}).optional();

export const agentRoutes: FastifyPluginAsync = async app => {
  // ===== Agents ===========================================================
  const agentCreate = z.object({
    clinicId: uuid,
    name: z.string().trim().min(1).max(80),
    voice: z.string().trim().max(80).optional(),
    tone: z.string().trim().max(120).optional(),
    language: z.string().trim().max(20).optional(),
    persona: z.string().trim().max(600).optional().nullable(),
    greetingOverride: z.string().trim().max(600).optional().nullable(),
    providerAgentId: providerAgentIdInput,
    providerVersionTag: providerVersionTagInput,
    active: z.boolean().optional(),
  });
  const agentUpdate = agentCreate.partial().omit({ clinicId: true });

  app.get('/agents', { preHandler: callArtifactRead }, async request => {
    const query = z.object({ clinicId: uuid.optional() }).parse(request.query);
    const rows = await db.receptionistAgent.findMany({
      where: { tenantId: request.auth.tenantId, ...(query.clinicId ? { clinicId: query.clinicId } : {}) },
      orderBy: { createdAt: 'asc' },
    });
    // Surface a verified provider that disagrees with the local copy rather
    // than letting Studio display a voice the caller will never hear.
    return rows.map(agent => ({
      ...agent,
      providerMismatch: agent.providerStatus === 'VERIFIED' && (agent.providerVoiceId || agent.providerLanguage)
        ? {
          voice: Boolean(agent.providerVoiceId && agent.providerVoiceId !== agent.voice),
          language: Boolean(agent.providerLanguage && agent.providerLanguage !== agent.language),
        }
        : null,
    }));
  });

  app.post('/agents', { preHandler: writeRoles }, async (request, reply) => {
    const input = agentCreate.parse(request.body);
    const row = await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockReceptionistConfiguration(tx, request.auth.tenantId);
      const clinic = await tx.receptionistClinic.findFirst({ where: { id: input.clinicId, tenantId: request.auth.tenantId, active: true }, select: { id: true } });
      if (!clinic) throw app.httpErrors.badRequest('An active tenant-owned clinic is required.');
      const duplicate = await tx.receptionistAgent.findFirst({
        where: { tenantId: request.auth.tenantId, clinicId: input.clinicId, name: { equals: input.name, mode: 'insensitive' } },
        select: { id: true },
      });
      if (duplicate) throw app.httpErrors.conflict('An agent with this name already exists for the clinic.');
      const created = await tx.receptionistAgent.create({ data: { tenantId: request.auth.tenantId, ...input } });
      await auditReceptionistMutation(tx, request, {
        action: 'receptionistAgent.created', resource: 'receptionistAgent', resourceId: created.id,
        metadata: { clinicId: created.clinicId, providerLinked: Boolean(created.providerAgentId), providerStatus: created.providerStatus },
      });
      return created;
    });
    return reply.code(201).send(row);
  });

  app.patch('/agents/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = agentUpdate.parse(request.body);
    try {
      return await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockReceptionistConfiguration(tx, request.auth.tenantId);
      const existing = await tx.receptionistAgent.findFirst({ where: { id, tenantId: request.auth.tenantId } });
      if (!existing) throw app.httpErrors.notFound('Agent not found');
      const providerBindingChanged = (input.providerAgentId !== undefined && input.providerAgentId !== existing.providerAgentId)
        || (input.providerVersionTag !== undefined && input.providerVersionTag !== existing.providerVersionTag);
      const deactivating = input.active === false && existing.active;
      if (providerBindingChanged || deactivating) {
        const [studioReference, outboundReference] = await Promise.all([
          tx.receptionistCampaign.findFirst({ where: { tenantId: request.auth.tenantId, agentId: id, status: 'ACTIVE' }, select: { id: true } }),
          tx.receptionistOutboundCampaign.findFirst({ where: { tenantId: request.auth.tenantId, agentId: id, status: { in: ['SCHEDULED', 'RUNNING'] } }, select: { id: true } }),
        ]);
        if (studioReference || outboundReference) throw app.httpErrors.conflict('Pause active and runnable campaigns before changing or deactivating this provider binding.');
      }
      if (input.name !== undefined) {
        const duplicate = await tx.receptionistAgent.findFirst({
          where: { tenantId: request.auth.tenantId, clinicId: existing.clinicId, id: { not: id }, name: { equals: input.name, mode: 'insensitive' } },
          select: { id: true },
        });
        if (duplicate) throw app.httpErrors.conflict('An agent with this name already exists for the clinic.');
      }
      const data: Prisma.ReceptionistAgentUpdateInput = { ...input };
      if (providerBindingChanged) Object.assign(data, {
        providerStatus: 'UNVERIFIED',
        providerVersion: null,
        providerPublished: null,
        providerAssignedTags: { set: [] },
        providerVoiceId: null,
        providerLanguage: null,
        providerWebhookUrl: null,
        providerWebhookEvents: { set: [] },
        providerDataStorageSetting: null,
        providerSignedUrl: null,
        providerResponseEngineType: null,
        providerResponseEngineId: null,
        providerResponseEngineVersion: null,
        providerResponseEngineGraphFingerprint: null,
        providerEffectiveDynamicVariables: Prisma.DbNull,
        providerBookToolSchema: Prisma.DbNull,
        providerBookToolFingerprint: null,
        providerToolCallStrictMode: null,
        providerLastModifiedAt: null,
        providerFingerprint: null,
        providerConfigRevision: { increment: 1 },
        providerVerifiedRevision: null,
        providerVerifiedAt: null,
        providerVerificationExpiresAt: null,
        providerLastAttemptStatus: 'NEVER',
        providerLastAttemptAt: null,
        providerLastErrorCode: null,
      });
      const row = await tx.receptionistAgent.update({ where: { id }, data });
      await auditReceptionistMutation(tx, request, {
        action: 'receptionistAgent.updated', resource: 'receptionistAgent', resourceId: id,
        metadata: { active: row.active, providerBindingChanged, providerStatus: row.providerStatus },
      });
        return row;
      });
    } catch (error) {
      if (isReceptionistDestinationConflict(error)) throw app.httpErrors.conflict('This active provider deployment is already assigned to another agent.');
      throw error;
    }
  });

  // Thin adapter over the shared verification service. The provider probe runs
  // outside any transaction (a Retell round trip inside `runWithTenantContext`
  // would hold the tenant-wide advisory lock and hit Prisma's transaction
  // timeout); the service commits agent, deployment and audit together.
  app.post('/agents/:id/verify-provider', {
    preHandler: writeRoles,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const actor: VerifyActor = { userId: request.auth.userId, source: 'USER', requestId: request.id, ip: request.ip };
    try {
      const outcome = await verifyAgentProvider({ tenantId: request.auth.tenantId, agentId: id, actor });
      switch (outcome.kind) {
        case 'not_found':
          throw app.httpErrors.notFound('Agent not found');
        case 'unlinked':
          throw app.httpErrors.conflict('Link a Retell agent before verification.');
        case 'concurrent_change':
          throw app.httpErrors.conflict('Agent configuration changed while provider verification was in progress. Retry verification.');
        case 'cooldown':
          return reply.code(429).send({
            code: 'cooldown',
            message: remediationFor('cooldown').action,
            retryAfterSeconds: outcome.retryAfterSeconds,
            agent: null,
          });
        case 'drift_blocked':
          return reply.code(409).send({
            code: outcome.code,
            message: 'Provider deployment drift detected. Pause active and runnable campaigns before approving the new immutable version.',
            agent: outcome.agent,
          });
        case 'failed':
          return reply.code(outcome.httpStatus).send({
            code: outcome.code,
            message: remediationFor(outcome.code, { agentId: id, clinicId: outcome.agent.clinicId }).action,
            agent: outcome.agent,
          });
        case 'verified':
          return reply.code(200).send({ code: null, message: null, agent: outcome.agent });
      }
    } catch (error) {
      if (isReceptionistDestinationConflict(error)) throw app.httpErrors.conflict('This active provider deployment is already assigned to another agent.');
      throw error;
    }
  });

  // Adopt what the provider actually reports for voice and language. Deploy
  // makes this moot by construction; it exists for an agent linked by hand,
  // where the provider is the source of truth and Studio is the copy.
  app.post('/agents/:id/adopt-provider-values', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    return runWithTenantContext(request.auth.tenantId, async tx => {
      await lockReceptionistConfiguration(tx, request.auth.tenantId);
      const agent = await tx.receptionistAgent.findFirst({ where: { id, tenantId: request.auth.tenantId } });
      if (!agent) throw app.httpErrors.notFound('Agent not found');
      if (!agent.providerVoiceId && !agent.providerLanguage) {
        throw app.httpErrors.conflict('This agent has no verified provider values to adopt. Verify it first.');
      }
      const row = await tx.receptionistAgent.update({
        where: { id },
        data: {
          ...(agent.providerVoiceId ? { voice: agent.providerVoiceId } : {}),
          ...(agent.providerLanguage ? { language: agent.providerLanguage } : {}),
        },
      });
      await auditReceptionistMutation(tx, request, {
        action: 'receptionistAgent.adoptedProviderValues', resource: 'receptionistAgent', resourceId: id,
        metadata: { voice: row.voice, language: row.language },
      });
      return row;
    });
  });

  app.delete('/agents/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    await runWithTenantContext(request.auth.tenantId, async tx => {
      await lockReceptionistConfiguration(tx, request.auth.tenantId);
      const existing = await tx.receptionistAgent.findFirst({ where: { id, tenantId: request.auth.tenantId } });
      if (!existing) throw app.httpErrors.notFound('Agent not found');
      const [studioReference, outboundReference] = await Promise.all([
        tx.receptionistCampaign.findFirst({ where: { tenantId: request.auth.tenantId, agentId: id }, select: { id: true } }),
        tx.receptionistOutboundCampaign.findFirst({ where: { tenantId: request.auth.tenantId, agentId: id }, select: { id: true } }),
      ]);
      if (studioReference || outboundReference) throw app.httpErrors.conflict('Agent history is referenced by a campaign. Deactivate the agent instead of deleting it.');
      await tx.receptionistAgent.delete({ where: { id } });
      await auditReceptionistMutation(tx, request, {
        action: 'receptionistAgent.deleted', resource: 'receptionistAgent', resourceId: id,
        metadata: { clinicId: existing.clinicId, providerLinked: Boolean(existing.providerAgentId) },
      });
    });
    return reply.code(204).send();
  });
};
