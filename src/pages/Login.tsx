import { useState, type FormEvent, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Lock, Mail, ShieldCheck, KeyRound, Smartphone } from 'lucide-react';
import { useSession } from '../hooks/useSession';
import { mfaSetupWithToken, mfaVerifyWithToken, requestPasswordReset, confirmPasswordReset } from '../lib/session';

type Mode = 'login' | 'mfa' | 'mfaSetup' | 'reset' | 'resetConfirm' | 'expired';

const fieldWrap = 'flex items-center gap-2 rounded-2xl border border-[var(--b1)] bg-[var(--s1)] px-3 py-2.5';
const fieldInput = 'w-full bg-transparent text-sm text-t1 outline-none placeholder:text-t3';
const primaryBtn = 'w-full rounded-2xl bg-[var(--indigo)] px-4 py-3 text-sm font-semibold text-white hover:opacity-90 transition disabled:opacity-50';

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { signIn } = useSession();

  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('admin@carecommand.ai');
  const [password, setPassword] = useState('ChangeMe123!');
  const [code, setCode] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [mfaToken, setMfaToken] = useState('');
  const [mfaSetupData, setMfaSetupData] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  function goHome() {
    const destination = (location.state as { from?: string } | null)?.from ?? '/';
    navigate(destination, { replace: true });
  }

  async function run(fn: () => Promise<void>) {
    setLoading(true); setError(null);
    try { await fn(); } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setLoading(false); }
  }

  const onLogin = (e: FormEvent) => { e.preventDefault(); void run(async () => {
    const result = await signIn(email.trim().toLowerCase(), password);
    if (result.kind === 'session') return goHome();
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
    const res = await requestPasswordReset(email.trim().toLowerCase());
    setInfo(res.message);
    if (res.devToken) setResetToken(res.devToken); // dev-only convenience; absent in production
    setMode('resetConfirm');
  }); };

  const onResetConfirm = (e: FormEvent) => { e.preventDefault(); void run(async () => {
    await confirmPasswordReset(resetToken.trim(), newPassword);
    setInfo('Password reset. Please sign in with your new password.');
    setNewPassword(''); setPassword(''); setMode('login');
  }); };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8 bg-[var(--s1)]">
      <div className="w-full max-w-md rounded-3xl border border-[var(--b1)] bg-[var(--s2)] p-6 shadow-xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="logo-icon w-10 h-10 rounded-2xl flex items-center justify-center shrink-0"><ShieldCheck className="w-5 h-5 text-white" /></div>
          <div>
            <p className="text-lg font-bold text-t1">CareCommand AI</p>
            <p className="text-xs text-t3">Operational platform login</p>
          </div>
        </div>

        {error && <Banner tone="red">{error}</Banner>}
        {info && !error && <Banner tone="blue">{info}</Banner>}

        {mode === 'login' && (
          <form onSubmit={onLogin} className="space-y-4">
            <Labeled label="Email" icon={<Mail className="w-4 h-4 text-t3 shrink-0" />}>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} className={fieldInput} placeholder="you@clinic.com" autoComplete="email" />
            </Labeled>
            <Labeled label="Password" icon={<Lock className="w-4 h-4 text-t3 shrink-0" />}>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} className={fieldInput} placeholder="••••••••" autoComplete="current-password" />
            </Labeled>
            <button type="submit" disabled={loading} className={primaryBtn}>{loading ? 'Signing in…' : 'Sign in'}</button>
            <button type="button" onClick={() => { setError(null); setInfo(null); setMode('reset'); }} className="w-full text-center text-xs font-semibold text-indigo hover:underline">Forgot password?</button>
          </form>
        )}

        {(mode === 'mfa' || mode === 'mfaSetup') && (
          <form onSubmit={onMfaVerify} className="space-y-4">
            {mode === 'mfaSetup' && mfaSetupData && (
              <div className="rounded-2xl border border-[var(--b1)] bg-[var(--s1)] p-3 space-y-2">
                <p className="text-xs font-semibold text-t2 inline-flex items-center gap-1.5"><Smartphone className="w-3.5 h-3.5" /> Set up your authenticator</p>
                <p className="text-[11px] text-t3">Your organization requires MFA. Add this secret to an authenticator app (Google Authenticator, 1Password, Authy), then enter the 6-digit code.</p>
                <code className="block break-all rounded-lg bg-[var(--s2)] px-2 py-1.5 text-[11px] font-mono text-t1">{mfaSetupData.secret}</code>
              </div>
            )}
            {mode === 'mfa' && <p className="text-sm text-t2">Enter the 6-digit code from your authenticator app.</p>}
            <Labeled label="Verification code" icon={<KeyRound className="w-4 h-4 text-t3 shrink-0" />}>
              <input inputMode="numeric" value={code} onChange={e => setCode(e.target.value)} className={fieldInput} placeholder="123456" autoComplete="one-time-code" maxLength={6} />
            </Labeled>
            <button type="submit" disabled={loading} className={primaryBtn}>{loading ? 'Verifying…' : 'Verify & continue'}</button>
            <button type="button" onClick={() => { setMode('login'); setCode(''); }} className="w-full text-center text-xs font-semibold text-t3 hover:underline">Back to sign in</button>
          </form>
        )}

        {mode === 'reset' && (
          <form onSubmit={onResetRequest} className="space-y-4">
            <p className="text-sm text-t2">Enter your email to start a password reset.</p>
            <Labeled label="Email" icon={<Mail className="w-4 h-4 text-t3 shrink-0" />}>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} className={fieldInput} placeholder="you@clinic.com" autoComplete="email" />
            </Labeled>
            <button type="submit" disabled={loading} className={primaryBtn}>{loading ? 'Sending…' : 'Send reset'}</button>
            <button type="button" onClick={() => { setError(null); setInfo(null); setMode('login'); }} className="w-full text-center text-xs font-semibold text-t3 hover:underline">Back to sign in</button>
          </form>
        )}

        {mode === 'resetConfirm' && (
          <form onSubmit={onResetConfirm} className="space-y-4">
            <p className="text-sm text-t2">Enter the reset token and choose a new password.</p>
            <Labeled label="Reset token" icon={<KeyRound className="w-4 h-4 text-t3 shrink-0" />}>
              <input value={resetToken} onChange={e => setResetToken(e.target.value)} className={fieldInput} placeholder="paste token" />
            </Labeled>
            <Labeled label="New password" icon={<Lock className="w-4 h-4 text-t3 shrink-0" />}>
              <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} className={fieldInput} placeholder="At least 8 characters" autoComplete="new-password" />
            </Labeled>
            <button type="submit" disabled={loading} className={primaryBtn}>{loading ? 'Updating…' : 'Reset password'}</button>
            <button type="button" onClick={() => { setError(null); setInfo(null); setMode('login'); }} className="w-full text-center text-xs font-semibold text-t3 hover:underline">Back to sign in</button>
          </form>
        )}

        {mode === 'expired' && (
          <div className="space-y-4">
            <p className="text-sm text-t2">{info ?? 'Your password has expired and must be reset before signing in.'}</p>
            <button type="button" onClick={() => { setError(null); setInfo(null); setMode('reset'); }} className={primaryBtn}>Reset password</button>
          </div>
        )}
      </div>
    </div>
  );
}

function Labeled({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold text-t2">{label}</span>
      <div className={fieldWrap}>{icon}{children}</div>
    </label>
  );
}

function Banner({ tone, children }: { tone: 'red' | 'blue'; children: ReactNode }) {
  const cls = tone === 'red' ? 'border-[var(--red-soft)] bg-[var(--red-soft)] text-red-v' : 'border-[var(--b1)] bg-[var(--blue-soft)] text-blue-v';
  return <div className={`mb-4 rounded-2xl border px-4 py-3 text-sm ${cls}`}>{children}</div>;
}
