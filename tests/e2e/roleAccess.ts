import { expect, type Page } from '@playwright/test';

// ===========================================================================
// The per-role access contract, written down once.
//
// Everything here is an EXPECTATION, not a derivation. None of it is imported
// from src/lib/access.ts or server/lib/permissions.ts on purpose: an
// expectation computed from the code under test agrees with whatever that code
// does, including the wrong thing, and a check that cannot disagree is not a
// check. These numbers and names were read off a signed-in browser.
//
// Source of the numbers: a manual crawl in Chrome on 2026-08-28 against the
// synthetic pilot, re-measured by this suite. Before the access registry
// landed every role was offered 28-30 destinations regardless of its grants.
// ===========================================================================

/** Roles this gate covers. */
export const CRAWL_ROLES = ['OWNER', 'FRONT_DESK', 'PROVIDER', 'AUDITOR'] as const;
export type CrawlRole = (typeof CRAWL_ROLES)[number];

export interface NavDestination {
  /** Sidebar href. */
  path: string;
  /**
   * The section name the restricted state must print when a role that cannot
   * open this destination deep-links to it.
   */
  label: string;
  /**
   * The one request the destination cannot render without — the call that
   * fetches its own subject matter. Panels a destination merely embeds (a
   * workspace summary, a payments strip) are deliberately NOT listed: several
   * are admin-scoped and answer 403 to a front-desk or provider session by
   * design, and the page degrades to a per-panel notice rather than failing.
   * `null` means the landing view is built from the session alone and issues
   * no unconditional request of its own.
   */
  primaryCall: string | null;
}

/**
 * Every destination the sidebar can offer, in sidebar order. A fully granted
 * OWNER must be offered exactly this list — that is what makes the per-role
 * counts below mean something rather than just being smaller.
 */
