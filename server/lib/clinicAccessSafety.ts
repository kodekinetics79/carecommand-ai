import type { Prisma } from '../generated/prisma/client';

/**
 * Serialize clinic lifecycle and user-access mutations for one tenant.
 * Every caller must acquire this lock before its authoritative branch/user
 * revalidation and keep the lock through mutation plus audit receipt.
 */
export async function lockClinicAccessMutation(tx: Prisma.TransactionClient, tenantId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`clinic-access:${tenantId}`}::text, 0))::text AS locked`;
}
