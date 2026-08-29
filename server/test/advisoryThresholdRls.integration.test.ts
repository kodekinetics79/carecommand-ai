import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ===========================================================================
// The RLS trap, and the guard that keeps it shut.
//
// `GrowthPolicy` is RLS-enrolled: prisma/migrations/20260828140000_growth_config_spine
// grants app_rls a SELECT policy of `USING (app_rls_tenant_allowed("tenantId"))`,
// and `app_rls_tenant_allowed` returns FALSE when no tenant GUC is set. A read
// that escapes tenant context therefore does not error — it returns NO ROW, and
// `getEffectiveGrowthPolicy` resolves to the code defaults with
// `source: 'default'`.
//
// That is the dangerous shape: a fail-open on the tenant's OWN configuration
// that looks exactly like working code. Every number keeps a plausible value,
// the endpoint keeps answering 200, and a tenant who raised
// `reputationRiskHigh` to 90 silently gets 80 — the precise defect this whole
// increment exists to remove, reintroduced by an invisible refactor.
//
// This suite does two things:
//   1. Proves the trap is real, against the real database, so the rule below is
//      evidence rather than folklore.
//   2. Guards the advisory read against it: the advisor must hand
//      `getEffectiveGrowthPolicy` a TRANSACTION client. Dropping that argument —
//      the exact regression — fails this suite.
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

// The real implementation, wrapped so the CLIENT the advisory service passes is
// observable. Nothing about the resolution changes — this suite asserts on real
// values resolved from the real database.
vi.mock('../modules/growth/service', async importOriginal => {
  const actual = await importOriginal<typeof import('../modules/growth/service')>();
  return { ...actual, getEffectiveGrowthPolicy: vi.fn(actual.getEffectiveGrowthPolicy) };
});

const { buildApp } = await import('../app');
const { fixtureDb } = await import('./helpers/fixtureDb');
const { db } = await import('../lib/db');
const { runWithTenantContext } = await import('../lib/tenantContext');
const { GROWTH_POLICY_DEFAULTS } = await import('../modules/growth/defaults');
const growthService = await import('../modules/growth/service');

const policySpy = vi.mocked(growthService.getEffectiveGrowthPolicy);

// A value no default anywhere in the product carries, so resolving it can only
// mean the tenant's stored row was actually read.
const CONFIGURED_HIGH = 93;

let app: FastifyInstance;
const tenantIds: string[] = [];

type Tenant = { id: string; ownerId: string; branchId: string };

async function makeConfiguredTenant(): Promise<Tenant> {
  const id = randomUUID();
  tenantIds.push(id);
  await fixtureDb.tenant.create({ data: { id, name: `advrls-${id.slice(0, 6)}`, slug: `advrls-${id.slice(0, 8)}` } });
  const branch = await fixtureDb.branch.create({ data: { tenantId: id, name: 'Main', location: 'Test' } });
  const owner = await fixtureDb.user.create({
    data: { tenantId: id, role: 'OWNER', active: true, email: `owner-${id.slice(0, 8)}@advrls.test`, displayName: 'Owner' },
  });
  await fixtureDb.growthPolicy.create({ data: { tenantId: id, reputationRiskHigh: CONFIGURED_HIGH, reputationRiskMedium: 40 } });
  // One case between the default band (80) and this tenant's band (93). It is
  // high-risk under the DEFAULTS and not under the TENANT's own rule, so a
  // silent fallback to defaults changes the answer — and the money.
  await fixtureDb.reputationCase.create({
    data: {
      tenantId: id, branchId: branch.id, badReviewRisk: 85,
      complaintCategory: 'Wait time', unresolvedComplaint: 'between the two bands',
      workflowStatus: 'open', recoveryWorkflow: 'callback', suggestedReply: 'We are sorry.',
      npsScore: 20, publicTrend: 'flat',
    },
  });
  return { id, ownerId: owner.id, branchId: branch.id };
}

const headers = (t: Tenant) => ({
  authorization: `Bearer ${app.jwt.sign({ userId: t.ownerId, tenantId: t.id, role: 'OWNER', type: 'access' })}`,
});

beforeAll(async () => { app = await buildApp(); }, 60_000);
beforeEach(() => { policySpy.mockClear(); });
afterAll(async () => {
  for (const id of tenantIds) await fixtureDb.tenant.delete({ where: { id } }).catch(() => {});
  await app?.close();
  await fixtureDb.$disconnect();
});

