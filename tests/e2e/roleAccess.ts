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
  { path: '/ai-receptionist', label: 'AI Receptionist', primaryCall: '/v1/conversations' },
  { path: '/receptionist-studio', label: 'Receptionist Studio', primaryCall: '/v1/receptionist/overview' },
  { path: '/staff', label: 'Staff Tasks', primaryCall: '/v1/staff/overview' },
  { path: '/crm', label: 'CRM', primaryCall: '/v1/leads' },
  { path: '/campaigner', label: 'Campaigner', primaryCall: '/v1/campaigns' },
  { path: '/reactivation', label: 'Reactivation', primaryCall: '/v1/crm/campaigns' },
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
  { path: '/devices', label: 'Device Integration', primaryCall: '/v1/devices/overview' },
  { path: '/enrollments', label: 'Device Enrollments', primaryCall: '/v1/connected-care/enrollments' },
  { path: '/rpm-readiness', label: 'RPM Billing Readiness', primaryCall: '/v1/connected-care/rpm-readiness' },
  { path: '/sync-logs', label: 'Provider Sync Logs', primaryCall: '/v1/connected-care/sync-logs' },
  { path: '/integration-setup', label: 'Integration Setup', primaryCall: '/v1/devices/providers' },
  { path: '/compliance', label: 'Compliance Readiness', primaryCall: '/v1/compliance/dashboard' },
  { path: '/control-plane', label: 'Control Plane', primaryCall: '/v1/control-plane/overview' },
  { path: '/integrations', label: 'Integrations', primaryCall: '/v1/integrations/status' },
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
  OWNER: {
    navDestinations: 32,
    mustOffer: ['/', '/settings', '/patients', '/scheduling', '/insurance', '/staff', '/integrations', '/monitoring', '/compliance', '/control-plane'],
    mustNotOffer: [],
  },
  // Patient, billing, staff and CRM reads; no revenue, operations, integrations
  // or compliance grant, and not on the connected-care role list.
  FRONT_DESK: {
    navDestinations: 20,
    mustOffer: ['/', '/settings', '/patients', '/scheduling', '/insurance', '/staff', '/crm'],
    mustNotOffer: ['/control-plane', '/compliance', '/integrations', '/monitoring', '/revenue', '/receptionist-studio'],
  },
  // Clinical reads plus the connected-care role list; no CRM, billing, revenue
  // or compliance grant.
  PROVIDER: {
    navDestinations: 17,
    mustOffer: ['/', '/settings', '/patients', '/scheduling', '/staff', '/monitoring', '/doctor-workspace'],
    mustNotOffer: ['/control-plane', '/compliance', '/crm', '/insurance', '/revenue', '/integrations'],
  },
  // Compliance and audit reads and nothing operational.
  AUDITOR: {
    navDestinations: 9,
    mustOffer: ['/', '/settings', '/compliance'],
    mustNotOffer: ['/control-plane', '/patients', '/scheduling', '/insurance', '/staff', '/integrations', '/monitoring', '/revenue'],
  },
};

/** The sentence the one restricted state prints, whatever the section. */
export const RESTRICTED_STATE_SENTENCE = 'is not part of your access';

/**
 * Raw authorization vocabulary that must never reach a rendered screen. "403"
 * is matched only when it is not part of a longer figure, so a real currency
 * amount such as "1,403.00" is not mistaken for a status code.
 */
const RAW_ACCESS_TEXT: readonly { name: string; pattern: RegExp }[] = [
  { name: '403', pattern: /(?<![\d.,])403(?![\d.,])/ },
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
