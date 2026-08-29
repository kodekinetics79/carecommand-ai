import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('../workers/queues', () => ({
  redisConnection: {},
  autopilotQueue: { client: Promise.resolve(undefined), add: async () => undefined },
  enqueueAutopilotExecution: async () => undefined,
  complianceQueue: { add: async () => undefined },
  registerComplianceSchedules: async () => undefined,
  campaignQueue: { add: async () => undefined },
  registerCampaignSchedules: async () => undefined,
}));

const { fixtureDb: db } = await import('./helpers/fixtureDb');
const { issueIntakeToken } = await import('../lib/intake');
const { runInTenantContext } = await import('../lib/tenantContext');

// The intake module mints a public token and hands it back. It contains no
// email, no SMS and no dispatch of any kind — yet a packet was recorded as
// 'sent' and emitted intake.packet.sent. Staff read that as "the patient has
// been contacted" and waited on a reply that could never arrive; an audit sent a
// packet to a patient whose phone was null and got "sent" back.
//
// A clinic acting on a false delivery claim is worse than one told the truth and
// asked to send the link itself, so these assertions are about what the product
// SAYS, not only what it stores.

const tenantIds: string[] = [];

afterAll(async () => {
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await db.$disconnect();
});

async function packetInTenant() {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  const tag = tenantId.slice(0, 8);
  await db.tenant.create({ data: { id: tenantId, name: `intake-truth-${tag}`, slug: `intake-truth-${tag}` } });
  const branch = await db.branch.create({ data: { tenantId, name: 'Main', location: 'Main', timezone: 'UTC' } });
  // Deliberately unreachable: no email, no phone. Nothing could be delivered to
  // this patient even if the module tried.
  const patient = await db.patient.create({
    data: { tenantId, branchId: branch.id, firstName: 'Unreachable', lastName: 'Patient', lifecycleStage: 'ACTIVE' },
  });
  const packet = await db.patientIntakePacket.create({
    data: { tenantId, patientId: patient.id, source: 'staff', status: 'draft' },
  });
  return { tenantId, packetId: packet.id, patientId: patient.id };
}

function asStaff<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runInTenantContext(
    { tenantId, actorId: 'worker:intake-truthfulness-test', actorRole: 'WORKER', source: 'worker' },
    fn,
  );
}

describe('intake delivery truthfulness', () => {
  it('records a link as issued, never as sent, when nothing was delivered', async () => {
    const { tenantId, packetId, patientId } = await packetInTenant();

    const token = await asStaff(tenantId, () => issueIntakeToken(tenantId, packetId, null));
    expect(token).toBeTruthy();

    const packet = await db.patientIntakePacket.findUniqueOrThrow({ where: { id: packetId } });
    expect(packet.status).toBe('link_issued');
    // The specific regression: this said 'sent' for a patient the clinic has no
    // way to reach.
    expect(packet.status).not.toBe('sent');

    const patient = await db.patient.findUniqueOrThrow({ where: { id: patientId } });
    expect(patient.email).toBeNull();
    expect(patient.phone).toBeNull();
  }, 60_000);

  it('emits a link-issued business event and never announces a send', async () => {
    const { tenantId, packetId } = await packetInTenant();
    await asStaff(tenantId, () => issueIntakeToken(tenantId, packetId, null));

    const events = await db.businessEvent.findMany({
      where: { tenantId, entityId: packetId },
      select: { eventType: true },
    });
    const types = events.map(e => e.eventType);

    expect(types).toContain('intake.packet.link_issued');
    // Downstream intelligence and any future reporting read these events. One
    // saying "sent" is the same false claim in a different table.
    expect(types).not.toContain('intake.packet.sent');
  }, 60_000);

  it('keeps the packet workable after the link is issued', async () => {
    // Renaming the status must not strand the packet: the queue still has to
    // treat it as active and still has to offer a reissue.
    const { tenantId, packetId } = await packetInTenant();
    await asStaff(tenantId, () => issueIntakeToken(tenantId, packetId, null));

    const reissued = await asStaff(tenantId, () => issueIntakeToken(tenantId, packetId, null));
    expect(reissued).toBeTruthy();

    const packet = await db.patientIntakePacket.findUniqueOrThrow({ where: { id: packetId } });
    expect(packet.status).toBe('link_issued');
    expect(packet.publicTokenHash).toBeTruthy();
    expect(packet.tokenExpiresAt?.getTime()).toBeGreaterThan(Date.now());
  }, 60_000);
});
