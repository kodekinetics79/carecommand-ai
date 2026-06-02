import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { requireRoles } from '../../plugins/roles';

const uuid = z.string().uuid();
const writeRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER');
const idParam = z.object({ id: uuid });

export const settingsRoutes: FastifyPluginAsync = async app => {
  // ---- Notification templates ----------------------------------------------
  const templateCreate = z.object({
    name: z.string().trim().min(2).max(160),
    channel: z.string().trim().min(2).max(80),
    status: z.enum(['ACTIVE', 'PAUSED']).default('ACTIVE'),
  });
  const templateUpdate = templateCreate.partial();

  app.get('/notification-templates', async request => {
    return db.notificationTemplate.findMany({
      where: { tenantId: request.auth.tenantId },
      orderBy: { createdAt: 'asc' },
    });
  });

  app.post('/notification-templates', { preHandler: writeRoles }, async (request, reply) => {
    const input = templateCreate.parse(request.body);
    const row = await db.notificationTemplate.create({ data: { tenantId: request.auth.tenantId, ...input } });
    await audit(request, { action: 'notificationTemplate.created', resource: 'notificationTemplate', resourceId: row.id });
    return reply.code(201).send(row);
  });

  app.patch('/notification-templates/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = templateUpdate.parse(request.body);
    const existing = await db.notificationTemplate.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Template not found');
    const row = await db.notificationTemplate.update({ where: { id }, data: input });
    await audit(request, { action: 'notificationTemplate.updated', resource: 'notificationTemplate', resourceId: id });
    return row;
  });

  app.delete('/notification-templates/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const existing = await db.notificationTemplate.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Template not found');
    await db.notificationTemplate.delete({ where: { id } });
    await audit(request, { action: 'notificationTemplate.deleted', resource: 'notificationTemplate', resourceId: id });
    return reply.code(204).send();
  });

  // ---- AI guardrails --------------------------------------------------------
  const guardrailCreate = z.object({
    rule: z.string().trim().min(4).max(500),
    active: z.boolean().default(true),
    sortOrder: z.number().int().min(0).default(0),
  });
  const guardrailUpdate = guardrailCreate.partial();

  app.get('/guardrails', async request => {
    return db.aiGuardrail.findMany({
      where: { tenantId: request.auth.tenantId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  });

  app.post('/guardrails', { preHandler: writeRoles }, async (request, reply) => {
    const input = guardrailCreate.parse(request.body);
    const row = await db.aiGuardrail.create({ data: { tenantId: request.auth.tenantId, ...input } });
    await audit(request, { action: 'guardrail.created', resource: 'aiGuardrail', resourceId: row.id });
    return reply.code(201).send(row);
  });

  app.patch('/guardrails/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = guardrailUpdate.parse(request.body);
    const existing = await db.aiGuardrail.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Guardrail not found');
    const row = await db.aiGuardrail.update({ where: { id }, data: input });
    await audit(request, { action: 'guardrail.updated', resource: 'aiGuardrail', resourceId: id });
    return row;
  });

  app.delete('/guardrails/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const existing = await db.aiGuardrail.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Guardrail not found');
    await db.aiGuardrail.delete({ where: { id } });
    await audit(request, { action: 'guardrail.deleted', resource: 'aiGuardrail', resourceId: id });
    return reply.code(204).send();
  });

  // ---- Customer communication preferences -----------------------------------
  const preferenceCreate = z.object({
    label: z.string().trim().min(2).max(160),
    description: z.string().trim().min(2).max(500),
    enabled: z.boolean().default(true),
    sortOrder: z.number().int().min(0).default(0),
  });
  const preferenceUpdate = preferenceCreate.partial();

  app.get('/preferences', async request => {
    return db.customerPreference.findMany({
      where: { tenantId: request.auth.tenantId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  });

  app.post('/preferences', { preHandler: writeRoles }, async (request, reply) => {
    const input = preferenceCreate.parse(request.body);
    const row = await db.customerPreference.create({ data: { tenantId: request.auth.tenantId, ...input } });
    await audit(request, { action: 'preference.created', resource: 'customerPreference', resourceId: row.id });
    return reply.code(201).send(row);
  });

  app.patch('/preferences/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = preferenceUpdate.parse(request.body);
    const existing = await db.customerPreference.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Preference not found');
    const row = await db.customerPreference.update({ where: { id }, data: input });
    await audit(request, { action: 'preference.updated', resource: 'customerPreference', resourceId: id });
    return row;
  });

  app.delete('/preferences/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const existing = await db.customerPreference.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Preference not found');
    await db.customerPreference.delete({ where: { id } });
    await audit(request, { action: 'preference.deleted', resource: 'customerPreference', resourceId: id });
    return reply.code(204).send();
  });

  // ---- Role definitions -----------------------------------------------------
  // Descriptive role catalogue for display/editing. The live user count is
  // computed from User.role; this does not alter the auth UserRole enum.
  const ROLE_MAP: Record<string, string> = {
    Owner: 'OWNER',
    'Branch Manager': 'MANAGER',
    Provider: 'PROVIDER',
    'Front Desk': 'FRONT_DESK',
    Admin: 'ADMIN',
    Analyst: 'ANALYST',
  };
  const roleCreate = z.object({
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().min(2).max(500),
    accent: z.string().trim().min(2).max(20).default('blue'),
    sortOrder: z.number().int().min(0).default(0),
  });
  const roleUpdate = roleCreate.partial();

  app.get('/roles', async request => {
    const [roles, counts] = await Promise.all([
      db.roleDefinition.findMany({
        where: { tenantId: request.auth.tenantId },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      db.user.groupBy({ by: ['role'], where: { tenantId: request.auth.tenantId }, _count: { _all: true } }),
    ]);
    const countByRole = new Map(counts.map(entry => [entry.role, entry._count._all]));
    return roles.map(role => ({
      ...role,
      userCount: countByRole.get(ROLE_MAP[role.name] as never) ?? 0,
    }));
  });

  app.post('/roles', { preHandler: writeRoles }, async (request, reply) => {
    const input = roleCreate.parse(request.body);
    const row = await db.roleDefinition.create({ data: { tenantId: request.auth.tenantId, ...input } });
    await audit(request, { action: 'role.created', resource: 'roleDefinition', resourceId: row.id });
    return reply.code(201).send(row);
  });

  app.patch('/roles/:id', { preHandler: writeRoles }, async request => {
    const { id } = idParam.parse(request.params);
    const input = roleUpdate.parse(request.body);
    const existing = await db.roleDefinition.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Role not found');
    const row = await db.roleDefinition.update({ where: { id }, data: input });
    await audit(request, { action: 'role.updated', resource: 'roleDefinition', resourceId: id });
    return row;
  });

  app.delete('/roles/:id', { preHandler: writeRoles }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const existing = await db.roleDefinition.findFirst({ where: { id, tenantId: request.auth.tenantId } });
    if (!existing) throw app.httpErrors.notFound('Role not found');
    await db.roleDefinition.delete({ where: { id } });
    await audit(request, { action: 'role.deleted', resource: 'roleDefinition', resourceId: id });
    return reply.code(204).send();
  });
};
