import 'dotenv/config';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixtureDb as db } from './helpers/fixtureDb';
import { reverifyExpiringAgents, setReverifyTestHooks } from '../lib/receptionist/agentReverification';
import { runWithJobTenantContext } from '../lib/tenantContext';
import type { VerifyOutcome } from '../lib/receptionist/agentVerification';

// ===========================================================================
// What the hourly job selects, and what it does when renewal fails.
//
// The verification probe is injected: this suite is about the SELECTION and
// the consequences (does staff hear about it, exactly once?), not about the
// provider round trip, which receptionistDeployment covers end to end.
//
// Every call goes through `runWithJobTenantContext`, exactly as the worker
// does. That is not ceremony: the runtime role is RLS-enforced, so a scan run
// without a tenant context legitimately sees zero agents.
// ===========================================================================

/** Run the scan the way the worker runs it. */
function reverify(tenantId: string, now?: Date) {
  return runWithJobTenantContext(tenantId, () => reverifyExpiringAgents(tenantId, now), 'worker:receptionist-agent-reverify');
}

const tenantIds: string[] = [];

async function tenantWithAgent(input: { expiresInMs: number; status?: 'VERIFIED' | 'INVALID'; active?: boolean }) {
  const tenantId = randomUUID();
  tenantIds.push(tenantId);
  await db.tenant.create({ data: { id: tenantId, name: `Reverify ${tenantId.slice(0, 8)}`, slug: `reverify-${tenantId.slice(0, 8)}` } });
  const branch = await db.branch.create({
    data: { tenantId, name: 'Main', location: '1 Main St', timezone: 'America/New_York', active: true },
    select: { id: true },
  });
  const clinic = await db.receptionistClinic.create({
    data: { tenantId, name: `Clinic ${tenantId.slice(0, 8)}`, phone: `+1212${tenantId.replace(/\D/g, '').slice(0, 7)}`, active: true },
  });
  await db.receptionistLocation.create({
    data: { tenantId, clinicId: clinic.id, branchId: branch.id, name: 'Main', address: '1 Main St', active: true },
  });
  const now = Date.now();
  // The database CHECK refuses a VERIFIED row that is not a complete
  // attestation, so the fixture supplies the whole snapshot rather than a
  // status flag — which is exactly the point of that constraint.
  const agent = await db.receptionistAgent.create({ data: {
    tenantId, clinicId: clinic.id, name: 'Avery', voice: 'mock-voice-nova',
    active: input.active ?? true,
    providerAgentId: `agent_${tenantId.replace(/-/g, '').slice(0, 12)}`,
    providerVersionTag: 'prod',
    providerVersion: 3,
    providerStatus: input.status ?? 'VERIFIED',
    providerPublished: true,
    providerAssignedTags: ['prod'],
    providerWebhookUrl: 'http://localhost:3001/v1/receptionist/webhooks/retell',
    providerWebhookEvents: ['call_started', 'call_ended', 'call_analyzed'],
    providerDataStorageSetting: 'basic_attributes_only',
    providerSignedUrl: true,
    providerResponseEngineType: 'retell-llm',
    providerResponseEngineId: 'llm_fixture',
    providerResponseEngineVersion: 1,
    providerFingerprint: 'a'.repeat(64),
    providerConfigRevision: 1,
    providerVerifiedRevision: 1,
    providerVerifiedAt: new Date(now - 1_000),
    providerVerificationExpiresAt: new Date(now + input.expiresInMs),
  } });
  return { tenantId, branchId: branch.id, clinicId: clinic.id, agentId: agent.id };
}

afterEach(() => setReverifyTestHooks(null));

afterAll(async () => {
  setReverifyTestHooks(null);
  for (const id of tenantIds) await db.tenant.delete({ where: { id } }).catch(() => undefined);
  await db.$disconnect();
});