export const NAV_DESTINATIONS: readonly NavDestination[] = [
  { path: '/', label: 'Command Center', primaryCall: '/v1/dashboard/summary' },
  { path: '/advisory', label: 'Advisory Room', primaryCall: '/v1/advisory/brief' },
  { path: '/opportunities', label: 'Opportunity Center', primaryCall: '/v1/opportunities' },
  { path: '/patients', label: 'Patients', primaryCall: '/v1/patients' },
  { path: '/scheduling', label: 'Scheduling', primaryCall: '/v1/appointments' },
  { path: '/patient-intake', label: 'Patient Intake', primaryCall: '/v1/intake/queue' },
  // The work the AI receptionist hands back to a human: emergency, callback and
  // service lanes. GET /v1/tasks is the lane query and the first request the
  // board makes; /v1/tasks/summary is deliberately NOT the probe here, because
  // the sidebar badge polls it from every page and a probe another surface also
  // issues would pass without this one loading.
  { path: '/front-desk', label: 'Front Desk', primaryCall: '/v1/tasks' },
  { path: '/ai-receptionist', label: 'AI Receptionist', primaryCall: '/v1/conversations' },
  { path: '/receptionist-studio', label: 'Receptionist Studio', primaryCall: '/v1/receptionist/overview' },
  { path: '/staff', label: 'Staff Tasks', primaryCall: '/v1/staff/overview' },
  // The CRM workspace opens on its Command View, whose figures come from
  // GET /v1/growth/metrics. It was /v1/leads until the Growth rebuild moved
  // scoring and aggregation server-side; the page no longer issues /v1/leads on
  // load at all, so the old probe waited for a request that never comes.
  { path: '/crm', label: 'CRM', primaryCall: '/v1/growth/metrics' },
  // /campaigner and /reactivation were one Campaign table behind two doors;
  // they merged into the single /campaigns workspace (both old paths now
  // redirect there — asserted by growth-redirects-and-nav.spec.ts).
  { path: '/campaigns', label: 'Campaigns', primaryCall: '/v1/crm/campaigns' },
  { path: '/autopilot', label: 'Autopilot', primaryCall: '/v1/autopilot/playbooks' },
  { path: '/reviews', label: 'Reviews', primaryCall: '/v1/reviews' },
  { path: '/clinic-radar', label: 'ClinicRadar', primaryCall: '/v1/competitors/radar' },
  { path: '/revenue', label: 'Revenue Leaks', primaryCall: '/v1/revenue-snapshots' },
  { path: '/revenue-protection', label: 'Revenue Protection', primaryCall: '/v1/revenue-protection/overview' },
  { path: '/insurance', label: 'Insurance', primaryCall: '/v1/insurance/overview' },
  { path: '/insurance-eligibility', label: 'Insurance Eligibility', primaryCall: '/v1/insurance/eligibility/history' },
  { path: '/doctor-workspace', label: 'Provider Performance', primaryCall: '/v1/providers/overview' },
  { path: '/benchmarking', label: 'Multi-Clinic Benchmarking', primaryCall: '/v1/competitors/radar' },
  { path: '/monitoring', label: 'Remote Monitoring', primaryCall: '/v1/monitoring/overview' },
  // The bands a clinic's own alerts fire on. Reading them is the whole point of
  // the screen and is on the monitoring module's role gate; writing one is
  // narrower (OWNER/ADMIN/MANAGER), which is why the probe is the read.
  { path: '/alert-thresholds', label: 'Alert Thresholds', primaryCall: '/v1/monitoring/rules' },
  { path: '/devices', label: 'Device Integration', primaryCall: '/v1/devices/overview' },
  { path: '/enrollments', label: 'Device Enrollments', primaryCall: '/v1/connected-care/enrollments' },
  { path: '/rpm-readiness', label: 'RPM Billing Readiness', primaryCall: '/v1/connected-care/rpm-readiness' },
  { path: '/sync-logs', label: 'Provider Sync Logs', primaryCall: '/v1/connected-care/sync-logs' },
  // '/integration-setup' and '/integrations' were certified destinations here
  // until the supplier catalogue left the tenant app on 2026-08-30. Both were
  // directories of the services CareCommand buys, with credential fields and a
  // Test-connection button per vendor; they are Platform Console surfaces now.
  // Every role's count falls by the entries it used to be offered.
  { path: '/compliance', label: 'Compliance Readiness', primaryCall: '/v1/compliance/dashboard' },
  { path: '/control-plane', label: 'Control Plane', primaryCall: '/v1/control-plane/overview' },
  { path: '/subscription', label: 'Subscription', primaryCall: '/v1/subscriptions/current' },
  // The account page every user reaches from their own avatar. Its landing view
  // is session-derived; the workspace-summary tiles it embeds are admin-scoped.
  { path: '/settings', label: 'Settings', primaryCall: null },
];

export interface RoleAccessContract {
  /**
   * How many destinations the sidebar offers this role. Counted in Chrome on
   * 2026-08-28 with every subscription feature entitled, so nothing is hidden
   * behind a plan lock and each offered entry is its own destination.
   */
  navDestinations: number;
  /** Destinations this role must be offered. */
  mustOffer: readonly string[];
  /** Destinations this role must never be offered. */
  mustNotOffer: readonly string[];
}

