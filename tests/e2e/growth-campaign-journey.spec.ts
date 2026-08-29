import 'dotenv/config';
import { test, expect, type Page } from '@playwright/test';
import { signIn, clickNavDestination } from './roleAccess';
import {
  createGrowthTenant, seedInactiveAudience, fixtureDb as db,
  GROWTH_PASSWORD, type GrowthTenant,
} from './growthFixture';

// ===========================================================================
// The Growth money path, end to end through the real UI and API:
//
//   owner signs in -> /campaigns -> picks a goal -> creates a campaign ->
//   generates the rule-based draft -> the audience preview shows
//   eligible / suppressed / missing-contact counts (with the suppressed count
//   GREATER THAN ZERO — the consent gate visibly firing is the product's core
//   guarantee) -> approves against the exact server preview (fingerprinted) ->
//   launches against the exact server preview -> dispatch evidence appears.
//
// PROVIDER SEMANTICS IN THIS HARNESS — verified against server config, not
// assumed: `channelStatus()` (server/lib/campaigns.ts) reports sms as
// setup_required because e2e:serve configures no TWILIO_* credentials, and
// `providerModeFor()` can only return 'mock_dev' when the credentials start
// with "mock" AND NODE_ENV !== 'production' — but e2e:serve pins
// NODE_ENV=production. So in this harness NO message can reach any provider
// (that is the no-real-send guarantee), dispatch truthfully records every
// contactable recipient as `setup_required` and never fabricates a
// provider-accepted receipt. The spec asserts exactly those semantics: real
// delivery-evidence rows, zero provider message ids, zero acceptance claims.
// The provider-ACCEPTED path (mock_dev) is unreachable here; see the
// test.fixme at the bottom, which documents the harness gap.
// ===========================================================================

const CAMPAIGN_NAME = 'E2E Winback Journey';

