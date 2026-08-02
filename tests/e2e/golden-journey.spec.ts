import 'dotenv/config';
import { test, expect, type Page } from '@playwright/test';
import { randomUUID, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fixtureDb as db } from '../../server/test/helpers/fixtureDb';
import { generatePasswordHash } from '../../server/lib/security';
import { recomputeEntitlements } from '../../server/lib/entitlements';
import { assertAccessibilityContract } from './accessibility';
import { ensureE2eSubscriptionPlan } from './subscriptionFixture';

const API = 'http://127.0.0.1:43201';
const OUTBOX = '.playwright/portal-outbox.jsonl';
const STAFF_PASSWORD = 'E2E-Staff-Pw-123!';
const STRIPE_SECRET = 'whsec_pw_e2e';

type GoldenData = {
  tenantId: string;
  slug: string;
  branchId: string;
  patientId: string;
  patientEmail: string;
  providerId: string;
  staffEmail: string;
  appointmentDate: string;
};

// Same formula the staff Scheduling page uses for its "Tomorrow" tab
// (src/pages/Scheduling.tsx isoDate(1)), so the appointment the patient books
// is visible on the surface where staff actually generate deposit payment links.
function tomorrowISO(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function stripeSignature(body: string, ts = Math.floor(Date.now() / 1000)) {
  const sig = createHmac('sha256', STRIPE_SECRET).update(`${ts}.${body}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}

async function seedGoldenData(projectName: string): Promise<GoldenData> {
  const tag = `${projectName.replace(/[^a-z0-9]/gi, '').toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const tenantId = randomUUID();
  const slug = `e2e-${tag}`;
  await db.tenant.create({ data: { id: tenantId, name: `E2E Clinic ${tag}`, slug } });
  const plan = await ensureE2eSubscriptionPlan();
  await db.tenantSubscription.create({ data: { tenantId, planId: plan.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(tenantId, db);

  const branch = await db.branch.create({ data: { tenantId, name: 'Main Clinic', location: 'Validation Suite' } });
  const staff = await db.user.create({
    data: {
      tenantId,
      role: 'ADMIN',
      active: true,
      email: `admin-${tag}@e2e.test`,
      displayName: 'E2E Admin',
      passwordHash: await generatePasswordHash(STAFF_PASSWORD),
      passwordChangedAt: new Date(),
    },
  });
  const providerUser = await db.user.create({
    data: {
      tenantId,
      role: 'PROVIDER',
      active: true,
      email: `provider-${tag}@e2e.test`,
      displayName: 'Dr E2E Provider',
      passwordHash: await generatePasswordHash(STAFF_PASSWORD),
      passwordChangedAt: new Date(),
    },
  });
  const provider = await db.providerProfile.create({ data: { tenantId, branchId: branch.id, userId: providerUser.id, specialty: 'Primary Care', rating: 4.9, reviewCount: 37 } });
  // Availability on every weekday so booking "tomorrow" always has open slots.
  await db.providerAvailability.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({ tenantId, branchId: branch.id, providerProfileId: provider.id, dayOfWeek, startMinute: 540, endMinute: 720, slotMinutes: 30 })),
  });
  await db.schedulingPolicy.create({ data: { tenantId, selfBookEnabled: true, requireEligibilityForSelfBook: false, requireIntakeForSelfBook: false, maxHorizonDays: 90, minNoticeHours: 0 } });
  // Real deposit rule so staff can drive the actual payment-link flow in the UI
  // (check deposit rules → generate link). The test never writes PaymentRequest
  // rows itself — the staff UI + API create them, exactly as in production.
  await db.depositRule.create({
    data: {
      tenantId, name: 'Appointment deposit', ruleType: 'standard',
      description: 'E2E golden journey: fixed deposit for every appointment',
      active: true, depositRequired: true, amountType: 'fixed', amountValue: 75, dueTiming: 'at_booking',
    },
  });

  // Patient (like DepositRule above) is FORCE-RLS: the app_rls runtime role can
  // only touch it inside a tenant-scoped transaction — same as the app itself.
  const patient = await db.patient.create({
    data: {
      tenantId,
      branchId: branch.id,
      firstName: 'Avery',
      lastName: 'Pilot',
      email: `avery-${tag}@e2e.test`,
      phone: '+15555550123',
      lifecycleStage: 'ACTIVE',
    },
  });
  await db.patientPortalAccount.create({ data: { tenantId, patientId: patient.id, email: patient.email, phone: patient.phone, status: 'invited' } });
  const packet = await db.patientIntakePacket.create({ data: { tenantId, patientId: patient.id, source: 'e2e', status: 'in_progress', readinessScore: 0 } });
  await db.patientIntakeSection.createMany({
    data: ['demographics', 'communication_consent', 'insurance', 'payment_policy'].map(sectionType => ({ tenantId, packetId: packet.id, sectionType, status: 'pending' })),
  });

  await db.device.create({ data: { tenantId, branchId: branch.id, name: 'E2E Glucose Gateway', deviceType: 'wearable_gateway', vendor: 'Manual', serialNumber: `E2E-${tag}`, connectionType: 'cloud_api', status: 'online', active: true } });
  await db.monitoringRule.create({ data: { tenantId, readingType: 'glucose', maxValue: 180, criticalMax: 300, assignedToUserId: staff.id, active: true } });

  return {
    tenantId,
    slug,
    branchId: branch.id,
    patientId: patient.id,
    patientEmail: patient.email!,
    providerId: provider.id,
    staffEmail: staff.email,
    appointmentDate: tomorrowISO(),
  };
}

async function latestPortalToken(tenantId: string) {
  const matchingTokens = async () => {
    const raw = await readFile(OUTBOX, 'utf8').catch(() => '');
    return raw.trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { tenantId: string; token: string })
      .filter(event => event.tenantId === tenantId);
  };
  await expect
    .poll(async () => (await matchingTokens()).length)
    .toBeGreaterThan(0);
  return (await matchingTokens()).at(-1)!;
}

async function loginPatient(page: Page, data: GoldenData) {
  await page.goto('/client/login');
  await assertAccessibilityContract(page, 'patient portal login');
  await page.getByLabel('Clinic').fill(data.slug);
  await page.getByLabel('Email').fill(data.patientEmail);
  await page.getByRole('button', { name: 'Send sign-in link' }).click();
  await expect(page.getByText('Enter your link code')).toBeVisible();
  const outbox = await latestPortalToken(data.tenantId);
  await page.getByLabel('Sign-in code').fill(outbox.token);
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByText(/Hi Avery/)).toBeVisible();
  await assertAccessibilityContract(page, 'patient portal dashboard');
}

async function loginStaff(page: Page, data: GoldenData) {
  await page.goto('/login');
  await assertAccessibilityContract(page, 'staff login');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(data.staffEmail);
  await page.getByRole('textbox', { name: /Password/ }).fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: /Sign in/i }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText('CareCommand AI').first()).toBeVisible();
}

