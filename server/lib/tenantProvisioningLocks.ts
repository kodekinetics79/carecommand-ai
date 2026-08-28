import type { Prisma } from '../generated/prisma/client';

/**
 * Serialize every provisioning entry point on both globally contested keys.
 * Sorting the canonical keys gives legacy and platform callers one lock order,
 * preventing deadlocks when requests share an email, a slug, or both.
 */
export async function lockTenantProvisioningIdentity(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  slug: string,
  ownerEmail: string,
) {
  const keys = [
    `tenant-owner-email:${ownerEmail.trim().toLowerCase()}`,
    `tenant-slug:${slug.trim().toLowerCase()}`,
  ].sort();
  for (const key of keys) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text, 0))::text AS locked`;
  }
}
