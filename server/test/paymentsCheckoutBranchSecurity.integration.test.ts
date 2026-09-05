import 'dotenv/config';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

let app: FastifyInstance;
const tenants: string[] = [];
const databaseCleanup: Array<() => Promise<void>> = [];

async function fixture() {
  const tenantId = randomUUID();
  tenants.push(tenantId);
  await db.tenant.create({ data: { id: tenantId, name: `Checkout ${tenantId.slice(0, 6)}`, slug: `checkout-${tenantId.slice(0, 8)}` } });
  await db.tenantFeatureEntitlement.createMany({ data: [
    { tenantId, featureKey: 'appointments', enabled: true, source: 'test' },
    { tenantId, featureKey: 'payments_deposits', enabled: true, source: 'test' },
  ] });
  const [branchA, branchB] = await Promise.all([
    db.branch.create({ data: { tenantId, name: 'Branch A', location: 'A' } }),
    db.branch.create({ data: { tenantId, name: 'Branch B', location: 'B' } }),
  ]);
  const admin = await db.user.create({ data: { tenantId, branchId: branchA.id, role: 'ADMIN', email: `checkout-${tenantId.slice(0, 8)}@example.test`, displayName: 'Branch Admin', active: true } });
  const [patientA, patientB] = await Promise.all([
    db.patient.create({ data: { tenantId, branchId: branchA.id, firstName: 'Synthetic', lastName: 'Alpha', lifecycleStage: 'ACTIVE' } }),
    db.patient.create({ data: { tenantId, branchId: branchB.id, firstName: 'Synthetic', lastName: 'Beta', lifecycleStage: 'ACTIVE' } }),
  ]);
  const startsAt = new Date(Date.now() + 86_400_000);
  const [appointmentA, appointmentB] = await Promise.all([
    db.appointment.create({ data: { tenantId, branchId: branchA.id, patientId: patientA.id, service: 'Consultation', startsAt, endsAt: new Date(startsAt.getTime() + 1_800_000), channel: 'EMAIL' } }),
    db.appointment.create({ data: { tenantId, branchId: branchB.id, patientId: patientB.id, service: 'Consultation', startsAt, endsAt: new Date(startsAt.getTime() + 1_800_000), channel: 'EMAIL' } }),
  ]);
  const [requestA, requestB] = await Promise.all([
    db.paymentRequest.create({ data: { tenantId, branchId: branchA.id, patientId: patientA.id, appointmentId: appointmentA.id, amount: 25, status: 'link_sent', reason: 'Deposit', mode: 'mock', paymentUrl: 'https://pay.example/a' } }),
    db.paymentRequest.create({ data: { tenantId, branchId: branchB.id, patientId: patientB.id, appointmentId: appointmentB.id, amount: 30, status: 'link_sent', reason: 'Deposit', mode: 'mock', paymentUrl: 'https://pay.example/b' } }),
  ]);
  const requirementB = await db.depositRequirement.create({ data: { tenantId, branchId: branchB.id, patientId: patientB.id, appointmentId: appointmentB.id, status: 'required', requiredAmount: 30, reason: 'Deposit', mode: 'mock' } });
  const token = app.jwt.sign({ userId: admin.id, tenantId, branchId: branchA.id, role: 'ADMIN', type: 'access' });
  return {
    tenantId,
    branchA,
    appointmentA,
    appointmentB,
    requestA,
    requestB,
    requirementB,
    headers: {
      authorization: `Bearer ${token}`,
      'x-carecommand-clinic-id': branchA.id,
    },
  };
}

beforeAll(async () => { app = await buildApp(); }, 60_000);
afterAll(async () => {
  for (const cleanup of databaseCleanup.reverse()) await cleanup().catch(() => {});
  for (const tenantId of tenants) await db.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  await app.close();
  await db.$disconnect();
});

async function createLinkTarget(t: Awaited<ReturnType<typeof fixture>>) {
  const source = await db.appointment.findUniqueOrThrow({ where: { id: t.appointmentA.id }, select: { patientId: true } });
  const startsAt = new Date(Date.now() + 172_800_000);
  const appointment = await db.appointment.create({
    data: {
      tenantId: t.tenantId,
      branchId: t.branchA.id,
      patientId: source.patientId,
      service: 'Synthetic checkout race',
      startsAt,
      endsAt: new Date(startsAt.getTime() + 1_800_000),
      channel: 'EMAIL',
      value: 100,
    },
  });
  const requirement = await db.depositRequirement.create({
    data: {
      tenantId: t.tenantId,
      branchId: t.branchA.id,
      patientId: source.patientId,
      appointmentId: appointment.id,
      status: 'required',
      requiredAmount: 25,
      reason: 'Synthetic concurrency deposit',
      mode: 'mock',
    },
  });
  return { appointment, requirement };
}

