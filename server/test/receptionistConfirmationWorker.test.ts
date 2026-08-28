import { beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchDue = vi.hoisted(() => vi.fn(async () => ({ scanned: 0 })));
const runJobContext = vi.hoisted(() => vi.fn(async (_tenantId: string, work: () => Promise<void>) => work()));

vi.mock('../lib/receptionist/confirmationOutbox', () => ({
  dispatchDueAppointmentConfirmations: dispatchDue,
}));
vi.mock('../lib/tenantContext', () => ({
  runWithJobTenantContext: runJobContext,
}));

import { runTenantComplianceJob } from '../workers/compliance.worker';
import { validateTenantJobEnvelope } from '../lib/jobEnvelope';
import { complianceQueue, enqueueComplianceTenantJob, registerComplianceSchedules } from '../workers/queues';

describe('receptionist confirmation worker integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the durable confirmation dispatcher every minute', async () => {
    const upsert = vi.spyOn(complianceQueue, 'upsertJobScheduler').mockResolvedValue({} as never);

    await registerComplianceSchedules();

    expect(upsert).toHaveBeenCalledWith(
      'receptionist-confirmation-dispatch',
      { pattern: '* * * * *' },
      { name: 'receptionist-confirmation-dispatch', data: {} },
    );
  });

  it('executes dispatch only inside the validated job tenant context', async () => {
    const tenantId = '00000000-0000-4000-8000-000000000001';

    await runTenantComplianceJob('receptionist-confirmation-dispatch', tenantId);

    expect(runJobContext).toHaveBeenCalledWith(
      tenantId,
      expect.any(Function),
      'worker:receptionist-confirmation',
    );
    expect(dispatchDue).toHaveBeenCalledOnce();
    expect(dispatchDue).toHaveBeenCalledWith(tenantId);
  });

  it('enqueues the per-tenant dispatch as a verifiable signed envelope', async () => {
    const tenantId = '00000000-0000-4000-8000-000000000002';
    const add = vi.spyOn(complianceQueue, 'add').mockResolvedValue({} as never);

    await enqueueComplianceTenantJob('receptionist-confirmation-dispatch', tenantId);

    expect(add).toHaveBeenCalledOnce();
    const [name, data, options] = add.mock.calls[0]!;
    expect(name).toBe('receptionist-confirmation-dispatch-tenant');
    expect(options?.jobId).toBeTypeOf('string');
    expect(validateTenantJobEnvelope(data, {
      queue: 'compliance-maintenance',
      operation: 'receptionist-confirmation-dispatch',
      jobId: options?.jobId,
    }).tenantId).toBe(tenantId);
  });
});
