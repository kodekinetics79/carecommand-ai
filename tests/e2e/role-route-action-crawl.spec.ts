import 'dotenv/config';
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { fixtureDb as db } from '../../server/test/helpers/fixtureDb';
import { generatePasswordHash } from '../../server/lib/security';
import { recomputeEntitlements } from '../../server/lib/entitlements';
import { assertAccessibilityContract } from './accessibility';
import { ensureE2eSubscriptionPlan } from './subscriptionFixture';

const PASSWORD = 'Route-Crawl-Pw-123!';
const roles = ['OWNER', 'FRONT_DESK', 'AUDITOR'] as const;
type Role = typeof roles[number];

let tenantId = '';
let emails: Record<Role, string>;

async function login(page: Page, role: Role) {
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(emails[role]);
  await page.getByRole('textbox', { name: /Password/ }).fill(PASSWORD);
  await page.getByRole('button', { name: /^Sign in$/i }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('main', { name: 'Clinic workspace' })).toBeVisible();
}

test.describe('role-aware real-backend route and action crawl', () => {
  test.beforeAll(async () => {
    const tag = randomUUID().slice(0, 8);
    tenantId = randomUUID();
    await db.tenant.create({ data: { id: tenantId, name: `Route Crawl ${tag}`, slug: `route-crawl-${tag}` } });
    const plan = await ensureE2eSubscriptionPlan();
    await db.tenantSubscription.create({ data: { tenantId, planId: plan.id, status: 'ACTIVE', startedAt: new Date() } });
    await recomputeEntitlements(tenantId, db);
    const passwordHash = await generatePasswordHash(PASSWORD);
    emails = Object.fromEntries(await Promise.all(roles.map(async role => {
      const email = `${role.toLowerCase()}-${tag}@route-crawl.test`;
      await db.user.create({
        data: { tenantId, role, active: true, email, displayName: `Route ${role}`, passwordHash, passwordChangedAt: new Date() },
      });
      return [role, email] as const;
    }))) as Record<Role, string>;
  });

  test.afterAll(async () => {
    if (tenantId) await db.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    await db.$disconnect();
  });

  for (const role of roles) {
    test(`${role} sees the correct navigation and every exposed route stays operational`, async ({ page }) => {
      const pageErrors: string[] = [];
      const serverFailures: string[] = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      page.on('response', response => {
        if (response.url().includes('/v1/') && response.status() >= 500) {
          serverFailures.push(`${response.status()} ${new URL(response.url()).pathname}`);
        }
      });

      await login(page, role);
      const nav = page.locator('#staff-navigation nav');
      await expect(nav.locator('a[href="#"]')).toHaveCount(0);
      await expect(page.locator('button a, a button')).toHaveCount(0);
      await assertAccessibilityContract(page, `${role}:/`);

      // Sidebar authorization is resolved from /auth/me independently of the
      // protected-layout session. Wait for a role-specific positive grant so
      // the inventory cannot sample the transient pre-hydration navigation.
      const hydratedLink = role === 'OWNER' ? '/control-plane' : role === 'AUDITOR' ? '/compliance' : '/ai-receptionist';
      await expect(nav.locator(`a[href="${hydratedLink}"]`)).toHaveCount(1);

      const hrefs = await nav.locator('a').evaluateAll(anchors => [...new Set(anchors.map(anchor => anchor.getAttribute('href')).filter((href): href is string => Boolean(href)))]);

      // Navigation offers only destinations this role's grants can open. Each
      // probe is a section whose endpoints enforce a permission or a role list,
      // checked against the default matrix in server/lib/permissions.ts:
      // FRONT_DESK has patient/billing/staff reads but no integrations:read;
      // AUDITOR has compliance and audit reads and nothing operational.
      const offered: Record<Role, Record<string, boolean>> = {
        OWNER: {
          '/patients': true, '/scheduling': true, '/insurance': true, '/staff': true,
          '/integrations': true, '/monitoring': true, '/compliance': true, '/control-plane': true,
        },
        FRONT_DESK: {
          '/patients': true, '/scheduling': true, '/insurance': true, '/staff': true,
          '/integrations': false, '/monitoring': false, '/compliance': false, '/control-plane': false,
        },
        AUDITOR: {
          '/patients': false, '/scheduling': false, '/insurance': false, '/staff': false,
          '/integrations': false, '/monitoring': false, '/compliance': true, '/control-plane': false,
        },
      };
      for (const [href, expected] of Object.entries(offered[role])) {
        expect(hrefs.includes(href), `${role} navigation offers ${href}`).toBe(expected);
      }
      // Everyone keeps a landing page and their own account settings.
      expect(hrefs).toContain('/');
      expect(hrefs).toContain('/settings');

      for (const href of hrefs) {
        // Use the product's client-side navigation so this exercises the same
        // SPA action a signed-in user performs (a hard navigation intentionally
        // discards the in-memory 15-minute access token).
        const openNavigation = page.getByRole('button', { name: 'Open navigation' });
        if (await openNavigation.isVisible()) await openNavigation.click();
        await nav.locator(`a[href="${href}"]`).first().click();
        await expect(page).toHaveURL(new RegExp(`${href === '/' ? '/$' : `${href}$`}`));
        await expect(page.getByRole('main', { name: 'Clinic workspace' })).toBeVisible();
        await expect(page.locator('a[href="#"]')).toHaveCount(0);
        await expect(page.locator('button a, a button')).toHaveCount(0);
        await assertAccessibilityContract(page, `${role}:${href}`);
      }

      // Arriving at a section this role cannot use — the bookmark/deep-link case
      // navigation no longer produces — is one honest state, never a status
      // code, the word "forbidden", or a raw permission key.
      const outOfScope: Record<Role, string | null> = { OWNER: null, FRONT_DESK: '/control-plane', AUDITOR: '/patients' };
      const blocked = outOfScope[role];
      if (blocked) {
        await page.goto(blocked);
        const main = page.getByRole('main', { name: 'Clinic workspace' });
        await expect(main.getByText('is not part of your access')).toBeVisible();
        const shown = (await main.innerText()).toLowerCase();
        expect(shown).not.toContain('forbidden');
        expect(shown).not.toContain('403');
        expect(shown).not.toContain('permission (');
        await assertAccessibilityContract(page, `${role}:${blocked} (no access)`);
      }

      expect(pageErrors, `uncaught browser errors for ${role}`).toEqual([]);
      expect(serverFailures, `real API 5xx responses for ${role}`).toEqual([]);
    });
  }
});
