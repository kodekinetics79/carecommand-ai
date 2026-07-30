import { validatePassword, generatePasswordHash } from './security';
import { platformDb } from './platformDb';
import { seedComplianceBaseline } from '../modules/compliance/baseline';
import { recomputeEntitlements } from './entitlements';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { validateIanaTimezone } from './scheduling';

export interface PlatformProvisionInput {
  clinicName: string;
  clinicSlug: string;
  ownerName: string;
  ownerEmail: string;
  ownerPassword: string;
  defaultBranchName: string;
  timezone?: string;
  planKey: string;
  trialDays: number;
}

export class PlatformProvisionError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

interface ProvisionRow {
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  owner_id: string;
  owner_email: string;
  branch_id: string;
  branch_name: string;
  subscription_status: string;
  trial_ends_at: Date | null;
}

export async function platformProvisionTenant(
  input: PlatformProvisionInput,
  client: PrismaClient | Prisma.TransactionClient = platformDb,
) {
  const slug = input.clinicSlug.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug)) {
    throw new PlatformProvisionError('invalid_slug', 'Slug must be 3-40 chars: lowercase letters, numbers, and hyphens.');
  }
  const policy = validatePassword(input.ownerPassword);
  if (!policy.ok) throw new PlatformProvisionError('weak_password', policy.message ?? 'Password does not meet policy.');
  const ownerEmail = input.ownerEmail.trim().toLowerCase();
  const timezone = validateIanaTimezone(input.timezone ?? 'America/New_York');
  const passwordHash = await generatePasswordHash(input.ownerPassword);
  const provision = async (tx: PrismaClient | Prisma.TransactionClient) => {
    // User email is not globally unique in the physical schema, while login
    // resolution and onboarding require it to be. Serialize both provisioning
    // entry points on the same canonical email key before the SQL function's
    // global existence check.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tenant-owner-email:${ownerEmail}`}::text, 0))::text AS locked`;
    let rows: ProvisionRow[];
    try {
      rows = await tx.$queryRaw<ProvisionRow[]>`
      SELECT * FROM app_platform_provision_tenant(
        ${input.clinicName.trim()}::text,
        ${slug}::text,
        ${input.ownerName.trim()}::text,
        ${ownerEmail}::text,
        ${passwordHash}::text,
        ${input.defaultBranchName.trim()}::text,
        ${timezone}::text,
        ${input.planKey}::text,
        ${input.trialDays}::integer
      )
      `;
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes('platform_slug_taken')) throw new PlatformProvisionError('slug_taken', 'That clinic slug is already in use.');
      if (message.includes('platform_email_taken')) throw new PlatformProvisionError('email_taken', 'That owner email is already in use.');
      if (message.includes('platform_plan_unavailable')) throw new PlatformProvisionError('plan_unavailable', 'Subscription catalog is not seeded.');
      throw error;
    }
    const row = rows[0];
    if (!row) throw new PlatformProvisionError('provision_failed', 'Tenant provisioning did not return a result.');

    // These are non-PHI governance/control tables exposed to app_platform by
    // explicit RLS policies; patient and clinical tables remain inaccessible.
    await seedComplianceBaseline(tx, row.tenant_id);
    await recomputeEntitlements(row.tenant_id, tx);

    return {
      tenant: { id: row.tenant_id, name: row.tenant_name, slug: row.tenant_slug },
      owner: { id: row.owner_id, email: row.owner_email, displayName: input.ownerName.trim(), role: 'OWNER' as const },
      branch: { id: row.branch_id, name: row.branch_name },
      subscription: { planKey: input.planKey, status: row.subscription_status, trialEndsAt: row.trial_ends_at?.toISOString() ?? null },
    };
  };

  // Route callers already pass a TransactionClient so provisioning joins the
  // platform audit transaction. Standalone callers receive the same all-or-
  // nothing guarantee by opening a transaction here.
  const rootClient = client as PrismaClient;
  return typeof rootClient.$transaction === 'function'
    ? rootClient.$transaction(tx => provision(tx))
    : provision(client);
}
