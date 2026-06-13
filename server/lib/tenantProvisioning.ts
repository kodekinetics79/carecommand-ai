import { db } from './db';
import { env } from '../config/env';
import { generatePasswordHash, validatePassword } from './security';
import { recomputeEntitlements } from './entitlements';
import { seedComplianceBaseline } from '../modules/compliance/baseline';

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
  status?: 'TRIAL' | 'ACTIVE';
  actorLabel?: string;
}

export class ProvisionError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export async function provisionTenant(input: ProvisionInput) {
  const slug = input.clinicSlug.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug)) {
    throw new ProvisionError('invalid_slug', 'Slug must be 3-40 chars: lowercase letters, numbers, and hyphens.');
  }
  const email = input.ownerEmail.trim().toLowerCase();
  const pw = validatePassword(input.ownerPassword);
  if (!pw.ok) throw new ProvisionError('weak_password', pw.message ?? 'Password does not meet policy.');

  if (await db.tenant.findUnique({ where: { slug } })) throw new ProvisionError('slug_taken', 'That clinic slug is already in use.');
  // Login resolves users by email across tenants, so enforce global email uniqueness.
  if (await db.user.findFirst({ where: { email } })) throw new ProvisionError('email_taken', 'That owner email is already in use.');

  const planKey = input.planKey ?? 'starter';
  const plan = await db.subscriptionPlan.findUnique({ where: { key: planKey } });
  if (!plan) throw new ProvisionError('plan_unavailable', 'Subscription catalog is not seeded.');

  const tenant = await db.tenant.create({ data: { name: input.clinicName.trim(), slug } });
  const branch = await db.branch.create({
    data: { tenantId: tenant.id, name: input.defaultBranchName.trim(), location: (input.address ?? input.clinicName).trim(), ...(input.timezone ? { timezone: input.timezone } : {}) },
  });
  const owner = await db.user.create({
    data: {
      tenantId: tenant.id, branchId: branch.id, email, displayName: input.ownerName.trim(), role: 'OWNER',
      passwordHash: await generatePasswordHash(input.ownerPassword), passwordChangedAt: new Date(), active: true,
    },
  });

  // Compliance baseline (also creates the default TenantSecurityPolicy).
  await seedComplianceBaseline(db, tenant.id);

  const now = new Date();
  const trialEndsAt = new Date(now.getTime() + env.TRIAL_DAYS * 86400000);
  const status = input.status ?? 'TRIAL';
  const subscription = await db.tenantSubscription.create({
    data: { tenantId: tenant.id, planId: plan.id, status, startedAt: now, trialEndsAt: status === 'TRIAL' ? trialEndsAt : null, currentPeriodEnd: status === 'TRIAL' ? trialEndsAt : null },
  });
  await recomputeEntitlements(tenant.id);

  const actorLabel = input.actorLabel ?? 'platform-operator';
  await db.auditEvent.create({ data: { tenantId: tenant.id, action: 'tenant.created', resource: 'tenant', resourceId: tenant.id, userAgent: actorLabel, metadata: { slug, plan: planKey, status } } });
  await db.auditEvent.create({ data: { tenantId: tenant.id, action: 'tenant.owner.created', resource: 'user', resourceId: owner.id, userAgent: actorLabel, metadata: { email } } });

  return {
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    owner: { id: owner.id, email: owner.email, displayName: owner.displayName, role: owner.role },
    branch: { id: branch.id, name: branch.name },
    subscription: { planKey, status, trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null },
  };
}
