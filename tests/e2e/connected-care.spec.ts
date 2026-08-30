import 'dotenv/config';
import { test, expect, type Page } from '@playwright/test';
import { randomUUID, createHmac } from 'node:crypto';
import { fixtureDb as db } from '../../server/test/helpers/fixtureDb';
import { generatePasswordHash, encryptSecret } from '../../server/lib/security';
import { recomputeEntitlements } from '../../server/lib/entitlements';
import { assertAccessibilityContract } from './accessibility';
import { ensureE2eSubscriptionPlan } from './subscriptionFixture';

// ===========================================================================
// Connected Care — end-to-end coverage for the module's own workflow.
//
// The backend was well covered by integration tests while the customer-facing
// journey had none, which is exactly how a module ships where two of five
// billing requirements have no user interface at all: every endpoint passed,
// and no patient could ever reach a billable state through the product.
//
// This spec walks the journey a clinic actually performs — enrol a patient
// against a device, capture consent, take readings in through the signed
// provider webhook, log a measured clinical review, and read the codes the
// evidence supports — and asserts the two truthfulness rules that make the
// module safe to demo: a device that has never reported is never badged as
// connected, and no figure is printed for a request that did not answer.
// ===========================================================================

const API = 'http://127.0.0.1:43201';
const STAFF_PASSWORD = 'E2E-Staff-Pw-123!';
const WEBHOOK_SECRET = 'e2e-connected-care-secret';

interface CareData {
  tenantId: string;
  slug: string;
  branchId: string;
  patientId: string;
  patientName: string;
  deviceId: string;
  staffEmail: string;
}

