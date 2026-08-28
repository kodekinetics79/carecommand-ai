import { db } from './db';
import { runWithJobTenantContext } from './tenantContext';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Resolve the minimal cross-tenant scheduler bootstrap set. The database
 * function is SECURITY DEFINER and returns active tenant UUIDs only; it exposes
 * no tenant names, configuration, PHI, credentials, or lifecycle metadata.
 */
export async function resolveActiveJobTenantIds(): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ tenantId: string }>>`
    SELECT tenant_id AS "tenantId" FROM app_active_tenant_ids()
  `;
  const ids = rows.map(row => row.tenantId);
  if (ids.some(id => !UUID.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error('Active-tenant job resolver returned invalid or duplicate identifiers');
  }
  return ids;
}

export async function forEachActiveJobTenant(
  only: string | undefined,
  actorId: string,
  work: (tenantId: string) => Promise<void>,
): Promise<void> {
  const tenantIds = only ? [only] : await resolveActiveJobTenantIds();
  for (const tenantId of tenantIds) {
    await runWithJobTenantContext(tenantId, async () => work(tenantId), actorId);
  }
}
