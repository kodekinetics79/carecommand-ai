import { db } from '../db';
import type { Prisma } from '../../generated/prisma/client';
import { forEachActiveJobTenant } from '../jobTenantResolver';
import { severityRank } from '../monitoring';
import { MONITORING_ALERT_SOURCE } from './alertInbox';
import {
  invalidateRpmProviderSignoff,
  lockRpmEvidenceForDevice,
  rpmPeriodBounds,
} from './rpmEvidence';

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

type SafetyTx = Prisma.TransactionClient;

async function accountableStaff(tx: SafetyTx, tenantId: string, branchId: string | null) {
  return tx.user.findFirst({
    where: {
      tenantId,
      active: true,
      role: { in: ['PROVIDER', 'MANAGER', 'ADMIN', 'OWNER'] },
      ...(branchId ? { OR: [{ branchId }, { role: { in: ['ADMIN', 'OWNER'] } }] } : {}),
    },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, displayName: true, role: true },
  });
}

async function queueStaffNotification(
  tx: SafetyTx,
  input: { tenantId: string; alertId: string; patientId?: string | null; branchId: string | null },
) {
  const recipient = await accountableStaff(tx, input.tenantId, input.branchId);
  await tx.notificationEvent.create({
    data: {
      tenantId: input.tenantId,
      alertId: input.alertId,
      patientId: input.patientId ?? null,
      recipientType: recipient?.role.toLowerCase() ?? 'unassigned_staff',
      recipientUserId: recipient?.id ?? null,
      recipientLabel: recipient?.displayName ?? 'unassigned clinical safety queue',
      channel: 'in_app',
      source: MONITORING_ALERT_SOURCE,
      status: 'queued',
      attempts: 0,
      consentChecked: true,
      consentResult: 'not_required',
    },
  });
  return recipient?.id ?? null;
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
  await forEachActiveJobTenant(only, 'worker:monitoring:missed-readings', async tenantId => {
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

      const created = await db.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${'missed:' + enr.patientId}))`;
        const currentEnrollment = await tx.patientDeviceEnrollment.findFirst({
          where: { tenantId, patientId: enr.patientId, status: 'active' },
          orderBy: { enrolledAt: 'asc' },
          select: { enrolledAt: true, branchId: true },
        });
        if (!currentEnrollment) return null;
        const last = await tx.deviceReading.findFirst({
          where: { tenantId, patientId: enr.patientId, validationStatus: 'valid' },
          orderBy: { capturedAt: 'desc' },
          select: { capturedAt: true },
        });
        const lastActivity = last?.capturedAt ?? currentEnrollment.enrolledAt;
        const hoursSince = (now.getTime() - lastActivity.getTime()) / 36e5;
        if (hoursSince < missedAfterHours) return null;
        const openExisting = await tx.readingAlert.findFirst({
          where: { tenantId, patientId: enr.patientId, alertType: 'missed_reading', status: { in: OPEN_STATUSES } },
          select: { id: true },
        });
        if (openExisting) return null;
        const reason = last
          ? `No valid reading in ${Math.floor(hoursSince)}h (expected at least every ${missedAfterHours}h). Outreach to capture the missed reading.`
          : `No reading since enrollment ${Math.floor(hoursSince)}h ago (expected at least every ${missedAfterHours}h). Outreach to capture the first reading.`;
        const alert = await tx.readingAlert.create({
          data: { tenantId, patientId: enr.patientId, branchId: currentEnrollment.branchId, severity: 'high', severityRank: severityRank('high'), alertType: 'missed_reading', status: 'open', generatedReason: reason },
          select: { id: true },
        });
        const recipientUserId = await queueStaffNotification(tx, { tenantId, alertId: alert.id, patientId: enr.patientId, branchId: currentEnrollment.branchId });
        await tx.auditEvent.create({
          data: { tenantId, actorUserId: null, action: 'monitoring.missed_reading.detected', resource: 'readingAlert', resourceId: alert.id, userAgent: 'monitoring-safety-job', metadata: { patientId: enr.patientId, missedAfterHours, hoursSince: Math.floor(hoursSince), recipientUserId } },
        });
        return alert.id;
      });
      if (created) {
        result.created++;
        result.alerts.push(created);
      }
    }
  });
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
  const rpmPeriod = rpmPeriodBounds(now);
  await forEachActiveJobTenant(only, 'worker:monitoring:offline-devices', async tenantId => {
    // Only devices currently believed healthy can transition to offline.
    const devices = await db.device.findMany({
      where: { tenantId, active: true, status: { in: ['online', 'pending'] } },
      select: { id: true, name: true, branchId: true, status: true, lastSeenAt: true },
    });
    for (const device of devices) {
      result.checked++;
      const outcome = await db.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${'offline:' + device.id}))`;
        const current = await tx.device.findFirst({
          where: { id: device.id, tenantId, active: true, status: { in: ['online', 'pending'] } },
          select: { id: true, name: true, branchId: true, status: true, lastSeenAt: true },
        });
        if (!current) return null;
        const lastReading = await tx.deviceReading.findFirst({ where: { tenantId, deviceId: current.id }, orderBy: { capturedAt: 'desc' }, select: { capturedAt: true } });
        const stamps = [current.lastSeenAt, lastReading?.capturedAt].filter((d): d is Date => !!d);
        const lastActivity = stamps.length ? new Date(Math.max(...stamps.map(d => d.getTime()))) : null;
        if (!lastActivity || lastActivity > cutoff) return null;
        const hoursSince = Math.floor((now.getTime() - lastActivity.getTime()) / 36e5);
        // Acquire every enrolled patient's RPM evidence lock before changing
        // Device.status. Provider signoff uses the same locks, so it must see
        // either the complete pre-mutation or complete post-mutation snapshot.
        const rpmPatientIds = await lockRpmEvidenceForDevice(tx, tenantId, current.id, rpmPeriod.start);
        const changed = await tx.device.updateMany({ where: { id: current.id, tenantId, status: current.status }, data: { status: 'offline' } });
        if (changed.count !== 1) return null;
        for (const patientId of rpmPatientIds) {
          await invalidateRpmProviderSignoff(tx, {
            tenantId, patientId, periodStart: rpmPeriod.start,
            reason: 'offline_detector_device_status_mutated', actorUserId: null,
            userAgent: 'monitoring-safety-job', mutationResourceId: current.id,
          });
        }
        await tx.deviceEvent.create({
          data: { tenantId, deviceId: current.id, type: 'status_changed', fromStatus: current.status, toStatus: 'offline', message: `Auto-marked offline — no activity in ${hoursSince}h (threshold ${offlineAfterHours}h).` },
        });
        const openExisting = await tx.readingAlert.findFirst({
          where: { tenantId, deviceId: current.id, alertType: 'device_offline', status: { in: OPEN_STATUSES } },
          select: { id: true },
        });
        if (openExisting) {
          await tx.auditEvent.create({ data: { tenantId, actorUserId: null, action: 'monitoring.device_offline.detected', resource: 'readingAlert', resourceId: openExisting.id, userAgent: 'monitoring-safety-job', metadata: { deviceId: current.id, hoursSince, offlineAfterHours, existingAlert: true } } });
          return { alertId: null, flipped: true };
        }
        const alert = await tx.readingAlert.create({
          data: { tenantId, deviceId: current.id, branchId: current.branchId, severity: 'high', severityRank: severityRank('high'), alertType: 'device_offline', status: 'open', generatedReason: `${current.name} offline — no activity in ${hoursSince}h (threshold ${offlineAfterHours}h). Check the device/connection.` },
          select: { id: true },
        });
        const recipientUserId = await queueStaffNotification(tx, { tenantId, alertId: alert.id, branchId: current.branchId });
        await tx.auditEvent.create({ data: { tenantId, actorUserId: null, action: 'monitoring.device_offline.detected', resource: 'readingAlert', resourceId: alert.id, userAgent: 'monitoring-safety-job', metadata: { deviceId: current.id, hoursSince, offlineAfterHours, recipientUserId } } });
        return { alertId: alert.id, flipped: true };
      });
      if (outcome?.flipped) result.flipped++;
      if (outcome?.alertId) {
        result.created++;
        result.alerts.push(outcome.alertId);
      }
    }
  });
  return result;
}
