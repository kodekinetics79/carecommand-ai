import { randomUUID } from 'node:crypto';
import type { CrawlRole } from './roleAccess';

// ===========================================================================
// Where the suite runs, and which accounts it signs in with.
//
// Two modes, chosen by configuration alone so the same specs gate a build in CI
// and a deployed environment:
//
//   E2E_BASE_URL unset  — the Playwright webServer builds and serves this
//                         checkout, and the run provisions its own throwaway
//                         tenant and users.
//   E2E_BASE_URL set    — the run is pointed at an already-running environment
//                         (the local pilot, staging, production). It creates
//                         nothing and touches no database; the accounts come
//                         from configuration and must already exist.
//
// A partially configured external run fails loudly rather than falling back to
// provisioning, so a missing variable can never turn a production run into an
// attempt to write to a production database.
// ===========================================================================

export interface RoleAccounts {
  emails: Record<CrawlRole, string>;
  password: string;
  /** Removes whatever this run created. A no-op in external mode. */
  dispose(): Promise<void>;
}

/** The environment this run is pointed at, or null for this checkout's own build. */
export function externalTarget(): string | null {
  const configured = process.env.E2E_BASE_URL?.trim();
  return configured ? configured : null;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required when E2E_BASE_URL points the suite at a running environment. `
      + 'Set E2E_ROLE_ACCOUNTS (JSON of role to email) or E2E_ROLE_<ROLE>_EMAIL for every role, plus E2E_ROLE_PASSWORD.',
    );
  }
  return value;
}

function configuredEmails(roles: readonly CrawlRole[]): Record<CrawlRole, string> {
  const raw = process.env.E2E_ROLE_ACCOUNTS?.trim();
  let declared: Record<string, unknown> = {};
  if (raw) {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('E2E_ROLE_ACCOUNTS must be a JSON object of role to email address.');
    }
    declared = parsed as Record<string, unknown>;
  }
  const emails = {} as Record<CrawlRole, string>;
  for (const role of roles) {
    const fromJson = declared[role];
    if (typeof fromJson === 'string' && fromJson.trim()) emails[role] = fromJson.trim();
    else emails[role] = requireEnv(`E2E_ROLE_${role}_EMAIL`);
  }
  return emails;
}

/**
 * Creates a tenant of its own with one user per role, entitled to every
 * subscription feature so nothing is hidden behind a plan lock and the count of
 * offered destinations reflects grants alone.
 *
 * The database helpers are imported here rather than at module scope so that a
 * run against a deployed environment never loads Prisma or opens a connection.
 */
async function provisionRoleAccounts(roles: readonly CrawlRole[]): Promise<RoleAccounts> {
  const [{ fixtureDb: db }, { generatePasswordHash }, { recomputeEntitlements }, { ensureE2eSubscriptionPlan }] = await Promise.all([
    import('../../server/test/helpers/fixtureDb'),
    import('../../server/lib/security'),
    import('../../server/lib/entitlements'),
    import('./subscriptionFixture'),
  ]);

  const tag = randomUUID().slice(0, 8);
  const tenantId = randomUUID();
  const password = `Role-Access-Pw-${tag}!`;

  await db.tenant.create({ data: { id: tenantId, name: `Role Access ${tag}`, slug: `role-access-${tag}` } });
  const plan = await ensureE2eSubscriptionPlan();
  await db.tenantSubscription.create({ data: { tenantId, planId: plan.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(tenantId, db);

  const passwordHash = await generatePasswordHash(password);
  const emails = Object.fromEntries(await Promise.all(roles.map(async role => {
    const email = `${role.toLowerCase()}-${tag}@role-access.test`;
    await db.user.create({
      data: { tenantId, role, active: true, email, displayName: `Role ${role}`, passwordHash, passwordChangedAt: new Date() },
    });
    return [role, email] as const;
  }))) as Record<CrawlRole, string>;

  return {
    emails,
    password,
    async dispose() {
      await db.tenant.delete({ where: { id: tenantId } }).catch(() => {});
      await db.$disconnect();
    },
  };
}

export async function resolveRoleAccounts(roles: readonly CrawlRole[]): Promise<RoleAccounts> {
  if (!externalTarget()) return provisionRoleAccounts(roles);
  return {
    emails: configuredEmails(roles),
    password: requireEnv('E2E_ROLE_PASSWORD'),
    async dispose() {},
  };
}
