import { useState, type FormEvent, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Lock, Mail, KeyRound, Smartphone, Eye, EyeOff, ShieldCheck, Users, Bot, TrendingUp, CalendarDays, BadgeCheck, CreditCard } from 'lucide-react';
import { useSession } from '../hooks/useSession';
import Logo from '../components/ui/Logo';
import { mfaSetupWithToken, mfaVerifyWithToken, requestPasswordReset, confirmPasswordReset } from '../lib/session';

type Mode = 'login' | 'mfa' | 'mfaSetup' | 'reset' | 'resetConfirm' | 'expired';
const REMEMBER_KEY = 'cc_remember_email';

const fieldWrap = 'flex items-center gap-2.5 rounded-lg border border-[var(--b1)] bg-[var(--s1)] px-3.5 py-2.5 focus-within:border-[var(--indigo)] focus-within:ring-2 focus-within:ring-[var(--indigo-soft)] transition';
const fieldInput = 'w-full bg-transparent text-sm text-t1 outline-none placeholder:text-t3';
const primaryBtn = 'w-full rounded-lg bg-[var(--indigo)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:opacity-90 active:scale-[0.99] transition disabled:opacity-50';
// One repeating ECG/heart-monitor beat, 440 units wide, baseline y=40 (tiled + scrolled for a live trace).
const ECG_PATH = 'M0 40 H70 l6 -3 l4 6 l6 -3 H150 l8 0 l4 -22 l6 40 l5 -18 H250 l6 0 l5 -4 l6 4 H440';

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { signIn } = useSession({ hydrate: false });

  // "Remember me" pre-fills the email on return (convenience only; no token change).
  const rememberedEmail = typeof localStorage !== 'undefined' ? localStorage.getItem(REMEMBER_KEY) : null;
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState(rememberedEmail ?? '');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(rememberedEmail !== null);
  const [code, setCode] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [mfaToken, setMfaToken] = useState('');
  const [mfaSetupData, setMfaSetupData] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [showPw, setShowPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);

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
    const cleanEmail = email.trim().toLowerCase();
    if (rememberMe) localStorage.setItem(REMEMBER_KEY, cleanEmail); else localStorage.removeItem(REMEMBER_KEY);
    const result = await signIn(cleanEmail, password);
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
    <div className="min-h-screen grid lg:grid-cols-[1.05fr_1fr] bg-[var(--bg)]">
      {/* ── Brand panel — light, premium, on-theme ───────────── */}
      <aside className="login-panel relative hidden lg:flex flex-col justify-center overflow-hidden px-14 py-12">
        <div className="login-panel-accent pointer-events-none absolute inset-0" aria-hidden="true" />
        <span className="login-orb login-orb-1" aria-hidden="true" />
        <span className="login-orb login-orb-2" aria-hidden="true" />
        <div className="login-grid" aria-hidden="true" />
        {/* Live ECG / heart-monitor trace */}
        <div className="login-ecg" aria-hidden="true">
          <svg viewBox="0 0 1320 80" className="login-ecg-svg" preserveAspectRatio="none">
            <g className="ecg-scroll">
              <path d={ECG_PATH} />
              <path d={ECG_PATH} transform="translate(440 0)" />
              <path d={ECG_PATH} transform="translate(880 0)" />
            </g>
          </svg>
        </div>

        {/* Prominent brand + tagline, centered, with product feature cards */}
        <div className="relative w-full max-w-xl mx-auto lg:pl-6 xl:pl-12">
          <div className="flex items-center gap-4 animate-fade-up">
            <Logo size={56} glow className="shrink-0 logo-drop" />
            <div>
              <p className="text-[2.1rem] font-extrabold text-t1 leading-none tracking-tight">CareCommand <span className="text-indigo">AI</span></p>
              <p className="text-[12px] font-bold text-indigo uppercase tracking-[0.22em] mt-2.5">Clinic Operating System</p>
            </div>
          </div>

          <h1 className="text-[1.6rem] font-bold text-t1 leading-snug tracking-tight mt-8 animate-fade-up login-rise-1">
            Run your entire clinic from <span className="text-indigo">one command center.</span>
          </h1>
          <p className="text-[13.5px] text-t2 leading-relaxed mt-2.5 max-w-lg animate-fade-up login-rise-2">
            Scheduling, revenue protection, patient growth, insurance, and an AI front desk — unified in one secure platform.
          </p>

          <div className="grid grid-cols-2 gap-3 mt-7">
            {FEATURES.map((f) => (
              <div key={f.title}
                className="feature-card group animate-fade-up rounded-xl border border-[var(--b1)] bg-gradient-to-b from-white/85 to-white/60 backdrop-blur px-4 py-3.5 shadow-sm">
                <span className={`inline-flex w-9 h-9 rounded-lg items-center justify-center mb-2.5 transition-transform duration-200 group-hover:scale-110 group-hover:-rotate-3 ${f.chip}`}>
                  <f.icon className="w-[18px] h-[18px]" aria-hidden="true" />
                </span>
                <p className="text-[13px] font-semibold text-t1 leading-tight">{f.title}</p>
                <p className="text-[11.5px] text-t3 leading-snug mt-0.5">{f.sub}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="absolute bottom-6 left-14 right-14 text-[11px] text-t3">
          © {new Date().getFullYear()} CareCommand AI · Powered by{' '}
          <a href="https://kodekinetics.com" target="_blank" rel="noopener noreferrer" className="text-t2 hover:text-indigo transition font-medium">Kode Kinetics</a>
        </div>
      </aside>

      {/* ── Sign-in ──────────────────────────────────────────── */}
      <main className="flex flex-col items-center justify-center px-6 py-10 sm:px-10">
        <div className="w-full max-w-sm">
          <div className="lg:hidden mb-8 flex items-center gap-3">
            <Logo size={38} className="shrink-0" />
            <div>
              <p className="text-[15px] font-bold text-t1 tracking-tight">CareCommand AI</p>
              <p className="text-[11px] text-t3">Clinic Operating System</p>
            </div>
          </div>

          <div className="mb-6">
            <h2 className="text-[1.35rem] font-bold text-t1 tracking-tight">Sign in to your clinic workspace</h2>
            <p className="text-[13px] text-t3 mt-1.5 leading-relaxed">
              Access scheduling, CRM, payments, revenue protection, and operational insights from one secure platform.
            </p>
          </div>

          {error && <Banner tone="red">{error}</Banner>}
          {info && !error && <Banner tone="blue">{info}</Banner>}

          {mode === 'login' && (
            <form onSubmit={onLogin} className="space-y-4">
              <Labeled label="Email" icon={<Mail className="w-4 h-4 text-t3 shrink-0" />}>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} className={fieldInput} placeholder="you@clinic.com" autoComplete="email" autoFocus />
              </Labeled>
              <Labeled label="Password" icon={<Lock className="w-4 h-4 text-t3 shrink-0" />}>
                <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} className={fieldInput} placeholder="••••••••" autoComplete="current-password" />
                <PwReveal shown={showPw} onToggle={() => setShowPw(v => !v)} />
              </Labeled>

              <div className="flex items-center justify-between">
                <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked={rememberMe} onChange={e => setRememberMe(e.target.checked)}
                    className="h-4 w-4 rounded border-[var(--b2)] text-[var(--indigo)] accent-[var(--indigo)] focus-visible:outline-2 focus-visible:outline-[var(--indigo)]" />
                  <span className="text-[13px] text-t2">Remember me</span>
                </label>
                <button type="button" onClick={() => { setError(null); setInfo(null); setMode('reset'); }} className="text-[13px] font-semibold text-indigo hover:underline">Forgot password?</button>
              </div>

              <button type="submit" disabled={loading} className={primaryBtn}>{loading ? 'Signing in…' : 'Sign in'}</button>

              <p className="flex items-center justify-center gap-1.5 text-[11px] text-t3">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-v" aria-hidden="true" /> Protected workspace · Integration-ready · audit-ready
              </p>
            </form>
          )}

          {(mode === 'mfa' || mode === 'mfaSetup') && (
            <form onSubmit={onMfaVerify} className="space-y-4">
              {mode === 'mfaSetup' && mfaSetupData && (
                <div className="rounded-xl border border-[var(--b1)] bg-[var(--s1)] p-3 space-y-2">
                  <p className="text-xs font-semibold text-t2 inline-flex items-center gap-1.5"><Smartphone className="w-3.5 h-3.5" /> Set up your authenticator</p>
                  <p className="text-[11px] text-t3">Your organization requires MFA. Add this secret to an authenticator app (Google Authenticator, 1Password, Authy), then enter the 6-digit code.</p>
                  <code className="block break-all rounded-lg bg-[var(--s2)] px-2 py-1.5 text-[11px] font-mono text-t1">{mfaSetupData.secret}</code>
                </div>
              )}
              {mode === 'mfa' && <p className="text-sm text-t2">Enter the 6-digit code from your authenticator app.</p>}
              <Labeled label="Verification code" icon={<KeyRound className="w-4 h-4 text-t3 shrink-0" />}>
                <input inputMode="numeric" value={code} onChange={e => setCode(e.target.value)} className={fieldInput} placeholder="123456" autoComplete="one-time-code" maxLength={6} autoFocus />
              </Labeled>
              <button type="submit" disabled={loading} className={primaryBtn}>{loading ? 'Verifying…' : 'Verify & continue'}</button>
              <button type="button" onClick={() => { setMode('login'); setCode(''); }} className="w-full text-center text-[13px] font-semibold text-t3 hover:underline">Back to sign in</button>
            </form>
          )}

          {mode === 'reset' && (
            <form onSubmit={onResetRequest} className="space-y-4">
              <p className="text-sm text-t2">Enter your email to start a password reset.</p>
              <Labeled label="Email" icon={<Mail className="w-4 h-4 text-t3 shrink-0" />}>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} className={fieldInput} placeholder="you@clinic.com" autoComplete="email" autoFocus />
              </Labeled>
              <button type="submit" disabled={loading} className={primaryBtn}>{loading ? 'Sending…' : 'Send reset link'}</button>
              <button type="button" onClick={() => { setError(null); setInfo(null); setMode('login'); }} className="w-full text-center text-[13px] font-semibold text-t3 hover:underline">Back to sign in</button>
            </form>
          )}

          {mode === 'resetConfirm' && (
            <form onSubmit={onResetConfirm} className="space-y-4">
              <p className="text-sm text-t2">Enter the reset token and choose a new password.</p>
              <Labeled label="Reset token" icon={<KeyRound className="w-4 h-4 text-t3 shrink-0" />}>
                <input value={resetToken} onChange={e => setResetToken(e.target.value)} className={fieldInput} placeholder="paste token" autoFocus />
              </Labeled>
              <Labeled label="New password" icon={<Lock className="w-4 h-4 text-t3 shrink-0" />}>
                <input type={showNewPw ? 'text' : 'password'} value={newPassword} onChange={e => setNewPassword(e.target.value)} className={fieldInput} placeholder="At least 8 characters" autoComplete="new-password" />
                <PwReveal shown={showNewPw} onToggle={() => setShowNewPw(v => !v)} />
              </Labeled>
              <button type="submit" disabled={loading} className={primaryBtn}>{loading ? 'Updating…' : 'Reset password'}</button>
              <button type="button" onClick={() => { setError(null); setInfo(null); setMode('login'); }} className="w-full text-center text-[13px] font-semibold text-t3 hover:underline">Back to sign in</button>
            </form>
          )}

          {mode === 'expired' && (
            <div className="space-y-4">
              <p className="text-sm text-t2">{info ?? 'Your password has expired and must be reset before signing in.'}</p>
              <button type="button" onClick={() => { setError(null); setInfo(null); setMode('reset'); }} className={primaryBtn}>Reset password</button>
            </div>
          )}

          {/* Footer */}
          <div className="mt-9 pt-5 border-t border-[var(--b1)] flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-[11px] text-t3">
            <a href="#" className="hover:text-t1 transition">Privacy</a>
            <span className="text-[var(--b2)]" aria-hidden="true">·</span>
            <a href="#" className="hover:text-t1 transition">Terms</a>
            <span className="text-[var(--b2)]" aria-hidden="true">·</span>
            <a href="#" className="hover:text-t1 transition">Security</a>
            <span className="text-[var(--b2)]" aria-hidden="true">·</span>
            <a href="mailto:support@carecommand.ai" className="hover:text-t1 transition">Support</a>
          </div>
          <p className="mt-3 text-center text-[11px] text-t3">
            Powered by{' '}
            <a href="https://kodekinetics.com" target="_blank" rel="noopener noreferrer" className="font-medium text-t2 hover:text-t1 transition">Kode Kinetics</a>
          </p>
        </div>
      </main>
    </div>
  );
}

