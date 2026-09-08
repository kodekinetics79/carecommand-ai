import 'dotenv/config';
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { fixtureDb as db } from '../../server/test/helpers/fixtureDb';
import { generatePasswordHash } from '../../server/lib/security';
import { recomputeEntitlements } from '../../server/lib/entitlements';
import { ensureE2eSubscriptionPlan } from './subscriptionFixture';

const STAFF_PASSWORD = 'E2E-Reminder-Pw-123!';

test('books with a Text reminder and shows production setup truth at 390px', async ({ page }, testInfo) => {
  const tag = `${testInfo.project.name.replace(/[^a-z0-9]/gi, '').toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const tenantId = randomUUID();
  const branchId = randomUUID();
  const staffEmail = `reminders-${tag}@e2e.test`;
  await page.setViewportSize({ width: 390, height: 844 });

  await db.tenant.create({ data: { id: tenantId, name: `Reminder Clinic ${tag}`, slug: `reminder-${tag}` } });
  try {
    const subscriptionPlan = await ensureE2eSubscriptionPlan();
    await db.tenantSubscription.create({ data: { tenantId, planId: subscriptionPlan.id, status: 'ACTIVE', startedAt: new Date() } });
    await recomputeEntitlements(tenantId, db);
    await db.branch.create({ data: { id: branchId, tenantId, name: 'Bright Health Main', location: 'Synthetic test clinic', timezone: 'UTC' } });
    await db.user.create({ data: {
      tenantId, role: 'ADMIN', active: true, email: staffEmail, displayName: 'Reminder Test Admin',
      passwordHash: await generatePasswordHash(STAFF_PASSWORD), passwordChangedAt: new Date(),
    } });
    const providerUser = await db.user.create({ data: {
      tenantId, role: 'PROVIDER', active: true, email: `provider-${tag}@e2e.test`, displayName: 'Dr Rivera',
      passwordHash: await generatePasswordHash(STAFF_PASSWORD), passwordChangedAt: new Date(),
    } });
    const provider = await db.providerProfile.create({ data: { tenantId, branchId, userId: providerUser.id, specialty: 'Primary care', active: true } });
    await db.providerAvailability.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({ tenantId, branchId, providerProfileId: provider.id, dayOfWeek, startMinute: 540, endMinute: 720, slotMinutes: 30 })),
    });
    await db.patient.create({ data: {
      tenantId, branchId, firstName: 'Avery', lastName: 'Reminder', phone: '+15555550123',
      email: `patient-${tag}@e2e.test`, lifecycleStage: 'ACTIVE',
    } });

    await page.goto('/login');
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill(staffEmail);
    await page.getByRole('textbox', { name: /Password/ }).fill(STAFF_PASSWORD);
    await page.getByRole('button', { name: /^Sign in$/i }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto('/scheduling');
    await page.getByRole('button', { name: 'Tomorrow' }).click();
    await page.getByRole('button', { name: 'Book appointment' }).click();

    const dialog = page.getByRole('dialog', { name: 'Book appointment' });
    await expect(page.getByLabel('Search patients')).toBeFocused();
    await expect(page.getByRole('radio', { name: 'None' })).toBeChecked();
    await page.getByLabel('Patient', { exact: true }).selectOption({ label: 'Avery Reminder' });
    await page.getByLabel('Service', { exact: true }).fill('Annual wellness visit');
    await page.getByLabel('Provider', { exact: true }).selectOption(provider.id);
    const slotsPanel = page.getByText('Open slots', { exact: true }).locator('..');
    await slotsPanel.getByRole('button').first().click();
    await page.getByRole('radio', { name: 'Text' }).check();
    await dialog.getByRole('button', { name: 'Book appointment' }).click();

    await expect(page.getByRole('status')).toContainText('Will not send until automatic reminders are set up. Text reminder selected. Appointment booked.');
    const row = page.locator('[data-appointment-id]').filter({ hasText: 'Avery Reminder' });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: /Reminders/ }).click();
    await expect(row.getByText('Will not send until automatic reminders are set up. Text reminder selected.')).toBeVisible();
    await expect(row.getByRole('radio', { name: 'Text' })).toBeChecked();

    await expect(page.locator('body')).not.toContainText(/twilio|retell|\+15555550123/i);
    const pageWidth = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
    expect(pageWidth.content).toBeLessThanOrEqual(pageWidth.viewport + 1);
  } finally {
    await db.tenant.delete({ where: { id: tenantId } }).catch(() => {});
  }
});
