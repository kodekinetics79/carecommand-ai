import 'dotenv/config';
import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '../lib/db';
import { detectMissedReadings, detectOfflineDevices } from '../lib/connectedCare/safetyDetection';

// Proves the proactive RPM safety net actually DETECTS at runtime (missed
// readings + offline devices) — previously these alerts were seed-only. Uses
// isolated tenants and scopes every detector call with `only=tenantId` so the
// shared dev DB never leaks across tests.

const createdTenantIds: string[] = [];
const HOURS = 36e5;

async function makeTenant() {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `ms-${id.slice(0, 6)}`, slug: `ms-${id.slice(0, 8)}` } });
  createdTenantIds.push(id);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'b', location: 'x' } });
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'MS', lastName: 'Patient', lifecycleStage: 'NEW' } });
  return { id, branchId: branch.id, patientId: patient.id };
}

afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await db.$disconnect();
});

describe('missed-reading detection (P0 safety)', () => {
  it('flags a stale enrollment once, is idempotent on re-run, and ignores a fresh reading', async () => {
    const now = new Date('2026-07-21T12:00:00.000Z');
    const t = await makeTenant();
    // Cadence: expect a reading at least every 24h (org-scoped MonitoringRule).
    await db.monitoringRule.create({ data: { tenantId: t.id, scope: 'organization', readingType: 'glucose', missedAfterHours: 24, active: true } });
    await db.patientDeviceEnrollment.create({ data: { tenantId: t.id, patientId: t.patientId, branchId: t.branchId, providerKey: 'manual', status: 'active', enrolledAt: new Date(now.getTime() - 200 * HOURS) } });
    // Last valid reading was 48h ago → past the 24h cadence.
    await db.deviceReading.create({ data: { tenantId: t.id, patientId: t.patientId, readingType: 'glucose', value: '120', numericValue: 120, capturedAt: new Date(now.getTime() - 48 * HOURS), validationStatus: 'valid' } });

    const first = await detectMissedReadings(t.id, now);
    expect(first.checked).toBe(1);
    expect(first.created).toBe(1);
    expect(await db.readingAlert.count({ where: { tenantId: t.id, alertType: 'missed_reading', status: 'open' } })).toBe(1);

    // Idempotent — a second scan does not stack a duplicate open alert.
    const second = await detectMissedReadings(t.id, now);
    expect(second.created).toBe(0);
    expect(await db.readingAlert.count({ where: { tenantId: t.id, alertType: 'missed_reading' } })).toBe(1);
  });

  it('does NOT flag a patient whose last reading is within the cadence', async () => {
    const now = new Date('2026-07-21T12:00:00.000Z');
    const t = await makeTenant();
    await db.monitoringRule.create({ data: { tenantId: t.id, scope: 'organization', readingType: 'glucose', missedAfterHours: 24, active: true } });
    await db.patientDeviceEnrollment.create({ data: { tenantId: t.id, patientId: t.patientId, branchId: t.branchId, providerKey: 'manual', status: 'active', enrolledAt: new Date(now.getTime() - 200 * HOURS) } });
    await db.deviceReading.create({ data: { tenantId: t.id, patientId: t.patientId, readingType: 'glucose', value: '120', numericValue: 120, capturedAt: new Date(now.getTime() - 2 * HOURS), validationStatus: 'valid' } });

    const r = await detectMissedReadings(t.id, now);
    expect(r.checked).toBe(1);
    expect(r.created).toBe(0);
    expect(await db.readingAlert.count({ where: { tenantId: t.id, alertType: 'missed_reading' } })).toBe(0);
  });
});

describe('device-offline detection (P0 safety)', () => {
  it('flips a stale online device offline + raises one alert, is idempotent, and leaves fresh devices online', async () => {
    const now = new Date('2026-07-21T12:00:00.000Z');
    const t = await makeTenant();
    const stale = await db.device.create({ data: { tenantId: t.id, branchId: t.branchId, name: 'Stale Monitor', deviceType: 'vitals_monitor', status: 'online', active: true, lastSeenAt: new Date(now.getTime() - 48 * HOURS) } });
    const fresh = await db.device.create({ data: { tenantId: t.id, branchId: t.branchId, name: 'Fresh Monitor', deviceType: 'vitals_monitor', status: 'online', active: true, lastSeenAt: new Date(now.getTime() - 1 * HOURS) } });

    const first = await detectOfflineDevices(t.id, 24, now);
    expect(first.flipped).toBe(1);
    expect(first.created).toBe(1);
    expect((await db.device.findUnique({ where: { id: stale.id }, select: { status: true } }))?.status).toBe('offline');
    expect((await db.device.findUnique({ where: { id: fresh.id }, select: { status: true } }))?.status).toBe('online');
    expect(await db.readingAlert.count({ where: { tenantId: t.id, deviceId: stale.id, alertType: 'device_offline', status: 'open' } })).toBe(1);

    // Idempotent — already offline, so no re-flip and no duplicate alert.
    const second = await detectOfflineDevices(t.id, 24, now);
    expect(second.flipped).toBe(0);
    expect(second.created).toBe(0);
    expect(await db.readingAlert.count({ where: { tenantId: t.id, deviceId: stale.id, alertType: 'device_offline' } })).toBe(1);
  });
});
