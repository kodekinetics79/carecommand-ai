import 'dotenv/config';
import { test, expect, type Page } from '@playwright/test';
import {
  CRAWL_ROLES,
  NAV_DESTINATIONS,
  RESTRICTED_STATE_SENTENCE,
  ROLE_ACCESS,
  apiPathname,
  arriveWithoutLink,
  clickNavDestination,
  rawAccessTextIn,
  readNavDestinations,
  signIn,
  type NavDestination,
} from './roleAccess';
import { externalTarget, resolveRoleAccounts, type RoleAccounts } from './roleAccounts';

// ===========================================================================
// The access model, as a gate.
//
// One signed-in browser per role, asserting the four things a hand crawl
// checks and then forgets:
//
//   1. the sidebar offers exactly as many destinations as the role can open;
//   2. no screen prints raw authorization vocabulary to anyone;
//   3. reaching a withheld section anyway lands on the named restricted state —
//      not a raw error, not a blank page;
//   4. every offered destination answers its own primary data call.
//
// Runs against this checkout's build by default and against a deployed
// environment when E2E_BASE_URL is configured (see roleAccounts.ts).
// ===========================================================================

let accounts: RoleAccounts;

test.beforeAll(async () => {
  accounts = await resolveRoleAccounts(CRAWL_ROLES);
});

test.afterAll(async () => {
  await accounts?.dispose();
});

/**
 * How long to let a screen's secondary panels answer after its primary call
 * has landed, before reading the rendered text.
 *
 * Deliberately a fixed grace rather than "wait until the network goes quiet".
 * Several screens (/advisory, /patients, /scheduling and the other
 * branch-scoped ones) re-issue GET /v1/branches continuously — hundreds of
 * times a second, without settling — so a quiet period never arrives. Waiting
 * for one holds those routes open for the whole timeout and multiplies their
 * request volume until the API's rate limiter starts answering 429, which then
 * fails this suite for a reason that has nothing to do with access.
 */
const PANEL_GRACE_MS = 750;

interface ApiTraffic {
  /** Every /v1 response seen since the last reset. */
  responses: { path: string; status: number }[];
  reset(): void;
}

function watchApiTraffic(page: Page): ApiTraffic {
  const responses: { path: string; status: number }[] = [];
  page.on('response', response => {
    if (response.url().includes('/v1/')) responses.push({ path: apiPathname(response.url()), status: response.status() });
  });
  return {
    responses,
    reset() {
      responses.length = 0;
    },
  };
}

