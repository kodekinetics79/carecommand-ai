import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { UserRole } from '../generated/prisma/enums';

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
const { INTAKE_ACKNOWLEDGEMENTS, issueIntakeToken } = await import('../lib/intake');
const { issuePortalSession } = await import('../lib/portalAuth');
const { runWithTenantContext } = await import('../lib/tenantContext');

let app: FastifyInstance;
const tenantIds: string[] = [];
const databaseCleanup: Array<() => Promise<void>> = [];

async function makeTenant() {
  const id = randomUUID();
  tenantIds.push(id);
  await db.tenant.create({ data: { id, name: `intake-${id.slice(0, 8)}`, slug: `intake-${id.slice(0, 8)}` } });
  const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { key: 'enterprise' } });
  await db.tenantSubscription.create({ data: { tenantId: id, planId: plan.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(id, db);
  const branchA = await db.branch.create({ data: { tenantId: id, name: 'Branch A', location: 'A', timezone: 'UTC' } });
  const branchB = await db.branch.create({ data: { tenantId: id, name: 'Branch B', location: 'B', timezone: 'UTC' } });
  const patientA = await db.patient.create({ data: { tenantId: id, branchId: branchA.id, firstName: 'Alex', lastName: 'A', lifecycleStage: 'ACTIVE' } });
  const patientB = await db.patient.create({ data: { tenantId: id, branchId: branchB.id, firstName: 'Blair', lastName: 'B', lifecycleStage: 'ACTIVE' } });
  const appointmentA = await db.appointment.create({ data: { tenantId: id, branchId: branchA.id, patientId: patientA.id, service: 'Visit A', startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 88_200_000), channel: 'EMAIL' } });
  const appointmentB = await db.appointment.create({ data: { tenantId: id, branchId: branchB.id, patientId: patientB.id, service: 'Visit B', startsAt: new Date(Date.now() + 172_800_000), endsAt: new Date(Date.now() + 174_600_000), channel: 'EMAIL' } });
  const users = {} as Record<'providerA' | 'frontA' | 'auditor', { id: string; role: UserRole; branchId: string | null }>;
  for (const [key, role, branchId] of [
    ['providerA', 'PROVIDER', branchA.id],
    ['frontA', 'FRONT_DESK', branchA.id],
    ['auditor', 'AUDITOR', null],
  ] as const) {
    const row = await db.user.create({ data: { tenantId: id, branchId, role, active: true, email: `${key}-${id.slice(0, 8)}@intake.test`, displayName: key } });
    users[key] = { id: row.id, role, branchId };
  }
  return { id, branchA, branchB, patientA, patientB, appointmentA, appointmentB, users };
}

function headers(t: { id: string }, user: { id: string; role: UserRole; branchId: string | null }) {
  return { authorization: `Bearer ${app.jwt.sign({ userId: user.id, tenantId: t.id, role: user.role, branchId: user.branchId, type: 'access' })}`, 'x-forwarded-for': '203.0.113.41' };
}

async function makePacket(tenantId: string, patientId: string, appointmentId: string, sectionTypes = ['demographics']) {
  return db.patientIntakePacket.create({
    data: {
      tenantId, patientId, appointmentId, status: 'sent', source: 'staff',
      sections: { create: sectionTypes.map(sectionType => ({ tenantId, sectionType, status: 'pending' })) },
    },
  });
}

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const cleanup of databaseCleanup.reverse()) await cleanup().catch(() => {});
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await db.$disconnect();
});

async function installAuditFailure(tenantId: string, condition: string) {
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `test_intake_audit_fail_fn_${suffix}`;
  const triggerName = `test_intake_audit_fail_trg_${suffix}`;
  await db.$executeRawUnsafe(`
    CREATE FUNCTION public."${functionName}"() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW."tenantId" = '${tenantId}'::uuid AND (${condition}) THEN
        RAISE EXCEPTION 'injected mandatory public intake audit failure';
      END IF;
      RETURN NEW;
    END
    $fn$
  `);
  await db.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON public."AuditEvent" FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()`);
  const remove = async () => {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."AuditEvent"`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
  };
  databaseCleanup.push(remove);
  return async () => { await remove(); databaseCleanup.pop(); };
}

