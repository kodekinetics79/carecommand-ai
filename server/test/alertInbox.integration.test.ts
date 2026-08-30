import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

vi.mock('../workers/queues', () => ({
  redisConnection: {},
  autopilotQueue: { client: Promise.resolve(undefined), add: async () => undefined },
  enqueueAutopilotExecution: async () => undefined,
  complianceQueue: { add: async () => undefined },
  registerComplianceSchedules: async () => undefined,
  campaignQueue: { add: async () => undefined },
  registerCampaignSchedules: async () => undefined,
}));

const { buildApp } = await import('../app');
const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { recomputeEntitlements } = await import('../lib/entitlements');
const { MONITORING_ALERT_SOURCE } = await import('../lib/connectedCare/alertInbox');
const { detectMissedReadings } = await import('../lib/connectedCare/safetyDetection');

let app: FastifyInstance;
const createdTenantIds: string[] = [];

async function makeTenant() {
  const id = randomUUID();
  await db.tenant.create({ data: { id, name: `ai-${id.slice(0, 6)}`, slug: `ai-${id.slice(0, 8)}` } });
  createdTenantIds.push(id);
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan!.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id, db);
  const branch = await db.branch.create({ data: { tenantId: id, name: 'b', location: 'x' } });
  const nurse = await db.user.create({ data: { tenantId: id, branchId: branch.id, role: 'PROVIDER', active: true, email: `n-${id.slice(0, 8)}@t.test`, displayName: 'Nurse' } });
  const other = await db.user.create({ data: { tenantId: id, branchId: branch.id, role: 'PROVIDER', active: true, email: `o-${id.slice(0, 8)}@t.test`, displayName: 'Other' } });
  const patient = await db.patient.create({ data: { tenantId: id, branchId: branch.id, firstName: 'Inbox', lastName: 'Patient', lifecycleStage: 'NEW' } });
  return { id, branchId: branch.id, nurseId: nurse.id, otherId: other.id, patientId: patient.id };
}

const auth = (tenantId: string, userId: string) => ({
  authorization: `Bearer ${app.jwt.sign({ tenantId, userId, role: 'OWNER', type: 'access' })}`,
});

/** Raise a real alert with its notification, the way ingest does. */
async function raiseAlert(tenantId: string, branchId: string, patientId: string, recipientUserId: string | null) {
  const alert = await db.readingAlert.create({
    data: {
      tenantId, patientId, branchId, severity: 'critical', severityRank: 3,
      alertType: 'abnormal_reading', status: 'open',
      generatedReason: 'Glucose 412mg/dL is in the critical range. Doctor review needed.',
    },
  });
  await db.notificationEvent.create({
    data: {
      tenantId, alertId: alert.id, patientId,
      recipientType: 'provider', recipientUserId,
      recipientLabel: recipientUserId ? 'Nurse' : 'unassigned clinical safety queue',
      channel: 'in_app', source: MONITORING_ALERT_SOURCE, status: 'queued', attempts: 0,
      consentChecked: true, consentResult: 'not_required',
    },
  });
  return alert;
}

