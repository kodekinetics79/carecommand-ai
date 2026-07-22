import { db } from '../db';
import type { Prisma } from '../../generated/prisma/client';

// ═══════════════════════════════════════════════════════════════════════════
// RPM PROACTIVE SAFETY NET — runtime detectors (P0)
//
// Two detectors that turn previously-dead columns into live safety signals:
//   1) MISSED READINGS — a patient enrolled in remote monitoring whose last
//      valid reading is older than the expected cadence (MonitoringRule.
//      missedAfterHours) gets a `missed_reading` ReadingAlert.
//   2) DEVICE OFFLINE — a device whose last activity (lastSeenAt / last reading)
//      exceeds a staleness threshold is flipped to `offline` and raises a
//      `device_offline` ReadingAlert.
//
// Both are IDEMPOTENT: they never duplicate an already-open alert, and the
// device flip only fires on a real online→offline transition. Pure, queue-
// agnostic functions so BullMQ can drive them and tests can call them directly.
// Every read/write is explicitly scoped by tenantId (these tables are not RLS-
// enabled). System-actor writes are recorded in the append-only AuditEvent,
// mirroring the compliance worker's pattern.
// ═══════════════════════════════════════════════════════════════════════════

// Default device staleness threshold when no per-rule cadence applies. A device
// silent for this long is treated as offline until it reports again.
export const DEVICE_OFFLINE_AFTER_HOURS = 24;

const OPEN_STATUSES = ['open', 'acknowledged', 'assigned'];

async function tenantIds(only?: string): Promise<string[]> {
  if (only) return [only];
  return (await db.tenant.findMany({ select: { id: true } })).map(t => t.id);
}

// Jobs have no request context, so they write AuditEvent directly (actorUserId
// null = system actor) — mirroring the compliance/autopilot worker audit pattern.
async function auditJob(tenantId: string, action: string, resourceId: string | null, metadata?: Prisma.InputJsonObject) {
  await db.auditEvent.create({
    data: { tenantId, actorUserId: null, action, resource: 'readingAlert', resourceId: resourceId ?? undefined, userAgent: 'monitoring-safety-job', metadata },
  }).catch(() => {});
}

/**
 * Resolve the expected reading cadence (missedAfterHours) for a patient from the
 * most specific active MonitoringRule. Precedence: patient > branch > org. Rules
 * without a missedAfterHours are ignored (no cadence configured → not our call).
 */
