import 'dotenv/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const purge = vi.hoisted(() => vi.fn(async () => ({ scanned: 0, localPurges: 0, vendorConfirmed: 0 })));
const runContext = vi.hoisted(() => vi.fn(async (_context: unknown, work: () => Promise<void>) => work()));
const runJobContext = vi.hoisted(() => vi.fn(async (_tenantId: string, work: () => Promise<void>) => work()));

vi.mock('../lib/receptionist/privacyLifecycle', () => ({ purgeDueReceptionistArtifacts: purge }));
vi.mock('../lib/tenantContext', () => ({ runInTenantContext: runContext, runWithJobTenantContext: runJobContext }));

const { runTenantComplianceJob } = await import('../workers/compliance.worker');
const { validateTenantJobEnvelope } = await import('../lib/jobEnvelope');
const { complianceQueue, enqueueComplianceTenantJob, registerComplianceSchedules } = await import('../workers/queues');

describe('receptionist artifact retention worker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers a daily retention purge', async () => {
    const upsert = vi.spyOn(complianceQueue, 'upsertJobScheduler').mockResolvedValue({} as never);
    await registerComplianceSchedules();
    expect(upsert).toHaveBeenCalledWith(
      'receptionist-artifact-retention-purge',
      { pattern: '20 3 * * *' },
      { name: 'receptionist-artifact-retention-purge', data: {} },
    );
  });

  it('purges only inside the requested tenant context without a long transaction', async () => {
    const tenantId = '00000000-0000-4000-8000-000000000006';
    await runTenantComplianceJob('receptionist-artifact-retention-purge', tenantId);
    expect(runContext).toHaveBeenCalledWith(
      { tenantId, actorId: 'worker:receptionist-artifact-retention-purge', actorRole: 'WORKER', source: 'worker' },
      expect.any(Function),
    );
    expect(runJobContext).not.toHaveBeenCalled();
    expect(purge).toHaveBeenCalledOnce();
  });

  it('enqueues a signed tenant-scoped job envelope', async () => {
    const tenantId = '00000000-0000-4000-8000-000000000007';
    const add = vi.spyOn(complianceQueue, 'add').mockResolvedValue({} as never);
    await enqueueComplianceTenantJob('receptionist-artifact-retention-purge', tenantId);
    const [name, data, options] = add.mock.calls[0]!;
    expect(name).toBe('receptionist-artifact-retention-purge-tenant');
    expect(validateTenantJobEnvelope(data, {
      queue: 'compliance-maintenance',
      operation: 'receptionist-artifact-retention-purge',
      jobId: options?.jobId,
    }).tenantId).toBe(tenantId);
  });
});
