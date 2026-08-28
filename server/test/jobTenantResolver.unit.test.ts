import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryRaw = vi.fn();
const runWithJobTenantContext = vi.fn(async (_tenantId: string, work: () => Promise<void>) => work());

vi.mock('../lib/db', () => ({ db: { $queryRaw: queryRaw } }));
vi.mock('../lib/tenantContext', () => ({ runWithJobTenantContext }));

const { forEachActiveJobTenant, resolveActiveJobTenantIds } = await import('../lib/jobTenantResolver');

beforeEach(() => {
  queryRaw.mockReset();
  runWithJobTenantContext.mockClear();
});

describe('active tenant scheduler bootstrap', () => {
  it('returns only validated unique UUIDs from the narrow database resolver', async () => {
    const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
    queryRaw.mockResolvedValue(ids.map(tenantId => ({ tenantId })));
    await expect(resolveActiveJobTenantIds()).resolves.toEqual(ids);
  });

  it('fails closed on malformed or duplicate resolver output', async () => {
    queryRaw.mockResolvedValue([{ tenantId: 'not-a-uuid' }]);
    await expect(resolveActiveJobTenantIds()).rejects.toThrow('invalid or duplicate');
    queryRaw.mockResolvedValue([
      { tenantId: '00000000-0000-4000-8000-000000000001' },
      { tenantId: '00000000-0000-4000-8000-000000000001' },
    ]);
    await expect(resolveActiveJobTenantIds()).rejects.toThrow('invalid or duplicate');
  });

  it('runs every resolved tenant under an attributed job tenant context', async () => {
    const ids = ['00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012'];
    queryRaw.mockResolvedValue(ids.map(tenantId => ({ tenantId })));
    const seen: string[] = [];
    await forEachActiveJobTenant(undefined, 'worker:test', async tenantId => { seen.push(tenantId); });

    expect(seen).toEqual(ids);
    expect(runWithJobTenantContext).toHaveBeenNthCalledWith(1, ids[0], expect.any(Function), 'worker:test');
    expect(runWithJobTenantContext).toHaveBeenNthCalledWith(2, ids[1], expect.any(Function), 'worker:test');
  });

  it('uses the supplied tenant without cross-tenant enumeration', async () => {
    const only = '00000000-0000-4000-8000-000000000021';
    await forEachActiveJobTenant(only, 'worker:test', async () => undefined);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(runWithJobTenantContext).toHaveBeenCalledWith(only, expect.any(Function), 'worker:test');
  });
});