async function seedCareData(tag0: string): Promise<CareData> {
  const tag = `${tag0.replace(/[^a-z0-9]/gi, '').toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const tenantId = randomUUID();
  const slug = `cc-${tag}`;
  await db.tenant.create({ data: { id: tenantId, name: `CC Clinic ${tag}`, slug } });
  const plan = await ensureE2eSubscriptionPlan();
  await db.tenantSubscription.create({ data: { tenantId, planId: plan.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(tenantId, db);

  const branch = await db.branch.create({ data: { tenantId, name: 'Main Clinic', location: 'Connected Care Suite' } });
  const staff = await db.user.create({
    data: {
      tenantId, role: 'ADMIN', active: true,
      email: `cc-admin-${tag}@e2e.test`, displayName: 'CC Admin',
      passwordHash: await generatePasswordHash(STAFF_PASSWORD), passwordChangedAt: new Date(),
    },
  });
  const patient = await db.patient.create({
    data: { tenantId, branchId: branch.id, firstName: 'Marta', lastName: 'Reyes', lifecycleStage: 'ACTIVE' },
  });
  // A device that has NEVER reported. Its stored status says online; the
  // product must not repeat that claim, because nothing has ever been observed.
  const device = await db.device.create({
    data: {
      tenantId, branchId: branch.id, name: 'Withings BP Cuff', deviceType: 'vitals_monitor',
      vendor: 'Withings', serialNumber: `CC-${tag}`, connectionType: 'cloud_api',
      status: 'online', active: true, lastSeenAt: null,
    },
  });
  // A configured provider is what makes an inbound webhook verifiable.
  await db.deviceProvider.create({
    data: {
      tenantId, providerKey: 'withings', displayName: 'Withings', category: 'DIRECT_API',
      mode: 'sandbox', status: 'SANDBOX', webhookConfigured: true,
      encryptedConfig: encryptSecret(JSON.stringify({ webhookSecret: WEBHOOK_SECRET })),
    },
  });

  return {
    tenantId, slug, branchId: branch.id,
    patientId: patient.id, patientName: 'Marta Reyes',
    deviceId: device.id, staffEmail: staff.email!,
  };
}

async function loginStaff(page: Page, data: CareData) {
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(data.staffEmail);
  await page.getByRole('textbox', { name: /Password/ }).fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: /Sign in/i }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** Post readings exactly as the vendor would: signed over the raw JSON body. */
async function postSignedReadings(tenantId: string, readings: unknown[]) {
  const raw = JSON.stringify({ readings });
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  const response = await fetch(`${API}/v1/connected-care/${tenantId}/providers/withings/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cc-signature': signature },
    body: raw,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test.describe('Connected Care — the clinic journey', () => {
  test('enrols a patient against a device, ingests readings, logs a measured review, and reports supportable codes', async ({ page }, testInfo) => {
    const data = await seedCareData(`journey-${testInfo.project.name}`);
    try {
      await loginStaff(page, data);

      // ── Enrolment binds the device. Without that binding every reading is
      // excluded for missing provenance and no device-day can ever accrue.
      await page.goto('/enrollments');
      await assertAccessibilityContract(page, 'device enrolments');
      await page.getByRole('button', { name: /Enrol patient/i }).click();
      await page.getByLabel('Patient').selectOption({ label: data.patientName });
      await page.getByLabel('Device provider').selectOption('withings');
      await page.getByLabel('Device', { exact: true }).selectOption(data.deviceId);
      await page.getByRole('button', { name: /^Enrol$/ }).click();
      // exact: the actions cell also carries the name via its aria-labels.
      await expect(page.getByRole('cell', { name: data.patientName, exact: true })).toBeVisible();

      // ── Consent shows its current state before offering an action, and the
      // disclosure the patient must hear — including cost sharing.
      await page.getByRole('button', { name: /Consent/i }).first().click();
      const consent = page.getByRole('dialog');
      await expect(consent.getByText(/No consent on record/i)).toBeVisible();
      // The phrase appears twice by design: once in the script read to the
      // patient, once in what the staff member attests to having said.
      await expect(page.getByText(/may owe a copay/i)).toHaveCount(2);
      await consent.getByRole('checkbox').check();
      await consent.getByRole('button', { name: /Record consent/i }).click();
      await expect(page.getByRole('dialog')).toBeHidden();

      // ── Readings arrive through the signed provider webhook, dated across
      // distinct days so they accrue as distinct device-days.
      const now = Date.now();
      const readings = Array.from({ length: 4 }, (_, day) => ({
        patientId: data.patientId,
        readingType: 'blood_pressure',
        value: '128/82',
        numericValue: 128,
        valueSecondary: 82,
        unit: 'mmHg',
        capturedAt: new Date(now - day * 24 * 60 * 60_000).toISOString(),
      }));
      const ingest = await postSignedReadings(data.tenantId, readings);
      expect(ingest.status).toBe(200);

      // ── A clinical review session: measured, narrated, with a live contact.
      await page.goto('/rpm-readiness');
      await assertAccessibilityContract(page, 'rpm billing readiness');
      await expect(page.getByText(data.patientName)).toBeVisible();

      // Drive the clock rather than sleeping: the server requires a session of
      // at least a minute, and a real minute of wall-clock in a test suite buys
      // nothing. Anchoring in the recent past keeps the recorded end instant
      // behind the server's clock, inside the allowed skew.
      await page.clock.install({ time: new Date(Date.now() - 5 * 60_000) });
      await page.getByRole('button', { name: /Log review session/i }).first().click();
      // Scope to the dialog: "Start review" is also the remedy link on the
      // unmet review-minutes requirement behind it.
      const session = page.getByRole('dialog');
      await session.getByRole('button', { name: /Start review/i }).click();
      await session.getByRole('textbox').fill('Reviewed four days of BP readings, confirmed evening dosing by phone.');
      await session.getByRole('combobox').selectOption('live_phone');
      await page.clock.fastForward(150_000);
      await session.getByRole('button', { name: /Stop and log/i }).click();
      await session.getByRole('button', { name: /Record session/i }).click();
      await expect(page.getByRole('dialog')).toBeHidden();

      // ── The page now reports which codes the evidence supports. Four
      // device-days is short of the 16-day threshold, and under the old single
      // gate that read as nothing billable at all. It is a supportable
      // short-duration supply month.
      await expect(page.getByText('99445')).toBeVisible();
      // The session was measured, not asserted: 150s of driven clock floors to
      // 2 recorded minutes, and the live phone call is reflected back.
      await expect(page.getByText(/2 review min/).first()).toBeVisible();
      await expect(page.getByText(/live contact recorded/).first()).toBeVisible();
    } finally {
      await db.tenant.delete({ where: { id: data.tenantId } }).catch(() => {});
    }
  });

  test('never badges a device as connected when nothing has been observed', async ({ page }, testInfo) => {
    const data = await seedCareData(`truth-${testInfo.project.name}`);
    try {
      await loginStaff(page, data);
      await page.goto('/devices');
      await assertAccessibilityContract(page, 'device integration');

      // The seeded device carries status 'online' with lastSeenAt null. The
      // registry previously rendered that stored column verbatim under a
      // "Connected now" heading — a clinician reading it would believe a
      // patient was being monitored by a device that has never spoken to us.
      const row = page.getByRole('row', { name: /Withings BP Cuff/ });
      await expect(row).toBeVisible();
      await expect(row.getByText(/^Online$/)).toHaveCount(0);
      await expect(row.getByText(/Never|Not reporting|never reported/i).first()).toBeVisible();
    } finally {
      await db.tenant.delete({ where: { id: data.tenantId } }).catch(() => {});
    }
  });

  test('says a panel failed instead of printing zero for it', async ({ page }, testInfo) => {
    const data = await seedCareData(`outage-${testInfo.project.name}`);
    try {
      await loginStaff(page, data);
      // A monitoring screen that prints "0 critical alerts" from a request that
      // never answered is the worst possible false negative in this product.
      await page.route('**/v1/connected-care/rpm-readiness*', route => route.abort('failed'));
      await page.goto('/rpm-readiness');

      await expect(page.getByText(/could not be loaded/i)).toBeVisible();
      await expect(page.getByRole('button', { name: /Try again/i })).toBeVisible();
      // No fabricated figure anywhere on a screen whose data never arrived.
      await expect(page.getByText(/with supportable codes/)).toHaveCount(0);
    } finally {
      await db.tenant.delete({ where: { id: data.tenantId } }).catch(() => {});
    }
  });
  test('lets a clinic set its own alert thresholds, including the missed-reading watch', async ({ page }, testInfo) => {
    const data = await seedCareData(`thresholds-${testInfo.project.name}`);
    try {
      await loginStaff(page, data);
      await page.goto('/alert-thresholds');
      await assertAccessibilityContract(page, 'alert thresholds');

      // A clinic with no rules of its own is running entirely on the built-in
      // bands — and, more importantly, nothing is watching for a patient who
      // stops reporting, because the cadence lives only on a rule.
      await expect(page.getByText(/No rules of your own yet/i)).toBeVisible();
      await expect(page.getByText(/nothing is watching for missed readings/i)).toBeVisible();
      // The defaults in force are shown rather than left implicit.
      await expect(page.getByRole('cell', { name: 'Glucose' })).toBeVisible();

      await page.getByRole('button', { name: /Add your first rule/i }).click();
      await page.getByLabel('Reading type').selectOption('glucose');
      await page.getByLabel('Safe low').fill('80');
      await page.getByLabel('Safe high').fill('200');
      await page.getByLabel('Missed after hours').fill('24');
      await page.getByRole('button', { name: /Save rule/i }).click();

      // The rule is in force, and the patient is now actually being watched.
      const row = page.getByRole('row', { name: /Glucose/ }).first();
      await expect(row).toBeVisible();
      await expect(page.getByText('24h')).toBeVisible();
      await expect(page.getByText(/not watched/i)).toHaveCount(0);
    } finally {
      await db.tenant.delete({ where: { id: data.tenantId } }).catch(() => {});
    }
  });

  test('refuses a threshold band that could never fire what it names', async ({ page }, testInfo) => {
    const data = await seedCareData(`badband-${testInfo.project.name}`);
    try {
      await loginStaff(page, data);
      await page.goto('/alert-thresholds');
      await page.getByRole('button', { name: /Add a rule/i }).click();
      // Inverted: a safe range whose low is above its high can never be
      // satisfied, so the rule would fail silently rather than loudly.
      await page.getByLabel('Safe low').fill('200');
      await page.getByLabel('Safe high').fill('100');
      await page.getByRole('button', { name: /Save rule/i }).click();

      await expect(page.getByRole('alert')).toContainText(/inverted/i);
      await expect(page.getByText(/No rules of your own yet/i)).toBeVisible();
    } finally {
      await db.tenant.delete({ where: { id: data.tenantId } }).catch(() => {});
    }
  });
});