async function openStaffSection(page: Page, name: string) {
  const mobileNavigation = page.getByRole('button', { name: 'Open navigation' });
  if (await mobileNavigation.isVisible()) await mobileNavigation.click();
  await page.getByRole('link', { name, exact: true }).click();
}

test.describe('staff authentication and accessibility contract', () => {
  test('preserves a deep link across login and reload, supports keyboard login, then logs out', async ({ page }, testInfo) => {
    const data = await seedGoldenData(`auth-${testInfo.project.name}`);
    try {
      await page.goto('/platform/login');
      await assertAccessibilityContract(page, 'platform login');
      await page.goto('/patients');
      await expect(page).toHaveURL(/\/login$/);

      const email = page.getByRole('textbox', { name: 'Email', exact: true });
      const password = page.getByRole('textbox', { name: /Password/ });
      await expect(email).toBeVisible();
      await expect(password).toBeVisible();

      // Keyboard-only form completion and submission.
      await email.focus();
      await page.keyboard.type(data.staffEmail);
      await password.focus();
      await page.keyboard.type(STAFF_PASSWORD);
      const submit = page.getByRole('button', { name: /^Sign in$/i });
      await submit.focus();
      await page.keyboard.press('Enter');

      await expect(page).toHaveURL(/\/patients$/);
      await expect(page.getByRole('main', { name: 'Clinic workspace' })).toBeVisible();
      await expect(page.getByRole('navigation').first()).toBeVisible();
      await expect(page.locator('img:not([alt])')).toHaveCount(0);
      await expect(page.locator('button a, a button')).toHaveCount(0);

      await page.reload();
      await expect(page).toHaveURL(/\/patients$/);
      await expect(page.getByRole('main', { name: 'Clinic workspace' })).toBeVisible();

      const accountMenu = page.getByRole('banner').getByRole('button', { name: /Account menu for E2E Admin/i });
      await accountMenu.click();
      await page.getByRole('button', { name: 'Sign out' }).click();
      await expect(page).toHaveURL(/\/login$/);

      await page.goto('/patients');
      await expect(page).toHaveURL(/\/login$/);
    } finally {
      await db.tenant.delete({ where: { id: data.tenantId } }).catch(() => {});
    }
  });
});

