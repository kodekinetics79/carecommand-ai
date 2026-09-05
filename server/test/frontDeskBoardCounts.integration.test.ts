import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClinicFixture } from './helpers/receptionistFixtures';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// ===========================================================================
// Package D — "The board is true", the counting half.
//
// The front desk summary is the one surface staff are asked to trust, so every
// number on it has to be a number and not an artefact of how the query was
// written:
//
//   D7 — the unacknowledged-critical COUNT was the length of a `take: 5`
//        preview. With nine unacknowledged emergencies the banner and both
//        badges said five, and callers six to nine were invisible until one of
//        the first five was acknowledged.
//   D8 — the critical query was tenant-wide with no workflow predicate, so a
//        critical INSURANCE or OPS task was announced to the front desk as a
//        clinical emergency.
//   D10 — 'CRITICAL' rows (the outbound reconciliation tasks) never appeared in
//        the banner at all, because it matched only lowercase.
//   D13 — the kind histogram loaded every open receptionist task into JS on the
//        hottest polled endpoint in the product. It is a SQL GROUP BY now.
//   D14 — `/tasks` could not filter by clinic, so in a multi-clinic tenant two
//        lanes showed every clinic's work beside three that switched with the
//        selector.
// ===========================================================================

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
const { createSafetyTask, fileDeploymentAttentionTask } = await import('../lib/receptionist/frontDeskTask');
const { runWithWebhookTenantContext } = await import('../lib/tenantContext');

let app: FastifyInstance;
const tenantIds: string[] = [];

let phoneCounter = 0;
const uniquePhone = () => `+1${String(process.pid % 100).padStart(2, '0')}${String(Date.now() % 100_000).padStart(5, '0')}${String(phoneCounter++ % 1_000).padStart(3, '0')}`;

interface Clinic { clinicId: string; callLogId: string; retellCallId: string }

interface Fixture {
  tenantId: string;
  branchId: string;
  a: Clinic;
  b: Clinic;
  owner: string;
}

async function makeClinic(tenantId: string, branchId: string, label: string): Promise<Clinic> {
  const clinic = await createClinicFixture(db, { tenantId, name: `Clinic ${label}`, phone: uniquePhone(), timezone: 'UTC' });
  await db.receptionistLocation.create({
    data: { tenantId, clinicId: clinic.id, branchId, name: `Loc ${label}`, address: '1 Test St', active: true },
  });
  const retellCallId = `call-${randomUUID()}`;
  const callLog = await db.receptionistCallLog.create({
    data: { tenantId, clinicId: clinic.id, retellCallId, callerPhone: '+12125550170', direction: 'inbound' },
  });
  return { clinicId: clinic.id, callLogId: callLog.id, retellCallId };
}

async function makeFixture(): Promise<Fixture> {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  const tag = tenantId.slice(0, 8);
  await db.tenant.create({ data: { id: tenantId, name: `fdbc-${tag}`, slug: `fdbc-${tag}` } });
  const branch = await db.branch.create({ data: { tenantId, name: 'Main', location: 'x', timezone: 'UTC' } });
  const owner = await db.user.create({
    data: { tenantId, role: 'OWNER' as never, active: true, email: `owner-${tag}@fdbc.test`, displayName: 'Owner' },
  });
  const [a, b] = await Promise.all([
    makeClinic(tenantId, branch.id, `A-${tag}`),
    makeClinic(tenantId, branch.id, `B-${tag}`),
  ]);
  return { tenantId, branchId: branch.id, a, b, owner: owner.id };
}

const auth = (f: Fixture, userId: string, role: string) => ({
  authorization: `Bearer ${app.jwt.sign({ userId, tenantId: f.tenantId, role, type: 'access' })}`,
});

function fileTask(f: Fixture, clinic: Clinic, kind: Parameters<typeof createSafetyTask>[1], args: Record<string, unknown> = {}, callId?: string) {
  return runWithWebhookTenantContext(
    f.tenantId,
    () => createSafetyTask({ tenantId: f.tenantId, callId: callId ?? clinic.retellCallId, callerPhone: '+12125550170' }, kind, args),
    'webhook:test-front-desk-counts',
  );
}

const summary = (f: Fixture, query = '') =>
  app.inject({ method: 'GET', url: `/v1/tasks/summary${query}`, headers: auth(f, f.owner, 'OWNER') });

beforeAll(async () => { app = await buildApp(); }, 60_000);

afterAll(async () => {
  await db.idempotencyKey.deleteMany({ where: { tenantId: { in: tenantIds }, scope: 'receptionist.live-safety' } }).catch(() => undefined);
  for (const tenantId of tenantIds) await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await app?.close();
  await db.$disconnect();
});

