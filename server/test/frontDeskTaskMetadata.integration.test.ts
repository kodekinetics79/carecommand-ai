import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClinicFixture } from './helpers/receptionistFixtures';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// ===========================================================================
// Package D — "The board is true", the metadata half.
//
// `StaffTask.metadata` is one JSON column that four different writers
// read-modify-write. What lives in it is the only copy of the caller's recorded
// message, the previous person's note, the callback window and the origin
// markers other modules look a task up by. These suites hold the three rules
// that keep it intact:
//
//   D3 — a blob that fails strict parse is never written back as the recovered
//        view. Every write-back merges onto the stored object.
//   D4 — a note on a task this module did not file keeps that task's own
//        metadata; it is never replaced by a synthetic receptionist blob.
//   D5 — one advisory-lock key per task id, in one namespace, on every writer.
//        Before this the live tools locked `hashtext('receptionist-safety:…')`,
//        the staff routes locked `hashtextextended('staff-task:…', 0)`, and
//        `markTransferOutcome` locked nothing, so concurrent writes to the same
//        task lost a message or a note with no error.
//
// D9 — and the one task that says the receptionist is off the air is filed
//      through the same contract the board reads, instead of a private shape
//      `parseReceptionistTask` rejects.
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
const frontDeskTask = await import('../lib/receptionist/frontDeskTask');
const {
  createSafetyTask, fileDeploymentAttentionTask, markTransferOutcome,
  parseReceptionistTaskDetailed, mergeReceptionistTaskMetadata, mergeForeignTaskMetadata,
  normalizeTaskPriority, staffTaskLockKey, RECEPTIONIST_TASK_KINDS,
} = frontDeskTask;
const { runWithWebhookTenantContext } = await import('../lib/tenantContext');

let app: FastifyInstance;
const tenantIds: string[] = [];

let phoneCounter = 0;
const uniquePhone = () => `+1${String(process.pid % 100).padStart(2, '0')}${String(Date.now() % 100_000).padStart(5, '0')}${String(phoneCounter++ % 1_000).padStart(3, '0')}`;

const CALLER = '+12125550166';

interface Fixture {
  tenantId: string;
  branchId: string;
  clinicId: string;
  callLogId: string;
  retellCallId: string;
  owner: string;
  frontDesk: string;
}

async function makeFixture(): Promise<Fixture> {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  const tag = tenantId.slice(0, 8);
  await db.tenant.create({ data: { id: tenantId, name: `fdm-${tag}`, slug: `fdm-${tag}` } });
  const branch = await db.branch.create({ data: { tenantId, name: 'Main', location: 'x', timezone: 'UTC' } });
  const clinic = await createClinicFixture(db, { tenantId, name: `Clinic ${tag}`, phone: uniquePhone(), timezone: 'UTC' });
  await db.receptionistLocation.create({
    data: { tenantId, clinicId: clinic.id, branchId: branch.id, name: 'Main', address: '1 Test St', active: true },
  });
  const mkUser = (role: string, label: string) => db.user.create({
    data: { tenantId, role: role as never, active: true, email: `${label}-${tag}@fdm.test`, displayName: `${role} ${label}` },
  });
  const [owner, frontDesk] = await Promise.all([mkUser('OWNER', 'owner'), mkUser('FRONT_DESK', 'fd')]);
  const retellCallId = `call-${randomUUID()}`;
  const callLog = await db.receptionistCallLog.create({
    data: { tenantId, clinicId: clinic.id, retellCallId, callerPhone: CALLER, direction: 'inbound' },
  });
  return {
    tenantId, branchId: branch.id, clinicId: clinic.id,
    callLogId: callLog.id, retellCallId, owner: owner.id, frontDesk: frontDesk.id,
  };
}

const auth = (f: Fixture, userId: string, role: string) => ({
  authorization: `Bearer ${app.jwt.sign({ userId, tenantId: f.tenantId, role, type: 'access' })}`,
});

function fileTask(f: Fixture, kind: Parameters<typeof createSafetyTask>[1], args: Record<string, unknown> = {}, invocationId?: string) {
  return runWithWebhookTenantContext(
    f.tenantId,
    () => createSafetyTask({ tenantId: f.tenantId, callId: f.retellCallId, callerPhone: CALLER, providerInvocationId: invocationId }, kind, args),
    'webhook:test-front-desk-metadata',
  );
}

