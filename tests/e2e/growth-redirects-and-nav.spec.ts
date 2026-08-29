import 'dotenv/config';
import { test, expect } from '@playwright/test';
import {
  RESTRICTED_STATE_SENTENCE, clickNavDestination, rawAccessTextIn, readNavDestinations, signIn,
} from './roleAccess';
import { createGrowthTenant, fixtureDb as db, GROWTH_PASSWORD, type GrowthTenant } from './growthFixture';

// ===========================================================================
// The campaign-workspace consolidation, as a gate:
//
//   - /campaigner and /reactivation are retired paths that must land on
//     /campaigns (bookmarks, saved links and in-app legacy callers included);
//   - the sidebar Growth group offers exactly five destinations, and never
//     the retired ones;
//   - a role holding neither campaign:read nor crm:read is not offered
//     /campaigns at all, and deep-linking to it lands on the product's named
//     restricted state — not a raw 403, "Forbidden", or a permission key.
// ===========================================================================

const GROWTH_GROUP_PATHS = ['/crm', '/campaigns', '/autopilot', '/reviews', '/clinic-radar'];
const RETIRED_PATHS = ['/campaigner', '/reactivation'];

test.describe('growth navigation and retired campaign paths', () => {
  let tenant: GrowthTenant;

  // Playwright resolves fixtures by parsing this destructuring pattern; the
  // empty pattern is its required spelling of 'no fixtures, only testInfo'.
  // eslint-disable-next-line no-empty-pattern
  test.beforeAll(async ({}, testInfo) => {
    tenant = await createGrowthTenant(`nav-${testInfo.project.name}`, ['OWNER', 'PROVIDER']);
  });

  test.afterAll(async () => {
    await tenant?.dispose();
    await db.$disconnect();
  });

  test('owner: Growth offers five entries and every retired path redirects into /campaigns', async ({ page }) => {
    await signIn(page, tenant.emails.OWNER!, GROWTH_PASSWORD);

    // --- Sidebar: the Growth group is the five merged destinations ----------
    const offered = await readNavDestinations(page);
    for (const path of GROWTH_GROUP_PATHS) {
      expect(offered, `owner navigation offers ${path}`).toContain(path);
    }
    for (const retired of RETIRED_PATHS) {
      expect(offered, `${retired} must no longer be offered anywhere`).not.toContain(retired);
    }
    const growthSection = page
      .locator('#staff-navigation nav > div')
      .filter({ has: page.getByRole('button', { name: 'Growth', exact: true }) });
    const growthHrefs = await growthSection
      .locator('a')
      .evaluateAll(anchors => anchors.map(a => a.getAttribute('href')));
    expect(growthHrefs, 'the Growth group is exactly the five merged destinations, in order').toEqual(GROWTH_GROUP_PATHS);

    // --- Cold loads of the retired paths (bookmark / shared link case) ------
    for (const retired of RETIRED_PATHS) {
      await page.goto(retired);
      await expect(page, `${retired} lands on the merged workspace`).toHaveURL('/campaigns');
      const main = page.getByRole('main', { name: 'Clinic workspace' });
      await expect(main).toBeVisible();
      // The destination renders its own page (the h1 comes from the campaign
      // workspace's PageHeader), not a blank shell or the restricted state.
      await expect(main.locator('h1').first()).toBeVisible();
      await expect(main.getByText(RESTRICTED_STATE_SENTENCE)).toHaveCount(0);
      expect((await main.innerText()).trim(), `${retired} redirect rendered a blank workspace`).not.toBe('');
    }

    // --- An in-app legacy caller (CRM still navigates to /campaigner) -------
    await clickNavDestination(page, '/crm');
    await expect(page).toHaveURL('/crm');
    await page.getByRole('button', { name: /create campaign draft/i }).click();
    await expect(page, 'the CRM campaign CTA follows the retired path into /campaigns').toHaveURL('/campaigns');
    // Replace-not-push: Back must return to /crm, not to the retired path.
    await page.goBack();
    await expect(page).toHaveURL('/crm');
  });

  test('a role without campaign permissions is not offered /campaigns and gets the named restricted state', async ({ page }) => {
    // PROVIDER holds neither campaign:read nor crm:read
    // (server/lib/permissions.ts), so the whole Growth group is withheld.
    await signIn(page, tenant.emails.PROVIDER!, GROWTH_PASSWORD);

    const offered = await readNavDestinations(page);
    for (const path of [...GROWTH_GROUP_PATHS.filter(p => p !== '/autopilot'), ...RETIRED_PATHS]) {
      expect(offered, `provider navigation must not offer ${path}`).not.toContain(path);
    }

    // Deep-linking straight into the withheld workspace: the app must render
    // its one named restricted state, and must not fetch the campaign list.
    const campaignCalls: string[] = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/v1/crm/campaigns')) campaignCalls.push(request.url());
    });
    await page.goto('/campaigns');
    const main = page.getByRole('main', { name: 'Clinic workspace' });
    await expect(main).toBeVisible();
    await expect(main.getByText(`Campaigns ${RESTRICTED_STATE_SENTENCE}`, { exact: true })).toBeVisible();
    expect(rawAccessTextIn(await main.innerText()), 'raw authorization vocabulary must never render').toEqual([]);
    expect(campaignCalls, 'the withheld page must not request the campaign list').toEqual([]);

    // The retired paths must not become a side door. For a role without the
    // campaign grants the access gate stops the page from being drawn BEFORE
    // the redirect component can mount, so the URL stays on the retired path —
    // and the restricted state still names the merged Campaigns section
    // (src/lib/access.ts declares the retired paths with the same label and
    // grants as /campaigns, exactly so this state is honest).
    await page.goto('/campaigner');
    await expect(page).toHaveURL('/campaigner');
    await expect(main.getByText(`Campaigns ${RESTRICTED_STATE_SENTENCE}`, { exact: true })).toBeVisible();
    expect(rawAccessTextIn(await main.innerText())).toEqual([]);
    expect(campaignCalls).toEqual([]);
  });
});