test.describe('per-role access model', () => {
  for (const role of CRAWL_ROLES) {
    test(`${role} is offered exactly the destinations it can open`, async ({ page }) => {
      // A whole-workspace crawl: every offered destination, then every
      // destination this role is not offered.
      test.setTimeout(15 * 60_000);
      test.info().annotations.push({ type: 'target', description: externalTarget() ?? 'playwright webServer (this checkout)' });

      const pageErrors: string[] = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      const traffic = watchApiTraffic(page);
      const contract = ROLE_ACCESS[role];
      const declared = NAV_DESTINATIONS.map(destination => destination.path);

      await signIn(page, accounts.emails[role], accounts.password);

      // --- 1. what the sidebar offers ------------------------------------
      const offered = await readNavDestinations(page);

      // A destination offered twice means an entry points somewhere other than
      // its own section — the shape a plan lock takes, where several entries
      // collapse onto /subscription and the count stops meaning "destinations
      // this role can open".
      expect([...new Set(offered)], `${role} is offered a destination more than once`).toEqual(offered);
      expect(offered.filter(href => !declared.includes(href)), `${role} is offered an undeclared destination`).toEqual([]);
      expect(offered.length, `navigation destinations offered to ${role}`).toBe(contract.navDestinations);
      if (role === 'OWNER') {
        expect(offered, 'a role holding every grant is offered the whole inventory').toEqual(declared);
      }
      for (const href of contract.mustOffer) {
        expect(offered, `${role} navigation offers ${href}`).toContain(href);
      }
      for (const href of contract.mustNotOffer) {
        expect(offered, `${role} navigation must not offer ${href}`).not.toContain(href);
      }

      // --- 4. every offered destination opens on its own data ------------
      // Step off the landing page first so that following the entry back to it
      // is a real navigation and the dashboard's request is observed like any
      // other destination's.
      await clickNavDestination(page, offered[offered.length - 1]!);
      await page.waitForTimeout(PANEL_GRACE_MS);

      for (const href of offered) {
        const destination = NAV_DESTINATIONS.find(entry => entry.path === href)!;
        traffic.reset();
        const primaryCall = destination.primaryCall;
        const primary = primaryCall
          ? page.waitForResponse(response => apiPathname(response.url()) === primaryCall, { timeout: 30_000 })
          : null;

        await clickNavDestination(page, href);
        await expect(page).toHaveURL(href);
        const main = page.getByRole('main', { name: 'Clinic workspace' });
        await expect(main, `${role} opened ${href} and got no workspace`).toBeVisible();

        if (primary) {
          const response = await primary;
          expect(response.status(), `${role} opened ${href} and ${primaryCall} answered ${response.status()}`).toBeLessThan(400);
        }
        await page.waitForTimeout(PANEL_GRACE_MS);

        // An offered destination is one the role can actually open, so the
        // restricted state must never be what an entry leads to.
        await expect(main, `${role} is offered ${href} but cannot open it`).not.toContainText(RESTRICTED_STATE_SENTENCE);
        expect((await main.innerText()).trim(), `${href} rendered nothing for ${role}`).not.toBe('');

        // --- 2. no raw authorization vocabulary, anywhere ----------------
        expect(rawAccessTextIn(await page.locator('body').innerText()), `raw authorization text on ${href} for ${role}`).toEqual([]);

        const serverErrors = traffic.responses.filter(call => call.status >= 500);
        expect(serverErrors, `server errors while ${role} opened ${href}`).toEqual([]);
      }

      // --- 3. arriving somewhere the sidebar does not offer ---------------
      const restricted = NAV_DESTINATIONS.filter(destination => !offered.includes(destination.path));
      expect(restricted.length, `destinations withheld from ${role}`).toBe(NAV_DESTINATIONS.length - contract.navDestinations);

      const assertRestricted = async (destination: NavDestination, arrival: string) => {
        const main = page.getByRole('main', { name: 'Clinic workspace' });
        await expect(main, `${role} ${arrival} ${destination.path} and got no workspace`).toBeVisible();

        // The named state, not a status code and not an empty shell.
        await expect(
          main.getByText(`${destination.label} ${RESTRICTED_STATE_SENTENCE}`, { exact: true }),
          `${role} ${arrival} ${destination.path} and is told which section it is`,
        ).toBeVisible();
        await page.waitForTimeout(PANEL_GRACE_MS);
        expect((await main.innerText()).trim(), `${destination.path} was blank for ${role}`).not.toBe('');
        expect(rawAccessTextIn(await page.locator('body').innerText()), `raw authorization text on ${destination.path} for ${role}`).toEqual([]);

        // Reaching it by hand does not put it back in the sidebar.
        expect(await readNavDestinations(page), `${destination.path} is still withheld from ${role}`).not.toContain(destination.path);

        const serverErrors = traffic.responses.filter(call => call.status >= 500);
        expect(serverErrors, `server errors while ${role} ${arrival} ${destination.path}`).toEqual([]);
      };

      // The bookmark: a cold load straight into a withheld section, with the
      // session rebuilt from the refresh cookie. One per role — see
      // arriveWithoutLink for why the sweep below cannot each be a cold load.
      const bookmarked = restricted[0];
      if (bookmarked) {
        traffic.reset();
        await page.goto(bookmarked.path);
        await assertRestricted(bookmarked, 'deep-linked to');
      }

      // Every withheld destination, reached the way a typed URL reaches it: a
      // location nothing in the interface links to.
      for (const destination of restricted) {
        traffic.reset();
        await arriveWithoutLink(page, destination.path);
        await assertRestricted(destination, 'arrived at');
      }

      expect(pageErrors, `uncaught browser errors for ${role}`).toEqual([]);
    });
  }
});