const FEATURES: Array<{ icon: typeof ShieldCheck; title: string; sub: string; chip: string }> = [
  { icon: Bot, title: 'AI Receptionist', sub: 'Answers calls & books 24/7', chip: 'bg-[var(--indigo-soft)] text-indigo' },
  { icon: TrendingUp, title: 'Revenue Leak Recovery', sub: 'Finds & recovers lost revenue', chip: 'bg-emerald-50 text-emerald-600' },
  { icon: CalendarDays, title: 'Smart Scheduling', sub: 'Fills gaps, cuts no-shows', chip: 'bg-blue-50 text-blue-600' },
  { icon: Users, title: 'Patient CRM & Reactivation', sub: 'Win-backs & retention', chip: 'bg-violet-50 text-violet-600' },
  { icon: BadgeCheck, title: 'Insurance & Eligibility', sub: 'Prevent denials before they happen', chip: 'bg-cyan-50 text-cyan-600' },
  { icon: CreditCard, title: 'Payments & Deposits', sub: 'Protect every booking', chip: 'bg-amber-50 text-amber-600' },
];

function PwReveal({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} className="text-t3 hover:text-t1 transition shrink-0 focus-visible:outline-2 focus-visible:outline-[var(--indigo)] rounded"
      aria-label={shown ? 'Hide password' : 'Show password'} title={shown ? 'Hide password' : 'Show password'}>
      {shown ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
    </button>
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
  return <div className={`mb-4 rounded-xl border px-4 py-3 text-sm ${cls}`}>{children}</div>;
}
