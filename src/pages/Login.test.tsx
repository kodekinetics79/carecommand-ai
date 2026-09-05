import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Login from './Login';

const { signIn, requestPasswordReset, confirmPasswordReset, clearSession } = vi.hoisted(() => ({
  signIn: vi.fn(),
  requestPasswordReset: vi.fn(),
  confirmPasswordReset: vi.fn(),
  clearSession: vi.fn(),
}));

vi.mock('../hooks/useSession', () => ({
  useSession: () => ({ signIn }),
}));

vi.mock('../lib/session', () => ({
  clearSession,
  requestPasswordReset,
  confirmPasswordReset,
  mfaSetupWithToken: vi.fn(),
  mfaVerifyWithToken: vi.fn(),
}));

function renderLogin() {
  return render(<BrowserRouter><Login /></BrowserRouter>);
}

describe('tenant password recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.history.replaceState({}, '', '/login');
  });

  it('keeps recovery discoverable and asks for an optional workspace', () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(screen.getByRole('heading', { name: 'Reset your password' })).toHaveFocus();
    expect(screen.getByLabelText('Email')).toBeVisible();
    expect(screen.getByLabelText('Clinic workspace (optional)')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Email me a reset link' })).toBeVisible();
  });

  it('submits normalized account details and shows an enumeration-safe confirmation', async () => {
    requestPasswordReset.mockResolvedValue({ message: 'generic' });
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: ' Owner@Bright.Example ' } });
    fireEvent.change(screen.getByLabelText('Clinic workspace (optional)'), { target: { value: ' Bright-Health ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a reset link' }));

    await screen.findByRole('heading', { name: 'Check your email' });
    expect(requestPasswordReset).toHaveBeenCalledWith('owner@bright.example', 'bright-health');
    expect(screen.getAllByText(/If an active account matches/).length).toBeGreaterThanOrEqual(1);
  });

  it('reads a reset fragment into memory, scrubs the URL, and never renders the token', async () => {
    const token = 'a'.repeat(43);
    window.history.replaceState({}, '', `/login#reset=${token}`);
    confirmPasswordReset.mockResolvedValue({ message: 'ok' });
    renderLogin();

    expect(screen.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    expect(window.location.hash).toBe('');
    expect(screen.queryByDisplayValue(token)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(token);
    expect(window.localStorage.getItem('reset')).toBeNull();

    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'Bright-Recovery-2026!' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'Bright-Recovery-2026!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    await waitFor(() => expect(confirmPasswordReset).toHaveBeenCalledWith(token, 'Bright-Recovery-2026!'));
    expect(clearSession).toHaveBeenCalledOnce();
    expect(await screen.findByRole('heading', { name: 'Password updated' })).toBeVisible();
  });

  it('blocks mismatched passwords before sending the credential', async () => {
    const token = 'b'.repeat(43);
    window.history.replaceState({}, '', `/login#reset=${token}`);
    renderLogin();
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'Bright-Recovery-2026!' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'Different-Recovery-2026!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The passwords do not match.');
    expect(confirmPasswordReset).not.toHaveBeenCalled();
  });
});
