import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { AlertCircle, ArrowLeft, Eye, EyeOff, Info, KeyRound, Lock, Mail, ShieldCheck, Smartphone, Users } from 'lucide-react';
import { useSession } from '../hooks/useSession';
import Logo from '../components/ui/Logo';
import { clearSession, mfaSetupWithToken, mfaVerifyWithToken, requestPasswordReset, confirmPasswordReset } from '../lib/session';

type Mode = 'login' | 'mfa' | 'mfaSetup' | 'reset' | 'resetSent' | 'resetConfirm' | 'resetSuccess' | 'expired';
const REMEMBER_KEY = 'cc_remember_email';

// The <Logo> geometry, reused as the panel's only ornament — drafted as an
// outline at ~25x scale and cropped by the corner.
const BRAND_PULSE = 'M7 18 H11.2 L13 13.5 L16 21 L18.2 16.5 H21 L24 12.5';

function resetTokenFromFragment(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.hash.slice(1)).get('reset')?.trim() ?? '';
}

// Each mode announces where you are. Multi-step auth that silently swaps the
// panel out from under the user is the main usability flaw of the old screen.
const COPY: Record<Mode, { eyebrow: string; title: string; sub: string; step?: 1 | 2 }> = {
  login:        { eyebrow: 'Secure sign-in',   title: 'Sign in to your workspace',   sub: 'Use the modules and locations assigned to your account.' },
  mfa:          { eyebrow: 'Verification',     title: 'Confirm it’s you',            sub: 'Enter the 6-digit code from your authenticator app.', step: 2 },
  mfaSetup:     { eyebrow: 'Set up MFA',       title: 'Add an authenticator',        sub: 'Your organization requires multi-factor authentication to continue.', step: 2 },
  reset:        { eyebrow: 'Account recovery', title: 'Reset your password',         sub: 'We’ll email a secure, single-use link to the address on your account.' },
  resetSent:    { eyebrow: 'Account recovery', title: 'Check your email',             sub: 'If an active account matches those details, a reset link is on its way.' },
  resetConfirm: { eyebrow: 'Account recovery', title: 'Choose a new password',       sub: 'Set a new password for your CareCommand workspace.', step: 2 },
  resetSuccess: { eyebrow: 'Account recovery', title: 'Password updated',            sub: 'Your prior sessions have been signed out. MFA settings are unchanged.' },
  expired:      { eyebrow: 'Account recovery', title: 'Your password has expired',   sub: 'It must be reset before you can sign in again.' },
};

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { signIn } = useSession({ hydrate: false });

  // Email-only convenience; authentication tokens and session duration are unchanged.
  const rememberedEmail = typeof localStorage !== 'undefined' ? localStorage.getItem(REMEMBER_KEY) : null;
  const [initialResetToken] = useState(resetTokenFromFragment);
  const [mode, setMode] = useState<Mode>(initialResetToken ? 'resetConfirm' : 'login');
  const [email, setEmail] = useState(rememberedEmail ?? '');
  const [password, setPassword] = useState('');
  const [tenantSlug, setTenantSlug] = useState('');
  const [tenantRequired, setTenantRequired] = useState(false);
  const [rememberMe, setRememberMe] = useState(rememberedEmail !== null);
  const [code, setCode] = useState('');
  const [resetToken, setResetToken] = useState(initialResetToken);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [mfaToken, setMfaToken] = useState('');
  const [mfaSetupData, setMfaSetupData] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [showPw, setShowPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useLayoutEffect(() => {
    if (!initialResetToken || typeof window === 'undefined') return;
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  }, [initialResetToken]);

  useEffect(() => {
    if (mode !== 'login') headingRef.current?.focus();
  }, [mode]);

  function goHome() {
    const destination = (location.state as { from?: string } | null)?.from ?? '/';
    navigate(destination, { replace: true });
  }

  function backToLogin() {
    setError(null); setInfo(null); setCode(''); setResetToken(''); setNewPassword(''); setConfirmPassword(''); setMode('login');
  }

  async function run(fn: () => Promise<void>) {
    setLoading(true); setError(null);
    try { await fn(); } catch (err) { setError(err instanceof Error ? err.message : 'We could not complete that request. Please try again.'); }
    finally { setLoading(false); }
  }

  const onLogin = (e: FormEvent) => { e.preventDefault(); void run(async () => {
    const cleanEmail = email.trim().toLowerCase();
    if (rememberMe) localStorage.setItem(REMEMBER_KEY, cleanEmail); else localStorage.removeItem(REMEMBER_KEY);
    const result = await signIn(cleanEmail, password, tenantRequired ? tenantSlug.trim().toLowerCase() : undefined);
    if (result.kind === 'session') return goHome();
    if (result.kind === 'tenant_required') {
      setTenantRequired(true);
      setInfo(result.message);
      return;
    }
    if (result.kind === 'mfa_required') { setMfaToken(result.mfaToken); setMode('mfa'); return; }
    if (result.kind === 'mfa_setup_required') {
      setMfaToken(result.mfaToken);
      const setup = await mfaSetupWithToken(result.mfaToken);
      setMfaSetupData({ secret: setup.secret, otpauthUri: setup.otpauthUri });
      setMode('mfaSetup');
      return;
    }
    if (result.kind === 'password_expired') { setInfo(result.message); setMode('expired'); }
  }); };

  const onMfaVerify = (e: FormEvent) => { e.preventDefault(); void run(async () => {
    await mfaVerifyWithToken(mfaToken, code.trim());
    goHome();
  }); };

  const onResetRequest = (e: FormEvent) => { e.preventDefault(); void run(async () => {
    const res = await requestPasswordReset(email.trim().toLowerCase(), tenantSlug.trim().toLowerCase() || undefined);
    if (res.devToken) {
      setResetToken(res.devToken); // explicit test/E2E mode only; absent from production
      setInfo(res.message);
      setMode('resetConfirm');
      return;
    }
    setInfo(null);
    setMode('resetSent');
  }); };

  const onResetConfirm = (e: FormEvent) => { e.preventDefault(); void run(async () => {
    if (newPassword !== confirmPassword) throw new Error('The passwords do not match.');
    await confirmPasswordReset(resetToken.trim(), newPassword);
    clearSession();
    setInfo(null); setNewPassword(''); setConfirmPassword(''); setPassword(''); setResetToken(''); setMode('resetSuccess');
  }); };

  const copy = COPY[mode];

  return (
    <div className="min-h-screen bg-[var(--paper)] lg:grid lg:grid-cols-[1.08fr_minmax(460px,0.92fr)]">

      {/* ═══ Ink field — brand, cropped mark, module index ═══════════════ */}
      <aside className="auth-ink relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between px-14 py-12 xl:px-16">
        <svg className="auth-mark" viewBox="0 0 32 32" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          <rect data-part="badge" x="2" y="2" width="28" height="28" rx="9" />
          <rect data-part="badge" x="5.4" y="5.4" width="21.2" height="21.2" rx="6.4" />
          <path data-part="pulse" d={BRAND_PULSE} />
          <circle data-part="pulse" cx="24" cy="12.5" r="1.7" />
        </svg>

        <div className="auth-in relative flex items-center gap-3.5">
          <Logo size={40} className="shrink-0" />
          <div className="leading-none">
            <p className="text-[17px] font-bold tracking-[-0.01em]">CareCommand <span style={{ color: 'var(--ink-accent)' }}>AI</span></p>
            <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--ink-t3)' }}>Clinic Operating System</p>
          </div>
        </div>

        <div className="relative max-w-[30rem] py-10">
          <h1 className="auth-in auth-d1 text-[2.5rem] font-bold leading-[1.08] tracking-[-0.03em] xl:text-[2.85rem]">
            Every clinic decision,
            <br />
            <span style={{ color: 'var(--ink-accent)' }}>one command center.</span>
          </h1>
          <p className="auth-in auth-d2 mt-5 max-w-[26rem] text-[14px] leading-relaxed" style={{ color: 'var(--ink-t2)' }}>
            Scheduling, patient engagement, insurance and front-office work — held in a single
            workspace instead of six browser tabs.
          </p>

          <div className="auth-in auth-d3 mt-11">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--ink-t3)' }}>In the workspace</p>
            <ul className="mt-4 grid grid-cols-2 gap-x-10">
              {MODULES.map(m => (
                <li key={m.name} className="auth-module auth-rule py-3">
                  <p className="auth-module-name text-[13.5px] font-semibold leading-tight" style={{ color: 'var(--ink-t1)' }}>{m.name}</p>
                  <p className="mt-1 text-[11.5px] leading-snug" style={{ color: 'var(--ink-t3)' }}>{m.note}</p>
                </li>
              ))}
            </ul>
            <p className="mt-5 text-[11px]" style={{ color: 'var(--ink-t3)' }}>Modules appear once they are enabled for your clinic.</p>
          </div>
        </div>

        <p className="relative text-[11px]" style={{ color: 'var(--ink-t3)' }}>
          © {new Date().getFullYear()} CareCommand AI · Powered by{' '}
          <a href="https://kodekinetics.com" target="_blank" rel="noopener noreferrer" className="font-medium transition hover:text-white" style={{ color: 'var(--ink-t2)' }}>Kode Kinetics</a>
        </p>
      </aside>

      {/* ═══ Paper field — the form ══════════════════════════════════════ */}
      <main className="auth-paper relative flex min-h-screen flex-col lg:min-h-0">
        {/* Mobile keeps the brand band rather than dropping the identity entirely. */}
        <div className="auth-band flex items-center gap-3 px-6 py-5 sm:px-10 lg:hidden">
          <Logo size={32} className="shrink-0" />
          <div className="leading-none">
            <p className="text-[14px] font-bold tracking-[-0.01em]">CareCommand <span style={{ color: 'var(--ink-accent)' }}>AI</span></p>
            <p className="mt-1.5 text-[9.5px] font-semibold uppercase tracking-[0.18em]" style={{ color: 'var(--ink-t3)' }}>Clinic Operating System</p>
          </div>
        </div>

        <div className="flex flex-1 items-center justify-center px-5 py-10 sm:px-10 sm:py-12">
          <div className="auth-card auth-in w-full max-w-[456px] px-6 py-8 sm:px-9 sm:py-9">

            <header className="mb-7">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-indigo">{copy.eyebrow}</p>
                {copy.step && (
                  <div className="auth-rail flex gap-1.5" aria-hidden="true">
                    <span className="on" /><span className={copy.step === 2 ? 'on' : ''} />
                  </div>
                )}
              </div>
              <h2 ref={headingRef} tabIndex={-1} className="mt-3 text-[1.5rem] font-bold leading-tight tracking-[-0.02em] text-t1 outline-none">{copy.title}</h2>
              <p className="mt-2 text-[13px] leading-relaxed text-t2">{copy.sub}</p>
            </header>

            {error && <Banner tone="error">{error}</Banner>}
            {info && !error && <Banner tone="info">{info}</Banner>}

            {mode === 'login' && (
              <form onSubmit={onLogin} className="space-y-4">
                <Field label="Email" icon={<Mail className="h-4 w-4 shrink-0 text-t3" />}>
                  <input type="email" value={email} onChange={e => { setEmail(e.target.value); setTenantRequired(false); setTenantSlug(''); }} className="auth-input" placeholder="you@clinic.com" autoComplete="email" required autoFocus />
                </Field>
                <Field label="Password" icon={<Lock className="h-4 w-4 shrink-0 text-t3" />}>
                  <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} className="auth-input" placeholder="••••••••" autoComplete="current-password" required />
                  <PwReveal shown={showPw} onToggle={() => setShowPw(v => !v)} />
                </Field>
                {tenantRequired && (
                  <Field label="Clinic workspace" icon={<Users className="h-4 w-4 shrink-0 text-t3" />}>
                    <input value={tenantSlug} onChange={e => setTenantSlug(e.target.value)} className="auth-input" placeholder="your-clinic" autoComplete="organization" required autoFocus />
                  </Field>
                )}

                <div className="flex items-center justify-between gap-3 pt-0.5">
                  <label className="inline-flex cursor-pointer select-none items-center gap-2">
                    <input type="checkbox" checked={rememberMe} onChange={e => setRememberMe(e.target.checked)}
                      className="h-[15px] w-[15px] rounded border-[var(--b2)] accent-[var(--indigo)] focus-visible:outline-2 focus-visible:outline-[var(--indigo)]" />
                    {/* Say exactly what is stored: the email only, never a session. */}
                    <span className="text-[13px] text-t2">Remember email on this device</span>
                  </label>
                  <button type="button" onClick={() => { setError(null); setInfo(null); setMode('reset'); }} className="min-h-11 rounded px-1 text-[13px] font-semibold text-indigo hover:underline">Forgot password?</button>
                </div>

                <Submit loading={loading} label="Sign in" busyLabel="Signing in…" />
              </form>
            )}

            {(mode === 'mfa' || mode === 'mfaSetup') && (
              <form onSubmit={onMfaVerify} className="space-y-4">
                {mode === 'mfaSetup' && mfaSetupData && (
                  <div className="rounded-xl border border-[var(--b1)] bg-white p-4">
                    <p className="inline-flex items-center gap-2 text-[12px] font-semibold text-t1"><Smartphone className="h-3.5 w-3.5 text-indigo" aria-hidden="true" /> Add this key to your authenticator</p>
                    <code aria-label="Authenticator setup key" className="mt-2.5 block break-all rounded-lg bg-[var(--s3)] px-2.5 py-2 font-mono text-[11.5px] text-t1">{mfaSetupData.secret}</code>
                    <p id="mfa-setup-help" className="mt-2.5 text-[11.5px] leading-relaxed text-t3">Then enter the 6-digit code it generates. Keep the setup key private.</p>
                  </div>
                )}
                <Field label="Verification code" icon={<KeyRound className="h-4 w-4 shrink-0 text-t3" />}>
                  <input inputMode="numeric" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} className="auth-input font-mono tracking-[0.3em]" placeholder="123456" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} aria-describedby={mode === 'mfaSetup' ? 'mfa-setup-help' : undefined} required autoFocus />
                </Field>
                <Submit loading={loading} label="Verify & continue" busyLabel="Verifying…" />
                <BackLink onClick={backToLogin} />
              </form>
            )}

            {mode === 'reset' && (
              <form onSubmit={onResetRequest} className="space-y-4">
                <Field label="Email" icon={<Mail className="h-4 w-4 shrink-0 text-t3" />}>
                  <input type="email" value={email} onChange={e => setEmail(e.target.value)} className="auth-input" placeholder="you@clinic.com" autoComplete="email" required autoFocus />
                </Field>
                <Field label="Clinic workspace (optional)" icon={<Users className="h-4 w-4 shrink-0 text-t3" />}>
                  <input value={tenantSlug} onChange={e => setTenantSlug(e.target.value)} className="auth-input" placeholder="bright-health" autoComplete="organization" aria-describedby="workspace-reset-help" />
                </Field>
                <p id="workspace-reset-help" className="-mt-2 text-[11.5px] leading-relaxed text-t3">Add this if you use the same email in more than one CareCommand workspace.</p>
                <Submit loading={loading} label="Email me a reset link" busyLabel="Sending…" />
                <BackLink onClick={backToLogin} />
              </form>
            )}

            {mode === 'resetSent' && (
              <div className="space-y-4">
                <Banner tone="info">If an active account matches, you’ll receive a single-use link that expires shortly. Check spam or try again after a few minutes.</Banner>
                <button type="button" onClick={() => setMode('reset')} className="auth-submit">Try another email</button>
                <BackLink onClick={backToLogin} />
              </div>
            )}

            {mode === 'resetConfirm' && (
              <form onSubmit={onResetConfirm} className="space-y-4">
                <Field label="New password" icon={<Lock className="h-4 w-4 shrink-0 text-t3" />}>
                  <input type={showNewPw ? 'text' : 'password'} value={newPassword} onChange={e => setNewPassword(e.target.value)} className="auth-input" placeholder="Use a strong, unique password" autoComplete="new-password" required autoFocus aria-describedby="password-reset-help" />
                  <PwReveal shown={showNewPw} onToggle={() => setShowNewPw(v => !v)} />
                </Field>
                <Field label="Confirm new password" icon={<KeyRound className="h-4 w-4 shrink-0 text-t3" />}>
                  <input type={showNewPw ? 'text' : 'password'} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} className="auth-input" placeholder="Re-enter your new password" autoComplete="new-password" required />
                </Field>
                <p id="password-reset-help" className="-mt-2 text-[11.5px] leading-relaxed text-t3">Use the minimum length required by your organization. A password manager can create and save a unique password.</p>
                <Submit loading={loading} label="Reset password" busyLabel="Updating…" />
                <button type="button" onClick={() => { setError(null); setMode('reset'); }} className="inline-flex min-h-11 w-full items-center justify-center rounded py-1 text-[13px] font-semibold text-t3 transition hover:text-t1">Request a new link</button>
              </form>
            )}

            {mode === 'resetSuccess' && (
              <div className="space-y-4">
                <Banner tone="info">All existing sessions were signed out. Sign in with your new password; your MFA settings have not changed.</Banner>
                <button type="button" onClick={backToLogin} className="auth-submit">Sign in</button>
              </div>
            )}

            {mode === 'expired' && (
              <div className="space-y-4">
                <button type="button" onClick={() => { setError(null); setInfo(null); setMode('reset'); }} className="auth-submit">Reset password</button>
                <BackLink onClick={backToLogin} />
              </div>
            )}

            <p className="mt-6 flex items-center justify-center gap-1.5 text-[11.5px] text-t3">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-v" aria-hidden="true" /> Role-based access · recorded account activity
            </p>
          </div>
        </div>

        <footer className="px-6 pb-7 sm:px-10">
          <div className="mx-auto flex w-full max-w-[456px] flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-[11.5px] text-t3">
            <a href="mailto:support@carecommand.ai" className="transition hover:text-t1">Support</a>
            <span className="text-[var(--b2)]" aria-hidden="true">·</span>
            <a href="mailto:security@carecommand.ai?subject=CareCommand%20security%20report" className="transition hover:text-t1">Report a security issue</a>
            <span className="text-[var(--b2)] lg:hidden" aria-hidden="true">·</span>
            <a href="https://kodekinetics.com" target="_blank" rel="noopener noreferrer" className="transition hover:text-t1 lg:hidden">Kode Kinetics</a>
          </div>
        </footer>
      </main>
    </div>
  );
}