/** A pre-C4 production row: the workflow is right, the rest is not this schema. */
const LEGACY_BLOB = {
  workflow: 'receptionist_safety',
  kind: 'message',
  // The two things the degrade path exists for, in shapes the schema rejects.
  messages: 'Caller asked us to ring back about the crown fitting.',
  callbackWindow: { from: 'tomorrow morning' },
  appointmentRequestId: 'legacy-request-7',
  // Content only this row holds.
  operatorNote: 'Second call this week — escalate if we miss it again.',
  callbackPhone: '+12125550999',
};

beforeAll(async () => { app = await buildApp(); }, 60_000);

afterAll(async () => {
  await db.idempotencyKey.deleteMany({ where: { tenantId: { in: tenantIds }, scope: 'receptionist.live-safety' } }).catch(() => undefined);
  for (const tenantId of tenantIds) await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await app?.close();
  await db.$disconnect();
});

describe('D3 — a degraded blob is never written back as the degraded view', () => {
  it('reports the parse as degraded and keeps the raw object beside it', () => {
    const parse = parseReceptionistTaskDetailed({ metadata: LEGACY_BLOB });
    expect(parse).not.toBeNull();
    expect(parse!.degraded).toBe(true);
    expect(parse!.raw).toMatchObject({ operatorNote: LEGACY_BLOB.operatorNote, messages: LEGACY_BLOB.messages });
    // The typed view is a recovery, not the truth: it cannot hold these.
    expect(parse!.meta.messages).toEqual([]);
    expect(parse!.meta.appointmentRequestId).toBeNull();
  });

  it('merges a write-back onto the stored object rather than replacing it', () => {
    const parse = parseReceptionistTaskDetailed({ metadata: LEGACY_BLOB })!;
    const merged = mergeReceptionistTaskMetadata(parse, { staffNotes: [{ text: 'Rang, no answer.', at: new Date().toISOString(), byUserId: randomUUID() }] });
    expect(merged).toMatchObject({
      workflow: 'receptionist_safety',
      kind: 'message',
      operatorNote: LEGACY_BLOB.operatorNote,
      messages: LEGACY_BLOB.messages,
      appointmentRequestId: 'legacy-request-7',
    });
    expect((merged as { staffNotes: unknown[] }).staffNotes).toHaveLength(1);
  });

  it('a staff note on a legacy row does not delete the caller message or the prior note', async () => {
    const f = await makeFixture();
    const task = await db.staffTask.create({
      data: {
        tenantId: f.tenantId, branchId: f.branchId, callLogId: f.callLogId,
        title: 'AI receptionist callback requested', priority: 'high', metadata: LEGACY_BLOB,
      },
    });
    const res = await app.inject({
      method: 'POST', url: `/v1/staff/tasks/${task.id}/notes`,
      headers: auth(f, f.frontDesk, 'FRONT_DESK'), payload: { text: 'Rang back, left voicemail.' },
    });
    expect(res.statusCode).toBe(200);

    const stored = (await db.staffTask.findUniqueOrThrow({ where: { id: task.id } })).metadata as Record<string, unknown>;
    expect(stored.messages).toBe(LEGACY_BLOB.messages);
    expect(stored.operatorNote).toBe(LEGACY_BLOB.operatorNote);
    expect(stored.callbackWindow).toEqual(LEGACY_BLOB.callbackWindow);
    expect(stored.appointmentRequestId).toBe('legacy-request-7');
    expect(stored.staffNotes).toHaveLength(1);
  });

  it('a transfer outcome on a legacy row keeps it too', async () => {
    const f = await makeFixture();
    const task = await db.staffTask.create({
      data: {
        tenantId: f.tenantId, branchId: f.branchId, callLogId: f.callLogId,
        title: 'AI receptionist human handoff requested', priority: 'high',
        metadata: { ...LEGACY_BLOB, kind: 'human_handoff' },
      },
    });
    await runWithWebhookTenantContext(
      f.tenantId,
      tx => markTransferOutcome(tx, { tenantId: f.tenantId, callLogId: f.callLogId, outcome: 'connected' }),
      'webhook:test-front-desk-metadata',
    );
    const row = await db.staffTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe('COMPLETED');
    const stored = row.metadata as Record<string, unknown>;
    expect(stored.transferStatus).toBe('connected');
    expect(stored.operatorNote).toBe(LEGACY_BLOB.operatorNote);
    expect(stored.messages).toBe(LEGACY_BLOB.messages);
  });
});