describe('D7 — the unacknowledged-critical count is a count, not a page length', () => {
  it('reports nine when there are nine, while still previewing five', async () => {
    const f = await makeFixture();
    for (let i = 0; i < 9; i += 1) {
      await fileTask(f, f.a, 'emergency', { reason_category: 'chest_pain' }, `call-emg-${randomUUID()}`);
    }
    const res = await summary(f);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.unacknowledgedCriticalCount).toBe(9);
    expect(body.unacknowledgedCritical).toHaveLength(5);
    expect(body.openByKind.emergency).toBe(9);
  });

  it('drops out of the count the moment one is acknowledged', async () => {
    const f = await makeFixture();
    const first = await fileTask(f, f.a, 'emergency', {}, `call-emg-${randomUUID()}`);
    await fileTask(f, f.a, 'emergency', {}, `call-emg-${randomUUID()}`);
    expect((await summary(f)).json().unacknowledgedCriticalCount).toBe(2);
    await db.staffTask.update({ where: { id: first.taskId }, data: { acknowledgedAt: new Date(), acknowledgedById: f.owner } });
    expect((await summary(f)).json().unacknowledgedCriticalCount).toBe(1);
  });
});

describe('D8 — the emergency banner is receptionist work, labelled', () => {
  it('excludes a critical insurance task and includes the receptionist ones', async () => {
    const f = await makeFixture();
    await db.staffTask.create({
      data: {
        tenantId: f.tenantId, branchId: f.branchId, title: 'Eligibility denial risk', priority: 'critical',
        metadata: { workflow: 'insurance_denial_prevention', entityType: 'eligibilityExecution', entityId: randomUUID() },
      },
    });
    const emergency = await fileTask(f, f.a, 'emergency', { reason_category: 'chest_pain' });

    const body = (await summary(f)).json();
    expect(body.unacknowledgedCriticalCount).toBe(1);
    expect(body.unacknowledgedCritical).toHaveLength(1);
    expect(body.unacknowledgedCritical[0]).toMatchObject({
      id: emergency.taskId, workflow: 'receptionist_safety', kind: 'emergency', clinicId: f.a.clinicId,
    });
  });

  it('D10 — an uppercase CRITICAL outbound reconciliation task is no longer invisible', async () => {
    const f = await makeFixture();
    const reconcile = await db.staffTask.create({
      data: {
        tenantId: f.tenantId, branchId: f.branchId, title: 'Urgent: reconcile outbound call after unconfirmed stop',
        priority: 'CRITICAL',
        metadata: { workflow: 'receptionist_outbound_stop_reconciliation', callLogId: f.a.callLogId },
      },
    });
    const body = (await summary(f)).json();
    expect(body.unacknowledgedCriticalCount).toBe(1);
    expect(body.unacknowledgedCritical[0]).toMatchObject({
      id: reconcile.id, workflow: 'receptionist_outbound_stop_reconciliation',
    });
  });

  it('says plainly which counters are tenant-wide, so the header numbers reconcile', async () => {
    const f = await makeFixture();
    const body = (await summary(f)).json();
    expect(body.counterScope).toMatchObject({
      openByKind: 'receptionist',
      openNeedsAction: 'receptionist',
      unacknowledgedCritical: 'receptionist',
      overdue: 'all_workflows',
      mine: 'all_workflows',
      dueWithin30m: 'all_workflows',
    });
  });
});

describe('D9 — the deployment task reaches the board', () => {
  it('appears in the critical banner, the kind histogram and the needs-action count', async () => {
    const f = await makeFixture();
    const filed = await runWithWebhookTenantContext(f.tenantId, () => fileDeploymentAttentionTask({
      tenantId: f.tenantId, agentId: randomUUID(), clinicId: f.a.clinicId, code: 'verification_failed',
      title: 'The receptionist is not answering',
      action: 'Re-verify the agent, then redeploy.',
      fixHref: '/receptionist-studio?tab=retell',
    }), 'webhook:test-front-desk-counts');

    const body = (await summary(f)).json();
    expect(body.openByKind.deployment_attention).toBe(1);
    expect(body.openNeedsAction).toBe(1);
    expect(body.unacknowledgedCriticalCount).toBe(1);
    expect(body.unacknowledgedCritical[0]).toMatchObject({
      id: filed.taskId,
      kind: 'deployment_attention',
      action: 'Re-verify the agent, then redeploy.',
      fixHref: '/receptionist-studio?tab=retell',
    });

    // And on the lane the task list feeds.
    const list = await app.inject({
      method: 'GET', url: '/v1/tasks?kind=deployment_attention', headers: auth(f, f.owner, 'OWNER'),
    });
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0].receptionist).toMatchObject({
      kind: 'deployment_attention',
      remediationAction: 'Re-verify the agent, then redeploy.',
      fixHref: '/receptionist-studio?tab=retell',
    });
  });
});