describe('re-verification selection', () => {
  it('renews an attestation that is about to lapse, and leaves a fresh one alone', async () => {
    const expiring = await tenantWithAgent({ expiresInMs: 3 * 60 * 60 * 1_000 });
    const fresh = await tenantWithAgent({ expiresInMs: 20 * 60 * 60 * 1_000 });
    const seen: string[] = [];
    setReverifyTestHooks(async input => {
      seen.push(input.agentId);
      return { kind: 'verified', agent: {} as never, deploymentChanged: false } satisfies VerifyOutcome;
    });

    const expiringSummary = await reverify(expiring.tenantId);
    expect(expiringSummary).toMatchObject({ scanned: 1, renewed: 1, failed: 0 });
    expect(seen).toEqual([expiring.agentId]);

    // 20 hours out is not the job's business yet; renewing it every hour would
    // be pointless provider traffic.
    const freshSummary = await reverify(fresh.tenantId);
    expect(freshSummary).toMatchObject({ scanned: 0, renewed: 0 });
  });

  it('ignores agents that are inactive or already invalid', async () => {
    const inactive = await tenantWithAgent({ expiresInMs: 60_000, active: false });
    const invalid = await tenantWithAgent({ expiresInMs: 60_000, status: 'INVALID' });
    setReverifyTestHooks(async () => ({ kind: 'verified', agent: {} as never, deploymentChanged: false }));
    expect(await reverify(inactive.tenantId)).toMatchObject({ scanned: 0 });
    // An INVALID agent already told the operator what to fix; re-probing it
    // hourly would add provider load and no information.
    expect(await reverify(invalid.tenantId)).toMatchObject({ scanned: 0 });
  });
});

describe('what staff are told when renewal fails', () => {
  it('raises exactly one task per agent and reason, however many times it runs', async () => {
    const fixture = await tenantWithAgent({ expiresInMs: 60 * 60 * 1_000 });
    setReverifyTestHooks(async () => ({
      kind: 'failed', agent: {} as never, code: 'prompt_drift', permanent: true, httpStatus: 200,
    }));

    const first = await reverify(fixture.tenantId);
    expect(first).toMatchObject({ scanned: 1, failed: 1, renewed: 0 });

    const tasks = await db.staffTask.findMany({ where: { tenantId: fixture.tenantId } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: 'AI receptionist deployment needs attention', priority: 'HIGH', status: 'OPEN' });
    // The task carries the fix, not just the failure.
    expect(tasks[0].metadata).toMatchObject({ workflow: 'receptionist_deployment', agentId: fixture.agentId, code: 'prompt_drift' });
    expect(String((tasks[0].metadata as { action: string }).action)).toMatch(/Redeploy from Studio/i);
    // It lands on the branch that answers for this clinic.
    expect(tasks[0].branchId).toBe(fixture.branchId);

    // An agent failing every hour must produce one thing to act on.
    await reverify(fixture.tenantId);
    await reverify(fixture.tenantId);
    expect(await db.staffTask.count({ where: { tenantId: fixture.tenantId } })).toBe(1);
  });

  it('stays quiet for a transient failure that is still hours from biting', async () => {
    const fixture = await tenantWithAgent({ expiresInMs: 5 * 60 * 60 * 1_000 });
    setReverifyTestHooks(async () => ({
      kind: 'failed', agent: {} as never, code: 'provider_unavailable', permanent: false, httpStatus: 503,
    }));
    const summary = await reverify(fixture.tenantId);
    // The agent is still VERIFIED and still answering; next hour will retry.
    expect(summary).toMatchObject({ transient: 1, failed: 0 });
    expect(await db.staffTask.count({ where: { tenantId: fixture.tenantId } })).toBe(0);
  });

  it('escalates a transient failure once the expiry is close enough to matter', async () => {
    const fixture = await tenantWithAgent({ expiresInMs: 45 * 60 * 1_000 });
    setReverifyTestHooks(async () => ({
      kind: 'failed', agent: {} as never, code: 'provider_unavailable', permanent: false, httpStatus: 503,
    }));
    await reverify(fixture.tenantId);
    const tasks = await db.staffTask.findMany({ where: { tenantId: fixture.tenantId } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].priority).toBe('MEDIUM');
  });

  it('does not hammer a provider that just failed for this agent', async () => {
    const fixture = await tenantWithAgent({ expiresInMs: 60 * 60 * 1_000 });
    await db.receptionistAgent.update({
      where: { id: fixture.agentId },
      data: { providerLastAttemptAt: new Date(), providerLastAttemptStatus: 'FAILED', providerLastAttemptSource: 'SYSTEM' },
    });
    let calls = 0;
    setReverifyTestHooks(async () => { calls += 1; return { kind: 'verified', agent: {} as never, deploymentChanged: false }; });
    expect(await reverify(fixture.tenantId)).toMatchObject({ scanned: 1, skipped: 1 });
    expect(calls).toBe(0);
  });
});
