import 'dotenv/config';
import { test, expect, type Page } from '@playwright/test';
import { clickNavDestination, signIn } from './roleAccess';
import {
  createGrowthTenant, seedCrmPipeline, fixtureDb as db,
  GROWTH_PASSWORD, type GrowthTenant,
} from './growthFixture';

// ===========================================================================
// The CRM workspace on real seeded data, end to end through the UI and API:
//
//   - the Command View metrics are the server's tenant-wide aggregates with
//     their basis stated (exact figures asserted against the seeded rows:
//     $2,600 open pipeline across 3 open leads, 100% win rate over 1 closed);
//   - the pipeline board places each lead in its recorded stage lane;
//   - marking a lead lost REQUIRES a reason: an empty confirmation must not
//     issue any request, and the completed one must carry the reason, persist
//     it, and write the LeadActivity + audit evidence the modal promises;
//   - patient search runs on the SERVER: the request carries the typed search
//     parameter and the result set is the server's answer.
//
// Seeded via tests/e2e/growthFixture.ts: 3 open leads (1200 + 600 + 800),
// 1 retained lead, and 2 patients (one matching the search, one not).
// ===========================================================================

const lane = (page: Page, label: string) =>
  page.locator('.glass-lane').filter({ has: page.getByText(label, { exact: true }) });

test.describe('growth CRM journey', () => {
  let tenant: GrowthTenant;
  let leadIds: Record<string, string>;

  // Playwright resolves fixtures by parsing this destructuring pattern; the
  // empty pattern is its required spelling of 'no fixtures, only testInfo'.
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    tenant = await createGrowthTenant(`crm-${testInfo.project.name}`, ['OWNER']);
    leadIds = await seedCrmPipeline(tenant);
  });

  test.afterEach(async () => {
    await tenant?.dispose();
  });

  test.afterAll(async () => {
    await db.$disconnect();
  });

  test('metrics carry their basis, the board mirrors stages, lost needs a reason, search hits the server', async ({ page }) => {
    test.slow();
    const pageErrors: string[] = [];
    const serverFailures: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('response', response => {
      if (response.url().includes('/v1/') && response.status() >= 500) {
        serverFailures.push(`${response.status()} ${new URL(response.url()).pathname}`);
      }
    });

    await signIn(page, tenant.emails.OWNER!, GROWTH_PASSWORD);
    await clickNavDestination(page, '/crm');
    await expect(page).toHaveURL('/crm');

    // --- Command View: exact server aggregates, with their basis ------------
    // Open pipeline = 1200 + 600 + 800 across the three open leads.
    await expect(page.getByText('$2,600')).toBeVisible();
    await expect(page.getByText(/3 open leads/).first()).toBeVisible();
    // Basis statement: figures cover the whole workspace, and the counts are
    // the seeded totals (2 patients, 4 leads), not a page sample.
    await expect(page.getByText(/2 patients/).first()).toBeVisible();
    await expect(page.getByText(/4 leads/).first()).toBeVisible();
    // Win rate: 1 retained, 0 lost -> 100% across 1 closed lead.
    await expect(page.getByText('100%')).toBeVisible();
    // The priority list ranks the seeded open leads, not placeholders.
    await expect(page.getByText(/Liam Newinquiry|Rita Contacted|Mona Booker/).first()).toBeVisible();

    // --- Pipeline board: leads by recorded stage -----------------------------
    await page.getByRole('tab', { name: 'Pipeline' }).click();
    await expect(lane(page, 'New Inquiry').getByText('Liam Newinquiry')).toBeVisible();
    await expect(lane(page, 'Contacted').getByText('Rita Contacted')).toBeVisible();
    await expect(lane(page, 'Booked').getByText('Mona Booker')).toBeVisible();
    await expect(lane(page, 'Retained').getByText('Vic Retained')).toBeVisible();

    // --- Mark lost: the modal enforces the reason ----------------------------
    const leadPatches: string[] = [];
    page.on('request', request => {
      if (request.method() === 'PATCH' && new URL(request.url()).pathname.startsWith('/v1/leads/')) {
        leadPatches.push(request.postData() ?? '');
      }
    });

    const ritaCard = page.locator('.hover-lift').filter({ hasText: 'Rita Contacted' });
    await ritaCard.getByRole('button', { name: 'Mark lost' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Confirming without a reason must go nowhere: the dialog stays and no
    // stage-change request is issued.
    await dialog.getByRole('button', { name: 'Mark lost' }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Reason')).toBeVisible();
    expect(leadPatches, 'an empty reason must not produce a stage-change request').toEqual([]);

    const reason = 'Chose a competitor after comparing quotes';
    await dialog.getByLabel('Reason').fill(reason);
    const patched = page.waitForResponse(r =>
      r.request().method() === 'PATCH' && new URL(r.url()).pathname === `/v1/leads/${leadIds['Rita Contacted']}`);
    await dialog.getByRole('button', { name: 'Mark lost' }).click();
    expect((await patched).status()).toBe(200);
    expect(leadPatches).toHaveLength(1);
    expect(JSON.parse(leadPatches[0])).toEqual({ stage: 'lost', lostReason: reason });

    // The board reflects the transition…
    await expect(lane(page, 'Lost').getByText('Rita Contacted')).toBeVisible();
    // …and the promised evidence actually exists.
    const lostLead = await db.lead.findUniqueOrThrow({ where: { id: leadIds['Rita Contacted'] } });
    expect(lostLead.stage).toBe('lost');
    expect(lostLead.lostReason).toBe(reason);
    const activity = await db.leadActivity.findFirst({
      where: { tenantId: tenant.tenantId, leadId: lostLead.id, activityType: 'stage_change', toStage: 'lost' },
    });
    expect(activity?.reason).toBe(reason);
    const auditActions = (await db.auditEvent.findMany({ where: { tenantId: tenant.tenantId }, select: { action: true } })).map(a => a.action);
    expect(auditActions).toContain('lead.updated');

    // The Command View aggregates move with the record system: 2 open leads
    // ($2,000) and a 50% win rate across the 2 closed leads.
    await page.getByRole('tab', { name: 'Command View' }).click();
    await expect(page.getByText('$2,000')).toBeVisible();
    await expect(page.getByText('50%')).toBeVisible();

    // --- Patient Intelligence: search is the server's ------------------------
    await page.getByRole('tab', { name: 'Patient Intelligence' }).click();
    await expect(page.getByText('Avery Findme')).toBeVisible();
    await expect(page.getByText('Blair Bystander')).toBeVisible();

    const searched = page.waitForRequest(request => {
      const url = new URL(request.url());
      return url.pathname === '/v1/patients' && url.searchParams.get('search') === 'Avery';
    });
    await page.getByLabel('Search patients').fill('Avery');
    await searched; // the request carries the typed search parameter
    await expect(page.getByText('Avery Findme')).toBeVisible();
    await expect(page.getByText('Blair Bystander')).toHaveCount(0);

    expect(pageErrors, 'uncaught browser errors').toEqual([]);
    expect(serverFailures, 'real API 5xx responses').toEqual([]);
  });
});
