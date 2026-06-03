import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Lock, Mail, ShieldCheck } from 'lucide-react';
import { useSession } from '../hooks/useSession';

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { signIn } = useSession();
  const [email, setEmail] = useState('admin@carecommand.ai');
  const [password, setPassword] = useState('ChangeMe123!');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await signIn(email.trim().toLowerCase(), password);
      const destination = (location.state as { from?: string } | null)?.from ?? '/';
      navigate(destination, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8 bg-[var(--s1)]">
      <div className="w-full max-w-md rounded-3xl border border-[var(--b1)] bg-[var(--s2)] p-6 shadow-xl">
        <div className="mb-6">
          <div className="mb-3 flex items-center gap-3">
            <div className="logo-icon w-10 h-10 rounded-2xl flex items-center justify-center shrink-0">
              <ShieldCheck className="w-5 h-5 text-white" />
            </div>
            <div>
              <p className="text-lg font-bold text-t1">CareCommand AI</p>
              <p className="text-xs text-t3">Operational platform login</p>
            </div>
          </div>
          <p className="text-sm text-t2 leading-relaxed">
            Sign in with a clinic account to access the MVP workspace.
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded-2xl border border-[var(--red-soft)] bg-[var(--red-soft)] px-4 py-3 text-sm text-red-v">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-t2">Email</span>
            <div className="flex items-center gap-2 rounded-2xl border border-[var(--b1)] bg-[var(--s1)] px-3 py-2.5">
              <Mail className="w-4 h-4 text-t3 shrink-0" />
              <input
                type="email"
                value={email}
                onChange={event => setEmail(event.target.value)}
                className="w-full bg-transparent text-sm text-t1 outline-none placeholder:text-t3"
                placeholder="admin@carecommand.ai"
                autoComplete="email"
              />
            </div>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold text-t2">Password</span>
            <div className="flex items-center gap-2 rounded-2xl border border-[var(--b1)] bg-[var(--s1)] px-3 py-2.5">
              <Lock className="w-4 h-4 text-t3 shrink-0" />
              <input
                type="password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                className="w-full bg-transparent text-sm text-t1 outline-none placeholder:text-t3"
                placeholder="••••••••"
                autoComplete="current-password"
              />
            </div>
          </label>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-2xl bg-[var(--indigo)] px-4 py-3 text-sm font-semibold text-white hover:opacity-90 transition disabled:opacity-50"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
