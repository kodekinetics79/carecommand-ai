import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ===========================================================================
// The RLS client-argument guard, extended to the no-show threshold's readers.
//
// GrowthPolicy is RLS-enrolled: a read outside tenant context returns NO ROW
// and `getEffectiveGrowthPolicy` silently resolves to the code defaults with
// `source: 'default'` — a fail-open on the tenant's own configuration that
// looks exactly like working code. server/test/advisoryThresholdRls guards the
// advisory read; this suite proves the trap for `noShowRiskHigh` specifically
// and guards the NEW reader this increment added: the eligibility simulation
// in server/modules/revenue-protection.ts, which resolves the tenant's risk
// thresholds through `runWithTenantContext(tenantId, tx => ...)`.
//
// The rule under guard: every `getEffectiveGrowthPolicy` call on a no-show
// classification path hands over a TRANSACTION client. Dropping the argument
// — the exact regression — fails this suite.
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

// The real implementation, wrapped so the CLIENT each caller passes is
// observable. Nothing about the resolution changes.
vi.mock('../modules/growth/service', async importOriginal => {
  const actual = await importOriginal<typeof import('../modules/growth/service')>();
  return { ...actual, getEffectiveGrowthPolicy: vi.fn(actual.getEffectiveGrowthPolicy) };
});

const { buildApp } = await import('../app');
const { fixtureDb } = await import('./helpers/fixtureDb');
const { db } = await import('../lib/db');
const { runWithTenantContext } = await import('../lib/tenantContext');
const { GROWTH_POLICY_DEFAULTS } = await import('../modules/growth/defaults');
const { createInsuranceProvider } = await import('../modules/revenue-protection');
const growthService = await import('../modules/growth/service');

const policySpy = vi.mocked(growthService.getEffectiveGrowthPolicy);

// A value no default anywhere in the product carries, so resolving it can only
// mean the tenant's stored row was actually read.
const CONFIGURED_HIGH = 93;

let app: FastifyInstance;
const tenantIds: string[] = [];

type Tenant = { id: string; ownerId: string; branchId: string; patientId: string; appointmentId: string };

async function makeConfiguredTenant(): Promise<Tenant> {
  const id = randomUUID();
  tenantIds.push(id);
  await fixtureDb.tenant.create({ data: { id, name: `nsrls-${id.slice(0, 6)}`, slug: `nsrls-${id.slice(0, 8)}` } });
  const branch = await fixtureDb.branch.create({ data: { tenantId: id, name: 'Main', location: 'Test' } });
  const owner = await fixtureDb.user.create({
    data: { tenantId: id, role: 'OWNER', active: true, email: `owner-${id.slice(0, 8)}@nsrls.test`, displayName: 'Owner' },
  });
  await fixtureDb.growthPolicy.create({ data: { tenantId: id, noShowRiskHigh: CONFIGURED_HIGH } });
  const patient = await fixtureDb.patient.create({
    data: { tenantId: id, branchId: branch.id, firstName: 'Rls', lastName: 'Guard' },
  });
  // One appointment between the default bound (50) and this tenant's bound
  // (93). It is risky under the DEFAULTS and not under the TENANT's own rule,
  // so a silent fallback to defaults changes the count — and the money.
  const startsAt = new Date(Date.now() + 60 * 60_000);
  const appointment = await fixtureDb.appointment.create({
    data: {
      tenantId: id, branchId: branch.id, patientId: patient.id,
      service: 'Between the bands', startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      channel: 'EMAIL', value: 180, noShowRisk: 70,
    },
  });
  return { id, ownerId: owner.id, branchId: branch.id, patientId: patient.id, appointmentId: appointment.id };
}

const headers = (t: Tenant) => ({
  authorization: `Bearer ${app.jwt.sign({ userId: t.ownerId, tenantId: t.id, role: 'OWNER', type: 'access' })}`,
});

/** An interactive-transaction client, not merely "not db": itx clients carry
 * the model delegates but none of the connection-lifecycle members. */
function expectTransactionClient(clientArg: unknown, label: string) {
  expect(clientArg, `${label}: the policy was read WITHOUT a client — this is the global-client read`).toBeDefined();
  expect(clientArg, `${label}: the policy was read on the GLOBAL client`).not.toBe(db);
  const client = clientArg as Record<string, unknown>;
  const runtime = db as unknown as Record<string, unknown>;
  for (const member of ['$connect', '$disconnect', '$extends'] as const) {
    expect(typeof runtime[member], `precondition: runtime client should expose ${member}`).toBe('function');
    expect(typeof client[member], `${label}: the client passed is not a transaction client (${member})`).toBe('undefined');
  }
  expect(typeof client.growthPolicy).toBe('object');
}

beforeAll(async () => { app = await buildApp(); }, 60_000);
beforeEach(() => { policySpy.mockClear(); });
afterAll(async () => {
  for (const id of tenantIds) await fixtureDb.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await fixtureDb.$disconnect();
});

// ===========================================================================
// 1. The trap, demonstrated for noShowRiskHigh.
// ===========================================================================
describe('GrowthPolicy.noShowRiskHigh under RLS — a read outside tenant context fails OPEN, silently', () => {
  it('resolves the code default instead of the tenant\'s stored 93, with no error at all', async () => {
    const t = await makeConfiguredTenant();

    const stored = await fixtureDb.growthPolicy.findUnique({ where: { tenantId: t.id } });
    expect(stored?.noShowRiskHigh).toBe(CONFIGURED_HIGH);

    const escaped = await growthService.getEffectiveGrowthPolicy(t.id, db);
    expect(escaped.source).toBe('default');
    expect(escaped.noShowRiskHigh).toBe(GROWTH_POLICY_DEFAULTS.noShowRiskHigh);
    expect(escaped.noShowRiskHigh).not.toBe(CONFIGURED_HIGH);

    const scoped = await runWithTenantContext(
      t.id,
      tx => growthService.getEffectiveGrowthPolicy(t.id, tx),
      { id: t.ownerId, role: 'OWNER' },
    );
    expect(scoped.source).toBe('tenant');
    expect(scoped.noShowRiskHigh).toBe(CONFIGURED_HIGH);
  }, 30_000);
});