export async function resolveMissedAfterHours(tenantId: string, patientId: string, branchId: string | null): Promise<number | null> {
  const rules = await db.monitoringRule.findMany({
    where: { tenantId, active: true, missedAfterHours: { not: null } },
    select: { scope: true, patientId: true, branchId: true, missedAfterHours: true, priority: true },
  });
  const score = (r: typeof rules[number]): number => {
    if (r.scope === 'patient' && r.patientId && r.patientId === patientId) return 3;
    if (r.scope === 'branch' && r.branchId && r.branchId === branchId) return 2;
    if (r.scope === 'organization') return 1;
    return 0;
  };
  const best = rules.map(r => ({ r, s: score(r) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s || b.r.priority - a.r.priority)[0]?.r;
  return best?.missedAfterHours ?? null;
}

export interface MissedReadingResult { checked: number; created: number; alerts: string[] }

/**
 * Detect enrolled patients whose latest valid reading has exceeded their
 * expected cadence and raise one open `missed_reading` alert each. Idempotent:
 * a patient with an already-open missed_reading alert is skipped.
 */
export async function detectMissedReadings(only?: string, now = new Date()): Promise<MissedReadingResult> {
  const result: MissedReadingResult = { checked: 0, created: 0, alerts: [] };
  for (const tenantId of await tenantIds(only)) {
    const enrollments = await db.patientDeviceEnrollment.findMany({
      where: { tenantId, status: 'active' },
      select: { patientId: true, branchId: true, enrolledAt: true },
    });
    // One check per patient even if enrolled with multiple providers.
    const seen = new Set<string>();
    for (const enr of enrollments) {
      if (seen.has(enr.patientId)) continue;
      seen.add(enr.patientId);
      const missedAfterHours = await resolveMissedAfterHours(tenantId, enr.patientId, enr.branchId);
      if (!missedAfterHours || missedAfterHours <= 0) continue; // no cadence configured
      result.checked++;

      const last = await db.deviceReading.findFirst({
        where: { tenantId, patientId: enr.patientId, validationStatus: 'valid' },
        orderBy: { capturedAt: 'desc' },
        select: { capturedAt: true },
      });
      const lastActivity = last?.capturedAt ?? enr.enrolledAt;
      const hoursSince = (now.getTime() - lastActivity.getTime()) / 36e5;
      if (hoursSince < missedAfterHours) continue;

      // Idempotent — never stack a second open missed_reading alert.
      const openExisting = await db.readingAlert.findFirst({
        where: { tenantId, patientId: enr.patientId, alertType: 'missed_reading', status: { in: OPEN_STATUSES } },
        select: { id: true },
      });
      if (openExisting) continue;

      const reason = last
        ? `No valid reading in ${Math.floor(hoursSince)}h (expected at least every ${missedAfterHours}h). Outreach to capture the missed reading.`
        : `No reading since enrollment ${Math.floor(hoursSince)}h ago (expected at least every ${missedAfterHours}h). Outreach to capture the first reading.`;
      const alert = await db.readingAlert.create({
        data: { tenantId, patientId: enr.patientId, branchId: enr.branchId, severity: 'high', alertType: 'missed_reading', status: 'open', generatedReason: reason },
        select: { id: true },
      });
      // Route to the nurse queue (staff notification — consent not required).
      await db.notificationEvent.create({
        data: { tenantId, alertId: alert.id, patientId: enr.patientId, recipientType: 'nurse', recipientLabel: 'nurse queue', channel: 'in_app', status: 'sent', attempts: 1, consentChecked: true, consentResult: 'not_required', sentAt: new Date() },
      }).catch(() => {});
      await auditJob(tenantId, 'monitoring.missed_reading.detected', alert.id, { patientId: enr.patientId, missedAfterHours, hoursSince: Math.floor(hoursSince) });
      result.created++;
      result.alerts.push(alert.id);
    }
  }
  return result;
}

export interface OfflineDeviceResult { checked: number; flipped: number; created: number; alerts: string[] }

/**
 * Detect devices whose last activity exceeds the staleness threshold, flip
 * online→offline, and raise one open `device_offline` alert each. Idempotent:
 * a device already offline/error is not re-flipped and an already-open
 * device_offline alert is not duplicated.
 */
export async function detectOfflineDevices(only?: string, offlineAfterHours = DEVICE_OFFLINE_AFTER_HOURS, now = new Date()): Promise<OfflineDeviceResult> {
  const result: OfflineDeviceResult = { checked: 0, flipped: 0, created: 0, alerts: [] };
  const cutoff = new Date(now.getTime() - offlineAfterHours * 36e5);
  for (const tenantId of await tenantIds(only)) {
    // Only devices currently believed healthy can transition to offline.
    const devices = await db.device.findMany({
      where: { tenantId, active: true, status: { in: ['online', 'pending'] } },
      select: { id: true, name: true, branchId: true, status: true, lastSeenAt: true },
    });
    for (const device of devices) {
      result.checked++;
      // Last activity = the newer of lastSeenAt and the device's latest reading.
      const lastReading = await db.deviceReading.findFirst({
        where: { tenantId, deviceId: device.id },
        orderBy: { capturedAt: 'desc' },
        select: { capturedAt: true },
      });
      const stamps = [device.lastSeenAt, lastReading?.capturedAt].filter((d): d is Date => !!d);
      const lastActivity = stamps.length ? new Date(Math.max(...stamps.map(d => d.getTime()))) : null;
      // A device that has NEVER reported (no lastSeenAt, no reading) is not
      // "offline" — it never came online. Skip until it produces a first signal.
      if (!lastActivity) continue;
      if (lastActivity > cutoff) continue; // still fresh

      const hoursSince = Math.floor((now.getTime() - lastActivity.getTime()) / 36e5);
      // Flip status (idempotent: only from online/pending).
      await db.device.update({ where: { id: device.id }, data: { status: 'offline' } });
      await db.deviceEvent.create({
        data: { tenantId, deviceId: device.id, type: 'status_changed', fromStatus: device.status, toStatus: 'offline', message: `Auto-marked offline — no activity in ${hoursSince}h (threshold ${offlineAfterHours}h).` },
      }).catch(() => {});
      result.flipped++;

      // Idempotent alert — never stack a second open device_offline alert.
      const openExisting = await db.readingAlert.findFirst({
        where: { tenantId, deviceId: device.id, alertType: 'device_offline', status: { in: OPEN_STATUSES } },
        select: { id: true },
      });
      if (openExisting) continue;
      const alert = await db.readingAlert.create({
        data: { tenantId, deviceId: device.id, branchId: device.branchId, severity: 'high', alertType: 'device_offline', status: 'open', generatedReason: `${device.name} offline — no activity in ${hoursSince}h (threshold ${offlineAfterHours}h). Check the device/connection.` },
        select: { id: true },
      });
      await auditJob(tenantId, 'monitoring.device_offline.detected', alert.id, { deviceId: device.id, hoursSince, offlineAfterHours });
      result.created++;
      result.alerts.push(alert.id);
    }
  }
  return result;
}
