import 'dotenv/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchDue = vi.hoisted(() => vi.fn(async () => ({ scanned: 0 })));
const reverify = vi.hoisted(() => vi.fn(async () => ({ scanned: 0, renewed: 0, failed: 0, transient: 0, driftBlocked: 0, skipped: 0 })));
const runJobContext = vi.hoisted(() => vi.fn(async (_tenantId: string, work: () => Promise<void>) => work()));
const runContext = vi.hoisted(() => vi.fn(async (_context: unknown, work: () => Promise<void>) => work()));

vi.mock('../lib/receptionist/confirmationOutbox', () => ({ dispatchDueAppointmentConfirmations: dispatchDue }));
vi.mock('../lib/receptionist/agentReverification', () => ({ reverifyExpiringAgents: reverify }));
vi.mock('../lib/tenantContext', () => ({ runWithJobTenantContext: runJobContext, runInTenantContext: runContext }));

const { runTenantComplianceJob } = await import('../workers/compliance.worker');
const { validateTenantJobEnvelope } = await import('../lib/jobEnvelope');
const { complianceQueue, enqueueComplianceTenantJob, registerComplianceSchedules } = await import('../workers/queues');

// ===========================================================================
// The re-verification job's wiring.
//
// A verification lapses after 24 hours and then fails closed. If this job is
// not registered, or runs outside a validated tenant context, a clinic that
// did nothing wrong finds its receptionist has stopped answering — so the
// registration and the tenant fence are worth pinning explicitly.
//
// And HOW it is fenced is load-bearing (A3). `runWithJobTenantContext` opens
// one Prisma interactive transaction around the whole job; this job makes three
// or more HTTPS round trips to Retell per agent, up to fifty agents a pass,
// against a 5000 ms default transaction timeout. A probe measured 6108 ms for a
// single agent. So the job aborted with P2028, BullMQ retried it into the same
// wall three times, and every attestation in the tenant lapsed — the outage the
// job exists to prevent, raised by nobody, because the raiser was the job.
// ===========================================================================

describe('receptionist agent re-verification worker', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('registers hourly, deliberately off the per-minute dispatch cadence', async () => {
    const upsert = vi.spyOn(complianceQueue, 'upsertJobScheduler').mockResolvedValue({} as never);
    await registerComplianceSchedules();
    expect(upsert).toHaveBeenCalledWith(
      'receptionist-agent-reverify',
      { pattern: '7 * * * *' },
      { name: 'receptionist-agent-reverify', data: {} },
    );
  });

  it('runs inside a validated tenant context, and NOT inside one long transaction', async () => {
    const tenantId = '00000000-0000-4000-8000-000000000003';
    await runTenantComplianceJob('receptionist-agent-reverify', tenantId);

    // AsyncLocalStorage only. `db` still opens a short transaction per
    // operation with the tenant GUCs applied, and `verifyAgentProvider` still
    // opens its own scoped transactions — around a provider probe that must run
    // with nothing open.
    expect(runContext).toHaveBeenCalledOnce();
    expect(runContext).toHaveBeenCalledWith(
      { tenantId, actorId: 'worker:receptionist-agent-reverify', actorRole: 'WORKER', source: 'worker' },
      expect.any(Function),
    );
    // The transaction-wrapping helper is the defect; it must not be back.
    expect(runJobContext).not.toHaveBeenCalled();
    expect(reverify).toHaveBeenCalledOnce();
    expect(reverify).toHaveBeenCalledWith(tenantId);
    // The confirmation dispatcher must not be dragged along by this job.
    expect(dispatchDue).not.toHaveBeenCalled();
  });

  it('still wraps the confirmation dispatcher in a transaction, which is short and has no provider calls', async () => {
    const tenantId = '00000000-0000-4000-8000-000000000005';
    await runTenantComplianceJob('receptionist-confirmation-dispatch', tenantId);
    expect(runJobContext).toHaveBeenCalledWith(tenantId, expect.any(Function), 'worker:receptionist-confirmation');
    expect(runContext).not.toHaveBeenCalled();
    expect(reverify).not.toHaveBeenCalled();
  });

  it('enqueues per tenant as a signed envelope that verifies against this queue', async () => {
    const tenantId = '00000000-0000-4000-8000-000000000004';
    const add = vi.spyOn(complianceQueue, 'add').mockResolvedValue({} as never);
    await enqueueComplianceTenantJob('receptionist-agent-reverify', tenantId);
    expect(add).toHaveBeenCalledOnce();
    const [name, data, options] = add.mock.calls[0]!;
    expect(name).toBe('receptionist-agent-reverify-tenant');
    expect(validateTenantJobEnvelope(data, {
      queue: 'compliance-maintenance',
      operation: 'receptionist-agent-reverify',
      jobId: options?.jobId,
    }).tenantId).toBe(tenantId);
  });
});