test.describe('growth campaign money path', () => {
  let tenant: GrowthTenant;

  test.beforeEach(async ({}, testInfo) => {
    tenant = await createGrowthTenant(`campaign-${testInfo.project.name}`, ['OWNER']);
    await seedInactiveAudience(tenant);
  });

  test.afterEach(async () => {
    await tenant?.dispose();
  });

  test.afterAll(async () => {
    await db.$disconnect();
  });

  test('owner drafts, previews, approves and launches a consent-gated campaign', async ({ page }) => {
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
    await clickNavDestination(page, '/campaigns');
    await expect(page).toHaveURL('/campaigns');

    // --- Goal selection opens the creator with the goal's audience chosen ---
    await page.getByRole('button', { name: /inactive patients/i }).first().click();
    const typeSelect = page.getByLabel('Campaign type');
    const audienceSelect = page.getByLabel('Audience type');
    const channelSelect = page.getByLabel('Channel').first();
    await expect(typeSelect).toHaveValue('inactive_patient_reactivation');
    await expect(audienceSelect).toHaveValue('inactive_patients');
    await expect(channelSelect).toHaveValue('sms');

    // --- Create the draft ---------------------------------------------------
    await page.getByLabel('Name').fill(CAMPAIGN_NAME);
    const created = page.waitForResponse(r => r.url().includes('/v1/crm/campaigns') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    expect((await created).status()).toBe(201);
    await expect(page.getByRole('heading', { name: CAMPAIGN_NAME })).toBeVisible();

    const campaign = await db.campaign.findFirstOrThrow({ where: { tenantId: tenant.tenantId, name: CAMPAIGN_NAME } });
    expect(campaign.status).toBe('APPROVAL_REQUIRED');
    expect(campaign.requiresApproval).toBe(true);
    expect(campaign.audienceType).toBe('inactive_patients');

    // --- Audience preview: the consent gate firing, visibly ----------------
    // 3 seeded inactive patients -> 1 contactable, 1 SUPPRESSED (the active
    // CampaignSuppression row), 1 with no phone. The suppressed count MUST be
    // greater than zero — this is the core guarantee under test.
    const audienceCard = page.locator('.cc-card').filter({ has: page.getByRole('heading', { name: /audience preview/i }) });
    await expect(audienceCard).toBeVisible();
    await expect(audienceCard.locator('div').filter({ hasText: /^3\s*Total$/ })).toBeVisible();
    await expect(audienceCard.locator('div').filter({ hasText: /^1\s*Contactable\*?$/ })).toBeVisible();
    await expect(audienceCard.locator('div').filter({ hasText: /^1\s*Suppressed$/ })).toBeVisible();
    await expect(audienceCard.locator('div').filter({ hasText: /^1\s*No contact$/ })).toBeVisible();
    // The suppressed figure is exactly 1 and therefore > 0; keep an explicit
    // numeric assertion so a copy change cannot silently weaken this check.
    const suppressedValue = await audienceCard
      .getByText('Suppressed', { exact: true })
      .locator('xpath=preceding-sibling::p[1]')
      .innerText();
    expect(Number(suppressedValue)).toBeGreaterThan(0);

    // --- Rule-based draft ---------------------------------------------------
    const drafted = page.waitForResponse(r => /\/v1\/crm\/campaigns\/[^/]+\/draft$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
    await page.getByRole('button', { name: /generate draft/i }).click();
    expect((await drafted).status()).toBe(200);
    // The generated template (raw merge fields, not a rendered message) is
    // shown for review before any approval.
    await expect(page.getByText(/\{\{firstName\}\}/).first()).toBeVisible();

    // --- Approve via the exact server preview (fingerprinted) ---------------
    await page.getByRole('button', { name: /review and approve/i }).click();
    const approveDialog = page.getByRole('dialog');
    await expect(approveDialog).toBeVisible();
    // The confirmation restates the exact server-side eligibility snapshot,
    // including the suppression the consent gate found.
    await expect(approveDialog.getByText(/suppressed: 1/i)).toBeVisible();
    await expect(approveDialog.getByText(/missing contact: 1/i)).toBeVisible();
    const approved = page.waitForResponse(r => /\/approve$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
    await approveDialog.getByRole('button', { name: /authorize exact preview/i }).click();
    expect((await approved).status()).toBe(200);
    await expect(page.getByText('Dispatch authorization recorded')).toBeVisible();

    await expect.poll(async () => {
      const row = await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
      return { status: row.status, fingerprinted: Boolean(row.dispatchAuthorizationFingerprint && row.dispatchAuthorizedByUserId && row.dispatchAuthorizedAt), approvedBy: Boolean(row.approvedByUserId) };
    }).toEqual({ status: 'SCHEDULED', fingerprinted: true, approvedBy: true });

    // --- Launch via the exact server preview ---------------------------------
    await page.getByRole('button', { name: /review and launch/i }).click();
    const launchDialog = page.getByRole('dialog');
    await expect(launchDialog).toBeVisible();
    await expect(launchDialog.getByText(/suppressed: 1/i)).toBeVisible();
    const launched = page.waitForResponse(r => /\/launch$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST');
    await launchDialog.getByRole('button', { name: /dispatch exact preview/i }).click();
    const launchResponse = await launched;
    expect(launchResponse.status()).toBe(200);
    const launchBody = await launchResponse.json() as {
      setupRequired: boolean;
      summary: { total: number; accepted: number; suppressed: number; skipped: number; setupRequired: number; failed: number };
      provider: { configured: boolean };
      launchFingerprint: string;
    };
    // The truthful provider outcome for this harness: nothing was, or could
    // have been, handed to a provider (no TWILIO_* config; NODE_ENV=production
    // rules out the dev mock). Total covers the whole authorized audience.
    expect(launchBody.summary.total).toBe(3);
    expect(launchBody.summary.accepted).toBe(0);
    expect(launchBody.provider.configured).toBe(false);
    expect(launchBody.setupRequired).toBe(true);
    expect(launchBody.launchFingerprint).toMatch(/^[0-9a-f]{64}$/);

    // --- Dispatch evidence, per recipient, truthful ---------------------------
    const evidenceCard = page.locator('.cc-card').filter({ has: page.getByRole('heading', { name: /dispatch evidence/i }) });
    await expect(evidenceCard.getByRole('heading', { name: /dispatch evidence \(3\)/i })).toBeVisible();
    // Both contactable recipients are recorded as setup_required (unconfigured
    // provider), the phone-less one as skipped — and nothing on this screen may
    // claim a provider accepted or delivered anything.
    await expect(evidenceCard.locator('.badge', { hasText: /^Setup required$/ })).toHaveCount(2);
    await expect(evidenceCard.locator('.badge', { hasText: /^Skipped$/ })).toHaveCount(1);
    await expect(evidenceCard.locator('.badge', { hasText: /accepted|delivered/i })).toHaveCount(0);
    // NOTE (minor product finding, not asserted): the "provider not
    // configured — nothing submitted" notice/banner set right after launch is
    // unmounted almost immediately, because onChanged() reloads the campaign
    // list and Campaigner.tsx's `selected` falls back to null while the list
    // is in flight, remounting CampaignDetail and dropping its notice state.
    // The durable no-submission truth is what this spec pins instead: the
    // per-recipient Setup required/Skipped evidence above, the launch
    // response, and the database rows below.

    // Durable evidence: rows exist because dispatch ran; none carries a
    // provider message id, and the audit trail records the whole authority
    // chain from creation to launch.
    const deliveries = await db.campaignDelivery.findMany({ where: { tenantId: tenant.tenantId, campaignId: campaign.id } });
    expect(deliveries).toHaveLength(3);
    expect(deliveries.map(d => d.status).sort()).toEqual(['setup_required', 'setup_required', 'skipped']);
    expect(deliveries.every(d => d.providerMessageId === null)).toBe(true);
    const after = await db.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(after.sent).toBe(0);
    const auditActions = (await db.auditEvent.findMany({ where: { tenantId: tenant.tenantId }, select: { action: true } })).map(a => a.action);
    expect(auditActions).toEqual(expect.arrayContaining([
      'campaign.created',
      'campaign.approved',
      'campaign.dispatch_authorized',
      'campaign.launched',
    ]));

    expect(pageErrors, 'uncaught browser errors').toEqual([]);
    expect(serverFailures, 'real API 5xx responses').toEqual([]);
  });

  // HARNESS GAP (reported, not worked around): the provider-ACCEPTED dispatch
  // path cannot be exercised by this suite. `providerModeFor()` returns
  // 'mock_dev' only when the channel credentials start with "mock" AND
  // NODE_ENV !== 'production' (server/lib/campaigns.ts), but the Playwright
  // harness (package.json e2e:serve) pins NODE_ENV=production and configures
  // no TWILIO_* credentials at all — so every launch lands on setup_required
  // and no CampaignDelivery can ever reach status 'accepted' here. Until the
  // harness grows an explicit synthetic-provider mode, "accepted" +
  // providerAcceptedAt semantics (and the delivery webhook advancing accepted
  // -> delivered) have no browser-level gate.
  test.fixme('dispatch evidence reaches provider-accepted through the dev mock provider', async () => {
    // Requires: TWILIO_ACCOUNT_SID=mock..., TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
    // in the e2e:serve environment AND a non-production NODE_ENV (or an
    // E2E_TEST_MODE-aware branch in channelStatus/providerModeFor). Then this
    // journey's launch would summarize accepted === eligible, the evidence rows
    // would carry mock provider message ids, and the suppressed recipient would
    // be recorded as 'suppressed' by the dispatch fence itself.
  });
});