describe('authenticated intake authorization and branch boundaries', () => {
  it('uses dedicated read/write permissions, scopes every packet surface, and audits reads', async () => {
    const t = await makeTenant();
    const packetA = await makePacket(t.id, t.patientA.id, t.appointmentA.id);
    const packetB = await makePacket(t.id, t.patientB.id, t.appointmentB.id);

    const providerRead = await app.inject({ method: 'GET', url: '/v1/intake/packets', headers: headers(t, t.users.providerA) });
    expect(providerRead.statusCode).toBe(200);
    expect(providerRead.json().map((row: { intakePacketId: string }) => row.intakePacketId)).toEqual([packetA.id]);
    expect(await db.auditEvent.findFirst({ where: { tenantId: t.id, actorUserId: t.users.providerA.id, action: 'intake.packets.read' } })).not.toBeNull();

    const providerWrite = await app.inject({ method: 'POST', url: '/v1/intake/packets', headers: headers(t, t.users.providerA), payload: { patientId: t.patientA.id, issueToken: false } });
    expect(providerWrite.statusCode).toBe(403);
    expect(providerWrite.json()).toMatchObject({ error: 'insufficient_permission', permission: 'intake:write' });

    const auditorRead = await app.inject({ method: 'GET', url: '/v1/intake/packets', headers: headers(t, t.users.auditor) });
    expect(auditorRead.statusCode).toBe(403);
    expect(auditorRead.json()).toMatchObject({ error: 'insufficient_permission', permission: 'intake:read' });

    const crossPacket = await app.inject({ method: 'GET', url: `/v1/intake/packets/${packetB.id}`, headers: headers(t, t.users.frontA) });
    expect(crossPacket.statusCode).toBe(403);
    const crossAppointment = await app.inject({ method: 'GET', url: `/v1/intake/appointment/${t.appointmentB.id}`, headers: headers(t, t.users.frontA) });
    expect(crossAppointment.statusCode).toBe(403);
    const crossReview = await app.inject({ method: 'PATCH', url: `/v1/intake/packets/${packetB.id}/review`, headers: headers(t, t.users.frontA), payload: { action: 'approve' } });
    expect(crossReview.statusCode).toBe(403);
    expect((await db.patientIntakePacket.findUniqueOrThrow({ where: { id: packetB.id } })).status).toBe('sent');

    const crossCreate = await app.inject({ method: 'POST', url: '/v1/intake/packets', headers: headers(t, t.users.frontA), payload: { appointmentId: t.appointmentB.id, issueToken: false } });
    expect(crossCreate.statusCode).toBe(403);
    const ownCreate = await app.inject({ method: 'POST', url: '/v1/intake/packets', headers: headers(t, t.users.frontA), payload: { patientId: t.patientA.id, issueToken: false } });
    expect(ownCreate.statusCode).toBe(201);
  });
});

