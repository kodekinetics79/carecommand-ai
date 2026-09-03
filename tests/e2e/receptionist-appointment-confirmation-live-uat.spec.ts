import 'dotenv/config';
import { devices, expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { fixtureDb as db } from '../../server/test/helpers/fixtureDb';
import { generatePasswordHash } from '../../server/lib/security';
import { recomputeEntitlements } from '../../server/lib/entitlements';
import { expectedRetellToolUrl, probeRetellAgent } from '../../server/lib/retell';
import { ensureE2eSubscriptionPlan } from './subscriptionFixture';

const API = 'http://127.0.0.1:43201';
const PASSWORD = 'Live-Appointment-UAT-Owner-2026!';
const PATIENT_DOB = '1990-01-15';
const LIVE_RUN_REQUESTED = process.env.RUN_APPOINTMENT_CONFIRMATION_LIVE_UAT === 'true';
const MASKED_DESTINATION = '***-***-' + (process.env.AUTHORIZED_TEST_PHONE_E164 ?? '').replace(/\D/g, '').slice(-4);
const REQUIRED_LIVE_TOOLS = ['record_recording_preference', 'verify_patient_identity', 'confirm_appointment'] as const;

type SeededAppointmentUat = Awaited<ReturnType<typeof seedAppointmentUat>>;
type ToolRow = Record<string, unknown>;

function requiredLiveEnvironment() {
  const required = [
    'LIVE_TEST_CALLS_AUTHORIZED',
    'LIVE_TEST_EXECUTION_ID',
    'LIVE_TEST_TENANT_ID',
    'LIVE_TEST_CLINIC_ID',
    'LIVE_TEST_EXPIRES_AT',
    'AUTHORIZED_TEST_PHONE_E164',
    'RETELL_API_KEY',
    'RETELL_FROM_NUMBER',
    'LIVE_TEST_RETELL_AGENT_ID',
    'LIVE_TEST_RETELL_AGENT_VERSION',
    'PUBLIC_API_URL',
  ] as const;
  const missing = required.filter(key => !process.env[key]?.trim());
  if (missing.length > 0) throw new Error(`Appointment-confirmation live UAT is missing: ${missing.join(', ')}`);
  if (process.env.LIVE_TEST_CALLS_AUTHORIZED !== 'true') throw new Error('LIVE_TEST_CALLS_AUTHORIZED must be true.');
  if (process.env.E2E_USE_INSTALLED_CHROME !== 'true') throw new Error('E2E_USE_INSTALLED_CHROME must be true.');
  if (process.env.E2E_HEADLESS === 'true') throw new Error('E2E_HEADLESS must be false or unset.');
  if ((process.env.RETELL_API_KEY ?? '').startsWith('mock')) throw new Error('RETELL_API_KEY must be a real Retell UAT key.');
  if (!/^\+[1-9]\d{7,14}$/.test(process.env.AUTHORIZED_TEST_PHONE_E164!)) throw new Error('AUTHORIZED_TEST_PHONE_E164 must use E.164.');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(process.env.LIVE_TEST_TENANT_ID!)) throw new Error('LIVE_TEST_TENANT_ID must be a UUID.');
  if (!uuid.test(process.env.LIVE_TEST_CLINIC_ID!)) throw new Error('LIVE_TEST_CLINIC_ID must be a UUID.');
  if (Number(process.env.LIVE_TEST_MAX_CALLS) !== 1) throw new Error('The appointment-confirmation harness requires LIVE_TEST_MAX_CALLS=1.');
  if (Number(process.env.LIVE_TEST_MAX_CALL_MINUTES) > 5) throw new Error('LIVE_TEST_MAX_CALL_MINUTES must be 5 or lower.');
  if (Number(process.env.LIVE_TEST_MAX_TOTAL_MINUTES) > 5) throw new Error('LIVE_TEST_MAX_TOTAL_MINUTES must be 5 or lower.');
  if (Number(process.env.LIVE_TEST_MAX_PROVIDER_COST_USD) > 3) throw new Error('LIVE_TEST_MAX_PROVIDER_COST_USD must be 3 or lower.');
  const providerVersion = Number(process.env.LIVE_TEST_RETELL_AGENT_VERSION);
  if (!Number.isSafeInteger(providerVersion) || providerVersion < 0) throw new Error('LIVE_TEST_RETELL_AGENT_VERSION must be a non-negative integer.');

  let publicApi: URL;
  try {
    publicApi = new URL(process.env.PUBLIC_API_URL!);
  } catch {
    throw new Error('PUBLIC_API_URL must be a valid URL.');
  }
  const host = publicApi.hostname.toLowerCase();
  if (publicApi.protocol !== 'https:' || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) {
    throw new Error('PUBLIC_API_URL must be a public HTTPS endpoint that routes to this exact disposable UAT API.');
  }
  return {
    destination: process.env.AUTHORIZED_TEST_PHONE_E164!,
    clinicId: process.env.LIVE_TEST_CLINIC_ID!,
    providerAgentId: process.env.LIVE_TEST_RETELL_AGENT_ID!,
    providerVersion,
    publicApi: publicApi.toString().replace(/\/$/, ''),
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

function clinicDate(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const value = (type: 'year' | 'month' | 'day') => parts.find(part => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function appointmentSpokenLabel(date: Date, timezone: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(date);
}

function canonicalUrl(value: string) {
  const url = new URL(value);
  url.hash = '';
  url.searchParams.sort();
  return url.toString();
}

function providerToolRows(tools: unknown[] | null): ToolRow[] {
  return (tools ?? []).filter((value): value is ToolRow => Boolean(value && typeof value === 'object' && !Array.isArray(value)));
}

async function seedAppointmentUat(projectName: string) {
  const live = requiredLiveEnvironment();
  const tag = `${projectName.replace(/[^a-z0-9]/gi, '').toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const tenantId = process.env.LIVE_TEST_TENANT_ID!;
  const timezone = 'America/New_York';
  await db.tenant.create({ data: { id: tenantId, name: `CareCommand Appointment UAT ${tag}`, slug: `appointment-uat-${tag}` } });
  const plan = await ensureE2eSubscriptionPlan();
  await db.tenantSubscription.create({ data: { tenantId, planId: plan.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(tenantId, db);
  const branch = await db.branch.create({ data: { tenantId, name: 'Blue Ridge Synthetic Clinic', location: 'Synthetic UAT', timezone } });
  const owner = await db.user.create({ data: {
    tenantId,
    branchId: branch.id,
    role: 'OWNER',
    active: true,
    email: `appointment-owner-${tag}@e2e.test`,
    displayName: 'Appointment UAT Owner',
    passwordHash: await generatePasswordHash(PASSWORD),
    passwordChangedAt: new Date(),
  } });
  const clinic = await db.receptionistClinic.create({ data: {
    id: live.clinicId,
    tenantId,
    name: 'Blue Ridge Synthetic Clinic',
    phone: process.env.RETELL_FROM_NUMBER!,
    timezone,
    country: 'US',
    defaultLanguage: 'en-US',
    complianceDisclosure: 'This is an authorized CareCommand software test using synthetic information only.',
    humanFallbackNumber: null,
    active: true,
  } });
  const verifiedAt = new Date();
  const agent = await db.receptionistAgent.create({ data: {
    tenantId,
    clinicId: clinic.id,
    name: 'CareCommand Appointment Confirmation Agent',
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
    providerFingerprint: `live-appointment-uat-${tag}`,
  } });
  await db.tenantAiUsage.create({ data: { tenantId, receptionistMinutes: 0, overageAllowed: false, killSwitch: false } });

  const patient = await db.patient.create({ data: {
    tenantId,
    branchId: branch.id,
    firstName: 'Jordan',
    lastName: 'Test',
    dateOfBirth: new Date(`${PATIENT_DOB}T00:00:00.000Z`),
    phone: live.destination,
    email: 'jordan.synthetic@e2e.test',
    tags: ['synthetic-live-uat'],
  } });
  const startsAt = new Date(Date.now() + 48 * 60 * 60_000);
  const appointment = await db.appointment.create({ data: {
    tenantId,
    branchId: branch.id,
    patientId: patient.id,
    service: 'Appointment confirmation demo',
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    status: 'CONFIRMED',
    channel: 'CALL',
  } });
  return { tenantId, branch, owner, clinic, agent, patient, appointment, startsAt, timezone, live };
}

async function loginApi(request: APIRequestContext, fixture: SeededAppointmentUat, base = API) {
  const response = await request.post(`${base}/v1/auth/login`, {
    data: { email: fixture.owner.email, password: PASSWORD },
  });
  expect(response.status()).toBe(200);
  return (await response.json() as { accessToken: string }).accessToken;
}

async function assertPublicCallbackAndProviderContract(request: APIRequestContext, fixture: SeededAppointmentUat) {
  await loginApi(request, fixture, fixture.live.publicApi);

  const probe = await probeRetellAgent(fixture.live.providerAgentId, 'carecommand', {
    pinnedVersion: fixture.live.providerVersion,
  });
  if (!probe.ok) throw new Error(`The pinned Retell agent could not be verified for appointment confirmation (${probe.error}).`);
  if (!probe.snapshot.published) throw new Error('The pinned Retell agent version is not published.');
  const tools = providerToolRows(probe.snapshot.tools);
  const expectedFnUrl = canonicalUrl(expectedRetellToolUrl(fixture.clinic.id, fixture.live.publicApi));
  for (const requiredName of REQUIRED_LIVE_TOOLS) {
    const tool = tools.find(row => row.name === requiredName);
    if (!tool) throw new Error(`The pinned Retell agent is missing required live tool ${requiredName}. Publish the current CareCommand receptionist configuration before dialing.`);
    if (typeof tool.url !== 'string' || canonicalUrl(tool.url) !== expectedFnUrl) {
      throw new Error(`Retell tool ${requiredName} does not call this UAT clinic through PUBLIC_API_URL. Refusing to place a call that cannot write its confirmation back.`);
    }
  }
}

async function createApprovedReminderCampaign(request: APIRequestContext, fixture: SeededAppointmentUat) {
  const token = await loginApi(request, fixture);
  const quiet = quietHoursAwayFromNow(fixture.clinic.timezone);
  const create = await request.post(`${API}/v1/receptionist/outbound-campaigns`, {
    headers: { authorization: `Bearer ${token}` },
    data: {
      clinicId: fixture.clinic.id,
      agentId: fixture.agent.id,
      name: 'Appointment confirmation — live customer demo',
      script: 'This is an appointment reminder. Use only the appointment context supplied for this call. After explicit recording consent and identity verification, ask whether the patient is still coming. If they say yes, use confirm_appointment. Do not hard-code or invent appointment details.',
      purpose: 'APPOINTMENT_REMINDER',
      legalBasis: 'TREATMENT_OPERATIONS',
      policyVersion: 'LIVE-UAT-APPOINTMENT-CONFIRM-2026-09',
      requiredFields: ['firstName', 'lastName', 'phone'],
      consentText: 'This attended test uses synthetic patient and appointment data only.',
      humanHandoffInstruction: 'End the synthetic test and route to staff if the recipient asks for medical or financial guidance.',
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

async function loginUi(page: Page, fixture: SeededAppointmentUat) {
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(fixture.owner.email);
  await page.getByRole('textbox', { name: /Password/ }).fill(PASSWORD);
  await page.getByRole('button', { name: /^Sign in$/i }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function choosePatientAndAppointment(page: Page, fixture: SeededAppointmentUat) {
  const patientSelect = page.getByRole('combobox', { name: 'Authorized outbound target' });
  await expect(patientSelect).toBeEnabled();
  await patientSelect.selectOption(`patient:${fixture.patient.id}`);
  const appointmentSelect = page.getByRole('combobox', { name: 'Appointment to confirm' });
  await expect(appointmentSelect).toBeVisible();
  await expect(appointmentSelect).toHaveValue(fixture.appointment.id);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText(/Jordan Test/)).toBeVisible();
  await expect(page.getByText('appointment linked')).toBeVisible();
}

async function showSchedulingConfirmation(page: Page, fixture: SeededAppointmentUat) {
  await page.goto('/scheduling');
  await page.getByLabel('Pick a date').fill(clinicDate(fixture.startsAt, fixture.timezone));
  const row = page.locator(`[data-appointment-id="${fixture.appointment.id}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('Jordan Test');
  await expect(row).toContainText(/Patient said they.*coming/);
  await expect(row).toContainText('Booked');
  await expect(row.getByRole('button', { name: 'Open the call' })).toBeVisible();
}

async function verifyResponsiveState(browser: Browser, fixture: SeededAppointmentUat) {
  const { defaultBrowserType: _defaultBrowserType, ...pixel7 } = devices['Pixel 7'];
  void _defaultBrowserType;
  const context = await browser.newContext({ ...pixel7, baseURL: 'http://127.0.0.1:44173' });
  const page = await context.newPage();
  try {
    await loginUi(page, fixture);
    await showSchedulingConfirmation(page, fixture);
    await expect(page.locator('body')).not.toContainText(fixture.live.destination);
  } finally {
    await context.close();
  }
}

test.describe.serial('installed Chrome live appointment-confirmation UAT', () => {
  test.skip(!LIVE_RUN_REQUESTED, 'Set RUN_APPOINTMENT_CONFIRMATION_LIVE_UAT=true to permit the one-call appointment-confirmation UAT.');
  let fixture: SeededAppointmentUat;
  let campaignId: string;

  test.beforeAll(async ({ browserName }, testInfo) => {
    void browserName;
    if (testInfo.project.name !== 'desktop-installed-chrome') {
      throw new Error('Appointment-confirmation live UAT must run only in the desktop-installed-chrome project.');
    }
    fixture = await seedAppointmentUat(testInfo.project.name);
  });

  test.afterAll(async () => {
    await db.$disconnect();
  });

  test('calls one authorized synthetic patient, records their confirmation, and shows it after reload', async ({ page, browser, request }, testInfo) => {
    test.setTimeout(10 * 60_000);
    await assertPublicCallbackAndProviderContract(request, fixture);
    campaignId = await createApprovedReminderCampaign(request, fixture);

    console.log('\nAPPOINTMENT CONFIRMATION LIVE DEMO CARD');
    console.log('Scenario: one synthetic patient confirms one real CareCommand appointment over the live AI receptionist call.');
    console.log(`Recipient: ${MASKED_DESTINATION}`);
    console.log('Synthetic patient: Jordan Test');
    console.log(`Synthetic DOB for identity check: ${PATIENT_DOB}`);
    console.log(`Appointment: ${appointmentSpokenLabel(fixture.startsAt, fixture.timezone)} · Appointment confirmation demo`);
    console.log('When the phone rings: answer the recording-consent question YES, confirm you are Jordan Test, give the synthetic DOB when asked, then say clearly: "Yes, I will attend that appointment."');
    console.log('Expected: CareCommand calls confirm_appointment, records a receptionist_call confirmation, and Scheduling shows "Patient said they’re coming" after reload.\n');

    const consoleErrors: string[] = [];
    const failedApiResponses: string[] = [];
    page.on('pageerror', error => consoleErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('response', response => {
      if (response.url().includes('/v1/') && response.status() >= 500) failedApiResponses.push(`${response.status()} ${new URL(response.url()).pathname}`);
    });

    await loginUi(page, fixture);
    await page.goto('/receptionist-studio?tab=outbound');
    await expect(page.getByRole('heading', { name: 'AI Receptionist Studio' })).toBeVisible();
    await expect(page.getByText('Test calling — one approved number')).toBeVisible();
    await expect(page.getByText(MASKED_DESTINATION)).toBeVisible();
    await expect(page.getByText('1 calls remaining')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(fixture.live.destination);

    await choosePatientAndAppointment(page, fixture);
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
    await testInfo.attach('appointment-confirmation-provider-call-id-masked', {
      body: Buffer.from(`${initialCall.retellCallId!.slice(0, 4)}…${initialCall.retellCallId!.slice(-4)}`),
      contentType: 'text/plain',
    });

    let terminal = false;
    for (let attempt = 0; attempt < 90; attempt += 1) {
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

    await expect.poll(async () => {
      const appointment = await db.appointment.findUniqueOrThrow({ where: { id: fixture.appointment.id } });
      return Boolean(appointment.patientConfirmedAt);
    }, { timeout: 60_000, message: 'The call ended but CareCommand never received a valid confirm_appointment write.' }).toBe(true);

    const [finalCall, finalAppointment] = await Promise.all([
      db.receptionistCallLog.findUniqueOrThrow({ where: { id: initialCall.id } }),
      db.appointment.findUniqueOrThrow({ where: { id: fixture.appointment.id } }),
    ]);
    expect(finalCall.durationSeconds).toBeGreaterThan(0);
    expect(finalCall.endedAt).not.toBeNull();
    expect(finalAppointment.status).toBe('CONFIRMED');
    expect(finalAppointment.patientConfirmationSource).toBe('receptionist_call');
    expect(finalAppointment.patientConfirmedCallLogId).toBe(initialCall.id);
    expect(await db.receptionistCallLog.count({ where: { tenantId: fixture.tenantId, outboundCampaignId: campaignId } })).toBe(1);
    expect(await db.receptionistOutboundProviderIntent.count({ where: { tenantId: fixture.tenantId, outboundCampaignId: campaignId } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId: fixture.tenantId, resourceId: fixture.appointment.id, action: 'receptionist.appointment.patientConfirmed' } })).toBe(1);
    expect(await db.auditEvent.count({ where: { tenantId: fixture.tenantId, resourceId: initialCall.retellCallId!, action: 'receptionist.identity.verified' } })).toBe(1);
    const usage = await db.tenantAiUsage.findUniqueOrThrow({ where: { tenantId: fixture.tenantId } });
    expect(usage.receptionistMinutes).toBeGreaterThanOrEqual(1);

    await showSchedulingConfirmation(page, fixture);
    await page.reload();
    await showSchedulingConfirmation(page, fixture);
    await testInfo.attach('appointment-confirmation-scheduling', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });

    await page.goto('/receptionist-studio?tab=outbound');
    await expect(page.getByRole('heading', { name: 'Who has said they’re coming' })).toBeVisible();
    await expect(page.getByText(/1 of 1 patient.*coming/)).toBeVisible();
    await expect(page.getByText('1 of them said so on a call from this campaign.')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(fixture.live.destination);
    await testInfo.attach('appointment-confirmation-campaign-result', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });

    await verifyResponsiveState(browser, fixture);
    expect(consoleErrors).toEqual([]);
    expect(failedApiResponses).toEqual([]);
  });
});
