import 'dotenv/config';
import { expect, test, type Page } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { fixtureDb as db } from '../../server/test/helpers/fixtureDb';
import { generatePasswordHash } from '../../server/lib/security';
import { recomputeEntitlements } from '../../server/lib/entitlements';
import { createEligibilityReconciliationWorker } from '../../server/workers/eligibilityReconciliation.worker';
import { eligibilityReconciliationQueue, enqueueEligibilityReconciliationTenantJob } from '../../server/workers/queues';
import { ensureE2eSubscriptionPlan } from './subscriptionFixture';

const API = 'http://127.0.0.1:43201';
const PASSWORD = 'Eligibility-Reconcile-E2E-123!';

type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed(projectName: string) {
  const tag = `${projectName.replace(/[^a-z0-9]/gi, '').toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const tenantId = randomUUID();
  await db.tenant.create({ data: { id: tenantId, name: `Eligibility E2E ${tag}`, slug: `elig-e2e-${tag}` } });
  const plan = await ensureE2eSubscriptionPlan();
  await db.tenantSubscription.create({ data: { tenantId, planId: plan.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(tenantId, db);
  const branch = await db.branch.create({ data: { tenantId, name: 'Eligibility Branch', location: 'Browser validation' } });
  const staff = await db.user.create({ data: {
    tenantId, branchId: branch.id, role: 'MANAGER', active: true,
    email: `manager-${tag}@e2e.test`, displayName: 'Eligibility Manager',
    passwordHash: await generatePasswordHash(PASSWORD), passwordChangedAt: new Date(),
  } });
  const patient = await db.patient.create({ data: { tenantId, branchId: branch.id, firstName: 'Reconcile', lastName: 'Patient' } });
  const payer = await db.insurancePayer.create({ data: { tenantId, name: 'Synthetic Payer' } });
  const policy = await db.patientInsurancePolicy.create({ data: {
    tenantId, branchId: branch.id, patientId: patient.id, payerId: payer.id,
    planName: 'Synthetic Evidence Plan', memberId: 'PRIVATE-E2E-MEMBER',
  } });
  const stale = new Date(Date.now() - 10 * 60_000);
  const requestedServiceAt = new Date('2026-07-15T14:00:00.000Z');
  const execution = await db.eligibilityExecution.create({ data: {
    tenantId, branchId: branch.id, patientId: patient.id, payerId: payer.id, policyId: policy.id, actorUserId: staff.id,
    idempotencyKeyHash: randomBytes(32).toString('hex'), hmacKeyVersion: 'v1',
    requestFingerprint: randomBytes(32).toString('hex'), requestContract: 'insurance_v1',
    providerKey: 'test-payer', providerMode: 'sandbox', status: 'PROVIDER_IN_FLIGHT',
    requestedServiceType: 'MRI imaging review', requestedServiceAt, providerStartedAt: stale, createdAt: stale,
  } });
  await db.auditEvent.create({ data: {
    tenantId, actorUserId: staff.id, action: 'eligibility.execution.requested',
    resource: 'eligibilityExecution', resourceId: execution.id,
    metadata: { requestedServiceType: 'MRI imaging review', requestedServiceAt: requestedServiceAt.toISOString() },
  } });

  const otherTenantId = randomUUID();
  await db.tenant.create({ data: { id: otherTenantId, name: `Other ${tag}`, slug: `other-${tag}` } });
  await db.tenantSubscription.create({ data: { tenantId: otherTenantId, planId: plan.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(otherTenantId, db);
  const otherBranch = await db.branch.create({ data: { tenantId: otherTenantId, name: 'Other Branch', location: 'Other' } });
  const otherPatient = await db.patient.create({ data: { tenantId: otherTenantId, branchId: otherBranch.id, firstName: 'Other', lastName: 'Patient' } });
  const otherExecution = await db.eligibilityExecution.create({ data: {
    tenantId: otherTenantId, branchId: otherBranch.id, patientId: otherPatient.id,
    idempotencyKeyHash: randomBytes(32).toString('hex'), hmacKeyVersion: 'v1',
    requestFingerprint: randomBytes(32).toString('hex'), requestContract: 'insurance_v1',
    providerKey: 'test-payer', providerMode: 'sandbox', status: 'RECONCILIATION_REQUIRED', reconciliationReason: 'provider_outcome_ambiguous',
  } });
  return { tenantId, otherTenantId, staff, execution, otherExecution };
}

async function login(page: Page, fixture: Fixture) {
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(fixture.staff.email);
  await page.getByRole('textbox', { name: /Password/ }).fill(PASSWORD);
  await page.getByRole('button', { name: /^Sign in$/i }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function accessToken(fixture: Fixture) {
  const response = await fetch(`${API}/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: fixture.staff.email, password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  return (await response.json() as { accessToken: string }).accessToken;
}

