import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { runWithTenantContext } from '../../lib/tenantContext';
import { validateIntakeFieldConfiguration, type IntakeFieldConfiguration } from './intakeContract';
import { uuid, idParam, writeRoles, intakeConfigurationError, isActiveIntakeContractError, compileCampaignIntakeContract, lockReceptionistConfiguration, auditReceptionistMutation, FIELD_TYPES } from './shared';

export const intakeRoutes: FastifyPluginAsync = async app => {
  // ===== Intake fields ====================================================
  const intakeFieldCreate = z.object({
    campaignId: uuid,
    fieldType: z.enum(FIELD_TYPES),
    label: z.string().trim().min(1).max(160),
    aiQuestion: z.string().trim().min(2).max(500),
    validationRule: z.string().trim().max(200).optional().nullable(),
    placeholder: z.string().trim().max(200).optional().nullable(),
    options: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
    required: z.boolean().optional(),
    confirmationRequired: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
  }).strict();
  const intakeFieldUpdate = intakeFieldCreate.partial().omit({ campaignId: true });

  app.get('/intake-fields', { preHandler: writeRoles }, async request => {
    const query = z.object({ campaignId: uuid }).parse(request.query);
    return db.receptionistIntakeField.findMany({
      where: { tenantId: request.auth.tenantId, campaignId: query.campaignId },
      orderBy: { sortOrder: 'asc' },
    });
  });

  app.post('/intake-fields', { preHandler: writeRoles }, async (request, reply) => {
    const input = intakeFieldCreate.parse(request.body);
    try {
      const row = await runWithTenantContext(request.auth.tenantId, async tx => {
        await lockReceptionistConfiguration(tx, request.auth.tenantId);
        const campaign = await tx.receptionistCampaign.findFirst({ where: { id: input.campaignId, tenantId: request.auth.tenantId } });
        if (!campaign) throw app.httpErrors.notFound('Campaign not found');
        if (campaign.status === 'ACTIVE') throw new Error('active_intake_contract_immutable');
        const existing = await tx.receptionistIntakeField.findMany({ where: { tenantId: request.auth.tenantId, campaignId: input.campaignId }, orderBy: { sortOrder: 'asc' } });
        const sortOrder = input.sortOrder ?? (existing.length ? Math.max(...existing.map(field => field.sortOrder)) + 1 : 0);
        const candidate: IntakeFieldConfiguration = {
          ...input,
          options: input.options ?? [],
          required: input.required ?? true,
          confirmationRequired: input.confirmationRequired ?? false,
          sortOrder,
        };
        const issues = validateIntakeFieldConfiguration([...existing, candidate]);
        if (issues.length) throw new Error(`invalid_intake_configuration:${issues.join('|')}`);
        const created = await tx.receptionistIntakeField.create({ data: { tenantId: request.auth.tenantId, ...candidate, campaignId: input.campaignId } });
        // Compile inside the same transaction so location-dependent schema
        // invariants fail atomically with the field mutation.
        await compileCampaignIntakeContract(tx, await tx.receptionistCampaign.findUniqueOrThrow({ where: { id: campaign.id } }));
        await auditReceptionistMutation(tx, request, { action: 'receptionistIntakeField.created', resource: 'receptionistIntakeField', resourceId: created.id, metadata: { campaignId: input.campaignId } });
        return created;
      });
      return reply.code(201).send(row);
    } catch (error) {
      const invalid = intakeConfigurationError(error);
      if (invalid) throw app.httpErrors.badRequest(invalid);
      if (isActiveIntakeContractError(error)) throw app.httpErrors.conflict('Pause the active campaign before changing its attested intake contract.');
      throw error;
    }
  });

  app.patch('/intake-fields/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = intakeFieldUpdate.parse(request.body);
    try {
      return await runWithTenantContext(request.auth.tenantId, async tx => {
        await lockReceptionistConfiguration(tx, request.auth.tenantId);
        const existing = await tx.receptionistIntakeField.findFirst({ where: { id, tenantId: request.auth.tenantId } });
        if (!existing) throw app.httpErrors.notFound('Intake field not found');
        const campaign = await tx.receptionistCampaign.findFirst({ where: { id: existing.campaignId, tenantId: request.auth.tenantId }, select: { status: true } });
        if (campaign?.status === 'ACTIVE') throw new Error('active_intake_contract_immutable');
        const fields = await tx.receptionistIntakeField.findMany({ where: { tenantId: request.auth.tenantId, campaignId: existing.campaignId } });
        const candidate = { ...existing, ...input } as IntakeFieldConfiguration;
        const issues = validateIntakeFieldConfiguration(fields.map(field => field.id === id ? candidate : field));
        if (issues.length) throw new Error(`invalid_intake_configuration:${issues.join('|')}`);
        const row = await tx.receptionistIntakeField.update({ where: { id }, data: input });
        const currentCampaign = await tx.receptionistCampaign.findUniqueOrThrow({ where: { id: existing.campaignId } });
        await compileCampaignIntakeContract(tx, currentCampaign);
        await auditReceptionistMutation(tx, request, { action: 'receptionistIntakeField.updated', resource: 'receptionistIntakeField', resourceId: id, metadata: { campaignId: existing.campaignId } });
        return row;
      });
    } catch (error) {
      const invalid = intakeConfigurationError(error);
      if (invalid) throw app.httpErrors.badRequest(invalid);
      if (isActiveIntakeContractError(error)) throw app.httpErrors.conflict('Pause the active campaign before changing its attested intake contract.');
      throw error;
    }
  });

  app.delete('/intake-fields/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    try {
      await runWithTenantContext(request.auth.tenantId, async tx => {
        await lockReceptionistConfiguration(tx, request.auth.tenantId);
        const existing = await tx.receptionistIntakeField.findFirst({ where: { id, tenantId: request.auth.tenantId } });
        if (!existing) throw app.httpErrors.notFound('Intake field not found');
        const campaign = await tx.receptionistCampaign.findFirst({ where: { id: existing.campaignId, tenantId: request.auth.tenantId }, select: { status: true } });
        if (campaign?.status === 'ACTIVE') throw new Error('active_intake_contract_immutable');
        await tx.receptionistIntakeField.delete({ where: { id } });
        await auditReceptionistMutation(tx, request, { action: 'receptionistIntakeField.deleted', resource: 'receptionistIntakeField', resourceId: id, metadata: { campaignId: existing.campaignId } });
      });
      return reply.code(204).send();
    } catch (error) {
      if (isActiveIntakeContractError(error)) throw app.httpErrors.conflict('Pause the active campaign before changing its attested intake contract.');
      throw error;
    }
  });

  app.post('/intake-fields/reorder', { preHandler: writeRoles }, async request => {
    const input = z.object({ campaignId: uuid, orderedIds: z.array(uuid).max(24) }).strict().parse(request.body);
    try {
      return await runWithTenantContext(request.auth.tenantId, async tx => {
        await lockReceptionistConfiguration(tx, request.auth.tenantId);
        const campaign = await tx.receptionistCampaign.findFirst({ where: { id: input.campaignId, tenantId: request.auth.tenantId } });
        if (!campaign) throw app.httpErrors.notFound('Campaign not found');
        if (campaign.status === 'ACTIVE') throw new Error('active_intake_contract_immutable');
        const fields = await tx.receptionistIntakeField.findMany({ where: { tenantId: request.auth.tenantId, campaignId: input.campaignId } });
        if (new Set(input.orderedIds).size !== input.orderedIds.length
          || fields.length !== input.orderedIds.length
          || fields.some(field => !input.orderedIds.includes(field.id))) {
          throw new Error('invalid_intake_configuration:Reorder must contain every campaign field exactly once.');
        }
        const future = fields.map(field => ({ ...field, sortOrder: input.orderedIds.indexOf(field.id) }));
        const issues = validateIntakeFieldConfiguration(future);
        if (issues.length) throw new Error(`invalid_intake_configuration:${issues.join('|')}`);
        for (const [index, fieldId] of input.orderedIds.entries()) {
          await tx.receptionistIntakeField.update({ where: { id: fieldId }, data: { sortOrder: index } });
        }
        await auditReceptionistMutation(tx, request, { action: 'receptionistIntakeField.reordered', resource: 'receptionistCampaign', resourceId: input.campaignId });
        return tx.receptionistIntakeField.findMany({ where: { tenantId: request.auth.tenantId, campaignId: input.campaignId }, orderBy: { sortOrder: 'asc' } });
      });
    } catch (error) {
      const invalid = intakeConfigurationError(error);
      if (invalid) throw app.httpErrors.badRequest(invalid);
      if (isActiveIntakeContractError(error)) throw app.httpErrors.conflict('Pause the active campaign before changing its attested intake contract.');
      throw error;
    }
  });
};