describe('D4 — a note on a foreign task keeps that task’s origin markers', () => {
  it('does not rewrite an insurance reconciliation task as a receptionist message', async () => {
    const f = await makeFixture();
    const entityId = randomUUID();
    const origin = {
      workflow: 'insurance_denial_prevention',
      entityType: 'eligibilityExecution',
      entityId,
      source: 'handoff',
      denialRisk: 'high',
    };
    const task = await db.staffTask.create({
      data: { tenantId: f.tenantId, branchId: f.branchId, title: 'Eligibility needs review', priority: 'high', metadata: origin },
    });

    const res = await app.inject({
      method: 'POST', url: `/v1/staff/tasks/${task.id}/notes`,
      headers: auth(f, f.frontDesk, 'FRONT_DESK'), payload: { text: 'Called the payer, waiting on a reference.' },
    });
    expect(res.statusCode).toBe(200);

    const stored = (await db.staffTask.findUniqueOrThrow({ where: { id: task.id } })).metadata as Record<string, unknown>;
    // Every marker the reconciliation path looks this task up by survives.
    expect(stored).toMatchObject(origin);
    expect(stored.kind).toBeUndefined();
    expect(stored.staffNotes).toHaveLength(1);

    // And it does not appear as receptionist work on the board.
    const summary = await app.inject({ method: 'GET', url: '/v1/tasks/summary', headers: auth(f, f.owner, 'OWNER') });
    expect(summary.json().openByKind.message).toBe(0);
    expect(summary.json().openNeedsAction).toBe(0);
  });

  it('appends a second note to a foreign task without losing the first', async () => {
    const f = await makeFixture();
    const task = await db.staffTask.create({
      data: {
        tenantId: f.tenantId, branchId: f.branchId, title: 'Opportunity hand-off', priority: 'medium',
        metadata: { workflow: 'opportunity_handoff', entityType: 'opportunity', entityId: randomUUID(), source: 'handoff' },
      },
    });
    for (const text of ['First look.', 'Second look.']) {
      const res = await app.inject({
        method: 'POST', url: `/v1/staff/tasks/${task.id}/notes`,
        headers: auth(f, f.frontDesk, 'FRONT_DESK'), payload: { text },
      });
      expect(res.statusCode).toBe(200);
    }
    const stored = (await db.staffTask.findUniqueOrThrow({ where: { id: task.id } })).metadata as { staffNotes: Array<{ text: string }> };
    expect(stored.staffNotes.map(n => n.text)).toEqual(['First look.', 'Second look.']);
  });

  it('mergeForeignTaskMetadata never invents a workflow', () => {
    expect(mergeForeignTaskMetadata(null, { staffNotes: [] })).toEqual({ staffNotes: [] });
    expect(mergeForeignTaskMetadata({ workflow: 'eligibility_reconciliation' }, { staffNotes: [] }))
      .toEqual({ workflow: 'eligibility_reconciliation', staffNotes: [] });
  });
});

describe('D5 — one lock key per task id, on every writer', () => {
  it('publishes a single namespace', () => {
    expect(staffTaskLockKey('t', 'x')).toBe('staff-task:t:x');
  });

  it('the two lock namespaces now hash to the same value', async () => {
    const key = staffTaskLockKey(randomUUID(), randomUUID());
    const rows = await db.$queryRaw<Array<{ extended: bigint }>>`
      SELECT hashtextextended(${key}::text, 0) AS extended
    `;
    // The bug was that hashtext(key)::bigint and hashtextextended(key, 0) are
    // different numbers, so the two writers never blocked each other at all.
    const legacy = await db.$queryRaw<Array<{ legacy: number }>>`SELECT hashtext(${key}::text) AS legacy`;
    expect(BigInt(rows[0].extended)).not.toBe(BigInt(legacy[0].legacy));
  });

  it('a caller’s second message and a staff note both survive when they race', async () => {
    const f = await makeFixture();
    const first = await fileTask(f, 'message', { message: 'First thing.' }, 'inv-1');

    // Both writers run at once against the same JSON column.
    const [, noteRes] = await Promise.all([
      fileTask(f, 'message', { message: 'And one more thing.' }, 'inv-2'),
      app.inject({
        method: 'POST', url: `/v1/staff/tasks/${first.taskId}/notes`,
        headers: auth(f, f.frontDesk, 'FRONT_DESK'), payload: { text: 'Picked this up.' },
      }),
    ]);
    expect(noteRes.statusCode).toBe(200);

    const stored = (await db.staffTask.findUniqueOrThrow({ where: { id: first.taskId } })).metadata as {
      messages: Array<{ text: string }>; staffNotes: Array<{ text: string }>;
    };
    expect(stored.messages.map(m => m.text)).toEqual(['First thing.', 'And one more thing.']);
    expect(stored.staffNotes.map(n => n.text)).toEqual(['Picked this up.']);
  });
});