export const ROLE_ACCESS: Record<CrawlRole, RoleAccessContract> = {
  // Every permission in the vocabulary: the whole inventory.
  // 2026-08-29: 32 -> 31 when /campaigner and /reactivation merged into the
  // single /campaigns destination.
  // 2026-08-30: 31 -> 33. Two destinations were added, not renamed: /front-desk
  // (the queue of work the AI receptionist hands back to a human) and
  // /alert-thresholds (the bands a clinic's own monitoring alerts fire on,
  // which had no write path anywhere in the product before it).
  // 2026-08-30: 33 -> 31. Two destinations were REMOVED from the product, not
  // withheld from this role: /integrations (the 17-provider grid) and
  // /integration-setup (credential entry for the same providers). An OWNER held
  // integrations:read and the device entitlement, so it was offered both; every
  // other declaration for this role is unchanged.
  OWNER: {
    navDestinations: 31,
    mustOffer: ['/', '/settings', '/patients', '/scheduling', '/insurance', '/staff', '/monitoring', '/compliance', '/control-plane', '/campaigns', '/front-desk', '/alert-thresholds', '/advisory'],
    mustNotOffer: [],
  },
  // Patient, billing, staff and CRM reads; no revenue, operations, integrations
  // or compliance grant, and not on the connected-care role list. Holds both
  // campaign:read and crm:read, so the merged campaign workspace is offered.
  // 2026-08-29: 20 -> 19 for the same /campaigns merge (two entries became one).
  // 2026-08-30: still 19, from two changes that cancel. Front Desk is the
  // role's own board and it holds both grants the board needs:
  // receptionist:call-artifacts:read for the call evidence and staff:read for
  // the task lanes. It gained receptionist:read in the same change, which opens
  // the Studio's READ routes — but the Studio screen still renders its mutation
  // controls, so navigation keeps gating it on receptionist:manage and this
  // role is still not offered it. Against that, /advisory left: the brief names
  // patients and their money and its route requires patient:read AND
  // revenue:read, which this role does not hold.
  // 2026-08-30: 19 -> 18. This role never held integrations:read, so
  // /integrations was already withheld — but /integration-setup declared no
  // permission at all (entitlement only), so every signed-in user was offered a
  // screen with API-key fields on it. That destination no longer exists.
  FRONT_DESK: {
    navDestinations: 18,
    mustOffer: ['/', '/settings', '/patients', '/scheduling', '/insurance', '/staff', '/crm', '/campaigns', '/front-desk'],
    mustNotOffer: ['/control-plane', '/compliance', '/monitoring', '/revenue', '/receptionist-studio', '/alert-thresholds', '/advisory'],
  },
  // Clinical reads plus the connected-care role list; no CRM, billing, revenue
  // or compliance grant — and therefore no campaign workspace, and no
  // receptionist grant of any kind, so no Front Desk board.
  // 2026-08-30: 17 -> 16, three movements. The /campaigns merge on 2026-08-29
  // took a destination away from this role that the note above did not record:
  // /reactivation required NO permission until then, so every role was offered
  // it, and the merged workspace requires campaign:read + crm:read.
  // /alert-thresholds gave one back — it is on the monitoring module's role
  // gate, which includes PROVIDER. And /advisory left, for the reason on
  // FRONT_DESK above: no revenue:read.
  // 2026-08-30: 16 -> 15, for the same reason as FRONT_DESK — the permissionless
  // /integration-setup entry it was being offered is gone.
  PROVIDER: {
    navDestinations: 15,
    mustOffer: ['/', '/settings', '/patients', '/scheduling', '/staff', '/monitoring', '/doctor-workspace', '/alert-thresholds'],
    mustNotOffer: ['/control-plane', '/compliance', '/crm', '/campaigns', '/insurance', '/revenue', '/front-desk', '/advisory'],
  },
  // Compliance and audit reads and nothing operational.
  // 2026-08-30: 9 -> 7. It loses the same free /reactivation entry the PROVIDER
  // note above describes, and /advisory, which it never had the grants for.
  // It is NOT offered /front-desk despite holding
  // receptionist:call-artifacts:read: the board's task lanes are GET /v1/tasks,
  // which requires staff:read, and an auditor holds no staff grant. A page
  // whose calls load and whose work lanes 403 is the half-open door this suite
  // exists to catch, so the requirement was corrected rather than the count.
  // 2026-08-30: 7 -> 6. Same single cause: /integration-setup asked for nothing,
  // so an auditor was offered a credential-entry screen too.
  AUDITOR: {
    navDestinations: 6,
    mustOffer: ['/', '/settings', '/compliance'],
    mustNotOffer: ['/control-plane', '/patients', '/scheduling', '/insurance', '/staff', '/monitoring', '/revenue', '/campaigns', '/front-desk', '/alert-thresholds', '/advisory'],
  },
};

/** The sentence the one restricted state prints, whatever the section. */
export const RESTRICTED_STATE_SENTENCE = 'is not part of your access';

/**
 * Raw authorization vocabulary that must never reach a rendered screen. "403"
 * is matched only when it is not part of a longer figure, so a real currency
 * amount such as "1,403.00" is not mistaken for a status code.
 */
