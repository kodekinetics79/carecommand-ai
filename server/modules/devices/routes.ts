import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../../lib/db';
import { audit } from '../../lib/audit';
import { requireRoles } from '../../plugins/roles';
import { requireFeature } from '../../lib/entitlements';
import { assertBranchAccess } from '../../lib/scope';
import { encryptSecret, decryptSecret } from '../../lib/security';
import { DEVICE_PROVIDERS } from '../../lib/connectedCare/catalog';
import { invalidateRpmSignoffsForDevice, rpmPeriodBounds } from '../../lib/connectedCare/rpmEvidence';
import { DEVICE_OFFLINE_AFTER_HOURS } from '../../lib/connectedCare/safetyDetection';
import { branchScope } from '../../lib/scope';

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
// A human may report that a device is BROKEN or RETIRED — both are observations
// about the physical world a person can genuinely make. Nobody can assert that a
// device is currently connected; that is only ever observed from telemetry.
// 'online' is therefore not settable through the API.
const HUMAN_SETTABLE_STATUSES = ['offline', 'error', 'pending'] as const;

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
  status: z.enum(HUMAN_SETTABLE_STATUSES).optional(),
  active: z.boolean().optional(),
});

interface DeviceEventInput { type: string; fromStatus?: string | null; toStatus?: string | null; message?: string | null }
async function recordEvent(tenantId: string, deviceId: string, actorUserId: string | null, e: DeviceEventInput) {
  await db.deviceEvent.create({
    data: { tenantId, deviceId, actorUserId, type: e.type, fromStatus: e.fromStatus ?? null, toStatus: e.toStatus ?? null, message: e.message ?? null },
  });
}

/**
 * Connectivity is DERIVED from observed activity, never read from the stored
 * column. The stored `status` is a human-settable field, so a staff member
 * could assert "online" from a dropdown and the registry would render it as
 * telemetry under a "Connected now" heading — a device last seen 71 days ago
 * showed a green Online badge next to its own contradicting timestamp.
 * A clinician reading that believes a patient is being monitored when nothing
 * is listening. Reachability is observed or it is unknown; it is never claimed.
 *
 * Correctness must not depend on the background offline-sweep worker running,
 * so this is computed on every read.
 */
export type Connectivity = 'reporting' | 'stale' | 'never_reported' | 'error' | 'retired';

export function deriveConnectivity(
  device: { status: string; active: boolean; lastSeenAt: Date | null },
  lastReadingAt: Date | null,
  now = new Date(),
  offlineAfterHours = DEVICE_OFFLINE_AFTER_HOURS,
): { connectivity: Connectivity; lastActivityAt: Date | null } {
  const candidates = [device.lastSeenAt, lastReadingAt].filter((d): d is Date => d instanceof Date);
  const lastActivityAt = candidates.length ? new Date(Math.max(...candidates.map(d => d.getTime()))) : null;
  if (!device.active) return { connectivity: 'retired', lastActivityAt };
  if (device.status === 'error') return { connectivity: 'error', lastActivityAt };
  // No observation has ever been made — "pending" is honest, "online" is not.
  if (!lastActivityAt) return { connectivity: 'never_reported', lastActivityAt };
  const staleAfter = now.getTime() - offlineAfterHours * 36e5;
  return { connectivity: lastActivityAt.getTime() >= staleAfter ? 'reporting' : 'stale', lastActivityAt };
}

const DEVICE_SELECT = {
  id: true, name: true, deviceType: true, vendor: true, model: true, serialNumber: true,
  connectionType: true, status: true, location: true, firmwareVersion: true, notes: true,
  lastSeenAt: true, lastTestStatus: true, lastTestedAt: true, branchId: true, active: true,
} as const;