test.describe('real staff eligibility reconciliation workflow', () => {
  let fixture: Fixture;
  let worker: ReturnType<typeof createEligibilityReconciliationWorker>;

  test.beforeEach(async ({ page }, testInfo) => {
    void page;
    fixture = await seed(testInfo.project.name);
    worker = createEligibilityReconciliationWorker();
  });

  test.afterEach(async () => {
    await worker?.close();
    await eligibilityReconciliationQueue.obliterate({ force: true }).catch(() => undefined);
    await eligibilityReconciliationQueue.close();
    await db.tenant.delete({ where: { id: fixture.tenantId } }).catch(() => undefined);
    await db.tenant.delete({ where: { id: fixture.otherTenantId } }).catch(() => undefined);
  });

  test.afterAll(async () => {
    await db.$disconnect();
  });

  test('surfaces, claims, reloads, and resolves stale payer work without a lookup or cross-tenant access', async ({ page }) => {
    const consoleErrors: string[] = [];
    const unexpectedFailures: string[] = [];
    page.on('pageerror', error => consoleErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('response', response => {
      if (response.url().includes('/v1/') && response.status() >= 500) unexpectedFailures.push(`${response.status()} ${new URL(response.url()).pathname}`);
    });

    await login(page, fixture);
    await page.goto('/insurance-eligibility');
    await expect(page.getByRole('heading', { name: 'Eligibility Reconciliation' })).toBeVisible();
    await expect(page.getByText(/stale provider in flight/i)).toBeVisible();
    await expect(page.getByText(/Synthetic Payer · Synthetic Evidence Plan/i)).toBeVisible();
    await expect(page.getByText('Service: MRI imaging review')).toBeVisible();
    await expect(page.getByText(/Requested:/)).toBeVisible();
    await expect(page.getByText(/Last attempt:/)).toBeVisible();
    await expect(page.getByText('Provider call may have occurred: yes · verified response lookup: not supported')).toBeVisible();
    await page.getByText(/Execution audit history/).click();
    await expect(page.getByText(/eligibility › execution › requested/)).toBeVisible();

    await enqueueEligibilityReconciliationTenantJob(fixture.tenantId);
    await expect.poll(async () => (await db.eligibilityExecution.findUniqueOrThrow({ where: { id: fixture.execution.id } })).status).toBe('MANUAL_EVIDENCE_PENDING');
    const afterScan = await db.eligibilityExecution.findUniqueOrThrow({ where: { id: fixture.execution.id } });
    expect(afterScan.providerStartedAt?.toISOString()).toBe(fixture.execution.providerStartedAt?.toISOString());
    expect(afterScan.providerCompletedAt).toBeNull();
    expect((await db.staffTask.findUniqueOrThrow({ where: { id: afterScan.reconciliationTaskId! } })).metadata).toMatchObject({
      providerCallMayHaveOccurred: true, noAutomaticPayerRetry: true,
    });

    await page.getByRole('button', { name: 'Reload from server' }).click();
    await expect(page.getByText(/manual pending/i)).toBeVisible();
    await page.getByRole('button', { name: 'Claim task' }).click();
    await expect(page.getByRole('button', { name: 'Record payer evidence' })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Eligibility Reconciliation' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record payer evidence' })).toBeVisible();
    await page.getByRole('button', { name: 'Record payer evidence' }).click();
    await page.getByLabel('Payer outcome').selectOption('ACTIVE');
    await page.getByLabel('Evidence source').selectOption('PAYER_PORTAL');
    await page.getByLabel('Payer reference').fill('PW-E2E-REF-123');
    const verifiedAt = new Date(Date.now() - 60_000);
    const localVerifiedAt = new Date(verifiedAt.getTime() - verifiedAt.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    await page.getByLabel('Verified at').fill(localVerifiedAt);
    await page.getByLabel('Verification notes').fill('Synthetic payer evidence reviewed by authorized staff');
    await page.getByLabel('Evidence matches this patient').check();
    await page.getByLabel('Evidence matches this policy/member contract').check();
    await page.getByLabel('Evidence came from the named payer').check();
    await page.getByLabel('Service and date of service match this request').check();
    await page.getByRole('button', { name: 'Attest matches and save' }).click();
    await expect.poll(async () => (await db.eligibilityExecution.findUniqueOrThrow({ where: { id: fixture.execution.id } })).status).toBe('MANUALLY_RECONCILED');
    await expect(page.getByText('Manually verified active').first()).toBeVisible();
    await expect(page.getByText('Manual payer evidence').first()).toBeVisible();
    await expect(page.getByText('Unknown').first()).toBeVisible();

    await page.getByLabel('Reconciliation filter').selectOption('reconciled');
    await expect(page.getByText(/Synthetic Payer · Synthetic Evidence Plan/i)).toBeVisible();
    await expect(page.getByText('Result source: Manual payer evidence')).toBeVisible();
    await expect(page.getByText('Result status: Manually verified active')).toBeVisible();

    const reconciled = await db.eligibilityExecution.findUniqueOrThrow({ where: { id: fixture.execution.id } });
    expect(reconciled).toMatchObject({ status: 'MANUALLY_RECONCILED', manualEvidenceReference: 'PW-E2E-REF-123', manualEvidenceOutcome: 'ACTIVE' });
    const verification = await db.eligibilityVerification.findUniqueOrThrow({ where: { id: reconciled.resultVerificationId! } });
    expect(verification).toMatchObject({ decisionSource: 'MANUAL_PAYER_EVIDENCE', coverageStatus: 'ACTIVE', copay: null, deductibleRemaining: null, coinsurance: null });
    expect(verification.eligibilityMessage).toContain('not a payment guarantee');
    expect(await db.auditEvent.count({ where: { tenantId: fixture.tenantId, resourceId: fixture.execution.id, action: 'eligibility.execution.manually_reconciled' } })).toBe(1);

    const token = await accessToken(fixture);
    const crossTenant = await fetch(`${API}/v1/insurance/eligibility/executions/${fixture.otherExecution.id}/claim`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ expectedGeneration: 0 }),
    });
    expect(crossTenant.status).toBe(404);
    expect(consoleErrors).toEqual([]);
    expect(unexpectedFailures).toEqual([]);
  });
});