// ===========================================================================
// 2. The advisory read — transaction client, and the tenant's own rule counted.
// ===========================================================================
describe('advisory no-show classification — reads the policy on a transaction client and applies the tenant\'s rule', () => {
  it('hands getEffectiveGrowthPolicy a transaction client and counts 0 under the tenant\'s 93 bound', async () => {
    const t = await makeConfiguredTenant();
    const res = await app.inject({ method: 'GET', url: '/v1/advisory/brief', headers: headers(t) });
    expect(res.statusCode, res.body).toBe(200);

    expect(policySpy, 'the advisory brief never read the tenant\'s growth policy').toHaveBeenCalled();
    const [tenantArg, clientArg] = policySpy.mock.calls.at(-1)!;
    expect(tenantArg).toBe(t.id);
    expectTransactionClient(clientArg, 'advisory');

    // Behavioural half: the 70-risk appointment counts under the default 50
    // and must NOT count under the tenant's 93. A silent fallback to defaults
    // flips both the count and the $120 it would price into expectedImpact.
    const advisor = res.json().advisors.find((a: { advisorType: string }) => a.advisorType === 'front-desk');
    const line = (advisor.evidence as string[]).find(item => item.startsWith('High no-show risk appointments'))!;
    expect(line).toContain(`stored risk ≥ ${CONFIGURED_HIGH}`);
    expect(line).toContain('configured for this workspace');
    expect(Number(line.match(/: (\d+)\.$/)![1])).toBe(0);
    expect(advisor.expectedImpact).toBe(0);

    // The operations advisor states the same rule — one policy, one context.
    const operations = res.json().advisors.find((a: { advisorType: string }) => a.advisorType === 'operations');
    expect((operations.evidence as string[]).join(' ')).toContain(`stored risk ≥ ${CONFIGURED_HIGH}`);
    expect(policySpy).toHaveBeenCalledTimes(1);
  }, 30_000);
});

// ===========================================================================
// 3. The NEW reader: the revenue-protection eligibility simulation.
// ===========================================================================
describe('revenue-protection risk thresholds — resolved on a transaction client, applying the tenant\'s rule', () => {
  it('the provider self-load hands getEffectiveGrowthPolicy a transaction client', async () => {
    const t = await makeConfiguredTenant();
    const outcome = await createInsuranceProvider().runEligibilityCheck({
      tenantId: t.id,
      branchId: t.branchId,
      appointment: {
        id: t.appointmentId, branchId: t.branchId, service: 'Between the bands',
        startsAt: new Date(), value: 180, noShowRisk: 70,
      },
    });

    expect(policySpy, 'the eligibility simulation never read the tenant\'s growth policy').toHaveBeenCalled();
    const [tenantArg, clientArg] = policySpy.mock.calls.at(-1)!;
    expect(tenantArg).toBe(t.id);
    expectTransactionClient(clientArg, 'revenue-protection');

    // Behavioural half: 70 is high under the code defaults (>= 50) and NOT
    // high under this tenant's 93. Coinsurance is the simulation's observable:
    // 0.25 for high, 0.15 otherwise. A fallback to defaults would answer 0.25.
    expect(outcome.coinsurance).toBe(0.15);

    // And the resolved policy really did come from the tenant's row.
    const resolved = await policySpy.mock.results.at(-1)!.value;
    expect(resolved.source).toBe('tenant');
    expect(resolved.noShowRiskHigh).toBe(CONFIGURED_HIGH);
  }, 30_000);

  it('the eligibility-check ROUTE reaches the same transaction-client read', async () => {
    const t = await makeConfiguredTenant();
    // The route needs the insurance_eligibility entitlement plus an active
    // policy bound to a payer.
    const plan = await fixtureDb.subscriptionPlan.findUniqueOrThrow({ where: { key: 'enterprise' } });
    await fixtureDb.tenantSubscription.create({ data: { tenantId: t.id, planId: plan.id, status: 'ACTIVE', startedAt: new Date() } });
    const { recomputeEntitlements } = await import('../lib/entitlements');
    await recomputeEntitlements(t.id, fixtureDb);
    const payer = await fixtureDb.insurancePayer.create({
      data: { tenantId: t.id, name: 'NSRLS Health', sourceProvider: 'mock', active: true },
    });
    await fixtureDb.patientInsurancePolicy.create({
      data: {
        tenantId: t.id, branchId: t.branchId, patientId: t.patientId, payerId: payer.id,
        planName: 'NSRLS PPO', memberId: 'NSRLS-001', coverageOrder: 1,
        effectiveFrom: new Date(Date.now() - 24 * 60 * 60_000),
      },
    });

    policySpy.mockClear();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/revenue-protection/eligibility/check',
      headers: { ...headers(t), 'idempotency-key': `nsrls-${t.id.slice(0, 8)}` },
      payload: { patientId: t.patientId, appointmentId: t.appointmentId },
    });
    expect(res.statusCode, res.body).toBe(200);

    expect(policySpy, 'the eligibility check route never read the tenant\'s growth policy').toHaveBeenCalled();
    const [tenantArg, clientArg] = policySpy.mock.calls.at(-1)!;
    expect(tenantArg).toBe(t.id);
    expectTransactionClient(clientArg, 'eligibility route');
  }, 40_000);
});