// WHY THERE IS NO BARE `403` PATTERN HERE
//
// There was one: /(?<![\d.,])403(?![\d.,])/. It excluded neighbouring digits
// and commas and nothing else, so it fired on any page containing
//
//   * a metric that happened to equal 403 ("403 patients"), or
//   * ANY identifier with 403 between two non-digits ("a1b403fe-...").
//
// Ids are regenerated every run, so this failed at random, on every branch,
// with no defect present — and a green rerun of unchanged code was the only
// way to tell. A check that cries wolf on a coin flip trains people to re-run
// CI until it passes, which is worse than not having it.
//
// Removing it loses nothing real. It could not tell a refusal from a UUID, so
// every time it fired someone had to re-run CI to find out which it was — and
// the answer was never "a defect". The word patterns below stay: unlike a
// number, `forbidden` and `insufficient_permission` cannot occur innocently.
//
// The network-level check that WOULD be exact — no /v1 response answering 403
// on a destination the sidebar offers — was written and run. It fails today
// for a real reason: the dashboard requests revenue data for every role, so
// three of four roles collect 14 refusals on the landing page. Fixing that is
// a product decision about which panels each role is shown, so it is tracked
// separately instead of being bundled into a test-hygiene change.
const RAW_ACCESS_TEXT: readonly { name: string; pattern: RegExp }[] = [
  { name: 'Forbidden', pattern: /forbidden/i },
  { name: 'required permission', pattern: /required permission/i },
  // The literal error code the API returns with a 403, in case it is ever
  // printed verbatim instead of the message.
  { name: 'insufficient_permission', pattern: /insufficient_permission/i },
];

/** Which pieces of raw authorization vocabulary appear in rendered text. */
export function rawAccessTextIn(rendered: string): string[] {
  return RAW_ACCESS_TEXT.filter(entry => entry.pattern.test(rendered)).map(entry => entry.name);
}

/** Request pathname, without the query string the caller may have added. */
export function apiPathname(url: string): string {
  return new URL(url).pathname;
}

export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
  await page.getByRole('textbox', { name: /Password/ }).fill(password);
  await page.getByRole('button', { name: /^Sign in$/i }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('main', { name: 'Clinic workspace' })).toBeVisible();
}

/**
 * The destinations the signed-in role is offered.
 *
 * Navigation is authorized from the session's resolved grants, so until
 * /v1/auth/me answers, the sidebar renders its own skeleton and offers
 * nothing. Waiting for that skeleton to clear is the product's own signal that
 * the grant set has arrived; sampling earlier would read a nav that is
 * momentarily empty for every role.
 */
export async function readNavDestinations(page: Page): Promise<string[]> {
  const nav = page.locator('#staff-navigation nav');
  await expect(nav.locator('.skeleton')).toHaveCount(0);
  await expect(nav.locator('a').first()).toBeAttached();
  return nav.locator('a').evaluateAll(anchors =>
    anchors.map(anchor => anchor.getAttribute('href')).filter((href): href is string => Boolean(href)));
}

/** Follow a sidebar entry the way a signed-in user does, drawer and all. */
export async function clickNavDestination(page: Page, href: string): Promise<void> {
  const openNavigation = page.getByRole('button', { name: 'Open navigation' });
  if (await openNavigation.isVisible()) await openNavigation.click();
  await page.locator(`#staff-navigation nav a[href="${href}"]`).first().click();
}

/**
 * Arrive at a path the sidebar does not offer, without reloading the page.
 *
 * The bookmark case is a cold load, and the gate still does one of those per
 * role. It cannot do one per withheld destination: every cold load spends a
 * POST /v1/auth/refresh to rebuild the in-memory access token, and that route
 * is capped at 20 per minute (server/modules/auth/routes.ts) — a real abuse
 * control, not a test-harness limit. Sweeping every withheld destination that
 * way trips it partway through and the app correctly signs the session out,
 * which tells us nothing about access.
 *
 * Pushing the URL and letting the router pick it up puts the app at a location
 * nothing in the interface links to, which is what this assertion is about. It
 * runs the same guard in ProtectedLayout on the same session; only the reload
 * is skipped.
 */
export async function arriveWithoutLink(page: Page, path: string): Promise<void> {
  await page.evaluate(destination => {
    window.history.pushState({}, '', destination);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await expect(page).toHaveURL(path);
}
