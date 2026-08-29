import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';

// ===========================================================================
// The opt-out side of the campaign dispatch fence.
//
// server/lib/campaignIntegrity.ts linearizes "not opted out" with "about to
// submit" by taking lockSuppressionFences() inside the transaction that commits
// the provider intent (and again inside the submission claim). That is only a
// linearization if every OPT-OUT WRITER takes the same advisory keys inside the
// transaction that writes its row. campaigns POST /consent and POST
// /suppressions already did. These four did not:
//
//   1. portal PATCH /preferences  → ConsentEvent        (identity-keyed)
//   2. portal PATCH /preferences  → ReceptionistOptOut  (destination-keyed)
//   3. intake communication_consent → CommunicationConsent (identity-keyed)
//   4. patients POST /:id/consents → ConsentEvent       (identity-keyed)
//
// Each writer gets the same two-part proof:
//
//   POSITIVE CONTROL — a foreign connection holds the exact advisory key the
//   corresponding dispatcher holds. The writer must block on it and must have
//   written NOTHING while blocked. (If the writer did not take the fence it
//   would simply finish, and the assertion fails.)
//
//   NEGATIVE CONTROL / RACE — the real claimCampaignProviderIntent() is queued
//   behind the blocked writer on that same key. When the gate is released the
//   writer is granted the lock first (PostgreSQL serves the advisory wait queue
//   in order), commits, and the claim — which re-reads suppression under the
//   fence — must come back `suppressed` with no provider intent recorded.
//   A writer that took the lock in a DIFFERENT transaction from its write would
//   release it at that transaction's commit and let the claim read ahead of the
//   insert; this is what catches that.
//
// submissionMode is 'mock_dev' throughout: the claim is the linearization point
// under test, and mock_dev reaches it without a tenant live-dispatch activation.
// No provider is contacted by anything in this file.
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
const { recomputeEntitlements } = await import('../lib/entitlements');
const { issuePortalSession } = await import('../lib/portalAuth');
const { submitSection } = await import('../lib/intake');
const { claimCampaignProviderIntent } = await import('../lib/campaignIntegrity');
const { dncFenceKey, identityFenceKey } = await import('../lib/receptionist/dncFence');
const { runWithJobTenantContext, runInTenantContext } = await import('../lib/tenantContext');

let app: FastifyInstance;
let gatePool: Pool;
const tenantIds: string[] = [];

/** How long a writer must stay unsettled before we call it "blocked". */
const BLOCK_MS = 500;

// ---- fixtures --------------------------------------------------------------

type Role = 'OWNER' | 'ADMIN';

async function makeTenant() {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `fence-${id.slice(0, 6)}`, slug: `optout-${id.slice(0, 8)}` } });
  const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
  if (plan) {
    await db.tenantSubscription.create({ data: { tenantId: id, planId: plan.id, status: 'ACTIVE', startedAt: new Date() } });
    await recomputeEntitlements(id, db); // patient_crm → the portal feature gate
  }
  const branch = await db.branch.create({ data: { tenantId: id, name: 'Main', location: 'Main St', timezone: 'UTC' } });
  const users = {} as Record<Role, string>;
  for (const role of ['OWNER', 'ADMIN'] as Role[]) {
    const user = await db.user.create({
      data: { tenantId: id, role, active: true, email: `${role.toLowerCase()}-${id.slice(0, 8)}@optout.test`, displayName: role },
    });
    users[role] = user.id;
  }
  return { id, branchId: branch.id, users };
}
type T = Awaited<ReturnType<typeof makeTenant>>;

const staffHeaders = (t: T, role: Role = 'ADMIN') => ({
  authorization: `Bearer ${app.jwt.sign({ userId: t.users[role], tenantId: t.id, role, type: 'access' })}`,
});

