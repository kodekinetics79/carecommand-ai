import 'dotenv/config';
import { test, expect } from '@playwright/test';
import { assertAccessibilityContract } from './accessibility';
import {
  NAV_DESTINATIONS,
  RESTRICTED_STATE_SENTENCE,
  ROLE_ACCESS,
  clickNavDestination,
  rawAccessTextIn,
  readNavDestinations,
  signIn,
  type CrawlRole,
} from './roleAccess';
import { resolveRoleAccounts, type RoleAccounts } from './roleAccounts';

// What each role may open is stated once, in roleAccess.ts, and shared with the
// access gate (role-access-gate.spec.ts) so the two crawls cannot drift apart.
// This spec's own subject is different: that each route a role IS offered
// renders a usable, accessible screen off the real backend.
const roles = ['OWNER', 'FRONT_DESK', 'AUDITOR'] as const satisfies readonly CrawlRole[];

let accounts: RoleAccounts;

test.describe('role-aware real-backend route and action crawl', () => {
  test.beforeAll(async () => {
    accounts = await resolveRoleAccounts(roles);
  });

  test.afterAll(async () => {
    await accounts?.dispose();
  });

  for (const role of roles) {
    test(`${role} sees the correct navigation and every exposed route stays operational`, async ({ page }) => {
      test.setTimeout(10 * 60_000);
      const pageErrors: string[] = [];
      const serverFailures: string[] = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      page.on('response', response => {
        if (response.url().includes('/v1/') && response.status() >= 500) {
          serverFailures.push(`${response.status()} ${new URL(response.url()).pathname}`);
        }
      });

      await signIn(page, accounts.emails[role], accounts.password);
      const nav = page.locator('#staff-navigation nav');
      await expect(nav.locator('a[href="#"]')).toHaveCount(0);
      await expect(page.locator('button a, a button')).toHaveCount(0);
      await assertAccessibilityContract(page, `${role}:/`);

      // Navigation offers only destinations this role's grants can open. Each
      // probe is a section whose endpoints enforce a permission or a role list,
      // checked against the default matrix in server/lib/permissions.ts:
      // FRONT_DESK has patient/billing/staff reads but no integrations:read;
      // AUDITOR has compliance and audit reads and nothing operational.
      const hrefs = [...new Set(await readNavDestinations(page))];
      for (const href of ROLE_ACCESS[role].mustOffer) {
        expect(hrefs, `${role} navigation offers ${href}`).toContain(href);
      }
      for (const href of ROLE_ACCESS[role].mustNotOffer) {
        expect(hrefs, `${role} navigation must not offer ${href}`).not.toContain(href);
      }

      for (const href of hrefs) {
        // Use the product's client-side navigation so this exercises the same
        // SPA action a signed-in user performs (a hard navigation intentionally
        // discards the in-memory 15-minute access token).
        await clickNavDestination(page, href);
        await expect(page).toHaveURL(href);
        await expect(page.getByRole('main', { name: 'Clinic workspace' })).toBeVisible();
        await expect(page.locator('a[href="#"]')).toHaveCount(0);
        await expect(page.locator('button a, a button')).toHaveCount(0);
        await assertAccessibilityContract(page, `${role}:${href}`);
      }

      // Arriving at a section this role cannot use — the bookmark/deep-link case
      // navigation no longer produces — is one honest state, never a status
      // code, the word "forbidden", or a raw permission key.
      const withheld = ROLE_ACCESS[role].mustNotOffer[0];
      const blocked = NAV_DESTINATIONS.find(destination => destination.path === withheld);
      if (blocked) {
        await page.goto(blocked.path);
        const main = page.getByRole('main', { name: 'Clinic workspace' });
        await expect(main.getByText(`${blocked.label} ${RESTRICTED_STATE_SENTENCE}`, { exact: true })).toBeVisible();
        expect(rawAccessTextIn(await main.innerText()), `raw authorization text on ${blocked.path}`).toEqual([]);
        await assertAccessibilityContract(page, `${role}:${blocked.path} (no access)`);
      }

      expect(pageErrors, `uncaught browser errors for ${role}`).toEqual([]);
      expect(serverFailures, `real API 5xx responses for ${role}`).toEqual([]);
    });
  }
});
