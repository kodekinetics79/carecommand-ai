import 'dotenv/config';
import { test, expect, type Page } from '@playwright/test';
import { clickNavDestination, signIn } from './roleAccess';
import { createGrowthTenant, fixtureDb as db, GROWTH_PASSWORD, type GrowthTenant } from './growthFixture';

// ===========================================================================
// The honest-state contract for the Growth surfaces, driven through the
// network: for each of /crm, /campaigns, /reviews and /clinic-radar,
//
//   1. IN FLIGHT — with the page's own data requests held open, the page must
//      show loading affordances and NO numeric KPI figure anywhere. A number
//      that renders before its response arrives is a fabricated zero.
//   2. FAILED — with the page's primary endpoint(s) answering 500, the page
//      must render an error state with a retry control — never zeros, never
//      a blank panel.
//   3. EMPTY — after the injected failure is lifted and the product's own
//      retry control is used, this tenant (which has NO growth data at all)
//      must show guidance-bearing empty states, not blank cards.
//
// KPI figures are detected structurally, not by copy: every numeric tile in
// these surfaces renders its value in a `.tabular-nums` element (StatCard,
// PremiumMetricCard, ClinicRadar's totals), and the dashboard-style cards use
// `.metric-card`. Loading affordances are `.skeleton`/`.skeleton-line`;
// failures are `role="alert"`; empty guidance is the dashed EmptyStatePremium
// block. None of those change when a copywriter rewrites a sentence.
// ===========================================================================

interface SurfaceContract {
  path: '/crm' | '/campaigns' | '/reviews' | '/clinic-radar';
  /** Every data request this surface issues for its own subject matter. */
  held: RegExp;
  /** The subset to answer 500 in the failure phase. */
  failed: (url: string) => boolean;
}

const SURFACES: SurfaceContract[] = [
  {
    path: '/crm',
    held: /\/v1\/(growth\/(metrics|leads|segments)|crm\/consent|patients)/,
    failed: url => url.includes('/v1/growth/metrics'),
  },
  {
    path: '/campaigns',
    held: /\/v1\/crm\/(campaigns|attribution)/,
    failed: url => new URL(url).pathname === '/v1/crm/campaigns' || url.includes('/v1/crm/attribution'),
  },
  {
    path: '/reviews',
    held: /\/v1\/(reviews|reputation|providers\/overview|growth\/policy)/,
    failed: url => url.includes('/v1/reviews') || url.includes('/v1/reputation'),
  },
  {
    path: '/clinic-radar',
    held: /\/v1\/(competitors\/radar|reputation)/,
    failed: url => url.includes('/v1/competitors/radar') || url.includes('/v1/reputation'),
  },
];

function workspaceMain(page: Page) {
  return page.getByRole('main', { name: 'Clinic workspace' });
}

/** No numeric KPI may be on screen: the tiles either exist with a real value or do not exist. */
async function expectNoKpiFigures(page: Page) {
  const main = workspaceMain(page);
  await expect(main.locator('.tabular-nums', { hasText: /\d/ })).toHaveCount(0);
  await expect(main.locator('.metric-card')).toHaveCount(0);
}

test.describe('growth surfaces render only honest states', () => {
  let tenant: GrowthTenant;

  test.beforeAll(async ({}, testInfo) => {
    // Deliberately a tenant with NO growth data: phase 3 asserts that a truly
    // empty workspace produces guidance, not blanks — and phases 1 and 2 never
    // depend on data existing.
    tenant = await createGrowthTenant(`honest-${testInfo.project.name}`, ['OWNER']);
  });

  test.afterAll(async () => {
    await tenant?.dispose();
    await db.$disconnect();
  });

  for (const surface of SURFACES) {
    test(`${surface.path}: loading shows no figures, failure shows retry, emptiness shows guidance`, async ({ page }) => {
      await signIn(page, tenant.emails.OWNER!, GROWTH_PASSWORD);

      // ---- Phase 1: hold every data response this surface depends on -------
      let phase: 'hold' | 'fail' = 'hold';
      const gate: Array<() => void> = [];
      await page.route(surface.held, async route => {
        if (phase === 'hold') await new Promise<void>(resolve => gate.push(resolve));
        if (phase === 'fail' && surface.failed(route.request().url())) {
          return route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'e2e_injected_failure', message: 'Injected by growth-honest-states.spec.ts' }),
          });
        }
        return route.continue();
      });

      await clickNavDestination(page, surface.path);
      await expect(page).toHaveURL(surface.path);
      const main = workspaceMain(page);

      // The page is mounted and says it is loading…
      await expect(main.locator('.skeleton-line, .skeleton').first()).toBeVisible();
      // …and while its requests are in flight, not one numeric KPI renders.
      await expectNoKpiFigures(page);

      // ---- Phase 2: the primary endpoint fails ------------------------------
      phase = 'fail';
      for (const release of gate.splice(0)) release();

      // An error state with a retry control — not zeros, not a blank card.
      await expect(main.getByRole('alert').first()).toBeVisible();
      const retryButtons = main.getByRole('button', { name: /try again|retry/i });
      await expect(retryButtons.first()).toBeVisible();
      await expectNoKpiFigures(page);
      expect((await main.innerText()).trim(), `${surface.path} error state rendered a blank workspace`).not.toBe('');

      // ---- Phase 3: lift the failure; recover via the product's own retry ---
      await page.unroute(surface.held);
      await expect(async () => {
        if (await retryButtons.count() > 0) {
          await retryButtons.first().click({ timeout: 2_000 }).catch(() => {});
        }
        expect(await retryButtons.count(), `${surface.path} still shows a retry control`).toBe(0);
        expect(await main.getByRole('alert').count(), `${surface.path} still shows an error state`).toBe(0);
      }).toPass({ timeout: 20_000 });

      // The empty workspace states its emptiness as guidance: the dashed
      // empty-state block with a real explanation, never a blank card.
      const guidance = main.locator('.border-dashed').filter({ hasText: /\w/ });
      await expect(guidance.first()).toBeVisible();
      expect(
        (await guidance.first().innerText()).trim().length,
        `${surface.path} empty state carries no guidance text`,
      ).toBeGreaterThan(40);
    });
  }
});