test.describe.serial('production-style browser golden journey', () => {
  let data: GoldenData;

  test.beforeEach(async ({ browserName }, testInfo) => {
    void browserName;
    data = await seedGoldenData(testInfo.project.name);
  });

  test.afterEach(async () => {
    if (data?.tenantId) await db.tenant.delete({ where: { id: data.tenantId } }).catch(() => {});
  });

  test.afterAll(async () => {
    await db.$disconnect();
  });

  test('patient books a real slot, updates insurance, and staff sees the result', async ({ page, context, request }, testInfo) => {
    // This deliberately spans patient booking, staff payment, webhook payment,
    // and clinical monitoring in two browser tabs. Keep the stricter global
    // timeout for focused tests while allowing this comprehensive gate 3x.
    test.slow();
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    const watch = (p: Page) => {
      p.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
      p.on('requestfailed', req => failedRequests.push(`${req.method()} ${req.url()} ${req.failure()?.errorText ?? ''}`));
    };
    watch(page);

    await loginPatient(page, data);
    await testInfo.attach('portal-dashboard', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });

    await page.getByRole('link', { name: /request an appointment/i }).click();
    await expect(page.getByText('Book an available slot', { exact: true })).toBeVisible();
    await page.getByLabel('Provider').selectOption(data.providerId);
    await page.getByRole('textbox', { name: 'Date', exact: true }).fill(data.appointmentDate);
    await expect(page.getByLabel('Open slots')).not.toHaveValue('');
    await page.getByLabel('Reason for visit').fill('Annual physical');
    await page.getByRole('button', { name: /Book appointment/i }).click();
    await expect(page.getByText(/The scheduling system confirmed Annual physical/)).toBeVisible();
    await testInfo.attach('portal-booking', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });

    const appointment = await db.appointment.findFirstOrThrow({ where: { tenantId: data.tenantId, patientId: data.patientId, service: 'Annual physical' } });
    expect(appointment.providerProfileId).toBe(data.providerId);
    expect(appointment.status).toBe('CONFIRMED');

    await page.getByRole('link', { name: /Insurance/i }).click();
    await page.getByRole('button', { name: /Add insurance|Add \/ update insurance/i }).click();
    await assertAccessibilityContract(page, 'patient portal insurance form');
    await page.getByPlaceholder('Plan name (e.g. Aetna Core)').fill('Aetna Enterprise PPO');
    await page.getByPlaceholder('Member ID').fill('E2E-MEMBER-001');
    await page.getByPlaceholder('Group # (optional)').fill('GRP-E2E');
    await page.getByPlaceholder('Subscriber name (optional)').fill('Avery Pilot');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText(/Policy details saved for clinic review/)).toBeVisible();

    // Staff creates the deposit payment link through the real UI (second tab —
    // staff and patient sessions use separate tokens, exactly like production).
    const staffPage = await context.newPage();
    watch(staffPage);
    await loginStaff(staffPage, data);
    await openStaffSection(staffPage, 'Scheduling');
    await staffPage.getByRole('button', { name: 'Tomorrow', exact: true }).click();
    const apptRow = staffPage.locator(`[data-appointment-id="${appointment.id}"]`);
    await expect(apptRow).toBeVisible();
    await apptRow.getByRole('button', { name: 'Deposit', exact: true }).click();
    await apptRow.getByRole('button', { name: /Check deposit rules/i }).click();
    await apptRow.getByRole('button', { name: /Generate payment link/i }).click();
    await expect(apptRow.getByText(/Payment link created/i)).toBeVisible();
    await testInfo.attach('staff-payment-link', { body: await staffPage.screenshot({ fullPage: true }), contentType: 'image/png' });

    // The PaymentRequest row must exist only because the staff UI created it.
    const paymentRequest = await db.paymentRequest.findFirstOrThrow({ where: { tenantId: data.tenantId, appointmentId: appointment.id } });
    expect(paymentRequest.status).toBe('link_sent');
    expect(paymentRequest.mode).toBe('mock');
    expect(paymentRequest.paymentUrl).toMatch(/^http:\/\/localhost:/);
    expect(paymentRequest.providerReference).toBeTruthy();
    expect(paymentRequest.publicToken).toBeTruthy();
    const requirement = await db.depositRequirement.findFirstOrThrow({ where: { tenantId: data.tenantId, appointmentId: appointment.id } });
    expect(requirement.status).toBe('link_sent');

    // Deposit requirements and responsibility estimates are distinct evidence.
    // Create an explicit synthetic estimate so this journey can validate the
    // portal acknowledgement boundary without implying the deposit generated it.
    await db.patientResponsibilityEstimate.create({
      data: {
        tenantId: data.tenantId,
        branchId: data.branchId,
        patientId: data.patientId,
        appointmentId: appointment.id,
        estimatedPatientResponsibility: 75,
        recommendedCollectAmount: 75,
        reason: 'Synthetic E2E estimate for portal acknowledgement validation.',
      },
    });

    // Patient sees the staff-created deposit and acknowledges the current estimate.
    await page.getByRole('link', { name: /Payments/i }).click();
    await page.getByRole('button', { name: /Acknowledge/i }).click();
    await expect(page.getByText('Appointment deposit · link_sent')).toBeVisible();
    await expect(page.getByText('$75 USD')).toBeVisible();
    // The explicit synthetic adapter returns an HTTP localhost URL. The portal
    // must not expose that unsafe/dead URL as if it were a real hosted checkout.
    await expect(page.getByText('Payment page unavailable — please contact the clinic.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open payment page', exact: true })).toHaveCount(0);

    const eventId = `evt_${randomUUID()}`;
    const body = JSON.stringify({ id: eventId, type: 'checkout.session.completed', data: { object: { id: paymentRequest.providerReference } } });
    const webhook = await request.post(`${API}/v1/revenue-protection/webhooks/stripe`, {
      headers: { 'content-type': 'application/json', 'stripe-signature': stripeSignature(body) },
      data: body,
    });
    expect(webhook.ok()).toBeTruthy();
    const replay = await request.post(`${API}/v1/revenue-protection/webhooks/stripe`, {
      headers: { 'content-type': 'application/json', 'stripe-signature': stripeSignature(body) },
      data: body,
    });
    expect(await replay.json()).toMatchObject({ duplicate: true });

    await openStaffSection(staffPage, 'Patients');
    await expect(staffPage.getByText('Avery Pilot').first()).toBeVisible();
    await openStaffSection(staffPage, 'Remote Monitoring');

    const ingest = await request.post(`${API}/v1/monitoring/readings/ingest`, {
      headers: { authorization: `Bearer ${await staffToken(data)}`, 'content-type': 'application/json' },
      data: { patientId: data.patientId, readingType: 'glucose', value: '325', numericValue: 325, unit: 'mg/dL', capturedAt: new Date().toISOString() },
    });
    expect(ingest.status()).toBe(201);
    const alert = await db.readingAlert.findFirstOrThrow({ where: { tenantId: data.tenantId, patientId: data.patientId, severity: 'critical' }, orderBy: { createdAt: 'desc' } });
    await staffPage.getByRole('button', { name: /Refresh/i }).click();
    await expect(staffPage.getByText('Avery Pilot').first()).toBeVisible();
    await expect(staffPage.getByText(/Glucose:.*325 mg\/dL/)).toBeVisible();

    // Staff acknowledges the alert through the real UI button — no API shortcut.
    const alertCard = staffPage.locator(`[data-alert-id="${alert.id}"]`);
    await alertCard.getByRole('button', { name: /Acknowledge/i }).click();
    await expect(alertCard.getByText('acknowledged', { exact: true })).toBeVisible();
    await expect(alertCard.getByRole('button', { name: /Acknowledge/i })).toHaveCount(0);
    await testInfo.attach('monitoring-acknowledged', { body: await staffPage.screenshot({ fullPage: true }), contentType: 'image/png' });
    await expect.poll(async () =>
      (await db.readingAlert.findUnique({ where: { id: alert.id }, select: { status: true } }))?.status
    ).toBe('acknowledged');

    const auditActions = await db.auditEvent.findMany({ where: { tenantId: data.tenantId }, select: { action: true } });
    expect(auditActions.map(a => a.action)).toEqual(expect.arrayContaining([
      'portal.login.requested',
      'portal.login.success',
      'portal.appointment.booked',
      'deposit.required',
      'payment.request.created',
      'payment.link.created',
      'portal.estimate.acknowledged',
      'payment.succeeded',
      'monitoring.reading.ingested',
      'monitoring.alert.acknowledged',
    ]));
    expect(auditActions.map(a => a.action)).not.toContain('portal.paymentPolicy.acknowledged');

    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });
});

async function staffToken(data: GoldenData) {
  const res = await fetch(`${API}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: data.staffEmail, password: STAFF_PASSWORD }),
  });
  if (!res.ok) throw new Error(`staff login failed ${res.status}`);
  const json = await res.json() as { accessToken?: string };
  if (!json.accessToken) throw new Error('staff login did not return access token');
  return json.accessToken;
}
