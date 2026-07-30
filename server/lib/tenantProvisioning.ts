import { db } from './db';
import { env } from '../config/env';
import { generatePasswordHash, validatePassword } from './security';
import { recomputeEntitlements } from './entitlements';
import { seedComplianceBaseline } from '../modules/compliance/baseline';
import { validateIanaTimezone } from './scheduling';
import type { PrismaClient } from '../generated/prisma/client';

// ===========================================================================
// Tenant provisioning — the full onboarding flow used by the operator-gated
// onboarding endpoint. Creates a tenant, default branch, owner user, compliance
// baseline (incl. default TenantSecurityPolicy), and a default TRIAL Starter
// subscription, then recomputes entitlements. Audited. Never returns secrets.
// ===========================================================================

export interface ProvisionInput {
  clinicName: string;
  clinicSlug: string;
  ownerName: string;
  ownerEmail: string;
  ownerPassword: string;
  defaultBranchName: string;
  timezone?: string;
  phone?: string;
  address?: string;
  planKey?: string;
  trialDays?: number;
  status?: 'TRIAL' | 'ACTIVE';
  actorLabel?: string;
}

export class ProvisionError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export async function provisionTenant(input: ProvisionInput, client: PrismaClient = db) {
  const slug = input.clinicSlug.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug)) {
    throw new ProvisionError('invalid_slug', 'Slug must be 3-40 chars: lowercase letters, numbers, and hyphens.');
  }
  const email = input.ownerEmail.trim().toLowerCase();
  const timezone = validateIanaTimezone(input.timezone ?? 'America/New_York');
  const pw = validatePassword(input.ownerPassword);
  if (!pw.ok) throw new ProvisionError('weak_password', pw.message ?? 'Password does not meet policy.');

  const planKey = input.planKey ?? 'starter';
  const passwordHash = await generatePasswordHash(input.ownerPassword);
  const trialDays = input.trialDays ?? env.TRIAL_DAYS;
  const status = input.status ?? 'TRIAL';
  const actorLabel = input.actorLabel ?? 'platform-operator';
  return client.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`tenant-owner-email:${email}`}::text, 0))::text AS locked`;
    // Every existence check is repeated inside the transaction. Unique
    // constraints remain the final race guard and any later failure rolls the
    // entire tenant graph back for a clean retry.
    if (await tx.tenant.findUnique({ where: { slug } })) throw new ProvisionError('slug_taken', 'That clinic slug is already in use.');
    if (await tx.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } })) throw new ProvisionError('email_taken', 'That owner email is already in use.');
    const plan = await tx.subscriptionPlan.findUnique({ where: { key: planKey } });
    if (!plan) throw new ProvisionError('plan_unavailable', 'Subscription catalog is not seeded.');
    const tenant = await tx.tenant.create({ data: { name: input.clinicName.trim(), slug } });
    const branch = await tx.branch.create({ data: { tenantId: tenant.id, name: input.defaultBranchName.trim(), location: (input.address ?? input.clinicName).trim(), timezone } });
    const owner = await tx.user.create({ data: {
      tenantId: tenant.id, branchId: branch.id, email, displayName: input.ownerName.trim(), role: 'OWNER',
      passwordHash, passwordChangedAt: new Date(), active: true,
    } });
    await seedComplianceBaseline(tx, tenant.id);
    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + trialDays * 86400000);
    const subscription = await tx.tenantSubscription.create({ data: {
      tenantId: tenant.id, planId: plan.id, status, startedAt: now,
      trialEndsAt: status === 'TRIAL' ? trialEndsAt : null,
      currentPeriodEnd: status === 'TRIAL' ? trialEndsAt : null,
    } });
    await recomputeEntitlements(tenant.id, tx);
    await tx.auditEvent.create({ data: { tenantId: tenant.id, action: 'tenant.created', resource: 'tenant', resourceId: tenant.id, userAgent: actorLabel, metadata: { slug, plan: planKey, status } } });
    await tx.auditEvent.create({ data: { tenantId: tenant.id, action: 'tenant.owner.created', resource: 'user', resourceId: owner.id, userAgent: actorLabel, metadata: { email } } });
    return {
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      owner: { id: owner.id, email: owner.email, displayName: owner.displayName, role: owner.role },
      branch: { id: branch.id, name: branch.name },
      subscription: { planKey, status, trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null },
    };
  });
}