// ===========================================================================
// 1. The trap, demonstrated. This is why the rule exists.
// ===========================================================================
describe('GrowthPolicy under RLS — a read outside tenant context fails OPEN, silently', () => {
  it('returns the code defaults instead of the tenant\'s stored row, with no error at all', async () => {
    const t = await makeConfiguredTenant();

    // The row is stored. The schema owner can see it.
    const stored = await fixtureDb.growthPolicy.findUnique({ where: { tenantId: t.id } });
    expect(stored?.reputationRiskHigh).toBe(CONFIGURED_HIGH);

    // The runtime client, with NO tenant context, resolves the same tenant to
    // the product defaults. No throw, no null, no warning: a plausible policy
    // for a tenant that has configured a different one.
    const escaped = await growthService.getEffectiveGrowthPolicy(t.id, db);
    expect(escaped.source).toBe('default');
    expect(escaped.reputationRiskHigh).toBe(GROWTH_POLICY_DEFAULTS.reputationRiskHigh);
    expect(escaped.reputationRiskHigh).not.toBe(CONFIGURED_HIGH);

    // The same read, inside a tenant transaction, resolves the tenant's row.
    // One argument is the whole difference between a clinic's rule and a
    // number nobody chose.
    const scoped = await runWithTenantContext(
      t.id,
      tx => growthService.getEffectiveGrowthPolicy(t.id, tx),
      { id: t.ownerId, role: 'OWNER' },
    );
    expect(scoped.source).toBe('tenant');
    expect(scoped.reputationRiskHigh).toBe(CONFIGURED_HIGH);
  }, 30_000);
});

// ===========================================================================
// 2. The guard. This is the assertion that fails if the read moves back.
// ===========================================================================
describe('advisory policy read — is made on a transaction client, not the global one', () => {
  it('hands getEffectiveGrowthPolicy a tenant transaction client', async () => {
    const t = await makeConfiguredTenant();
    const res = await app.inject({ method: 'GET', url: '/v1/advisory/brief', headers: headers(t) });
    expect(res.statusCode, res.body).toBe(200);

    expect(policySpy, 'the advisory brief never read the tenant\'s growth policy').toHaveBeenCalled();
    const call = policySpy.mock.calls.at(-1)!;
    const [tenantArg, clientArg] = call;
    expect(tenantArg).toBe(t.id);

    // REGRESSION GUARD, part 1. `getEffectiveGrowthPolicy(tenantId)` — the
    // global-client read — leaves this undefined. That call reads correctly
    // inside an authenticated request only because the runtime `db` proxy
    // happens to wrap each call in the request's ALS tenant context; it fails
    // open the moment the same code is reached from a worker, a job, a script,
    // or any path where that context is not established. The argument is what
    // makes the read correct by construction rather than by luck.
    expect(clientArg, 'the policy was read WITHOUT a client — this is the global-client read').toBeDefined();

    // REGRESSION GUARD, part 2. Passing the global client explicitly is the
    // same defect, spelled differently.
    expect(clientArg, 'the policy was read on the GLOBAL client').not.toBe(db);

    // REGRESSION GUARD, part 3. What was passed is a Prisma INTERACTIVE
    // TRANSACTION client, not merely some object that is not `db`: an itx
    // client carries the model delegates but none of the connection-lifecycle
    // members (`$connect` / `$disconnect` / `$extends`), all of which the
    // runtime client does carry.
    const client = clientArg as unknown as Record<string, unknown>;
    const runtime = db as unknown as Record<string, unknown>;
    for (const member of ['$connect', '$disconnect', '$extends'] as const) {
      expect(typeof runtime[member], `precondition: the runtime client should expose ${member}`).toBe('function');
      expect(typeof client[member], `the client passed is not a transaction client (${member})`).toBe('undefined');
    }
    expect(typeof client.growthPolicy).toBe('object');
  }, 30_000);

  it('resolves the tenant\'s stored row end to end — the advisor bands at 93, not at the default 80', async () => {
    const t = await makeConfiguredTenant();
    const res = await app.inject({ method: 'GET', url: '/v1/advisory/brief', headers: headers(t) });
    expect(res.statusCode, res.body).toBe(200);

    const advisor = res.json().advisors.find((a: { advisorType: string }) => a.advisorType === 'competitor');
    const evidence: string[] = advisor.evidence;

    // The behavioural half of the guard: a fallback to defaults would band the
    // seeded 85-risk case as high and say so.
    expect(evidence.join(' ')).toContain(`recorded risk ≥ ${CONFIGURED_HIGH}`);
    expect(evidence.join(' ')).toContain('configured for this workspace');
    expect(evidence.join(' ')).not.toContain(`recorded risk ≥ ${GROWTH_POLICY_DEFAULTS.reputationRiskHigh}`);

    const highRiskLine = evidence.find(line => line.startsWith('High-risk reputation cases'))!;
    expect(Number(highRiskLine.match(/: (\d+)\.$/)![1])).toBe(0);
    // …and the money follows: no high-risk case, no $250.
    expect(advisor.expectedImpact).toBe(0);

    // And the resolved policy really did come from the tenant's row, not from a
    // default that happened to match.
    const resolved = await policySpy.mock.results.at(-1)!.value;
    expect(resolved.source).toBe('tenant');
    expect(resolved.reputationRiskHigh).toBe(CONFIGURED_HIGH);
  }, 30_000);

  it('reads the policy once per advisory context, not once per advisor', async () => {
    // Five advisors are built from one context. A per-call-site read would open
    // five tenant transactions for one page, and would be the natural place for
    // one of them to drift back to the global client.
    const t = await makeConfiguredTenant();
    const res = await app.inject({ method: 'GET', url: '/v1/advisory/brief', headers: headers(t) });
    expect(res.statusCode).toBe(200);
    expect(res.json().advisors).toHaveLength(5);
    expect(policySpy).toHaveBeenCalledTimes(1);
  }, 30_000);
});
