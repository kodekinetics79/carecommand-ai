import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const admin = vi.hoisted(() => ({
  me: vi.fn(),
  overview: vi.fn(),
  health: vi.fn(),
  tenants: vi.fn(),
  plans: vi.fn(),
  addons: vi.fn(),
  requests: vi.fn(),
  getSettings: vi.fn(),
  settingPresets: vi.fn(),
  updateSettings: vi.fn(),
  createTenant: vi.fn(),
}));

vi.mock('../lib/platformAdmin', async () => {
  const actual = await vi.importActual<typeof import('../lib/platformAdmin')>('../lib/platformAdmin');
  return { ...actual, platformAdmin: { ...actual.platformAdmin, ...admin }, setPlatformToken: vi.fn() };
});

import PlatformConsole from './PlatformConsole';

/**
 * The Control Tower is the only screen an operator uses to onboard a paying
 * clinic. Three failures made it feel broken while every endpoint behind it
 * worked, and these tests hold each of them shut:
 *
 *   * "Create company" greyed out without naming a single unmet requirement;
 *   * a plan catalog that failed to load rendered as a healthy "Starter"
 *     option, which then failed provisioning with "catalog is not seeded";
 *   * Platform Settings spun forever on any load failure, which is what
 *     "the settings page is dead" looked like from the operator's chair.
 */

const SETTINGS = {
  platformName: 'CareCommand', supportEmail: null,
  defaultTrialDays: 14, defaultPlanKey: 'growth',
  defaultTimezone: 'Europe/London', defaultCountry: 'GB',
  defaultBranchName: 'Reception', defaultVoiceMinutes: 300,
  requireMfaFloor: true, sessionTimeoutMaxMinutes: 240, requireOperatorMfa: true,
  presetKey: 'uk_pilot', updatedAt: '2026-08-29T10:00:00.000Z',
};

const PLANS = [{ key: 'starter', name: 'Starter', monthlyPrice: 0, features: [] }, { key: 'growth', name: 'Growth', monthlyPrice: 0, features: [] }];

function renderConsole() {
  return render(<MemoryRouter initialEntries={['/platform']}><PlatformConsole /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  admin.me.mockResolvedValue({ id: 'op-1', email: 'op@carecommand.test', name: 'Ops Person', role: 'PLATFORM_ADMIN', legacy: false, mfaEnabled: true });
  admin.overview.mockResolvedValue({ tenants: 1, activeTenants: 1, pendingRequests: 0, suspended: 0, operators: 1 });
  admin.health.mockResolvedValue({ api: 'ok', database: 'ok', redis: 'ok', failedJobs: 0 });
  admin.tenants.mockResolvedValue([]);
  admin.plans.mockResolvedValue(PLANS);
  admin.addons.mockResolvedValue([]);
  admin.requests.mockResolvedValue([]);
  admin.getSettings.mockResolvedValue(SETTINGS);
  admin.settingPresets.mockResolvedValue({ presets: [{ key: 'uk_pilot', label: 'UK clinic - pilot', description: 'Two-week trial, London time.', values: { defaultTrialDays: 14 } }] });
});

async function openSection(label: string) {
  const nav = await screen.findByLabelText('Section');
  fireEvent.change(nav, { target: { value: label } });
}

