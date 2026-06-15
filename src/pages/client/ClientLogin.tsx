import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Mail, Building2, KeyRound } from 'lucide-react';
import Logo from '../../components/ui/Logo';
import { portalClient, setPortalToken } from '../../lib/portalClient';

export default function ClientLogin() {
  const navigate = useNavigate();
  const [step, setStep] = useState<'request' | 'verify'>('request');
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [clinicSlug, setClinicSlug] = useState('harley-street-medical');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function request() {
    setBusy(true); setError(null); setMsg(null);
    try {
      const r = mode === 'signup'
        ? await portalClient.signup(clinicSlug.trim(), email.trim())
        : await portalClient.requestLink(clinicSlug.trim(), email.trim());
      setMsg(r.message);
      if (r.devToken) { setToken(r.devToken); } // dev convenience only
      setStep('verify');
    } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong'); }
    finally { setBusy(false); }
  }
  async function verify() {
    setBusy(true); setError(null);
    try { const r = await portalClient.verify(token.trim()); setPortalToken(r.token); navigate('/client'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Invalid or expired link'); }
    finally { setBusy(false); }
  }

  const field = 'flex items-center gap-2.5 rounded-xl border border-[var(--b1)] bg-[var(--s1)] px-3.5 py-3 focus-within:border-[var(--indigo)] focus-within:ring-2 focus-within:ring-[var(--indigo-soft)] transition';
  const input = 'w-full bg-transparent text-sm text-t1 outline-none placeholder:text-t3';

  return (
    <div className="min-h-screen grid place-items-center bg-[var(--bg)] p-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 mb-7">
          <Logo size={44} className="shrink-0 logo-drop" />
          <div><p className="text-base font-bold text-t1">Patient Portal</p><p className="text-[12px] text-t3">Your appointments, intake & care</p></div>
        </div>

        <div className="glass-card p-6">
          <h1 className="text-lg font-bold text-t1">{step === 'verify' ? 'Enter your link code' : mode === 'signup' ? 'Create your account' : 'Sign in'}</h1>
          <p className="text-[13px] text-t3 mt-1">{step === 'verify' ? 'Paste the code from your sign-in link.' : mode === 'signup' ? 'Enter the email your clinic has on file — we’ll send a one-time code to confirm it’s you.' : 'We’ll send a secure one-time sign-in link.'}</p>

          {error && <div className="mt-4 rounded-xl bg-red-soft border border-[rgba(220,38,38,0.18)] px-3.5 py-2.5 text-[13px] text-red-v">{error}</div>}
          {msg && step === 'verify' && <div className="mt-4 rounded-xl bg-[var(--blue-soft)] border border-[var(--b1)] px-3.5 py-2.5 text-[12px] text-blue-v">{msg}</div>}

          {step === 'request' ? (
            <div className="mt-5 space-y-3">
              <label className="block space-y-1.5"><span className="text-[11px] font-bold uppercase tracking-wide text-t3">Clinic</span>
                <div className={field}><Building2 className="w-4 h-4 text-t3" /><input className={input} value={clinicSlug} onChange={e => setClinicSlug(e.target.value)} placeholder="your-clinic" autoComplete="off" /></div></label>
              <label className="block space-y-1.5"><span className="text-[11px] font-bold uppercase tracking-wide text-t3">Email</span>
                <div className={field}><Mail className="w-4 h-4 text-t3" /><input className={input} type="email" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === 'Enter' && email && request()} placeholder="you@email.com" autoComplete="email" /></div></label>
              <button type="button" disabled={busy || !email.trim() || !clinicSlug.trim()} onClick={request} className="w-full rounded-xl bg-[var(--indigo)] px-4 py-3 text-sm font-semibold text-white shadow-sm hover:opacity-90 active:scale-[0.99] transition disabled:opacity-50">
                {busy ? <Loader2 className="inline w-4 h-4 animate-spin" /> : mode === 'signup' ? 'Create account' : 'Send sign-in link'}
              </button>
              <button type="button" onClick={() => { setMode(m => m === 'signup' ? 'signin' : 'signup'); setError(null); setMsg(null); }} className="w-full text-center text-[12px] font-semibold text-t3 hover:text-indigo transition">
                {mode === 'signup' ? 'Already have an account? Sign in' : 'New patient? Create an account'}
              </button>
            </div>
          ) : (
            <div className="mt-5 space-y-3">
              <label className="block space-y-1.5"><span className="text-[11px] font-bold uppercase tracking-wide text-t3">Sign-in code</span>
                <div className={field}><KeyRound className="w-4 h-4 text-t3" /><input className={input} value={token} onChange={e => setToken(e.target.value)} onKeyDown={e => e.key === 'Enter' && token && verify()} placeholder="paste your code" autoFocus /></div></label>
              <button type="button" disabled={busy || !token.trim()} onClick={verify} className="w-full rounded-xl bg-[var(--indigo)] px-4 py-3 text-sm font-semibold text-white shadow-sm hover:opacity-90 active:scale-[0.99] transition disabled:opacity-50">
                {busy ? <Loader2 className="inline w-4 h-4 animate-spin" /> : 'Continue'}
              </button>
              <button type="button" onClick={() => { setStep('request'); setToken(''); setError(null); }} className="w-full text-center text-xs font-semibold text-t3 hover:text-t1 transition">Use a different email</button>
            </div>
          )}
        </div>
        <p className="text-center text-[11px] text-t3 mt-4">Protected health information. Do not share your sign-in link.</p>
      </div>
    </div>
  );
}