async function makePatient(t: T, phone: string | null, extra: { email?: string; churnRisk?: number; lifetimeValue?: number } = {}) {
  return db.patient.create({
    data: {
      tenantId: t.id, branchId: t.branchId, firstName: 'Opt', lastName: 'Out',
      phone, email: extra.email ?? null, lifecycleStage: 'ACTIVE',
      churnRisk: extra.churnRisk ?? 0, lifetimeValue: extra.lifetimeValue ?? 0,
      lastVisitAt: new Date('2020-01-01T00:00:00Z'),
    },
    select: { id: true },
  });
}

async function portalTokenFor(t: T, patientId: string) {
  const account = await db.patientPortalAccount.create({
    data: { tenantId: t.id, patientId, status: 'active', email: `p-${randomUUID().slice(0, 8)}@optout.test` },
  });
  return issuePortalSession(app, account, db);
}

async function makeCampaign(t: T) {
  return db.campaign.create({
    data: {
      tenantId: t.id, name: 'Reactivation', goal: 'inactive_patient_reactivation', status: 'SCHEDULED', channels: [],
      campaignType: 'inactive_patient_reactivation', audienceType: 'inactive_patients', campaignChannel: 'sms',
      messageTemplate: 'Hi {{firstName}}, it has been a while since your visit to {{clinicName}}.',
      requiresApproval: true, approvedAt: new Date(), draftSource: 'rule_based',
    },
    select: { id: true },
  });
}

/**
 * The real phase-1 dispatch claim — the transaction whose COMMIT is the
 * linearization point between "not opted out" and "we are about to submit".
 */
function claim(t: T, campaignId: string, input: {
  channel: 'sms' | 'email' | 'voice' | 'whatsapp';
  patientId: string | null;
  leadId: string | null;
  destination: string;
}) {
  return runWithJobTenantContext(t.id, () => claimCampaignProviderIntent({
    tenantId: t.id,
    campaignId,
    channel: input.channel,
    candidate: { patientId: input.patientId, leadId: input.leadId },
    destination: input.destination,
    destinationMasked: null,
    provider: 'mock',
    idempotencyKey: `${campaignId}:${input.patientId ?? input.leadId}:${input.channel}`,
    launchFingerprint: 'f'.repeat(64),
    submissionMode: 'mock_dev',
    force: false,
  }), 'worker:test-optout-fence');
}

// ---- concurrency plumbing --------------------------------------------------

type Tracked<V> = { settled: () => boolean; done: Promise<V> };

/** Wraps a promise so the test can ask whether it has settled yet. */
function track<V>(promise: Promise<V>): Tracked<V> {
  let settled = false;
  const done = promise.then(
    value => { settled = true; return value; },
    error => { settled = true; throw error; },
  );
  done.catch(() => undefined); // never an unhandled rejection while we poll
  return { settled: () => settled, done };
}

const pause = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

/**
 * Holds the given advisory fence keys on a foreign connection until released —
 * exactly what a dispatcher's claim transaction does between taking the fences
 * and committing.
 */
async function openGate(keys: string[]) {
  const client = await gatePool.connect();
  await client.query('BEGIN');
  for (const key of [...keys].sort()) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
  }
  return {
    release: async () => { await client.query('COMMIT'); },
    dispose: async () => { await client.query('ROLLBACK').catch(() => undefined); client.release(); },
  };
}

/** How many backends are currently parked on an advisory lock they asked for. */
async function advisoryWaiters(): Promise<number> {
  const { rows } = await gatePool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
  );
  return rows[0].n;
}

/**
 * The discriminator between an APPLICATION fence and the database's own
 * BEFORE-ROW suppression-fence triggers.
 *
 * ConsentEvent / CommunicationConsent / CampaignSuppression / ReceptionistOptOut
 * each carry a BEFORE INSERT OR UPDATE OR DELETE trigger (added by
 * prisma/migrations/20260730240000_receptionist_dnc_revocation_fence) that takes
 * the very same `receptionist-suppression:*` keys. So "the writer blocks on the
 * fence key" alone is satisfied by the trigger and proves nothing about the
 * application code.
 *
 * The two differ in WHERE the transaction is parked. A trigger fires from inside
 * the INSERT, and the executor has already taken RowExclusiveLock on the target
 * relation by then. An application fence parks the transaction before the write
 * statement is issued at all, so no such lock is held.
 *
 * Counting only backends that are BOTH waiting on an advisory lock AND already
 * holding a write lock on this table makes the check immune to unrelated
 * activity elsewhere in the database.
 */
