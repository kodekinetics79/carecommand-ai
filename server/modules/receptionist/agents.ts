import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { env } from '../../config/env';
import { runWithTenantContext } from '../../lib/tenantContext';
import { evaluateRetellAgentReadiness, isValidRetellVersionTag, probeRetellAgent, RETELL_AGENT_VERIFICATION_TTL_MS, type RetellAgentSnapshot } from '../../lib/retell';
import { Prisma } from '../../generated/prisma/client';
import { uuid, idParam, writeRoles, isReceptionistDestinationConflict, lockReceptionistConfiguration, auditReceptionistMutation } from './shared';

const providerAgentIdInput = z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/).optional().nullable();

const providerVersionTagInput = z.string().trim().refine(isValidRetellVersionTag, {
  message: 'Deployment tag must start lowercase, use at most 20 lowercase letters, digits, hyphens or underscores, and cannot be latest, latest_published, or v<number>.',
}).optional();

function expectedRetellAgentWebhookUrl() {
  return `${env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/receptionist/webhooks/retell`;
}

function providerSnapshotData(snapshot: RetellAgentSnapshot) {
  return {
    providerVersion: snapshot.version,
    providerPublished: snapshot.published,
    providerAssignedTags: snapshot.assignedTags,
    providerVoiceId: snapshot.voiceId,
    providerLanguage: snapshot.language,
    providerWebhookUrl: snapshot.webhookUrl,
    providerWebhookEvents: snapshot.webhookEvents,
    providerDataStorageSetting: snapshot.dataStorageSetting,
    providerSignedUrl: snapshot.signedUrl,
    providerResponseEngineType: snapshot.responseEngineType,
    providerResponseEngineId: snapshot.responseEngineId,
    providerResponseEngineVersion: snapshot.responseEngineVersion,
    providerLastModifiedAt: snapshot.lastModifiedAt,
    providerFingerprint: snapshot.fingerprint,
    providerResponseEngineGraphFingerprint: snapshot.responseEngineGraphFingerprint,
    providerEffectiveDynamicVariables: snapshot.effectiveDynamicVariables as Prisma.InputJsonValue,
    providerBookToolSchema: snapshot.bookToolSchema as Prisma.InputJsonValue,
    providerBookToolFingerprint: snapshot.bookToolFingerprint,
    providerToolCallStrictMode: snapshot.toolCallStrictMode,
  };
}