describe('versioned intake acknowledgements', () => {
  it('requires accepted:true and the exact approved identifier, then persists canonical evidence', async () => {
    const t = await makeTenant();
    const account = await db.patientPortalAccount.create({ data: { tenantId: t.id, patientId: t.patientA.id, status: 'active', email: `portal-${t.id.slice(0, 8)}@intake.test` } });
    const packet = await makePacket(t.id, t.patientA.id, t.appointmentA.id, ['payment_policy', 'estimate_acknowledgement']);
    const portalHeaders = { authorization: `Bearer ${await issuePortalSession(app, account, db)}` };

    const view = await app.inject({ method: 'GET', url: `/v1/portal/intake/${packet.id}`, headers: portalHeaders });
    expect(view.statusCode).toBe(200);
    const sections = view.json().sections as Array<{ sectionType: string; acknowledgement: { id: string; version: string; text: string } | null }>;

    for (const sectionType of ['payment_policy', 'estimate_acknowledgement'] as const) {
      const acknowledgement = sections.find(row => row.sectionType === sectionType)?.acknowledgement;
      expect(acknowledgement).toEqual(INTAKE_ACKNOWLEDGEMENTS[sectionType]);
      const url = `/v1/portal/intake/${packet.id}/sections`;

      const omitted = await app.inject({ method: 'POST', url, headers: portalHeaders, payload: { sectionType, data: { acknowledgementId: acknowledgement!.id } } });
      expect(omitted.statusCode).toBe(400);
      const declined = await app.inject({ method: 'POST', url, headers: portalHeaders, payload: { sectionType, data: { accepted: false, acknowledgementId: acknowledgement!.id } } });
      expect(declined.statusCode).toBe(400);
      const stale = await app.inject({ method: 'POST', url, headers: portalHeaders, payload: { sectionType, data: { accepted: true, acknowledgementId: `${sectionType}:obsolete` } } });
      expect(stale.statusCode).toBe(400);
      expect(await db.patientConsentRecord.count({ where: { tenantId: t.id, packetId: packet.id, consentType: sectionType } })).toBe(0);

      const accepted = await app.inject({ method: 'POST', url, headers: portalHeaders, payload: { sectionType, data: { accepted: true, acknowledgementId: acknowledgement!.id, consentText: 'client-controlled text' } } });
      expect(accepted.statusCode).toBe(200);
      const evidence = await db.patientConsentRecord.findFirstOrThrow({ where: { tenantId: t.id, packetId: packet.id, consentType: sectionType } });
      expect(evidence).toMatchObject({ status: 'accepted', version: acknowledgement!.version, consentTextSnapshot: acknowledgement!.text });
      const stored = await db.patientIntakeSection.findFirstOrThrow({ where: { packetId: packet.id, sectionType } });
      expect(stored.data).toEqual({ accepted: true, acknowledgementId: acknowledgement!.id, version: acknowledgement!.version });
    }
  });
});

describe('public intake mandatory audit durability', () => {
  it('fails closed on a public packet read when access audit persistence fails, then succeeds on retry', async () => {
    const t = await makeTenant();
    const packet = await makePacket(t.id, t.patientA.id, t.appointmentA.id);
    const token = await runWithTenantContext(t.id, () => issueIntakeToken(t.id, packet.id), { id: t.users.frontA.id, role: 'FRONT_DESK' });
    const removeFault = await installAuditFailure(t.id, "NEW.action = 'intake.public_token.used'");

    const failed = await app.inject({ method: 'GET', url: `/v1/intake/public/${token}` });
    expect(failed.statusCode).toBe(500);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, action: 'intake.public_token.used', resourceId: packet.id } })).toBe(0);

    await removeFault();
    const retry = await app.inject({ method: 'GET', url: `/v1/intake/public/${token}` });
    expect(retry.statusCode).toBe(200);
    expect(await db.auditEvent.count({ where: { tenantId: t.id, action: 'intake.public_token.used', resourceId: packet.id } })).toBe(1);
  });

  it('rolls back public submission when the public submission audit fails, then processes the same token once', async () => {
    const t = await makeTenant();
    const packet = await makePacket(t.id, t.patientA.id, t.appointmentA.id);
    const token = await runWithTenantContext(t.id, () => issueIntakeToken(t.id, packet.id), { id: t.users.frontA.id, role: 'FRONT_DESK' });
    const before = await db.patientIntakePacket.findUniqueOrThrow({ where: { id: packet.id } });
    const removeFault = await installAuditFailure(t.id, "NEW.action = 'intake.packet.submitted' AND NEW.metadata->>'source' = 'public_token'");

    const failed = await app.inject({ method: 'POST', url: `/v1/intake/public/${token}/submit` });
    expect(failed.statusCode).toBe(500);
    const rolledBack = await db.patientIntakePacket.findUniqueOrThrow({ where: { id: packet.id } });
    expect(rolledBack.status).toBe(before.status);
    expect(rolledBack.submittedAt).toBeNull();
    expect(await db.auditEvent.count({ where: { tenantId: t.id, action: 'intake.packet.submitted', resourceId: packet.id } })).toBe(0);

    await removeFault();
    const retry = await app.inject({ method: 'POST', url: `/v1/intake/public/${token}/submit` });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ submitted: true, alreadySubmitted: false });
    expect((await db.patientIntakePacket.findUniqueOrThrow({ where: { id: packet.id } })).submittedAt).not.toBeNull();
    expect(await db.auditEvent.count({ where: { tenantId: t.id, action: 'intake.packet.submitted', resourceId: packet.id } })).toBe(2);
  });
});
