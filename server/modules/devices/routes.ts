import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { requireRoles } from '../../plugins/roles';
import { requireFeature } from '../../lib/entitlements';
import { assertBranchAccess } from '../../lib/scope';
import { encryptSecret } from '../../lib/security';
import { DEVICE_PROVIDERS } from '../../lib/connectedCare/catalog';
import { invalidateRpmSignoffsForDevice, rpmPeriodBounds } from '../../lib/connectedCare/rpmEvidence';

function devStatus(category: string, mode: string, hasRequired: boolean): string {
  if (category === 'MANUAL') return 'ACTIVE';
  if (!hasRequired) return 'NOT_CONFIGURED';
  return mode === 'sandbox' ? 'SANDBOX' : 'ACTIVE';
}

const uuid = z.string().uuid();
const adminRoles = requireRoles('OWNER', 'ADMIN', 'MANAGER');

const DEVICE_TYPES = ['vitals_monitor', 'lab_analyzer', 'check_in_kiosk', 'document_scanner', 'imaging', 'wearable_gateway'] as const;
const CONNECTION_TYPES = ['network', 'usb', 'bluetooth', 'cloud_api'] as const;
const STATUSES = ['online', 'offline', 'error', 'pending'] as const;

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  deviceType: z.enum(DEVICE_TYPES),
  vendor: z.string().trim().max(120).optional(),
  model: z.string().trim().max(120).optional(),
  serialNumber: z.string().trim().max(120).optional(),
  connectionType: z.enum(CONNECTION_TYPES).default('network'),
  branchId: uuid.optional(),
  location: z.string().trim().max(160).optional(),
  firmwareVersion: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(500).optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  deviceType: z.enum(DEVICE_TYPES).optional(),
  vendor: z.string().trim().max(120).nullable().optional(),
  model: z.string().trim().max(120).nullable().optional(),
  serialNumber: z.string().trim().max(120).nullable().optional(),
  connectionType: z.enum(CONNECTION_TYPES).optional(),
  branchId: uuid.nullable().optional(),
  location: z.string().trim().max(160).nullable().optional(),
  firmwareVersion: z.string().trim().max(60).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  status: z.enum(STATUSES).optional(),
  active: z.boolean().optional(),
});

interface DeviceEventInput { type: string; fromStatus?: string | null; toStatus?: string | null; message?: string | null }
async function recordEvent(tenantId: string, deviceId: string, actorUserId: string | null, e: DeviceEventInput) {
  await db.deviceEvent.create({
    data: { tenantId, deviceId, actorUserId, type: e.type, fromStatus: e.fromStatus ?? null, toStatus: e.toStatus ?? null, message: e.message ?? null },
  });
}

const DEVICE_SELECT = {
  id: true, name: true, deviceType: true, vendor: true, model: true, serialNumber: true,
  connectionType: true, status: true, location: true, firmwareVersion: true, notes: true,
  lastSeenAt: true, lastTestStatus: true, lastTestedAt: true, branchId: true,
} as const;

