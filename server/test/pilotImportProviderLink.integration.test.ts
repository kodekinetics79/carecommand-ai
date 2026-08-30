import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
const { signPlatformToken } = await import('../lib/platformAuth');
const { generatePasswordHash } = await import('../lib/security');

// Appointment.providerProfileId is what the double-booking exclusion constraint
// binds on, and what every conflict, availability and past-date guard reads
// before doing anything. The pilot importer wrote only the legacy free-text
// providerRef, so every imported appointment was invisible to all of it — the
// Front Office audit booked one patient into the same slot twice and pushed a
// confirmed appointment back into 2019, purely because the rows carried no
// provider. A practice migrating off another system landed its whole history
// that way.

let app: FastifyInstance;
const cleanup: Array<() => Promise<void>> = [];

beforeAll(async () => { app = await buildApp(); }, 90_000);

afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn().catch(() => {});
  await app?.close();
  await db.$disconnect();
});

async function pilotTenant({ openSession = true }: { openSession?: boolean } = {}) {
  const tenantId = randomUUID();
  const platformUserId = randomUUID();
  const tag = tenantId.slice(0, 8);

  await db.platformUser.create({
    data: {
      id: platformUserId,
      email: `ops-${tag}@carecommand.test`,
      name: 'Pilot Operator',
      passwordHash: await generatePasswordHash('pilot-password-123'),
      role: 'PLATFORM_ADMIN',
      status: 'active',
    },
  });
  await db.tenant.create({ data: { id: tenantId, name: `Link ${tag}`, slug: `link-${tag}` } });
  cleanup.push(async () => { await db.platformAuditEvent.deleteMany({ where: { tenantId } }).catch(() => {}); });
  cleanup.push(async () => { await db.tenant.delete({ where: { id: tenantId } }).catch(() => {}); });
  cleanup.push(async () => { await db.platformUser.delete({ where: { id: platformUserId } }).catch(() => {}); });

  const branch = await db.branch.create({ data: { tenantId, name: 'Main', location: 'Main', timezone: 'America/Chicago' } });
  const user = await db.user.create({
    data: {
      tenantId, role: 'PROVIDER', active: true,
      email: `dr.reyes-${tag}@clinic.test`, displayName: 'Dr Ana Reyes',
      passwordHash: await generatePasswordHash('provider-password-123'),
    },
  });
  const provider = await db.providerProfile.create({
    data: { tenantId, branchId: branch.id, userId: user.id, specialty: 'General' },
  });
  await db.patient.create({
    data: { tenantId, branchId: branch.id, firstName: 'Sam', lastName: 'Ortiz', externalRef: 'PAT-1', lifecycleStage: 'ACTIVE' },
  });

  const headers = {
    authorization: `Bearer ${signPlatformToken(app, { id: platformUserId, role: 'PLATFORM_ADMIN' })}`,
    'content-type': 'application/json',
  };

  // Pilot import reads and writes the clinic's patient and appointment rows, so
  // it now requires a live break-glass session the same way the staff roster
  // does. Opening one is part of the operator flow, not test scaffolding.
  if (openSession) {
    const session = await app.inject({
      method: 'POST', url: `/v1/platform/tenants/${tenantId}/support-session`, headers,
      payload: { reason: 'Pilot data import for onboarding', minutes: 60 },
    });
    if (session.statusCode >= 400) throw new Error(`could not open a support session: ${session.statusCode} ${session.body}`);
    cleanup.push(async () => { await db.supportAccessSession.deleteMany({ where: { tenantId } }).catch(() => {}); });
  }

  return { tenantId, branch, provider, user, headers };
}

function commit(tenantId: string, headers: Record<string, string>, csvText: string) {
  return app.inject({
    method: 'POST',
    url: `/v1/platform/tenants/${tenantId}/pilot-import/appointments/commit`,
    headers,
    payload: JSON.stringify({ csvText, mapping: {} }),
  });
}

const HEADER = 'patient_external_ref,service,starts_at,ends_at,branch_name,provider';