// Monochrome and typographic — a contents list, not six pastel marketing cards.
const MODULES: Array<{ name: string; note: string }> = [
  { name: 'AI Receptionist', note: 'Calls, handoffs, booking' },
  { name: 'Scheduling',      note: 'Slots and appointments' },
  { name: 'Patient CRM',     note: 'Consent-aware outreach' },
  { name: 'Insurance',       note: 'Eligibility and follow-up' },
  { name: 'Revenue',         note: 'Risks and work queues' },
  { name: 'Payments',        note: 'Requests and confirmations' },
];

function Submit({ loading, label, busyLabel }: { loading: boolean; label: string; busyLabel: string }) {
  return (
    <button type="submit" disabled={loading} className="auth-submit inline-flex items-center justify-center gap-2">
      {loading && (
        <svg className="auth-spin h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2.5" />
          <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      )}
      {loading ? busyLabel : label}
    </button>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex w-full items-center justify-center gap-1.5 rounded py-1 text-[13px] font-semibold text-t3 transition hover:text-t1">
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Back to sign in
    </button>
  );
}

function PwReveal({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} className="shrink-0 rounded text-t3 transition hover:text-t1 focus-visible:outline-2 focus-visible:outline-[var(--indigo)]"
      aria-label={shown ? 'Hide password' : 'Show password'} title={shown ? 'Hide password' : 'Show password'}>
      {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </button>
  );
}

function Field({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-semibold text-t2">{label}</span>
      <div className="auth-field">{icon}{children}</div>
    </label>
  );
}

function Banner({ tone, children }: { tone: 'error' | 'info'; children: ReactNode }) {
  const isError = tone === 'error';
  const Icon = isError ? AlertCircle : Info;
  return (
    <div role={isError ? 'alert' : 'status'} aria-live="polite"
      className={`mb-5 flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-[13px] leading-relaxed ${
        isError ? 'border-[rgba(220,38,38,0.22)] bg-[var(--red-soft)] text-red-v' : 'border-[rgba(37,99,235,0.20)] bg-[var(--blue-soft)] text-blue-v'
      }`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}