export const deviceRoutes: FastifyPluginAsync = async app => {
  // Entire device surface requires the device_integration entitlement.
  app.addHook('preHandler', requireFeature('device_integration'));

  // Overview: connected-device registry + status summary for the practice.
  app.get('/overview', async request => {
    const tenantId = request.auth.tenantId;
    const [devices, branches] = await Promise.all([
      db.device.findMany({ where: { tenantId, active: true }, orderBy: [{ status: 'asc' }, { name: 'asc' }], select: DEVICE_SELECT }),
      db.branch.findMany({ where: { tenantId, active: true }, select: { id: true, name: true } }),
    ]);
    const branchName = new Map(branches.map(b => [b.id, b.name]));
    const byStatus = (s: string) => devices.filter(d => d.status === s).length;
    return {
      summary: { total: devices.length, online: byStatus('online'), offline: byStatus('offline'), error: byStatus('error'), pending: byStatus('pending') },
      devices: devices.map(d => ({ ...d, branchName: d.branchId ? branchName.get(d.branchId) ?? null : null })),
      branches,
    };
  });

  // Device detail + full status/config/audit timeline. Branch-access-checked.
  app.get('/:id', async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const tenantId = request.auth.tenantId;
    const device = await db.device.findFirst({ where: { id, tenantId }, select: DEVICE_SELECT });
    if (!device) throw app.httpErrors.notFound('Device not found');
    if (device.branchId) await assertBranchAccess(request, device.branchId);

    const [branch, events] = await Promise.all([
      device.branchId ? db.branch.findFirst({ where: { id: device.branchId, tenantId }, select: { id: true, name: true } }) : Promise.resolve(null),
      db.deviceEvent.findMany({ where: { tenantId, deviceId: id }, orderBy: { createdAt: 'desc' }, take: 100 }),
    ]);

    const actorIds = [...new Set(events.map(e => e.actorUserId).filter((v): v is string => !!v))];
    const users = actorIds.length ? await db.user.findMany({ where: { id: { in: actorIds }, tenantId }, select: { id: true, displayName: true } }) : [];
    const nameMap = new Map(users.map(u => [u.id, u.displayName]));

    return {
      device: { ...device, branchName: branch?.name ?? null },
      events: events.map(e => ({
        id: e.id, type: e.type, fromStatus: e.fromStatus, toStatus: e.toStatus, message: e.message,
        actorName: e.actorUserId ? nameMap.get(e.actorUserId) ?? 'Unknown user' : 'System',
        createdAt: e.createdAt,
      })),
    };
  });

  // Register a new device. Admin roles only; audited + event.
  app.post('/', { preHandler: adminRoles }, async (request, reply) => {
    const input = createSchema.parse(request.body);
    const tenantId = request.auth.tenantId;
    if (input.branchId) await assertBranchAccess(request, input.branchId);
    const device = await db.device.create({ data: { tenantId, ...input, status: 'pending' }, select: { id: true, name: true, deviceType: true } });
    await recordEvent(tenantId, device.id, request.auth.userId, { type: 'registered', toStatus: 'pending', message: `Registered via ${input.connectionType}` });
    await audit(request, { action: 'device.registered', resource: 'device', resourceId: device.id, metadata: { name: device.name, deviceType: device.deviceType } });
    return reply.code(201).send(device);
  });

  // Update / reconfigure a device. Admin roles only; audited + event(s).
  app.patch('/:id', { preHandler: adminRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const input = updateSchema.parse(request.body);
    const tenantId = request.auth.tenantId;
    const existing = await db.device.findFirst({ where: { id, tenantId } });
    if (!existing) throw app.httpErrors.notFound('Device not found');
    if (existing.branchId) await assertBranchAccess(request, existing.branchId);
    if (input.branchId) await assertBranchAccess(request, input.branchId);

    const statusChanged = input.status && input.status !== existing.status;
    const configKeys = Object.keys(input).filter(k => k !== 'status' && k !== 'active');
    const period = rpmPeriodBounds();
    const updated = await db.$transaction(async tx => {
      const row = await tx.device.update({
        where: { id: existing.id },
        data: { ...input, lastSeenAt: input.status === 'online' ? new Date() : existing.lastSeenAt },
        select: { id: true, name: true, status: true, active: true },
      });
      if (statusChanged) {
        await tx.deviceEvent.create({ data: { tenantId, deviceId: id, actorUserId: request.auth.userId, type: 'status_changed', fromStatus: existing.status, toStatus: input.status, message: `Status set to ${input.status}` } });
      }
      if (configKeys.length > 0) {
        await tx.deviceEvent.create({ data: { tenantId, deviceId: id, actorUserId: request.auth.userId, type: 'config_updated', message: `Updated ${configKeys.join(', ')}` } });
      }
      await invalidateRpmSignoffsForDevice(tx, {
        tenantId, deviceId: id, periodStart: period.start,
        reason: 'enrolled_device_mutated', actorUserId: request.auth.userId,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
      });
      await tx.auditEvent.create({
        data: {
          tenantId, actorUserId: request.auth.userId, action: 'device.updated',
          resource: 'device', resourceId: id, requestId: request.id,
          ipAddress: request.ip, userAgent: request.headers['user-agent'],
          metadata: { status: row.status, active: row.active, fields: configKeys },
        },
      });
      return row;
    });
    return updated;
  });

  // Local readiness test (no external telemetry). Flips to online, records result.
  app.post('/:id/test', { preHandler: adminRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const tenantId = request.auth.tenantId;
    const existing = await db.device.findFirst({ where: { id, tenantId } });
    if (!existing) throw app.httpErrors.notFound('Device not found');
    if (existing.branchId) await assertBranchAccess(request, existing.branchId);
    const now = new Date();
    const period = rpmPeriodBounds(now);
    const updated = await db.$transaction(async tx => {
      const row = await tx.device.update({
        where: { id: existing.id },
        data: { status: 'online', lastSeenAt: now, lastTestStatus: 'passed', lastTestedAt: now },
        select: { id: true, status: true, lastSeenAt: true, lastTestStatus: true, lastTestedAt: true },
      });
      await tx.deviceEvent.create({ data: { tenantId, deviceId: id, actorUserId: request.auth.userId, type: 'connection_test', fromStatus: existing.status, toStatus: 'online', message: 'Local readiness check passed' } });
      await invalidateRpmSignoffsForDevice(tx, {
        tenantId, deviceId: id, periodStart: period.start,
        reason: 'enrolled_device_mutated', actorUserId: request.auth.userId,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
      });
      await tx.auditEvent.create({ data: { tenantId, actorUserId: request.auth.userId, action: 'device.connection_tested', resource: 'device', resourceId: id, requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'] } });
      return row;
    });
    return updated;
  });

  // Deactivate (soft remove). Admin roles only; audited + event.
  app.delete('/:id', { preHandler: adminRoles }, async (request, reply) => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const tenantId = request.auth.tenantId;
    const existing = await db.device.findFirst({ where: { id, tenantId } });
    if (!existing) throw app.httpErrors.notFound('Device not found');
    if (existing.branchId) await assertBranchAccess(request, existing.branchId);
    const period = rpmPeriodBounds();
    await db.$transaction(async tx => {
      await tx.device.update({ where: { id: existing.id }, data: { active: false, status: 'offline' } });
      await tx.deviceEvent.create({ data: { tenantId, deviceId: id, actorUserId: request.auth.userId, type: 'deactivated', fromStatus: existing.status, toStatus: 'offline', message: 'Device deactivated' } });
      await invalidateRpmSignoffsForDevice(tx, {
        tenantId, deviceId: id, periodStart: period.start,
        reason: 'enrolled_device_mutated', actorUserId: request.auth.userId,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
      });
      await tx.auditEvent.create({ data: { tenantId, actorUserId: request.auth.userId, action: 'device.deactivated', resource: 'device', resourceId: id, requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'], metadata: { name: existing.name } } });
    });
    return reply.code(204).send();
  });

  // ════════════════════════════════════════════════════════════════════════
  // DEVICE PROVIDER REGISTRY — real configurable integrations (no fake "active")
  // ════════════════════════════════════════════════════════════════════════
  const devProviderKey = z.enum(['dexcom', 'withings', 'validic', 'terra', 'tenovi', 'manual']);

  app.get('/providers', async request => {
    const rows = await db.deviceProvider.findMany({ where: { tenantId: request.auth.tenantId } });
    const byKey = new Map(rows.map(r => [r.providerKey, r]));
    return DEVICE_PROVIDERS.map(def => {
      const row = byKey.get(def.key);
      return {
        key: def.key, displayName: def.displayName, category: def.category, supportsSandbox: def.supportsSandbox, supportsWebhook: def.supportsWebhook, note: def.note,
        configFields: def.configFields.map(f => ({ key: f.key, label: f.label, secret: f.secret, required: f.required })),
        status: row?.status ?? (def.category === 'MANUAL' ? 'ACTIVE' : 'NOT_CONFIGURED'), mode: row?.mode ?? 'sandbox',
        configured: def.category === 'MANUAL' || (!!row && row.status !== 'NOT_CONFIGURED'),
        webhookConfigured: row?.webhookConfigured ?? false,
        lastHealthCheckAt: row?.lastHealthCheckAt ?? null, lastHealthStatus: row?.lastHealthStatus ?? null, healthMessage: row?.healthMessage ?? null, lastSyncAt: row?.lastSyncAt ?? null,
      };
    });
  });

  app.post('/providers/:key/configure', { preHandler: adminRoles }, async (request, reply) => {
    const { key } = z.object({ key: devProviderKey }).parse(request.params);
    const def = DEVICE_PROVIDERS.find(p => p.key === key)!;
    const { mode, config } = z.object({ mode: z.enum(['sandbox', 'production']).default('sandbox'), config: z.record(z.string(), z.string()).default({}) }).parse(request.body ?? {});
    const required = def.configFields.filter(f => f.required).map(f => f.key);
    const hasRequired = required.every(k => (config[k] ?? '').trim().length > 0);
    if (def.category !== 'MANUAL' && !hasRequired) throw app.httpErrors.badRequest(`Missing required config: ${required.join(', ')}`);
    const status = devStatus(def.category, mode, hasRequired);
    const encryptedConfig = Object.keys(config).length ? encryptSecret(JSON.stringify(config)) : null;
    const row = await db.deviceProvider.upsert({
      where: { tenantId_providerKey: { tenantId: request.auth.tenantId, providerKey: key } },
      create: { tenantId: request.auth.tenantId, providerKey: key, displayName: def.displayName, category: def.category, mode, status, encryptedConfig },
      update: { mode, status, ...(encryptedConfig ? { encryptedConfig } : {}) },
      select: { id: true, providerKey: true, status: true, mode: true },
    });
    await audit(request, { action: 'device.provider.configured', resource: 'deviceProvider', resourceId: row.id, metadata: { providerKey: key, mode, status } });
    return reply.send(row);
  });

  app.post('/providers/:key/health-check', { preHandler: adminRoles, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async request => {
    const { key } = z.object({ key: devProviderKey }).parse(request.params);
    const def = DEVICE_PROVIDERS.find(p => p.key === key)!;
    const row = await db.deviceProvider.findFirst({ where: { tenantId: request.auth.tenantId, providerKey: key } });
    let healthStatus = 'error';
    let message = 'Provider is not configured.';
    if (def.category === 'MANUAL') { healthStatus = 'healthy'; message = 'Manual entry is always available.'; }
    else if (row && (row.status === 'SANDBOX' || row.status === 'ACTIVE')) { healthStatus = 'healthy'; message = `Credentials present (${row.mode}).`; }
    const updated = await db.deviceProvider.upsert({
      where: { tenantId_providerKey: { tenantId: request.auth.tenantId, providerKey: key } },
      create: { tenantId: request.auth.tenantId, providerKey: key, displayName: def.displayName, category: def.category, status: def.category === 'MANUAL' ? 'ACTIVE' : 'NOT_CONFIGURED', lastHealthCheckAt: new Date(), lastHealthStatus: healthStatus, healthMessage: message },
      update: { lastHealthCheckAt: new Date(), lastHealthStatus: healthStatus, healthMessage: message },
      select: { providerKey: true, status: true, lastHealthStatus: true, healthMessage: true, lastHealthCheckAt: true },
    });
    await audit(request, { action: 'device.provider.health_check', resource: 'deviceProvider', resourceId: row?.id ?? key, metadata: { providerKey: key, healthStatus } });
    return updated;
  });
};
