import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
const { recordUsageEvent, periodUsageTotal, periodUsageByMetric, usagePeriodKey, voiceCallDedupeKey, USAGE_METRICS } =
  await import('../lib/usageMetering');

/**
 * The defect this replaces: voice minutes were counted in two LIFETIME
 * counters that nothing ever reset, and both call-admission gates refused a
 * call once used >= limitValue. A clinic on 500 included minutes therefore
 * stopped answering its patients' calls permanently, part-way through its
 * second month, with a 402 and no warning.
 *
 * These tests pin the three properties that make the ledger safe to bill from:
 * usage belongs to the period the work happened in, a redelivered webhook
 * cannot bill twice, and one tenant's usage is never another's.
 */
describe('usage metering — periods, redelivery, isolation', () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const JAN = new Date('2026-01-14T10:00:00.000Z');
  const FEB = new Date('2026-02-03T10:00:00.000Z');

  beforeAll(async () => {
    for (const [id, tag] of [[tenantA, 'a'], [tenantB, 'b']] as const) {
      await db.tenant.create({ data: { id, name: `usage-${tag}-${id.slice(0, 6)}`, slug: `usage-${tag}-${id.slice(0, 8)}` } });
    }
  }, 60_000);

  afterAll(async () => {
    // UsageEvent is append-only for every role by trigger, so a cascading
    // tenant delete would raise P0001 - correctly. Retire the fixtures instead.
    await db.tenant.updateMany({ where: { id: { in: [tenantA, tenantB] } }, data: { status: 'cancelled', name: 'ZZ test fixture (usage metering)' } });
  });

  it('derives the billing period from when the work happened, not when it was recorded', () => {
    expect(usagePeriodKey(JAN)).toBe('2026-01');
    expect(usagePeriodKey(FEB)).toBe('2026-02');
    expect(usagePeriodKey(new Date('2026-12-31T23:59:59.999Z'))).toBe('2026-12');
  });

  it("a clinic's allowance comes back the following month", async () => {
    await recordUsageEvent(db, {
      tenantId: tenantA, metric: USAGE_METRICS.voiceMinute, quantity: 480, occurredAt: JAN,
      sourceModule: 'receptionist', sourceType: 'receptionistCallLog', dedupeKey: `test-jan-${tenantA}`,
    });
    expect(await periodUsageTotal(db, tenantA, USAGE_METRICS.voiceMinute, JAN)).toBe(480);
    // The month that would previously have been permanently blocked.
    expect(await periodUsageTotal(db, tenantA, USAGE_METRICS.voiceMinute, FEB)).toBe(0);
  });

  it('bills a late redelivery into the period the call actually happened in', async () => {
    await recordUsageEvent(db, {
      tenantId: tenantA, metric: USAGE_METRICS.voiceMinute, quantity: 5,
      occurredAt: new Date('2026-01-31T23:58:00.000Z'), // call ran in January
      sourceModule: 'receptionist', sourceType: 'receptionistCallLog', dedupeKey: `test-late-${tenantA}`,
    });
    expect(await periodUsageTotal(db, tenantA, USAGE_METRICS.voiceMinute, JAN)).toBe(485);
    expect(await periodUsageTotal(db, tenantA, USAGE_METRICS.voiceMinute, FEB)).toBe(0);
  });

  it('a redelivered webhook does not bill the same minutes twice', async () => {
    const callId = `call_${randomUUID().slice(0, 8)}`;
    const event = {
      tenantId: tenantB, metric: USAGE_METRICS.voiceMinute, quantity: 4, occurredAt: FEB,
      sourceModule: 'receptionist', sourceType: 'receptionistCallLog', dedupeKey: voiceCallDedupeKey(callId, 4),
    } as const;
    await recordUsageEvent(db, event);
    await recordUsageEvent(db, event);
    await recordUsageEvent(db, event);
    expect(await periodUsageTotal(db, tenantB, USAGE_METRICS.voiceMinute, FEB)).toBe(4);

    // The same call corrected upward bills only the increment, because the
    // cumulative total is part of the key.
    await recordUsageEvent(db, { ...event, quantity: 2, dedupeKey: voiceCallDedupeKey(callId, 6) });
    expect(await periodUsageTotal(db, tenantB, USAGE_METRICS.voiceMinute, FEB)).toBe(6);
  });

  it("never counts one clinic's minutes against another's allowance", async () => {
    expect(await periodUsageTotal(db, tenantA, USAGE_METRICS.voiceMinute, FEB)).toBe(0);
    expect(await periodUsageTotal(db, tenantB, USAGE_METRICS.voiceMinute, JAN)).toBe(0);
    const byMetric = await periodUsageByMetric(db, tenantB, FEB);
    expect(byMetric[USAGE_METRICS.voiceMinute]).toBe(6);
  });

  it('ignores a zero or negative quantity rather than writing a meaningless row', async () => {
    const before = await periodUsageTotal(db, tenantB, USAGE_METRICS.voiceMinute, FEB);
    await recordUsageEvent(db, {
      tenantId: tenantB, metric: USAGE_METRICS.voiceMinute, quantity: 0, occurredAt: FEB,
      sourceModule: 'receptionist', sourceType: 'receptionistCallLog', dedupeKey: `test-zero-${tenantB}`,
    });
    await recordUsageEvent(db, {
      tenantId: tenantB, metric: USAGE_METRICS.voiceMinute, quantity: -5, occurredAt: FEB,
      sourceModule: 'receptionist', sourceType: 'receptionistCallLog', dedupeKey: `test-negative-${tenantB}`,
    });
    expect(await periodUsageTotal(db, tenantB, USAGE_METRICS.voiceMinute, FEB)).toBe(before);
  });

  it('refuses to let a recorded usage row be rewritten or erased, by anyone', async () => {
    const row = await db.usageEvent.findFirstOrThrow({ where: { tenantId: tenantB } });
    await expect(db.usageEvent.update({ where: { id: row.id }, data: { quantity: 9999 } })).rejects.toThrow(/append-only/i);
    await expect(db.usageEvent.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/i);
  });
});
