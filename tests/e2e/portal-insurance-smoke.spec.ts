import 'dotenv/config';
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { fixtureDb as db } from '../../server/test/helpers/fixtureDb';
import { generatePasswordHash } from '../../server/lib/security';
import { createMagicToken, hashPortalToken } from '../../server/lib/portalAuth';
import { recomputeEntitlements } from '../../server/lib/entitlements';
import { ensureE2eSubscriptionPlan } from './subscriptionFixture';

type GoldenData = {
  tenantId: string;
  slug: string;
  patientEmail: string;
  patientName: string;
  patientId: string;
  signInToken: string;
};

async function seedData(projectName: string): Promise<GoldenData> {
  const tag = `${projectName.replace(/[^a-z0-9]/gi, '').toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const tenantId = randomUUID();
  const slug = `e2e-${tag}`;

  await db.tenant.create({ data: { id: tenantId, name: `E2E Clinic ${tag}`, slug } });
  const plan = await ensureE2eSubscriptionPlan();
  await db.tenantSubscription.create({ data: { tenantId, planId: plan.id, status: 'ACTIVE', startedAt: new Date() } });
  await recomputeEntitlements(tenantId, db);

  const branch = await db.branch.create({ data: { tenantId, name: 'Main Clinic', location: 'Validation Suite' } });
  await db.user.create({
    data: {
      tenantId,
      role: 'ADMIN',
      active: true,
      email: `admin-${tag}@e2e.test`,
      displayName: 'E2E Admin',
      passwordHash: await generatePasswordHash('E2E-Staff-Pw-123!'),
      passwordChangedAt: new Date(),
    },
  });
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
  await db.patientPortalAccount.create({
    data: {
      tenantId,
      patientId: patient.id,
      email: patient.email,
      phone: patient.phone,
      status: 'invited',
    },
  });
  const signInToken = createMagicToken();
  const portalAccount = await db.patientPortalAccount.findFirstOrThrow({
    where: { tenantId, patientId: patient.id },
    select: { id: true },
  });
  await db.patientPortalToken.create({
    data: {
      tenantId,
      accountId: portalAccount.id,
      tokenHash: hashPortalToken(signInToken.raw),
      type: 'magic_login',
      expiresAt: new Date(Date.now() + 15 * 60_000),
    },
  });

  return {
    tenantId,
    slug,
    patientEmail: patient.email,
    patientName: `${patient.firstName} ${patient.lastName}`,
    patientId: patient.id,
    signInToken: signInToken.raw,
  };
}

async function loginPatient(page: Page, data: GoldenData) {
  await page.goto('/client/login');
  await page.getByLabel('Clinic').fill(data.slug);
  await page.getByLabel('Email').fill(data.patientEmail);
  await page.getByRole('button', { name: 'Send sign-in link' }).click();

  await expect(page.getByText('Enter your link code')).toBeVisible();
  await page.getByPlaceholder('paste your code').fill(data.signInToken);
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByText(/Hi Avery/)).toBeVisible({ timeout: 15000 });
  await page.getByRole('link', { name: 'Insurance', exact: true }).click();
}

test('SDET portal insurance smoke: request-link + verify + save insurance', async ({ page }) => {
  const data = await seedData('sdet-smoke');
  const failedRequests: string[] = [];

  page.on('requestfailed', req => failedRequests.push(`${req.method()} ${req.url()} ${req.failure()?.errorText ?? ''}`));

  try {
    await loginPatient(page, data);

    await page.getByRole('button', { name: /Add insurance|Add \/ update insurance/i }).click();
    await page.getByPlaceholder('Plan name (e.g. Aetna Core)').fill('Aetna Enterprise PPO');
    await page.getByPlaceholder('Member ID').fill('SDET-MEMBER-001');
    await page.getByPlaceholder('Group # (optional)').fill('GRP-SDET');
    await page.getByPlaceholder('Subscriber name (optional)').fill('Avery Pilot');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByText(/Policy details saved for clinic review/)).toBeVisible();
    await expect(failedRequests).toEqual([]);

    const policy = await db.patientInsurancePolicy.findFirst({
      where: { tenantId: data.tenantId, patientId: data.patientId, planName: 'Aetna Enterprise PPO', active: true },
    });
    expect(policy).not.toBeNull();
    expect(policy?.verificationStatus).toBe('pending');
  } finally {
    await db.tenant.delete({ where: { id: data.tenantId } }).catch(() => {});
  }
});