describe('D13 — the kind histogram is computed in SQL and still agrees with the rows', () => {
  it('counts each kind once and recovers an unrecognised kind as message, like the reader does', async () => {
    const f = await makeFixture();
    await fileTask(f, f.a, 'message', { message: 'One.' }, `call-${randomUUID()}`);
    await fileTask(f, f.a, 'human_handoff', {}, `call-${randomUUID()}`);
    await fileTask(f, f.a, 'booking_review', {}, `call-${randomUUID()}`);
    // A row whose kind this build does not know: it must land where
    // `parseReceptionistTask` puts it, not vanish from the histogram.
    await db.staffTask.create({
      data: {
        tenantId: f.tenantId, branchId: f.branchId, title: 'From a future build', priority: 'high',
        metadata: { workflow: 'receptionist_safety', kind: 'a_kind_from_a_later_build', requiresAcknowledgement: true },
      },
    });

    const body = (await summary(f)).json();
    expect(body.openByKind).toMatchObject({ message: 2, human_handoff: 1, booking_review: 1, emergency: 0 });
    expect(body.openNeedsAction).toBe(4);
  });

  it('honours the branch scope the queue uses', async () => {
    const f = await makeFixture();
    const other = await db.branch.create({ data: { tenantId: f.tenantId, name: 'Other', location: 'y', timezone: 'UTC' } });
    // Use the clinic's recorded call so the task resolves to the same branch
    // the scoped queue is proving. An unknown call id is deliberately filed
    // unscoped and must not leak into a clinic-specific queue.
    await fileTask(f, f.a, 'message', { message: 'Branch A.' });
    await db.staffTask.create({
      data: {
        tenantId: f.tenantId, branchId: other.id, title: 'Elsewhere', priority: 'high',
        metadata: { workflow: 'receptionist_safety', kind: 'message', requiresAcknowledgement: true },
      },
    });
    expect((await summary(f, `?branchId=${f.branchId}`)).json().openByKind.message).toBe(1);
    expect((await summary(f)).json().openByKind.message).toBe(2);
  });
});

describe('D14 — the task list can be scoped to one clinic', () => {
  it('filters by the clinic on the task metadata and by the clinic on its source call', async () => {
    const f = await makeFixture();
    const inA = await fileTask(f, f.a, 'message', { message: 'Clinic A.' });
    const inB = await fileTask(f, f.b, 'message', { message: 'Clinic B.' });
    // A pre-C4 row with only a call link and no metadata.clinicId.
    const legacyB = await db.staffTask.create({
      data: {
        tenantId: f.tenantId, branchId: f.branchId, callLogId: f.b.callLogId,
        title: 'Legacy row', priority: 'high',
        metadata: { workflow: 'receptionist_safety', kind: 'message', requiresAcknowledgement: true },
      },
    });

    const list = async (clinicId?: string) => {
      const res = await app.inject({
        method: 'GET', url: `/v1/tasks${clinicId ? `?clinicId=${clinicId}` : ''}`,
        headers: auth(f, f.owner, 'OWNER'),
      });
      expect(res.statusCode).toBe(200);
      return (res.json().data as Array<{ id: string }>).map(row => row.id).sort();
    };

    expect(await list(f.a.clinicId)).toEqual([inA.taskId]);
    expect(await list(f.b.clinicId)).toEqual([inB.taskId, legacyB.id].sort());
    expect((await list()).length).toBe(3);
  });

  it('the clinic filter does not silently replace the branch visibility scope', async () => {
    const f = await makeFixture();
    const other = await db.branch.create({ data: { tenantId: f.tenantId, name: 'Other', location: 'y', timezone: 'UTC' } });
    const frontDeskOther = await db.user.create({
      data: {
        tenantId: f.tenantId, role: 'FRONT_DESK' as never, active: true, branchId: other.id,
        email: `fd-other-${randomUUID().slice(0, 8)}@fdbc.test`, displayName: 'FD other',
      },
    });
    await fileTask(f, f.a, 'message', { message: 'Branch main, clinic A.' });

    const res = await app.inject({
      method: 'GET', url: `/v1/tasks?clinicId=${f.a.clinicId}`,
      headers: auth(f, frontDeskOther.id, 'FRONT_DESK'),
    });
    expect(res.statusCode).toBe(200);
    // The task sits on the main branch; a user pinned elsewhere must not see it
    // just because they asked for that clinic.
    expect(res.json().data).toHaveLength(0);
  });

  it('scopes the summary to one clinic too, so the tiles and the lanes agree', async () => {
    const f = await makeFixture();
    await fileTask(f, f.a, 'message', { message: 'A.' });
    await fileTask(f, f.b, 'emergency', {});
    expect((await summary(f, `?clinicId=${f.a.clinicId}`)).json().openByKind).toMatchObject({ message: 1, emergency: 0 });
    expect((await summary(f, `?clinicId=${f.b.clinicId}`)).json().unacknowledgedCriticalCount).toBe(1);
    expect((await summary(f, `?clinicId=${f.a.clinicId}`)).json().unacknowledgedCriticalCount).toBe(0);
  });
});
