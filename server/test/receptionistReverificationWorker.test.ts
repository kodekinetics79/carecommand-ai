import 'dotenv/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchDue = vi.hoisted(() => vi.fn(async () => ({ scanned: 0 })));
const reverify = vi.hoisted(() => vi.fn(async () => ({ scanned: 0, renewed: 0, failed: 0, transient: 0, driftBlocked: 0, skipped: 0 })));
const runJobContext = vi.hoisted(() => vi.fn(async (_tenantId: string, work: () => Promise<void>) => work()));

vi.mock('../lib/receptionist/confirmationOutbox', () => ({ dispatchDueAppointmentConfirmations: dispatchDue }));
vi.mock('../lib/receptionist/agentReverification', () => ({ reverifyExpiringAgents: reverify }));
vi.mock('../lib/tenantContext', () => ({ runWithJobTenantContext: runJobContext }));

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

  it('runs only inside a validated job tenant context', async () => {
    const tenantId = '00000000-0000-4000-8000-000000000003';
    await runTenantComplianceJob('receptionist-agent-reverify', tenantId);
    expect(runJobContext).toHaveBeenCalledWith(tenantId, expect.any(Function), 'worker:receptionist-agent-reverify');
    expect(reverify).toHaveBeenCalledOnce();
    expect(reverify).toHaveBeenCalledWith(tenantId);
    // The confirmation dispatcher must not be dragged along by this job.
    expect(dispatchDue).not.toHaveBeenCalled();
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
