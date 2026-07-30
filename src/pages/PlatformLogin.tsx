import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ShieldCheck, Loader2, Lock, Mail, KeyRound, Building2, Activity, Layers, Eye, EyeOff } from 'lucide-react';
import { platformAdmin, setPlatformToken } from '../lib/platformAdmin';

export default function PlatformLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setError(null);
    try {
      if (mfaToken) {
        const r = await platformAdmin.mfaVerify(code, mfaToken);
        setPlatformToken(r.token);
        navigate('/platform');
        return;
      }
      const r = await platformAdmin.login(email, password);
      if (r.mfaRequired && r.mfaToken) { setMfaToken(r.mfaToken); return; }
      if (r.token) { setPlatformToken(r.token); navigate('/platform'); }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-[var(--bg)]">
      {/* ── Brand / intelligence panel ─────────────────────────── */}
      <aside className="platform-brand relative hidden lg:flex flex-col justify-between overflow-hidden p-12">
        <div className="platform-brand-glow pointer-events-none absolute inset-0" />
        <div className="relative flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[var(--indigo-soft)] ring-1 ring-[var(--indigo-mid)] grid place-items-center">
            <ShieldCheck className="w-5 h-5 text-indigo" />
          </div>
          <div>
            <p className="text-sm font-bold tracking-tight text-t1">CareCommand</p>
            <p className="text-[11px] text-t3 font-medium tracking-wide uppercase">Operator Control Plane</p>
          </div>
        </div>

        <div className="relative space-y-6 max-w-md">
          <h1 className="text-3xl font-bold leading-tight tracking-tight text-t1">
            The command center for your entire clinic network.
          </h1>
          <p className="text-sm text-t2 leading-relaxed">
            Provision tenants, govern subscriptions and entitlements, and monitor platform health — all from a single, audited operator console.
          </p>
          <div className="grid gap-3 pt-2">
            {[
              { icon: Building2, label: 'Multi-tenant provisioning', sub: 'Onboard and configure clinics in seconds' },
              { icon: Layers, label: 'Subscription & entitlement control', sub: 'Plans, add-ons, and feature governance' },
              { icon: Activity, label: 'Live platform observability', sub: 'Usage, status, and a full audit trail' },
            ].map(f => (
              <div key={f.label} className="flex items-start gap-3 rounded-xl border border-[var(--b1)] bg-white/70 backdrop-blur px-4 py-3 shadow-sm">
                <div className="w-8 h-8 rounded-lg bg-[var(--indigo-soft)] ring-1 ring-[var(--indigo-mid)] grid place-items-center shrink-0"><f.icon className="w-4 h-4 text-indigo" /></div>
                <div>
                  <p className="text-[13px] font-semibold text-t1">{f.label}</p>
                  <p className="text-[11px] text-t3">{f.sub}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <p className="relative text-[11px] text-t3">© {new Date().getFullYear()} CareCommand · Enterprise Operations</p>
      </aside>

      {/* ── Sign-in form ───────────────────────────────────────── */}
      <main className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm">
          <div className="lg:hidden mb-8 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo grid place-items-center"><ShieldCheck className="w-5 h-5 text-white" /></div>
            <div><p className="text-base font-bold text-t1">CareCommand</p><p className="text-[11px] text-t3">Operator Control Plane</p></div>
          </div>

          <div className="mb-7">
            <h2 className="text-xl font-bold text-t1 tracking-tight">{mfaToken ? 'Two-factor verification' : 'Operator sign in'}</h2>
            <p className="text-[13px] text-t3 mt-1">{mfaToken ? 'Enter the code from your authenticator app.' : 'Secure access for platform operators only.'}</p>
          </div>

          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-xl border border-[rgba(220,38,38,0.18)] bg-red-soft px-3.5 py-2.5 text-[13px] text-red-v">
              <Lock className="w-4 h-4 mt-0.5 shrink-0" /><span>{error}</span>
            </div>
          )}

          <div className="space-y-4">
            {!mfaToken ? (
              <>
                <Field label="Email" icon={<Mail className="w-4 h-4 text-t3" />}>
                  <input className="w-full bg-transparent text-sm text-t1 outline-none placeholder:text-t3" type="email"
                    value={email} onChange={e => setEmail(e.target.value)} placeholder="operator@carecommand.ai" autoComplete="username" autoFocus />
                </Field>
                <Field label="Password" icon={<Lock className="w-4 h-4 text-t3" />}>
                  <input className="w-full bg-transparent text-sm text-t1 outline-none placeholder:text-t3" type={showPw ? 'text' : 'password'}
                    value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()}
                    placeholder="••••••••••••" autoComplete="current-password" />
                  <button type="button" onClick={() => setShowPw(v => !v)} className="text-t3 hover:text-t1 transition shrink-0"
                    aria-label={showPw ? 'Hide password' : 'Show password'} title={showPw ? 'Hide password' : 'Show password'}>
                    {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </Field>
              </>
            ) : (
              <Field label="Authentication code" icon={<KeyRound className="w-4 h-4 text-t3" />}>
                <input className="w-full bg-transparent text-sm text-t1 outline-none tracking-[0.3em] placeholder:tracking-normal placeholder:text-t3"
                  inputMode="numeric" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={e => e.key === 'Enter' && submit()} placeholder="123456" autoFocus />
              </Field>
            )}

            <button type="button" disabled={busy} onClick={submit}
              className="w-full rounded-xl bg-[var(--indigo)] px-4 py-3 text-sm font-semibold text-white shadow-sm hover:opacity-90 active:scale-[0.99] transition disabled:opacity-50">
              {busy ? <Loader2 className="inline w-4 h-4 animate-spin" /> : mfaToken ? 'Verify & continue' : 'Sign in'}
            </button>

            {mfaToken && (
              <button type="button" onClick={() => { setMfaToken(null); setCode(''); setError(null); }}
                className="w-full text-center text-xs font-semibold text-t3 hover:text-t1 transition">Back to sign in</button>
            )}
          </div>

          <div className="mt-8 flex items-center gap-2 rounded-xl bg-[var(--s2)] border border-[var(--b1)] px-3.5 py-2.5">
            <ShieldCheck className="w-4 h-4 text-emerald-v shrink-0" />
            <p className="text-[11px] text-t3 leading-snug">Platform operators only. For pilot handoff, create the clinic in Control Tower and share the owner login shown after provisioning.</p>
          </div>
        </div>
      </main>
    </div>
  );
}

function Field({ label, icon, children }: { label: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-wide text-t3">{label}</span>
      <div className="flex items-center gap-2.5 rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-3.5 py-3 focus-within:border-[var(--indigo)] focus-within:ring-2 focus-within:ring-[var(--indigo-soft)] transition">
        {icon}{children}
      </div>
    </label>
  );
}