beforeAll(async () => { app = await buildApp(); await app.ready(); });
afterAll(async () => {
  for (const id of createdTenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app.close();
});

describe('alert inbox — alerts that actually reach a clinician', () => {
  it('delivers a queued alert to its recipient and records that it arrived', async () => {
    const t = await makeTenant();
    const alert = await raiseAlert(t.id, t.branchId, t.patientId, t.nurseId);

    // The row starts unseen. Nothing anywhere used to move it past this point.
    const before = await db.notificationEvent.findFirstOrThrow({ where: { tenantId: t.id, alertId: alert.id } });
    expect(before).toMatchObject({ status: 'queued', deliveredAt: null, acceptedAt: null });

    const res = await app.inject({ method: 'GET', url: '/v1/monitoring/notifications', headers: auth(t.id, t.nurseId) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { unseen: number; items: Array<{ alertId: string; severity: string; reason: string; addressedToMe: boolean }> };
    expect(body.unseen).toBe(1);
    expect(body.items).toHaveLength(1);

    // The inbox must say what happened, not merely that something did.
    expect(body.items[0]).toMatchObject({ alertId: alert.id, severity: 'critical', addressedToMe: true });
    expect(body.items[0].reason).toContain('critical range');

    // Reaching the recipient's inbox IS delivery for an in-app channel.
    const after = await db.notificationEvent.findFirstOrThrow({ where: { tenantId: t.id, alertId: alert.id } });
    expect(after.status).toBe('delivered');
    expect(after.deliveredAt).not.toBeNull();
    // Delivery is not acknowledgement: a human has not said they saw it yet.
    expect(after.acceptedAt).toBeNull();
  });

  it('records acknowledgement separately, and never rewrites the original delivery time', async () => {
    const t = await makeTenant();
    const alert = await raiseAlert(t.id, t.branchId, t.patientId, t.nurseId);
    await app.inject({ method: 'GET', url: '/v1/monitoring/notifications', headers: auth(t.id, t.nurseId) });
    const delivered = await db.notificationEvent.findFirstOrThrow({ where: { tenantId: t.id, alertId: alert.id } });
    const firstDeliveredAt = delivered.deliveredAt!;

    const ack = await app.inject({ method: 'POST', url: `/v1/monitoring/notifications/${delivered.id}/acknowledge`, headers: auth(t.id, t.nurseId) });
    expect(ack.statusCode).toBe(204);

    const acked = await db.notificationEvent.findFirstOrThrow({ where: { id: delivered.id } });
    expect(acked.acceptedAt).not.toBeNull();
    // The moment it actually arrived is the truthful one and must survive.
    expect(acked.deliveredAt?.toISOString()).toBe(firstDeliveredAt.toISOString());
  });

  it('does not hand one clinician another clinician\'s addressed alert', async () => {
    const t = await makeTenant();
    await raiseAlert(t.id, t.branchId, t.patientId, t.nurseId);

    const mine = await app.inject({ method: 'GET', url: '/v1/monitoring/notifications', headers: auth(t.id, t.nurseId) });
    expect((mine.json() as { items: unknown[] }).items).toHaveLength(1);

    const theirs = await app.inject({ method: 'GET', url: '/v1/monitoring/notifications', headers: auth(t.id, t.otherId) });
    expect((theirs.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it('surfaces an unaddressed alert to everyone rather than letting it vanish', async () => {
    const t = await makeTenant();
    // No accountable staff member was resolvable when this fired. An alert
    // nobody owns is the one most likely to be missed, so it must not be
    // filtered out of every inbox.
    await raiseAlert(t.id, t.branchId, t.patientId, null);

    // Both clinicians see it, and — critically — the first one looking does
    // not make it vanish for the second. Seeing is not owning: an unowned
    // critical alert stays in every queue until a human claims it.
    for (const userId of [t.nurseId, t.otherId]) {
      const res = await app.inject({ method: 'GET', url: '/v1/monitoring/notifications', headers: auth(t.id, userId) });
      const body = res.json() as { unseen: number; items: Array<{ addressedToMe: boolean }> };
      expect(body.items).toHaveLength(1);
      expect(body.items[0].addressedToMe).toBe(false);
      expect(body.unseen).toBe(1);
    }

    // Acknowledging is the act of taking responsibility, and only then does it
    // leave the unseen queue.
    const row = await db.notificationEvent.findFirstOrThrow({ where: { tenantId: t.id, recipientUserId: null } });
    expect((await app.inject({ method: 'POST', url: `/v1/monitoring/notifications/${row.id}/acknowledge`, headers: auth(t.id, t.nurseId) })).statusCode).toBe(204);
    const afterAck = await app.inject({ method: 'GET', url: '/v1/monitoring/notifications', headers: auth(t.id, t.otherId) });
    expect((afterAck.json() as { unseen: number }).unseen).toBe(0);
  });

  it('drops a delivered alert out of the unseen count but keeps it retrievable', async () => {
    const t = await makeTenant();
    await raiseAlert(t.id, t.branchId, t.patientId, t.nurseId);
    await app.inject({ method: 'GET', url: '/v1/monitoring/notifications', headers: auth(t.id, t.nurseId) });

    const unseenOnly = await app.inject({ method: 'GET', url: '/v1/monitoring/notifications', headers: auth(t.id, t.nurseId) });
    expect((unseenOnly.json() as { unseen: number; items: unknown[] }).unseen).toBe(0);
    expect((unseenOnly.json() as { items: unknown[] }).items).toHaveLength(0);

    const withSeen = await app.inject({ method: 'GET', url: '/v1/monitoring/notifications?includeSeen=true', headers: auth(t.id, t.nurseId) });
    expect((withSeen.json() as { items: unknown[] }).items).toHaveLength(1);
  });

  it('keeps inboxes tenant-scoped', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    await raiseAlert(a.id, a.branchId, a.patientId, a.nurseId);

    const foreign = await app.inject({ method: 'GET', url: '/v1/monitoring/notifications', headers: auth(b.id, b.nurseId) });
    expect((foreign.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it('delivers what the safety detector raises, end to end', async () => {
    const t = await makeTenant();
    await db.monitoringRule.create({ data: { tenantId: t.id, scope: 'organization', readingType: 'glucose', missedAfterHours: 24, active: true } });
    await db.patientDeviceEnrollment.create({
      data: {
        tenantId: t.id, patientId: t.patientId, branchId: t.branchId, providerKey: 'manual',
        status: 'active', enrolledAt: new Date(Date.now() - 48 * 36e5),
      },
    });

    const detected = await detectMissedReadings(t.id);
    expect(detected.created).toBe(1);

    // The detector runs headless in a worker; its notification must still be
    // reachable by a human. This is the path that produced silence before.
    const res = await app.inject({ method: 'GET', url: '/v1/monitoring/notifications', headers: auth(t.id, t.nurseId) });
    const body = res.json() as { unseen: number; items: Array<{ alertType: string }> };
    expect(body.unseen).toBeGreaterThanOrEqual(1);
    expect(body.items.some(i => i.alertType === 'missed_reading')).toBe(true);
  });
});