async function blockedInsideAWriteTo(table: string): Promise<number> {
  const { rows } = await gatePool.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM pg_locks w
       JOIN pg_locks r ON r.pid = w.pid AND r.locktype = 'relation' AND r.granted AND r.mode = 'RowExclusiveLock'
       JOIN pg_class c ON c.oid = r.relation
      WHERE w.locktype = 'advisory' AND NOT w.granted AND c.relname = $1`,
    [table],
  );
  return rows[0].n;
}

/**
 * The shared shape of every proof below.
 *
 * `write` is the real opt-out writer. `rowsWritten` counts the row it is
 * supposed to produce. `table` is the relation that row lands in. `racer` is the
 * real dispatch claim for a recipient the opt-out must reach.
 */
async function proveFencedWriter(options: {
  fenceKeys: string[];
  write: () => Promise<unknown>;
  table: string;
  rowsWritten: () => Promise<number>;
  racer: () => Promise<{ outcome: string }>;
}) {
  const gate = await openGate(options.fenceKeys);
  try {
    const writer = track(options.write());
    await pause(BLOCK_MS);
    // 1. It really did take the fence: it is stuck on a key it does not hold...
    expect(writer.settled(), 'the opt-out writer did NOT block on the dispatch suppression fence').toBe(false);
    expect(await advisoryWaiters(), 'the writer is stalled on something other than an advisory lock').toBeGreaterThan(0);
    // 2. ...and it took it BEFORE its write, so nothing has landed yet...
    expect(await options.rowsWritten()).toBe(0);
    // 3. ...and it is not merely parked inside the INSERT by the table's own
    //     BEFORE-ROW fence trigger: the write statement has not begun.
    expect(
      await blockedInsideAWriteTo(options.table),
      `the fence was taken by the ${options.table} row trigger from inside the write, not by the writer before it`,
    ).toBe(0);

    // 4. Queue the real dispatch claim behind the writer on that same key.
    const racer = track(options.racer());
    await pause(BLOCK_MS);
    expect(racer.settled(), 'the dispatch claim did not queue behind the opt-out writer').toBe(false);

    await gate.release();

    // 4. The writer is served first, commits, and only then does the claim get
    //    to re-read suppression — where it must see the opt-out.
    await writer.done;
    expect(await options.rowsWritten()).toBe(1);
    const outcome = await racer.done;
    return outcome;
  } finally {
    await gate.dispose();
  }
}

/** The negative control: a fence on some OTHER key must not hold this writer up. */
async function proveUnrelatedKeyDoesNotBlock(unrelatedKeys: string[], write: () => Promise<unknown>) {
  const gate = await openGate(unrelatedKeys);
  try {
    const writer = track(write());
    await pause(BLOCK_MS);
    expect(writer.settled(), 'the writer blocked on a key no dispatcher for it would hold').toBe(true);
    return writer.done;
  } finally {
    await gate.dispose();
  }
}

beforeAll(async () => {
  app = await buildApp();
  gatePool = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL, max: 6 });
}, 60_000);

afterAll(async () => {
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await gatePool?.end();
  await app?.close();
  await db.$disconnect();
});

// ===========================================================================
// 1. Patient portal — ConsentEvent (identity-keyed)
// ===========================================================================
describe('portal PATCH /preferences — ConsentEvent takes the patient identity fence', () => {
  it('blocks on the patient fence, writes nothing while held, and a racing dispatch claim is suppressed', async () => {
    const t = await makeTenant();
    const phone = '+15556100001';
    const patient = await makePatient(t, phone);
    const token = await portalTokenFor(t, patient.id);
    const campaign = await makeCampaign(t);

    const outcome = await proveFencedWriter({
      // isSuppressedTx reads ConsentEvent by (tenantId, patientId, purpose), so
      // the patient identity fence is the key claimCampaignProviderIntent holds
      // for this recipient.
      fenceKeys: [identityFenceKey(t.id, 'patient', patient.id)],
      write: async () => {
        const res = await app.inject({
          method: 'PATCH', url: '/v1/portal/preferences',
          headers: { authorization: `Bearer ${token}` }, payload: { sms: false },
        });
        expect(res.statusCode).toBe(200);
        return res;
      },
      table: 'ConsentEvent',
      rowsWritten: () => db.consentEvent.count({ where: { tenantId: t.id, patientId: patient.id, purpose: 'SMS' } }),
      racer: () => claim(t, campaign.id, { channel: 'sms', patientId: patient.id, leadId: null, destination: phone }),
    });

    expect(outcome.outcome).toBe('suppressed');
    expect(await db.campaignSubmissionClaim.count({ where: { tenantId: t.id } })).toBe(0);
    const delivery = await db.campaignDelivery.findFirstOrThrow({ where: { tenantId: t.id, campaignId: campaign.id } });
    expect(delivery.status).toBe('suppressed');
    expect(delivery.providerMessageId).toBeNull();
  }, 30_000);

  it('is not held up by a fence on a different patient', async () => {
    const t = await makeTenant();
    const patient = await makePatient(t, '+15556100002');
    const other = await makePatient(t, '+15556100003');
    const token = await portalTokenFor(t, patient.id);

    const res = await proveUnrelatedKeyDoesNotBlock(
      [identityFenceKey(t.id, 'patient', other.id)],
      () => app.inject({
        method: 'PATCH', url: '/v1/portal/preferences',
        headers: { authorization: `Bearer ${token}` }, payload: { sms: false },
      }),
    );
    expect((res as { statusCode: number }).statusCode).toBe(200);
  }, 30_000);
});

// ===========================================================================
// 2. Patient portal — ReceptionistOptOut (destination-keyed)
//
// The adversarial case for this increment. A global voice opt-out is keyed by
// PHONE NUMBER, not by patient: it suppresses that number for every identity in
// the tenant, including a Lead this portal session has never heard of. A
// dispatcher aimed at such a lead holds the LEAD identity fence and the
// DESTINATION fence — never this patient's. So the patient fence alone would
// have looked correct and serialized with nothing.
// ===========================================================================
describe('portal PATCH /preferences — ReceptionistOptOut takes the destination fence', () => {
  it('blocks on the destination fence and suppresses a racing claim aimed at a LEAD on the same number', async () => {
    const t = await makeTenant();
    const phone = '+15556100004';
    const patient = await makePatient(t, phone);
    const token = await portalTokenFor(t, patient.id);
    const campaign = await makeCampaign(t);
    // A different identity, same phone number — reachable only by the
    // destination key.
    const lead = await db.lead.create({
      data: { tenantId: t.id, name: 'Same Number', phone, channel: 'CALL', service: 'Consult', stage: 'new', source: 'walk_in' },
      select: { id: true },
    });

    const outcome = await proveFencedWriter({
      fenceKeys: [dncFenceKey(t.id, phone)],
      write: async () => {
        const res = await app.inject({
          method: 'PATCH', url: '/v1/portal/preferences',
          headers: { authorization: `Bearer ${token}` }, payload: { voice: false },
        });
        expect(res.statusCode).toBe(200);
        return res;
      },
      table: 'ReceptionistOptOut',
      rowsWritten: () => db.receptionistOptOut.count({ where: { tenantId: t.id, contactPhone: phone, revokedAt: null } }),
      racer: () => claim(t, campaign.id, { channel: 'voice', patientId: null, leadId: lead.id, destination: phone }),
    });

    expect(outcome.outcome).toBe('suppressed');
    expect(await db.campaignSubmissionClaim.count({ where: { tenantId: t.id } })).toBe(0);
  }, 30_000);

  it('is not held up by the destination fence for a different number', async () => {
    const t = await makeTenant();
    const patient = await makePatient(t, '+15556100005');
    const token = await portalTokenFor(t, patient.id);

    const res = await proveUnrelatedKeyDoesNotBlock(
      [dncFenceKey(t.id, '+15556100099')],
      () => app.inject({
        method: 'PATCH', url: '/v1/portal/preferences',
        headers: { authorization: `Bearer ${token}` }, payload: { voice: false },
      }),
    );
    expect((res as { statusCode: number }).statusCode).toBe(200);
  }, 30_000);

  it('still takes the patient fence too when the same request also writes a ConsentEvent', async () => {
    // One request, two differently-keyed opt-out records. Both keys must be
    // held: the patient fence for the ConsentEvent, the destination fence for
    // the ReceptionistOptOut.
    const t = await makeTenant();
    const phone = '+15556100006';
    const patient = await makePatient(t, phone);
    const token = await portalTokenFor(t, patient.id);

    const gate = await openGate([identityFenceKey(t.id, 'patient', patient.id)]);
    try {
      const writer = track(app.inject({
        method: 'PATCH', url: '/v1/portal/preferences',
        headers: { authorization: `Bearer ${token}` }, payload: { sms: false, voice: false },
      }));
      await pause(BLOCK_MS);
      expect(writer.settled()).toBe(false);
      expect(await db.receptionistOptOut.count({ where: { tenantId: t.id, contactPhone: phone } })).toBe(0);
      expect(await db.consentEvent.count({ where: { tenantId: t.id, patientId: patient.id } })).toBe(0);
      await gate.release();
      expect((await writer.done).statusCode).toBe(200);
      expect(await db.receptionistOptOut.count({ where: { tenantId: t.id, contactPhone: phone } })).toBe(1);
      expect(await db.consentEvent.count({ where: { tenantId: t.id, patientId: patient.id, purpose: 'SMS' } })).toBe(1);
    } finally {
      await gate.dispose();
    }
  }, 30_000);
});

// ===========================================================================
// 3. Intake — CommunicationConsent (identity-keyed, patient OR lead)
// ===========================================================================
describe('intake communication_consent — CommunicationConsent takes the identity fence', () => {
  async function makePacket(t: T, identity: { patientId?: string; leadId?: string }) {
    return db.patientIntakePacket.create({
      data: {
        tenantId: t.id, patientId: identity.patientId ?? null, leadId: identity.leadId ?? null,
        status: 'sent', source: 'staff',
        sections: { create: [{ tenantId: t.id, sectionType: 'communication_consent', status: 'pending' }] },
      },
      select: { id: true },
    });
  }

  const submit = (t: T, packetId: string) => runInTenantContext(
    { tenantId: t.id, actorId: 'worker:test-optout-fence', actorRole: 'WORKER', source: 'worker' },
    () => submitSection(t.id, packetId, 'communication_consent', { sms: false }, { source: 'intake_public' }),
  );

  it('a patient-bound packet blocks on the patient fence and suppresses a racing claim', async () => {
    const t = await makeTenant();
    const phone = '+15556100007';
    const patient = await makePatient(t, phone);
    const packet = await makePacket(t, { patientId: patient.id });
    const campaign = await makeCampaign(t);

    const outcome = await proveFencedWriter({
      fenceKeys: [identityFenceKey(t.id, 'patient', patient.id)],
      write: () => submit(t, packet.id),
      table: 'CommunicationConsent',
      rowsWritten: () => db.communicationConsent.count({ where: { tenantId: t.id, patientId: patient.id, channel: 'sms', status: 'opted_out' } }),
      racer: () => claim(t, campaign.id, { channel: 'sms', patientId: patient.id, leadId: null, destination: phone }),
    });

    expect(outcome.outcome).toBe('suppressed');
    expect(await db.campaignSubmissionClaim.count({ where: { tenantId: t.id } })).toBe(0);
  }, 30_000);

  it('a lead-bound packet blocks on the LEAD fence and suppresses a racing claim for that lead', async () => {
    // Intake is frequently pre-patient. The identity fence has to follow
    // whichever of the two the packet is actually bound to.
    const t = await makeTenant();
    const phone = '+15556100008';
    const lead = await db.lead.create({
      data: { tenantId: t.id, name: 'Pre Patient', phone, channel: 'CALL', service: 'Consult', stage: 'new', source: 'web' },
      select: { id: true },
    });
    const packet = await makePacket(t, { leadId: lead.id });
    const campaign = await makeCampaign(t);

    const outcome = await proveFencedWriter({
      fenceKeys: [identityFenceKey(t.id, 'lead', lead.id)],
      write: () => submit(t, packet.id),
      table: 'CommunicationConsent',
      rowsWritten: () => db.communicationConsent.count({ where: { tenantId: t.id, leadId: lead.id, channel: 'sms', status: 'opted_out' } }),
      racer: () => claim(t, campaign.id, { channel: 'sms', patientId: null, leadId: lead.id, destination: phone }),
    });

    expect(outcome.outcome).toBe('suppressed');
    expect(await db.campaignSubmissionClaim.count({ where: { tenantId: t.id } })).toBe(0);
  }, 30_000);

  it('does not fence a section submission that records no opt-out', async () => {
    // The fence guards the CommunicationConsent write. A submission with no
    // `false` answer writes no opt-out, so it must not queue behind an
    // unrelated dispatcher for this patient.
    const t = await makeTenant();
    const patient = await makePatient(t, '+15556100009');
    const packet = await makePacket(t, { patientId: patient.id });

    await proveUnrelatedKeyDoesNotBlock(
      [identityFenceKey(t.id, 'patient', patient.id)],
      () => runInTenantContext(
        { tenantId: t.id, actorId: 'worker:test-optout-fence', actorRole: 'WORKER', source: 'worker' },
        () => submitSection(t.id, packet.id, 'communication_consent', { sms: true }, { source: 'intake_public' }),
      ),
    );
    // And it recorded nothing, exactly as before: a checked box never grants.
    expect(await db.communicationConsent.count({ where: { tenantId: t.id, patientId: patient.id } })).toBe(0);
  }, 30_000);
});

// ===========================================================================
// 4. Staff-entered consent — patients POST /:id/consents (identity-keyed)
// ===========================================================================
describe('patients POST /:id/consents — ConsentEvent takes the patient identity fence', () => {
  it('blocks on the patient fence, writes nothing while held, and a racing claim is suppressed', async () => {
    const t = await makeTenant();
    const phone = '+15556100010';
    const patient = await makePatient(t, phone);
    const campaign = await makeCampaign(t);

    const outcome = await proveFencedWriter({
      fenceKeys: [identityFenceKey(t.id, 'patient', patient.id)],
      write: async () => {
        const res = await app.inject({
          method: 'POST', url: `/v1/patients/${patient.id}/consents`, headers: staffHeaders(t),
          payload: { purpose: 'SMS', granted: false, source: 'front_desk_verbal' },
        });
        expect(res.statusCode).toBe(201);
        return res;
      },
      table: 'ConsentEvent',
      rowsWritten: () => db.consentEvent.count({ where: { tenantId: t.id, patientId: patient.id, purpose: 'SMS' } }),
      racer: () => claim(t, campaign.id, { channel: 'sms', patientId: patient.id, leadId: null, destination: phone }),
    });

    expect(outcome.outcome).toBe('suppressed');
    expect(await db.campaignSubmissionClaim.count({ where: { tenantId: t.id } })).toBe(0);
  }, 30_000);

  it('is not held up by a fence on a different patient, and still 404s a patient outside the tenant', async () => {
    const t = await makeTenant();
    const patient = await makePatient(t, '+15556100011');
    const other = await makePatient(t, '+15556100012');

    const res = await proveUnrelatedKeyDoesNotBlock(
      [identityFenceKey(t.id, 'patient', other.id)],
      () => app.inject({
        method: 'POST', url: `/v1/patients/${patient.id}/consents`, headers: staffHeaders(t),
        payload: { purpose: 'SMS', granted: false, source: 'front_desk_verbal' },
      }),
    );
    expect((res as { statusCode: number }).statusCode).toBe(201);

    // The ownership check still runs first and is unchanged by the fence: an
    // unknown patient is refused without ever reaching a lock or a write.
    const foreign = await app.inject({
      method: 'POST', url: `/v1/patients/${randomUUID()}/consents`, headers: staffHeaders(t),
      payload: { purpose: 'SMS', granted: false, source: 'front_desk_verbal' },
    });
    expect(foreign.statusCode).toBe(404);
  }, 30_000);
});

// ===========================================================================
// 5. /v1/patients/summary reads the tenant's GrowthPolicy, not two literals.
// ===========================================================================
describe('patients summary sources its thresholds from GrowthPolicy', () => {
  async function seedPatients(t: T) {
    // 55 is the whole point: at-risk on CRM (>= 50), healthy on the old server
    // count (>= 60). 4000 is the exact-boundary patient the old `>` dropped.
    await makePatient(t, null, { churnRisk: 55, lifetimeValue: 100 });
    await makePatient(t, null, { churnRisk: 85, lifetimeValue: 100 });
    await makePatient(t, null, { churnRisk: 10, lifetimeValue: 4000 });
    await makePatient(t, null, { churnRisk: 10, lifetimeValue: 9000 });
  }
  const summary = (t: T) => app.inject({ method: 'GET', url: '/v1/patients/summary', headers: staffHeaders(t) });

  it('with no stored policy, applies the inclusive code defaults (churn >= 50, ltv >= 4000)', async () => {
    const t = await makeTenant();
    await seedPatients(t);
    const body = (await summary(t)).json();
    // >= 50 now counts the 55 the old >= 60 dropped. This is the convergence.
    expect(body.highRiskCount).toBe(2);
    // >= 4000 now counts the patient sitting exactly on the threshold.
    expect(body.highLifetimeValueCount).toBe(2);
  });

  it('a tenant that raises churnRiskHigh gets a different highRiskCount', async () => {
    const t = await makeTenant();
    await seedPatients(t);
    expect((await summary(t)).json().highRiskCount).toBe(2);

    await db.growthPolicy.create({ data: { tenantId: t.id, churnRiskHigh: 80 } });
    expect((await summary(t)).json().highRiskCount).toBe(1); // only the 85

    await db.growthPolicy.update({ where: { tenantId: t.id }, data: { churnRiskHigh: 5 } });
    expect((await summary(t)).json().highRiskCount).toBe(4);
  });

  it('a tenant that raises highValuePatientLtv gets a different highLifetimeValueCount', async () => {
    const t = await makeTenant();
    await seedPatients(t);
    expect((await summary(t)).json().highLifetimeValueCount).toBe(2);

    await db.growthPolicy.create({ data: { tenantId: t.id, highValuePatientLtv: 9000 } });
    // Still inclusive: the 9000 patient counts, the 4000 one no longer does.
    expect((await summary(t)).json().highLifetimeValueCount).toBe(1);
  });

  it('one tenant\'s policy never moves another tenant\'s counts', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    await seedPatients(a);
    await seedPatients(b);
    await db.growthPolicy.create({ data: { tenantId: a.id, churnRiskHigh: 90 } });
    expect((await summary(a)).json().highRiskCount).toBe(0);
    expect((await summary(b)).json().highRiskCount).toBe(2);
  });
});