function providerIntakeEvidenceFailure(snapshot: RetellAgentSnapshot): string | null {
  if (snapshot.bookToolProbeStatus === 'UNAVAILABLE') return 'provider_response_engine_unavailable';
  if (snapshot.bookToolProbeStatus === 'UNSUPPORTED') return 'provider_response_engine_unsupported';
  if (!snapshot.responseEngineGraphFingerprint || !snapshot.bookToolSchema || !snapshot.bookToolFingerprint) {
    return 'provider_intake_contract_unattested';
  }
  if (snapshot.toolCallStrictMode !== true) return 'provider_intake_contract_not_strict';
  return null;
}

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

  app.get('/agents', { preHandler: writeRoles }, async request => {
    const query = z.object({ clinicId: uuid.optional() }).parse(request.query);
    return db.receptionistAgent.findMany({
      where: { tenantId: request.auth.tenantId, ...(query.clinicId ? { clinicId: query.clinicId } : {}) },
      orderBy: { createdAt: 'asc' },
    });
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

  app.post('/agents/:id/verify-provider', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const before = await db.receptionistAgent.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!before) throw app.httpErrors.notFound('Agent not found');
    if (!before.providerAgentId) throw app.httpErrors.conflict('Link a Retell agent before verification.');

    const attemptedAt = new Date();
    const probe = await probeRetellAgent(before.providerAgentId, before.providerVersionTag);
    const permanentProbeFailure = !probe.ok && ['not_found', 'invalid_request', 'invalid_response'].includes(probe.error);
    const readinessFailure = probe.ok
      ? evaluateRetellAgentReadiness(probe.snapshot, { versionTag: before.providerVersionTag, webhookUrl: expectedRetellAgentWebhookUrl() })
      : null;
    const intakeEvidenceFailure = probe.ok ? providerIntakeEvidenceFailure(probe.snapshot) : null;
    const safeError = probe.ok ? readinessFailure ?? intakeEvidenceFailure : probe.error;

    try {
      const updated = await runWithTenantContext(request.auth.tenantId, async tx => {
        await lockReceptionistConfiguration(tx, request.auth.tenantId);
        const current = await tx.receptionistAgent.findFirst({ where: { id, tenantId: request.auth.tenantId } });
        if (!current) throw app.httpErrors.notFound('Agent not found');
        if (current.providerConfigRevision !== before.providerConfigRevision
          || current.providerAgentId !== before.providerAgentId
          || current.providerVersionTag !== before.providerVersionTag) {
          throw app.httpErrors.conflict('Agent configuration changed while provider verification was in progress. Retry verification.');
        }

        const success = probe.ok && !readinessFailure && !intakeEvidenceFailure;
        const failedCandidateChanged = probe.ok && current.providerStatus === 'VERIFIED'
          && (
            current.providerVersion !== probe.snapshot.version
            || current.providerFingerprint !== probe.snapshot.fingerprint
            || current.providerResponseEngineType !== probe.snapshot.responseEngineType
            || current.providerResponseEngineId !== probe.snapshot.responseEngineId
            || current.providerResponseEngineVersion !== probe.snapshot.responseEngineVersion
          );
        const deploymentChanged = success && current.providerStatus === 'VERIFIED'
          && (
            current.providerVersion !== probe.snapshot.version
            || current.providerFingerprint !== probe.snapshot.fingerprint
            || (probe.snapshot.bookToolProbeStatus === 'SUCCEEDED'
              && (current.providerResponseEngineGraphFingerprint !== probe.snapshot.responseEngineGraphFingerprint
                || current.providerBookToolFingerprint !== probe.snapshot.bookToolFingerprint))
          );
        if (deploymentChanged) {
          const [studioReference, outboundReference] = await Promise.all([
            tx.receptionistCampaign.findFirst({ where: { tenantId: request.auth.tenantId, agentId: id, status: 'ACTIVE' }, select: { id: true } }),
            tx.receptionistOutboundCampaign.findFirst({ where: { tenantId: request.auth.tenantId, agentId: id, status: { in: ['SCHEDULED', 'RUNNING'] } }, select: { id: true } }),
          ]);
          if (studioReference || outboundReference) {
            const row = await tx.receptionistAgent.update({
              where: { id },
              data: {
                providerLastAttemptAt: attemptedAt,
                providerLastAttemptStatus: 'FAILED',
                providerLastErrorCode: 'provider_deployment_drift',
              },
            });
            await auditReceptionistMutation(tx, request, {
              action: 'receptionistAgent.providerDeploymentDriftDetected',
              resource: 'receptionistAgent',
              resourceId: id,
              metadata: {
                pinnedVersion: current.providerVersion,
                detectedVersion: probe.snapshot.version,
                studioCampaignActive: Boolean(studioReference),
                outboundCampaignRunnable: Boolean(outboundReference),
              },
            });
            return { row, driftBlocked: true };
          }
        }
        const data: Prisma.ReceptionistAgentUpdateInput = {
          providerLastAttemptAt: attemptedAt,
          providerLastAttemptStatus: success ? 'SUCCEEDED' : 'FAILED',
          providerLastErrorCode: safeError,
          ...(success ? providerSnapshotData(probe.snapshot) : {}),
          ...(success ? {
            providerStatus: 'VERIFIED' as const,
            providerVerifiedRevision: current.providerConfigRevision,
            providerVerifiedAt: attemptedAt,
            providerVerificationExpiresAt: new Date(attemptedAt.getTime() + RETELL_AGENT_VERIFICATION_TTL_MS),
          } : (permanentProbeFailure || (probe.ok && (current.providerStatus !== 'VERIFIED' || failedCandidateChanged))) ? {
            providerStatus: 'INVALID' as const,
            providerVerifiedRevision: null,
            providerVerifiedAt: null,
            providerVerificationExpiresAt: null,
          } : {}),
        };
        const row = await tx.receptionistAgent.update({ where: { id }, data });
        await auditReceptionistMutation(tx, request, {
          action: success
            ? deploymentChanged ? 'receptionistAgent.providerDeploymentUpdated' : 'receptionistAgent.providerVerified'
            : 'receptionistAgent.providerVerificationFailed',
          resource: 'receptionistAgent', resourceId: id,
          metadata: {
            providerStatus: row.providerStatus,
            providerVersion: row.providerVersion,
            providerVersionTag: row.providerVersionTag,
            deploymentChanged,
            reason: safeError,
          },
        });
        return { row, driftBlocked: false };
      });
      if (updated.driftBlocked) {
        return reply.code(409).send({
          ...updated.row,
          code: 'provider_deployment_drift',
          message: 'Provider deployment drift detected. Pause active and runnable campaigns before approving the new immutable version.',
        });
      }
      if ((!probe.ok && !permanentProbeFailure) || intakeEvidenceFailure === 'provider_response_engine_unavailable') {
        return reply.code(503).send(updated.row);
      }
      return reply.code(200).send(updated.row);
    } catch (error) {
      if (isReceptionistDestinationConflict(error)) throw app.httpErrors.conflict('This active provider deployment is already assigned to another agent.');
      throw error;
    }
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