export const deviceRoutes: FastifyPluginAsync = async app => {
  // Entire device surface requires the device_integration entitlement.
  app.addHook('preHandler', requireFeature('device_integration'));

  // Overview: connected-device registry + status summary for the practice.
  app.get('/overview', async request => {
    const tenantId = request.auth.tenantId;
    // Branch-scoped, matching the detail route. Without this a branch-restricted
    // user was refused GET /:id but had already received every device in every
    // branch — serial numbers included — from this list.
    const [devices, branches] = await Promise.all([
      db.device.findMany({ where: { tenantId, active: true, ...branchScope(request) }, orderBy: [{ status: 'asc' }, { name: 'asc' }], select: DEVICE_SELECT }),
      db.branch.findMany({ where: { tenantId, active: true }, select: { id: true, name: true } }),
    ]);
    const branchName = new Map(branches.map(b => [b.id, b.name]));

    // Newest reading per device — the other half of "has this thing spoken to
    // us recently", alongside lastSeenAt.
    const deviceIds = devices.map(d => d.id);
    const lastReadings = deviceIds.length
      ? await db.deviceReading.groupBy({
          by: ['deviceId'],
          where: { tenantId, deviceId: { in: deviceIds } },
          _max: { capturedAt: true },
        })
      : [];
    const lastReadingAt = new Map(lastReadings.map(r => [r.deviceId as string, r._max.capturedAt]));

    const now = new Date();
    const enriched = devices.map(d => {
      const { connectivity, lastActivityAt } = deriveConnectivity(d, lastReadingAt.get(d.id) ?? null, now);
      return {
        ...d,
        branchName: d.branchId ? branchName.get(d.branchId) ?? null : null,
        connectivity,
        lastActivityAt,
        offlineAfterHours: DEVICE_OFFLINE_AFTER_HOURS,
      };
    });
    const byConnectivity = (c: Connectivity) => enriched.filter(d => d.connectivity === c).length;
    return {
      summary: {
        total: enriched.length,
        reporting: byConnectivity('reporting'),
        stale: byConnectivity('stale'),
        neverReported: byConnectivity('never_reported'),
        error: byConnectivity('error'),
      },
      devices: enriched,
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
        // lastSeenAt is telemetry. It is stamped by ingest, never by an edit —
        // it previously moved to now() whenever a human picked "online", which
        // manufactured the very evidence the staleness check relies on.
        data: { ...input },
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

  // Local readiness test (no external telemetry). Evaluates whether the device
  // RECORD is complete enough to receive data. It must never claim the device is
  // reachable: `status` reflects real telemetry (lastSeenAt) and is not mutated
  // here. Previously this unconditionally wrote status='online' and
  // lastTestStatus='passed' without performing any check, which reported
  // unreachable devices as Online and inflated the RPM device-readiness count.
  app.post('/:id/test', { preHandler: adminRoles }, async request => {
    const { id } = z.object({ id: uuid }).parse(request.params);
    const tenantId = request.auth.tenantId;
    const existing = await db.device.findFirst({ where: { id, tenantId } });
    if (!existing) throw app.httpErrors.notFound('Device not found');
    if (existing.branchId) await assertBranchAccess(request, existing.branchId);
    const now = new Date();
    const period = rpmPeriodBounds(now);
    const readinessFailures: string[] = [];
    if (!existing.active) readinessFailures.push('device_inactive');
    if (!existing.branchId) readinessFailures.push('no_location_assigned');
    if (!existing.serialNumber) readinessFailures.push('no_serial_number');
    const passed = readinessFailures.length === 0;
    const message = passed
      ? 'Local readiness check passed. Device record is complete; reachability is not verified by this check.'
      : `Local readiness check failed: ${readinessFailures.join(', ')}.`;
    const updated = await db.$transaction(async tx => {
      const row = await tx.device.update({
        where: { id: existing.id },
        data: { lastTestStatus: passed ? 'passed' : 'failed', lastTestedAt: now },
        select: { id: true, status: true, lastSeenAt: true, lastTestStatus: true, lastTestedAt: true },
      });
      await tx.deviceEvent.create({ data: { tenantId, deviceId: id, actorUserId: request.auth.userId, type: 'connection_test', fromStatus: existing.status, toStatus: existing.status, message } });
      await invalidateRpmSignoffsForDevice(tx, {
        tenantId, deviceId: id, periodStart: period.start,
        reason: 'enrolled_device_mutated', actorUserId: request.auth.userId,
        requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'],
      });
      await tx.auditEvent.create({ data: { tenantId, actorUserId: request.auth.userId, action: 'device.connection_tested', resource: 'device', resourceId: id, requestId: request.id, ipAddress: request.ip, userAgent: request.headers['user-agent'] } });
      return row;
    });
    return { ...updated, readiness: { passed, failures: readinessFailures, reachabilityVerified: false } };
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

  // A verdict older than this is reported as stale rather than rendered as if it
  // were current. A health check describes the moment it ran, not forever.
  const HEALTH_VERDICT_TTL_HOURS = 24;

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
        // The UI must be able to tell "checked and fine" from "checked once,
        // months ago" without doing date arithmetic and getting it wrong.
        healthVerdictStale: row?.lastHealthCheckAt
          ? row.lastHealthCheckAt.getTime() < Date.now() - HEALTH_VERDICT_TTL_HOURS * 36e5
          : null,
        healthVerdictTtlHours: HEALTH_VERDICT_TTL_HOURS,
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
      // Clear the prior health verdict: it described the OLD credentials. Leaving
      // it in place produced "Health: healthy · checked 71d ago" in green next to
      // credentials that had since been replaced.
      update: { mode, status, ...(encryptedConfig ? { encryptedConfig } : {}), lastHealthCheckAt: null, lastHealthStatus: null, healthMessage: null },
      select: { id: true, providerKey: true, status: true, mode: true },
    });
    await audit(request, { action: 'device.provider.configured', resource: 'deviceProvider', resourceId: row.id, metadata: { providerKey: key, mode, status } });
    return reply.send(row);
  });

  app.post('/providers/:key/health-check', { preHandler: adminRoles, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async request => {
    const { key } = z.object({ key: devProviderKey }).parse(request.params);
    const def = DEVICE_PROVIDERS.find(p => p.key === key)!;
    const row = await db.deviceProvider.findFirst({ where: { tenantId: request.auth.tenantId, providerKey: key } });
    // TRUTHFULNESS: 'healthy' asserts this provider was reached. Nothing in this
    // process can reach one — there is no HTTP client on this path and no vendor
    // adapter yet. Reporting 'healthy' because a row exists whose status column
    // the same tenant wrote 30 seconds earlier told an admin, in green, that
    // their integration worked; they then enrolled patients against a connection
    // that had never been tested. Until a live adapter exists, the honest
    // verdict is 'unverified'.
    let healthStatus = 'error';
    let message = 'Provider is not configured.';
    if (def.category === 'MANUAL') {
      // Manual entry involves no third party — this one IS verifiable locally.
      healthStatus = 'healthy';
      message = 'Manual entry is always available — no external provider involved.';
    } else if (row && (row.status === 'SANDBOX' || row.status === 'ACTIVE')) {
      // Decrypt-and-parse is a real local check: it catches the silent failure
      // where a rotated encryption key leaves every stored credential unreadable
      // while the old code still reported 'healthy'.
      const decrypted = row.encryptedConfig ? decryptSecret(row.encryptedConfig) : null;
      let parsed: Record<string, unknown> | null = null;
      if (decrypted) { try { parsed = JSON.parse(decrypted) as Record<string, unknown>; } catch { parsed = null; } }
      if (!parsed) {
        healthStatus = 'error';
        message = 'Stored credentials cannot be decrypted. The application encryption key may have changed since they were saved — re-enter them.';
      } else {
        healthStatus = 'unverified';
        message = `Credentials stored and readable (${row.mode}). No live ${def.displayName} adapter exists yet, so reachability has never been tested.`;
      }
    }
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
