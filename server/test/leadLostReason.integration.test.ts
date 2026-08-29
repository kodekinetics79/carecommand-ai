import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// ===========================================================================
// The "mark lead as lost" modal blocks the operator until they type a
// justification and tells them it is "captured for lost-reason intelligence"
// and "recorded in the audit trail". Until this increment the reason was
// discarded in the browser and `Lead.stage` was overwritten in place, so a
// stage change left no trace at all.
//
// This suite is the proof of the promise: the reason reaches the database, the
// audit trail, and a LeadActivity row, and a lead cannot be marked lost without
// one.
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

let app: FastifyInstance;
const tenantIds: string[] = [];

async function makeTenant() {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `lead-${id.slice(0, 6)}`, slug: `lead-${id.slice(0, 8)}` } });
  const user = await db.user.create({
    data: { tenantId: id, role: 'MANAGER', active: true, email: `mgr-${id.slice(0, 8)}@lead.test`, displayName: 'Manager' },
  });
  return { id, userId: user.id };
}

type T = Awaited<ReturnType<typeof makeTenant>>;
const headers = (t: T) => ({
  authorization: `Bearer ${app.jwt.sign({ userId: t.userId, tenantId: t.id, role: 'MANAGER', type: 'access' })}`,
});

async function createLead(t: T, stage = 'new-inquiry') {
  const res = await app.inject({
    method: 'POST', url: '/v1/leads', headers: headers(t),
    payload: { name: 'Dana Patel', channel: 'CALL', service: 'Implant consult', stage, source: 'website', estimatedValue: 2400 },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; stage: string; lostReason: string | null };
}

const setStage = (t: T, id: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `/v1/leads/${id}`, headers: headers(t), payload });

const activityFor = (t: T, leadId: string) =>
  db.leadActivity.findMany({ where: { tenantId: t.id, leadId }, orderBy: { occurredAt: 'asc' } });

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

describe('lead lost-reason — the modal\'s promise is kept end to end', () => {
  it('round-trips the operator\'s reason onto the lead, the audit trail and the activity history', async () => {
    const t = await makeTenant();
    const lead = await createLead(t);
    expect(lead.lostReason).toBeNull();

    const reason = 'Chose a competitor closer to home after the quote';
    const res = await setStage(t, lead.id, { stage: 'lost', lostReason: reason });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stage: 'lost', lostReason: reason });

    const stored = await db.lead.findUnique({ where: { id: lead.id } });
    expect(stored?.lostReason, 'the reason must survive the request, not the browser').toBe(reason);

    const audits = await db.auditEvent.findMany({ where: { tenantId: t.id, action: 'lead.updated', resourceId: lead.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({ lostReason: reason, fromStage: 'new-inquiry', toStage: 'lost' });

    const activity = await activityFor(t, lead.id);
    expect(activity.map(a => [a.fromStage, a.toStage])).toEqual([[null, 'new-inquiry'], ['new-inquiry', 'lost']]);
    expect(activity[1]).toMatchObject({
      activityType: 'stage_change', fromStage: 'new-inquiry', toStage: 'lost',
      reason, actorUserId: t.userId,
    });
  });

  it('refuses to mark a lead lost with no reason, and changes nothing when it does', async () => {
    const t = await makeTenant();
    const lead = await createLead(t);

    const res = await setStage(t, lead.id, { stage: 'lost' });
    expect(res.statusCode).toBe(400);

    const stored = await db.lead.findUnique({ where: { id: lead.id } });
    expect(stored?.stage).toBe('new-inquiry');
    expect(stored?.lostReason).toBeNull();
    expect(await activityFor(t, lead.id)).toHaveLength(1);

    // A blank or one-character justification is not a justification.
    expect((await setStage(t, lead.id, { stage: 'lost', lostReason: '  ' })).statusCode).toBe(400);
    expect((await setStage(t, lead.id, { stage: 'lost', lostReason: 'x' })).statusCode).toBe(400);
  });

  it('records every stage transition, so "why are we losing leads?" has an answer', async () => {
    const t = await makeTenant();
    const lead = await createLead(t);

    expect((await setStage(t, lead.id, { stage: 'contacted' })).statusCode).toBe(200);
    expect((await setStage(t, lead.id, { stage: 'consult-booked' })).statusCode).toBe(200);
    // A no-op stage write must not manufacture history.
    expect((await setStage(t, lead.id, { stage: 'consult-booked' })).statusCode).toBe(200);
    // Neither must an unrelated field.
    expect((await setStage(t, lead.id, { estimatedValue: 3100 })).statusCode).toBe(200);
    expect((await setStage(t, lead.id, { stage: 'lost', lostReason: 'Price — went with a cheaper provider' })).statusCode).toBe(200);

    const activity = await activityFor(t, lead.id);
    expect(activity.map(a => a.toStage)).toEqual(['new-inquiry', 'contacted', 'consult-booked', 'lost']);
    expect(activity.filter(a => a.reason !== null).map(a => a.reason)).toEqual(['Price — went with a cheaper provider']);
    expect(activity.every(a => a.activityType === 'stage_change')).toBe(true);
  });

  it('keeps a lead\'s history inside its own tenant', async () => {
    const [a, b] = [await makeTenant(), await makeTenant()];
    const lead = await createLead(a);
    expect((await setStage(a, lead.id, { stage: 'lost', lostReason: 'Never responded to three follow-ups' })).statusCode).toBe(200);

    // Another tenant cannot see or move the lead at all.
    expect((await setStage(b, lead.id, { stage: 'contacted' })).statusCode).toBe(404);
    expect(await activityFor(b, lead.id)).toHaveLength(0);
    expect(await activityFor(a, lead.id)).toHaveLength(2);
  });
});