describe('Control Tower — creating a company', () => {
  it('names every unmet requirement instead of greying the button out in silence', async () => {
    renderConsole();
    await openSection('tenants');
    fireEvent.click(await screen.findByRole('button', { name: /New company/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Create company/i }));

    const stillNeeded = await screen.findByText(/Still needed:/i);
    expect(stillNeeded.textContent).toMatch(/Company name/i);
    expect(stillNeeded.textContent).toMatch(/Slug/i);
    expect(stillNeeded.textContent).toMatch(/Owner email/i);
    expect(stillNeeded.textContent).toMatch(/password/i);
    expect(admin.createTenant).not.toHaveBeenCalled();
  });

  it('states the slug contract the database will actually enforce', async () => {
    renderConsole();
    await openSection('tenants');
    fireEvent.click(await screen.findByRole('button', { name: /New company/i }));
    fireEvent.change(screen.getByPlaceholderText('sunrise-dental'), { target: { value: 'ab' } });
    fireEvent.click(screen.getByRole('button', { name: /Create company/i }));

    expect((await screen.findByText(/Still needed:/i)).textContent).toMatch(/3-40 characters/i);
    expect(admin.createTenant).not.toHaveBeenCalled();
  });

  it('offers the platform default plan rather than a hardcoded Starter', async () => {
    renderConsole();
    await openSection('tenants');
    fireEvent.click(await screen.findByRole('button', { name: /New company/i }));
    await waitFor(() => expect((screen.getByLabelText('Plan') as HTMLSelectElement).value).toBe('growth'));
  });

  it('refuses to provision against a plan catalog it could not load, instead of inventing one', async () => {
    admin.plans.mockRejectedValue(new Error('Subscription catalog unavailable'));
    renderConsole();
    await openSection('tenants');
    fireEvent.click(await screen.findByRole('button', { name: /New company/i }));

    // Named twice on purpose: once as a banner, once in the list of reasons
    // the submit is blocked.
    expect((await screen.findAllByText(/Subscription catalog unavailable/i)).length).toBeGreaterThan(0);
    const plan = await screen.findByLabelText('Plan');
    expect((plan as HTMLSelectElement).disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText('Sunrise Dental Group'), { target: { value: 'Sunrise Dental Group' } });
    fireEvent.change(screen.getByPlaceholderText('Dr. Jane Doe'), { target: { value: 'Dr Jane Doe' } });
    fireEvent.change(screen.getByPlaceholderText('owner@clinic.com'), { target: { value: 'owner@sunrise.test' } });
    fireEvent.change(screen.getByPlaceholderText('Set an initial password'), { target: { value: 'a-long-enough-password' } });
    fireEvent.click(screen.getByRole('button', { name: /Create company/i }));

    await waitFor(() => expect(admin.createTenant).not.toHaveBeenCalled());
  });
});

describe('Control Tower — platform settings', () => {
  it('shows the failure instead of spinning forever when settings cannot be loaded', async () => {
    admin.getSettings.mockRejectedValue(new Error('Platform session expired. Please sign in again.'));
    renderConsole();
    await openSection('settings');
    expect(await screen.findByText(/Platform session expired/i)).toBeTruthy();
  });

  it('renders the provisioning defaults and the security floor it actually applies', async () => {
    renderConsole();
    await openSection('settings');
    await waitFor(() => expect((screen.getByLabelText('Default plan') as HTMLSelectElement).value).toBe('growth'));
    expect((screen.getByDisplayValue('Europe/London') as HTMLInputElement).value).toBe('Europe/London');
    expect((screen.getByDisplayValue('300') as HTMLInputElement).value).toBe('300');
    // Two MFA controls exist and they mean different things: one is the floor a
    // new CLINIC starts on, the other governs our own staff.
    expect((screen.getByRole('checkbox', { name: /Require MFA from day one/i }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: /Require MFA for every Control Tower operator/i }) as HTMLInputElement).checked).toBe(true);
  });

  it('states what turning operator MFA off actually costs, rather than offering a bare toggle', async () => {
    renderConsole();
    await openSection('settings');
    const operatorMfa = await screen.findByRole('checkbox', { name: /Require MFA for every Control Tower operator/i });
    expect(operatorMfa).toBeTruthy();
    expect(screen.getByText(/reach every tenant/i)).toBeTruthy();
    expect(screen.getByText(/already enrolled keep being asked/i)).toBeTruthy();
  });

  it('re-renders from what the server stored, not from what it sent', async () => {
    admin.updateSettings.mockResolvedValue({ ...SETTINGS, defaultVoiceMinutes: 275, presetKey: 'custom' });
    renderConsole();
    await openSection('settings');
    await screen.findByLabelText('Default plan');
    fireEvent.change(screen.getByDisplayValue('300'), { target: { value: '999' } });
    fireEvent.click(screen.getByRole('button', { name: /Save settings/i }));

    await waitFor(() => expect(screen.getByDisplayValue('275')).toBeTruthy());
    expect(await screen.findByText(/New companies provision with these values/i)).toBeTruthy();
  });

  it('applies a preset by filling the fields, leaving them editable', async () => {
    renderConsole();
    await openSection('settings');
    const preset = await screen.findByLabelText('Settings preset');
    fireEvent.change(preset, { target: { value: 'uk_pilot' } });
    const trial = screen.getByDisplayValue('14') as HTMLInputElement;
    expect(trial.disabled).toBe(false);
    fireEvent.change(trial, { target: { value: '30' } });
    expect((screen.getByDisplayValue('30') as HTMLInputElement).value).toBe('30');
  });
});

describe('Control Tower — a failed list is not an empty list', () => {
  it('does not tell the operator they are all caught up when the request failed', async () => {
    admin.requests.mockRejectedValue(new Error('Request failed (500)'));
    renderConsole();
    await openSection('requests');
    expect(await screen.findByText(/Could not load this list/i)).toBeTruthy();
    expect(screen.queryByText(/all caught up/i)).toBeNull();
  });
});