describe('pilot import — provider linkage', () => {
  it('links an imported appointment to the real provider, by display name', async () => {
    const { tenantId, provider, headers } = await pilotTenant();

    const res = await commit(tenantId, headers, [
      HEADER,
      'PAT-1,Annual exam,2026-09-04 09:00,2026-09-04 09:30,Main,Dr Ana Reyes',
    ].join('\n'));

    expect(res.statusCode).toBe(200);
    const appointment = await db.appointment.findFirstOrThrow({ where: { tenantId } });
    // The whole point: the canonical link, not just the free-text ref.
    expect(appointment.providerProfileId).toBe(provider.id);
    expect(appointment.providerRef).toBe('Dr Ana Reyes');
  }, 90_000);

  it('links by login email and by profile id too, since clinics export different keys', async () => {
    const { tenantId, provider, user, headers } = await pilotTenant();

    const res = await commit(tenantId, headers, [
      HEADER,
      `PAT-1,Follow up,2026-09-05 09:00,2026-09-05 09:30,Main,${user.email}`,
      `PAT-1,Review,2026-09-06 09:00,2026-09-06 09:30,Main,${provider.id}`,
    ].join('\n'));

    expect(res.statusCode).toBe(200);
    const appointments = await db.appointment.findMany({ where: { tenantId }, orderBy: { startsAt: 'asc' } });
    expect(appointments).toHaveLength(2);
    for (const appointment of appointments) expect(appointment.providerProfileId).toBe(provider.id);
  }, 90_000);

  it('reports a reference it could not match instead of importing it silently', async () => {
    const { tenantId, headers } = await pilotTenant();

    const res = await commit(tenantId, headers, [
      HEADER,
      'PAT-1,Annual exam,2026-09-04 09:00,2026-09-04 09:30,Main,SYN-PROVIDER-2',
    ].join('\n'));

    expect(res.statusCode).toBe(200);
    const body = res.json() as { summary: { providersUnmatched: number }; unmatchedProviderRefs: string[] };
    // Naming it is the point. An unlinked appointment is outside every
    // scheduling guard, and the clinic has to be able to find and fix it.
    expect(body.unmatchedProviderRefs).toContain('SYN-PROVIDER-2');
    expect(body.summary.providersUnmatched).toBe(1);

    const appointment = await db.appointment.findFirstOrThrow({ where: { tenantId } });
    expect(appointment.providerProfileId).toBeNull();
    expect(appointment.providerRef).toBe('SYN-PROVIDER-2');
  }, 90_000);

  it('brings imported appointments inside the double-booking constraint', async () => {
    // The payoff. With a provider attached the database itself refuses the
    // second booking of the same slot; with NULL it accepted both, which is how
    // the audit double-booked a patient.
    const { tenantId, branch, provider, headers } = await pilotTenant();

    const res = await commit(tenantId, headers, [
      HEADER,
      'PAT-1,Annual exam,2026-09-04 09:00,2026-09-04 09:30,Main,Dr Ana Reyes',
    ].join('\n'));
    expect(res.statusCode).toBe(200);

    const imported = await db.appointment.findFirstOrThrow({ where: { tenantId } });
    expect(imported.providerProfileId).toBe(provider.id);

    const patient = await db.patient.findFirstOrThrow({ where: { tenantId } });
    await expect(db.appointment.create({
      data: {
        tenantId, branchId: branch.id, patientId: patient.id,
        providerProfileId: provider.id,
        service: 'Conflicting visit',
        startsAt: imported.startsAt, endsAt: imported.endsAt,
        channel: 'EMAIL',
      },
    })).rejects.toThrow();
  }, 90_000);

  /**
   * Pilot import is the only platform capability that reads and writes a
   * clinic's patient and appointment rows. It ran on the operator's identity
   * alone: no reason recorded, no expiry, nothing the clinic could see
   * afterwards. It now needs the same break-glass session the staff roster does.
   */
  it('refuses to touch clinic data without an open support session, and says how to get one', async () => {
    const { tenantId, headers } = await pilotTenant({ openSession: false });
    const res = await commit(tenantId, headers, [
      'external_ref,first_name,last_name',
      'PAT-2,Rosa,Marin',
    ].join('\n'));
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('support_session_required');
    expect(String(res.json().message)).toMatch(/support session/i);
  });

  it('refuses the checklist read too - the guard is on the workspace, not on one route', async () => {
    const { tenantId, headers } = await pilotTenant({ openSession: false });
    const res = await app.inject({ method: 'GET', url: `/v1/platform/tenants/${tenantId}/pilot-checklist`, headers });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('support_session_required');
  });
});
