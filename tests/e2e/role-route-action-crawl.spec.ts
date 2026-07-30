import 'dotenv/config';
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { fixtureDb as db } from '../../server/test/helpers/fixtureDb';
import { generatePasswordHash } from '../../server/lib/security';
import { recomputeEntitlements } from '../../server/lib/entitlements';

const PASSWORD = 'Route-Crawl-Pw-123!';
const roles = ['OWNER', 'FRONT_DESK', 'AUDITOR'] as const;
type Role = typeof roles[number];

let tenantId = '';
let emails: Record<Role, string>;

async function login(page: Page, role: Role) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(emails[role]);
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
    const plan = await db.subscriptionPlan.findUnique({ where: { key: 'enterprise' } });
    if (plan) await db.tenantSubscription.create({ data: { tenantId, planId: plan.id, status: 'ACTIVE', startedAt: new Date() } });
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

      const hrefs = await nav.locator('a').evaluateAll(anchors => [...new Set(anchors.map(anchor => anchor.getAttribute('href')).filter((href): href is string => Boolean(href)))]);
      expect(hrefs.length).toBeGreaterThan(20);
      expect(hrefs.includes('/control-plane')).toBe(role === 'OWNER');
      expect(hrefs.includes('/compliance')).toBe(role === 'OWNER' || role === 'AUDITOR');

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
      }

      expect(pageErrors, `uncaught browser errors for ${role}`).toEqual([]);
      expect(serverFailures, `real API 5xx responses for ${role}`).toEqual([]);
    });
  }
});