describe('appointment checkout branch isolation', () => {
  it('limits payment reads and queues to the authenticated branch and audits successful reads', async () => {
    const t = await fixture();
    const own = await app.inject({ method: 'GET', url: `/v1/payments/appointments/${t.appointmentA.id}/payment`, headers: t.headers });
    const foreign = await app.inject({ method: 'GET', url: `/v1/payments/appointments/${t.appointmentB.id}/payment`, headers: t.headers });
    expect(own.statusCode).toBe(200);
    expect(foreign.statusCode).toBe(404);

    const queue = await app.inject({ method: 'GET', url: '/v1/payments/payment-requests', headers: t.headers });
    expect(queue.statusCode).toBe(200);
    expect((queue.json() as Array<{ paymentRequestId: string }>).map(row => row.paymentRequestId)).toEqual([t.requestA.id]);
    expect(queue.body).not.toContain(t.requestB.id);
    expect(await db.auditEvent.count({ where: { tenantId: t.tenantId, action: { in: ['payment.appointment.read', 'payment.queue.read'] } } })).toBe(2);
  });

  it('denies cross-branch deposit evaluation, link generation, and waiver by object id', async () => {
    const t = await fixture();
    const deposit = await app.inject({ method: 'POST', url: `/v1/payments/appointments/${t.appointmentB.id}/deposit`, headers: t.headers });
    const link = await app.inject({ method: 'POST', url: `/v1/payments/appointments/${t.appointmentB.id}/payment-link`, headers: t.headers });
    const waive = await app.inject({ method: 'POST', url: `/v1/payments/deposit-requirements/${t.requirementB.id}/waive`, headers: t.headers, payload: { reason: 'Not authorized here' } });
    expect([deposit.statusCode, link.statusCode, waive.statusCode]).toEqual([404, 404, 404]);
    expect((await db.depositRequirement.findUniqueOrThrow({ where: { id: t.requirementB.id } })).status).toBe('required');
  });

  it('serializes concurrent payment-link generation to one active local request', async () => {
    const t = await fixture();
    const target = await createLinkTarget(t);
    const url = `/v1/payments/appointments/${target.appointment.id}/payment-link`;

    const responses = await Promise.all([
      app.inject({ method: 'POST', url, headers: t.headers }),
      app.inject({ method: 'POST', url, headers: t.headers }),
    ]);

    expect(responses.every(response => [200, 201, 202].includes(response.statusCode))).toBe(true);
    expect(responses.some(response => [200, 201].includes(response.statusCode) && response.json().status === 'link_created')).toBe(true);
    const requests = await db.paymentRequest.findMany({ where: { tenantId: t.tenantId, appointmentId: target.appointment.id } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.status).toBe('link_sent');
    expect(requests[0]?.paymentUrl).toBeTruthy();
    const linked = await db.depositRequirement.findUniqueOrThrow({ where: { id: target.requirement.id } });
    expect(linked.status).toBe('link_sent');
    expect(linked.paymentRequestId).toBe(requests[0]?.id);
    expect(await db.auditEvent.count({ where: { tenantId: t.tenantId, resourceId: requests[0]?.id, action: { in: ['payment.request.created', 'payment.link.created'] } } })).toBe(2);
    expect(await db.businessEvent.count({ where: { tenantId: t.tenantId, entityId: requests[0]?.id, eventType: { in: ['payment.request.created', 'payment.link.created'] } } })).toBe(2);
  });

  it('rolls back local completion on audit failure and resumes from durable provider reconciliation without a duplicate request', async () => {
    const t = await fixture();
    const target = await createLinkTarget(t);
    const suffix = randomUUID().replaceAll('-', '');
    const sequenceName = `test_checkout_audit_fail_seq_${suffix}`;
    const functionName = `test_checkout_audit_fail_fn_${suffix}`;
    const triggerName = `test_checkout_audit_fail_trg_${suffix}`;
    await db.$executeRawUnsafe(`CREATE SEQUENCE public."${sequenceName}"`);
    await db.$executeRawUnsafe(`GRANT USAGE, SELECT, UPDATE ON SEQUENCE public."${sequenceName}" TO app_rls`);
    await db.$executeRawUnsafe(`
      CREATE FUNCTION public."${functionName}"() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW."tenantId" = '${t.tenantId}'::uuid
           AND NEW.action = 'payment.request.created'
           AND nextval('public."${sequenceName}"') = 1 THEN
          RAISE EXCEPTION 'injected checkout audit failure';
        END IF;
        RETURN NEW;
      END
      $fn$
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT ON public."AuditEvent"
      FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()
    `);
    const cleanup = async () => {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."AuditEvent"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${functionName}"()`);
      await db.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS public."${sequenceName}"`);
    };
    databaseCleanup.push(cleanup);

    const url = `/v1/payments/appointments/${target.appointment.id}/payment-link`;
    const first = await app.inject({ method: 'POST', url, headers: t.headers });
    expect(first.statusCode).toBe(503);
    expect(first.json()).toMatchObject({ status: 'reconciliation_required', retryable: true });

    const afterFailure = await db.paymentRequest.findMany({ where: { tenantId: t.tenantId, appointmentId: target.appointment.id } });
    expect(afterFailure).toHaveLength(1);
    expect(afterFailure[0]).toMatchObject({ status: 'reconciliation_required' });
    expect(afterFailure[0]?.paymentUrl).toBeTruthy();
    expect(await db.auditEvent.count({ where: { tenantId: t.tenantId, resourceId: afterFailure[0]?.id, action: { in: ['payment.request.created', 'payment.link.created'] } } })).toBe(0);
    expect(await db.businessEvent.count({ where: { tenantId: t.tenantId, entityId: afterFailure[0]?.id, eventType: { in: ['payment.request.created', 'payment.link.created'] } } })).toBe(0);
    // The reservation is durably linked before calling the provider so that a
    // webhook can reconcile this exact requirement even if local finalization
    // loses the race or rolls back.
    expect(await db.depositRequirement.findUniqueOrThrow({ where: { id: target.requirement.id } })).toMatchObject({
      status: 'required',
      paymentRequestId: afterFailure[0]?.id,
    });

    const retry = await app.inject({ method: 'POST', url, headers: t.headers });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ status: 'link_created', reused: true, checkoutUrl: afterFailure[0]?.paymentUrl });
    const afterRetry = await db.paymentRequest.findMany({ where: { tenantId: t.tenantId, appointmentId: target.appointment.id } });
    expect(afterRetry).toHaveLength(1);
    expect(afterRetry[0]?.id).toBe(afterFailure[0]?.id);
    expect(afterRetry[0]?.status).toBe('link_sent');
    expect(await db.depositRequirement.findUniqueOrThrow({ where: { id: target.requirement.id } })).toMatchObject({
      status: 'link_sent',
      paymentRequestId: afterRetry[0]?.id,
    });
    expect(await db.auditEvent.count({ where: { tenantId: t.tenantId, resourceId: afterRetry[0]?.id, action: { in: ['payment.request.created', 'payment.link.created'] } } })).toBe(2);
    expect(await db.businessEvent.count({ where: { tenantId: t.tenantId, entityId: afterRetry[0]?.id, eventType: { in: ['payment.request.created', 'payment.link.created'] } } })).toBe(2);

    await cleanup();
    databaseCleanup.pop();
  });

  it('fails closed for an abandoned provider reservation instead of creating a duplicate external link', async () => {
    const t = await fixture();
    const target = await createLinkTarget(t);
    const source = await db.appointment.findUniqueOrThrow({ where: { id: target.appointment.id }, select: { patientId: true } });
    const abandoned = await db.paymentRequest.create({
      data: {
        tenantId: t.tenantId,
        branchId: t.branchA.id,
        patientId: source.patientId,
        appointmentId: target.appointment.id,
        amount: 25,
        currency: 'USD',
        status: 'provider_pending',
        reason: 'Synthetic abandoned provider request',
        mode: 'mock',
        publicToken: randomUUID(),
        createdAt: new Date(Date.now() - 180_000),
      },
    });

    const response = await app.inject({ method: 'POST', url: `/v1/payments/appointments/${target.appointment.id}/payment-link`, headers: t.headers });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ status: 'reconciliation_required', retryable: false, paymentRequestId: abandoned.id });
    const requests = await db.paymentRequest.findMany({ where: { tenantId: t.tenantId, appointmentId: target.appointment.id } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.status).toBe('provider_outcome_unknown');
    expect((await db.depositRequirement.findUniqueOrThrow({ where: { id: target.requirement.id } })).status).toBe('required');
  });
});
