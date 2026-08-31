import 'dotenv/config';
import { devices, expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { fixtureDb as db } from '../../server/test/helpers/fixtureDb';
import { generatePasswordHash } from '../../server/lib/security';
import { recomputeEntitlements } from '../../server/lib/entitlements';
import { ensureE2eSubscriptionPlan } from './subscriptionFixture';

const API = 'http://127.0.0.1:43201';
const PASSWORD = 'Live-Voice-UAT-Owner-2026!';
const LIVE_RUN_REQUESTED = process.env.RUN_LIVE_VOICE_UAT === 'true';
const MASKED_DESTINATION = '***-***-' + (process.env.AUTHORIZED_TEST_PHONE_E164 ?? '').replace(/\D/g, '').slice(-4);

type SeededVoiceUat = Awaited<ReturnType<typeof seedVoiceUat>>;

function requiredLiveEnvironment() {
  const required = [
    'LIVE_TEST_CALLS_AUTHORIZED',
    'LIVE_TEST_EXECUTION_ID',
    'LIVE_TEST_TENANT_ID',
    'LIVE_TEST_EXPIRES_AT',
    'AUTHORIZED_TEST_PHONE_E164',
    'RETELL_API_KEY',
    'RETELL_FROM_NUMBER',
    'LIVE_TEST_RETELL_AGENT_ID',
    'LIVE_TEST_RETELL_AGENT_VERSION',
  ] as const;
  const missing = required.filter(key => !process.env[key]?.trim());
  if (missing.length > 0) throw new Error(`Live voice UAT is missing: ${missing.join(', ')}`);
  if (process.env.LIVE_TEST_CALLS_AUTHORIZED !== 'true') throw new Error('LIVE_TEST_CALLS_AUTHORIZED must be true.');
  if (process.env.E2E_USE_INSTALLED_CHROME !== 'true') throw new Error('E2E_USE_INSTALLED_CHROME must be true.');
  if (process.env.E2E_HEADLESS === 'true') throw new Error('E2E_HEADLESS must be false or unset.');
  if ((process.env.RETELL_API_KEY ?? '').startsWith('mock')) throw new Error('RETELL_API_KEY must be a real Retell UAT key.');
  if (!/^\+[1-9]\d{7,14}$/.test(process.env.AUTHORIZED_TEST_PHONE_E164!)) throw new Error('AUTHORIZED_TEST_PHONE_E164 must use E.164.');
  if (Number(process.env.LIVE_TEST_MAX_CALLS) !== 1) throw new Error('The smoke harness requires LIVE_TEST_MAX_CALLS=1.');
  if (Number(process.env.LIVE_TEST_MAX_CALL_MINUTES) > 5) throw new Error('LIVE_TEST_MAX_CALL_MINUTES must be 5 or lower.');
  if (Number(process.env.LIVE_TEST_MAX_TOTAL_MINUTES) > 5) throw new Error('LIVE_TEST_MAX_TOTAL_MINUTES must be 5 or lower.');
  if (Number(process.env.LIVE_TEST_MAX_PROVIDER_COST_USD) > 3) throw new Error('LIVE_TEST_MAX_PROVIDER_COST_USD must be 3 or lower.');
  const providerVersion = Number(process.env.LIVE_TEST_RETELL_AGENT_VERSION);
  if (!Number.isSafeInteger(providerVersion) || providerVersion < 0) throw new Error('LIVE_TEST_RETELL_AGENT_VERSION must be a non-negative integer.');
  return {
    destination: process.env.AUTHORIZED_TEST_PHONE_E164!,
    providerAgentId: process.env.LIVE_TEST_RETELL_AGENT_ID!,
    providerVersion,
  };
}

function quietHoursAwayFromNow(timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const hour = Number(parts.find(part => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find(part => part.type === 'minute')?.value ?? 0);
  const start = (hour * 60 + minute + 12 * 60) % (24 * 60);
  const end = (start + 60) % (24 * 60);
  const format = (value: number) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  return { start: format(start), end: format(end) };
}

async function seedVoiceUat(projectName: string) {
  const live = requiredLiveEnvironment();
  const tag = `${projectName.replace(/[^a-z0-9]/gi, '').toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const tenantId = process.env.LIVE_TEST_TENANT_ID!;
  await db.tenant.create({ data: { id: tenantId, name: `CareCommand Voice UAT ${tag}`, slug: `voice-uat-${tag}` } });
  const plan = await ensureE2eSubscriptionPlan();
  await db.tenantSubscription.create({ data: { tenantId, planId: plan.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(tenantId, db);
  const branch = await db.branch.create({ data: { tenantId, name: 'Blue Ridge Synthetic Clinic', location: 'Synthetic UAT' } });
  const owner = await db.user.create({ data: {
    tenantId,
    branchId: branch.id,
    role: 'OWNER',
    active: true,
    email: `voice-owner-${tag}@e2e.test`,
    displayName: 'Voice UAT Owner',
    passwordHash: await generatePasswordHash(PASSWORD),
    passwordChangedAt: new Date(),
  } });
  const clinic = await db.receptionistClinic.create({ data: {
    tenantId,
    name: 'Blue Ridge Synthetic Clinic',
    phone: process.env.RETELL_FROM_NUMBER!,
    timezone: 'America/New_York',
    complianceDisclosure: 'This is an authorized CareCommand software test using synthetic information only.',
    humanFallbackNumber: null,
    active: true,
  } });
  const verifiedAt = new Date();
  const agent = await db.receptionistAgent.create({ data: {
    tenantId,
    clinicId: clinic.id,
    name: 'CareCommand Live UAT Agent',
    active: true,
    providerAgentId: live.providerAgentId,
    providerVersion: live.providerVersion,
    providerStatus: 'VERIFIED',
    providerPublished: true,
    providerConfigRevision: 1,
    providerVerifiedRevision: 1,
    providerVerifiedAt: verifiedAt,
    providerVerificationExpiresAt: new Date(verifiedAt.getTime() + 2 * 60 * 60_000),
    providerLastAttemptAt: verifiedAt,
    providerLastAttemptStatus: 'SUCCEEDED',
    providerDataStorageSetting: 'basic_attributes_only',
    providerSignedUrl: true,
    providerFingerprint: `live-uat-${tag}`,
  } });
  await db.tenantAiUsage.create({ data: { tenantId, receptionistMinutes: 0, overageAllowed: false, killSwitch: false } });
  return { tenantId, branch, owner, clinic, agent, live };
}

async function loginApi(request: APIRequestContext, fixture: SeededVoiceUat) {
  const response = await request.post(`${API}/v1/auth/login`, {
    data: { email: fixture.owner.email, password: PASSWORD },
  });
  expect(response.status()).toBe(200);
  return (await response.json() as { accessToken: string }).accessToken;
}

async function createApprovedCampaign(request: APIRequestContext, fixture: SeededVoiceUat) {
  const token = await loginApi(request, fixture);
  const quiet = quietHoursAwayFromNow(fixture.clinic.timezone);
  const create = await request.post(`${API}/v1/receptionist/outbound-campaigns`, {
    headers: { authorization: `Bearer ${token}` },
    data: {
      clinicId: fixture.clinic.id,
      agentId: fixture.agent.id,
      name: 'Authorized live voice smoke test',
      script: 'State the synthetic-test disclosure, ask the recipient to confirm the call arrived, and end the call politely. Do not collect medical, financial, or identity information.',
      purpose: 'CARE_COORDINATION',
      legalBasis: 'TREATMENT_OPERATIONS',
      policyVersion: 'LIVE-UAT-SMOKE-2026-08',
      requiredFields: ['firstName', 'lastName', 'phone'],
      consentText: 'This attended call uses synthetic information and is limited to connectivity verification.',
      humanHandoffInstruction: 'End the test and route to staff if the recipient asks for medical or financial guidance.',
      bookingMode: 'APPOINTMENT_REQUEST_ONLY',
      quietHoursStart: quiet.start,
      quietHoursEnd: quiet.end,
      maxRetryAttempts: 0,
    },
  });
  expect(create.status()).toBe(201);
  const campaign = await create.json() as { id: string };
  const approve = await request.post(`${API}/v1/receptionist/outbound-campaigns/${campaign.id}/approve`, {
    headers: { authorization: `Bearer ${token}` },
    data: { approvalConfirmed: true, status: 'RUNNING' },
  });
  expect(approve.status()).toBe(200);
  return campaign.id;
}

async function loginUi(page: Page, fixture: SeededVoiceUat) {
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(fixture.owner.email);
  await page.getByRole('textbox', { name: /Password/ }).fill(PASSWORD);
  await page.getByRole('button', { name: /^Sign in$/i }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function verifyResponsiveState(browser: Browser, fixture: SeededVoiceUat) {
  const { defaultBrowserType: _defaultBrowserType, ...pixel7 } = devices['Pixel 7'];
  void _defaultBrowserType;
  const context = await browser.newContext({ ...pixel7, baseURL: 'http://127.0.0.1:44173' });
  const page = await context.newPage();
  try {
    await loginUi(page, fixture);
    await page.goto('/receptionist-studio?tab=outbound');
    await expect(page.getByRole('heading', { name: 'AI Receptionist Studio' })).toBeVisible();
    await expect(page.getByText('Attended synthetic live voice UAT')).toBeVisible();
    await expect(page.getByText(MASKED_DESTINATION)).toBeVisible();
    await expect(page.getByText('Jordan Test')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(fixture.live.destination);
  } finally {
    await context.close();
  }
}

test.describe.serial('installed Chrome live AI receptionist UAT', () => {
  test.skip(!LIVE_RUN_REQUESTED, 'Set RUN_LIVE_VOICE_UAT=true to permit the one-call live UAT.');
  let fixture: SeededVoiceUat;
  let campaignId: string;

  test.beforeAll(async ({ browserName }, testInfo) => {
    void browserName;
    if (testInfo.project.name !== 'desktop-installed-chrome') {
      throw new Error('Live voice UAT must run only in the desktop-installed-chrome project.');
    }
    fixture = await seedVoiceUat(testInfo.project.name);
  });

  test.afterAll(async () => {
    await db.$disconnect();
  });

  test('places exactly one authorized Retell call through CareCommand and proves durable Chrome state', async ({ page, browser, request }, testInfo) => {
    test.setTimeout(8 * 60_000);
    campaignId = await createApprovedCampaign(request, fixture);
    console.log('\nLIVE CALL TEST CARD');
    console.log(`Scenario: one-call connectivity and disclosure smoke test`);
    console.log(`Recipient: ${MASKED_DESTINATION}`);
    console.log('When the phone rings, answer, confirm that the CareCommand test call arrived, and end the call after the AI responds.');
    console.log('Expected: one provider call, no medical/financial data collection, durable masked call status and audit evidence.\n');

    const consoleErrors: string[] = [];
    const failedApiResponses: string[] = [];
    page.on('pageerror', error => consoleErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('response', response => {
      if (response.url().includes('/v1/') && response.status() >= 500) {
        failedApiResponses.push(`${response.status()} ${new URL(response.url()).pathname}`);
      }
    });

    await loginUi(page, fixture);
    await page.goto('/receptionist-studio?tab=outbound');
    await expect(page.getByRole('heading', { name: 'AI Receptionist Studio' })).toBeVisible();
    await expect(page.getByText('Attended synthetic live voice UAT')).toBeVisible();
    await expect(page.getByText(MASKED_DESTINATION)).toBeVisible();
    await expect(page.getByText('1 calls remaining')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(fixture.live.destination);

    await page.getByRole('button', { name: 'Add the approved test number' }).click();
    await page.getByRole('button', { name: 'Attach synthetic recipient' }).click();
    await expect(page.getByText(/Authorized synthetic recipient .* is attached/)).toBeVisible();
    await expect(page.getByText('Jordan Test')).toBeVisible();

    const targetCard = page.getByRole('heading', { name: /Target list/ }).locator('..');
    const callButton = targetCard.getByRole('button', { name: 'Call', exact: true });
    await expect(callButton).toBeEnabled();
    await callButton.click();
    await expect(page.getByText(/Call accepted by the provider/)).toBeVisible({ timeout: 30_000 });

    await expect.poll(async () => db.receptionistCallLog.findFirst({
      where: { tenantId: fixture.tenantId, outboundCampaignId: campaignId },
      orderBy: { createdAt: 'desc' },
    }), { timeout: 30_000 }).not.toBeNull();
    const initialCall = await db.receptionistCallLog.findFirstOrThrow({
      where: { tenantId: fixture.tenantId, outboundCampaignId: campaignId },
      orderBy: { createdAt: 'desc' },
    });
    expect(initialCall.retellCallId).toBeTruthy();
    expect(initialCall.callerPhone).toBe(fixture.live.destination);
    await testInfo.attach('provider-call-id-masked', {
      body: Buffer.from(`${initialCall.retellCallId!.slice(0, 4)}…${initialCall.retellCallId!.slice(-4)}`),
      contentType: 'text/plain',
    });

    let terminal = false;
    for (let attempt = 0; attempt < 75; attempt += 1) {
      const refresh = page.getByRole('button', { name: 'Refresh provider status' });
      await expect(refresh).toBeEnabled();
      await refresh.click();
      await page.waitForTimeout(3_500);
      const current = await db.receptionistCallLog.findUniqueOrThrow({ where: { id: initialCall.id } });
      if (current.endedAt) {
        terminal = true;
        break;
      }
    }
    expect(terminal, 'The authorized recipient must answer/end the Retell call before the UAT timeout.').toBe(true);

    const finalCall = await db.receptionistCallLog.findUniqueOrThrow({ where: { id: initialCall.id } });
    expect(finalCall.durationSeconds).toBeGreaterThan(0);
    expect(finalCall.endedAt).not.toBeNull();
    expect(await db.receptionistCallLog.count({ where: { tenantId: fixture.tenantId, outboundCampaignId: campaignId } })).toBe(1);
    expect(await db.receptionistOutboundProviderIntent.count({ where: { tenantId: fixture.tenantId, outboundCampaignId: campaignId } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId: fixture.tenantId, resourceId: initialCall.id, action: 'receptionist.call.launched' } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId: fixture.tenantId, resourceId: initialCall.id, action: 'receptionist.call.providerSynchronized' } })).toBeGreaterThan(0);
    const usage = await db.tenantAiUsage.findUniqueOrThrow({ where: { tenantId: fixture.tenantId } });
    expect(usage.receptionistMinutes).toBeGreaterThanOrEqual(1);

    await expect(page.getByText(/Ended · \d+s/i)).toBeVisible();
    await expect(page.locator('body')).not.toContainText(fixture.live.destination);
    await page.reload();
    await expect(page.getByText('Jordan Test')).toBeVisible();
    await expect(page.getByText(/Escalated|No answer|Voicemail|Failed|Booked|Not interested|Opted out/i).first()).toBeVisible();
    await expect(page.locator('body')).not.toContainText(fixture.live.destination);

    await verifyResponsiveState(browser, fixture);
    expect(consoleErrors).toEqual([]);
    expect(failedApiResponses).toEqual([]);
    await testInfo.attach('live-voice-final-state', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  });
});