describe('D9 — the deployment task the board can actually show', () => {
  it('is a kind of the one task contract', () => {
    expect(RECEPTIONIST_TASK_KINDS).toContain('deployment_attention');
  });

  it('files through createSafetyTask with the remediation copy and lowercase critical', async () => {
    const f = await makeFixture();
    const agentId = randomUUID();
    const filed = await runWithWebhookTenantContext(f.tenantId, () => fileDeploymentAttentionTask({
      tenantId: f.tenantId, agentId, clinicId: f.clinicId, code: 'verification_failed',
      title: 'The receptionist is not answering',
      action: 'Re-verify the agent in Studio, then redeploy.',
      fixHref: '/receptionist-studio?tab=retell',
    }), 'webhook:test-deployment-attention');

    const task = await db.staffTask.findUniqueOrThrow({ where: { id: filed.taskId } });
    // Lowercase, so the critical banner sees it. Branch-resolved, so it lands
    // on the desk that actually answers for this clinic.
    expect(task.priority).toBe('critical');
    expect(task.branchId).toBe(f.branchId);
    expect(task.title).toBe('The receptionist is not answering');
    expect(task.metadata).toMatchObject({
      workflow: 'receptionist_safety',
      kind: 'deployment_attention',
      agentId,
      clinicId: f.clinicId,
      code: 'verification_failed',
      remediationTitle: 'The receptionist is not answering',
      remediationAction: 'Re-verify the agent in Studio, then redeploy.',
      fixHref: '/receptionist-studio?tab=retell',
      requiresAcknowledgement: true,
    });
    // And it parses, which the old `receptionist_deployment` shape never did.
    expect(parseReceptionistTaskDetailed(task)?.meta.kind).toBe('deployment_attention');
  });

  it('keeps the (agent, code) idempotency: one open row per failing agent per code', async () => {
    const f = await makeFixture();
    const agentId = randomUUID();
    const file = (code: string) => runWithWebhookTenantContext(f.tenantId, () => fileDeploymentAttentionTask({
      tenantId: f.tenantId, agentId, clinicId: f.clinicId, code,
      title: `t-${code}`, action: `a-${code}`, fixHref: null,
    }), 'webhook:test-deployment-attention');

    const first = await file('verification_failed');
    const again = await file('verification_failed');
    const other = await file('number_bound');
    expect(again.taskId).toBe(first.taskId);
    expect(again.duplicate).toBe(true);
    expect(other.taskId).not.toBe(first.taskId);
    expect(await db.staffTask.count({ where: { tenantId: f.tenantId } })).toBe(2);
  });

  it('opens a NEW row once someone closed the last one, so a still-broken agent is not silenced', async () => {
    const f = await makeFixture();
    const agentId = randomUUID();
    const file = () => runWithWebhookTenantContext(f.tenantId, () => fileDeploymentAttentionTask({
      tenantId: f.tenantId, agentId, clinicId: f.clinicId, code: 'verification_failed',
      title: 'off the air', action: 'redeploy', fixHref: null,
    }), 'webhook:test-deployment-attention');

    const first = await file();
    await db.staffTask.update({ where: { id: first.taskId }, data: { status: 'COMPLETED', completedAt: new Date(), outcomeCode: 'not_needed' } });
    const second = await file();
    expect(second.taskId).not.toBe(first.taskId);
  });

  it('accepts the worker’s softer priority for a transient probe failure', async () => {
    const f = await makeFixture();
    const filed = await runWithWebhookTenantContext(f.tenantId, () => fileDeploymentAttentionTask({
      tenantId: f.tenantId, agentId: randomUUID(), clinicId: f.clinicId, code: 'provider_unreachable',
      title: 'Provider probe failed', action: 'Retry in an hour.', fixHref: null, priority: 'medium',
    }), 'webhook:test-deployment-attention');
    expect((await db.staffTask.findUniqueOrThrow({ where: { id: filed.taskId } })).priority).toBe('medium');
  });
});

describe('D10 — one priority vocabulary', () => {
  it('normalises every spelling the tree still writes', () => {
    expect(normalizeTaskPriority('CRITICAL')).toBe('critical');
    expect(normalizeTaskPriority('HIGH')).toBe('high');
    expect(normalizeTaskPriority('critical')).toBe('critical');
    expect(normalizeTaskPriority('urgent')).toBeNull();
    expect(normalizeTaskPriority(null)).toBeNull();
  });

  it('a task created through the API is stored in the one spelling the board reads', async () => {
    const f = await makeFixture();
    const res = await app.inject({
      method: 'POST', url: '/v1/tasks',
      headers: auth(f, f.owner, 'OWNER'),
      payload: { title: 'Call the lab back', priority: 'CRITICAL' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().priority).toBe('critical');
  });
});
