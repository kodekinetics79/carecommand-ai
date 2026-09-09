import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import {
  ApiError,
  patientLogout,
  patientMe,
  patientRequestLink,
  patientSignup,
  patientVerify,
  staffLogin,
  staffLogout,
  staffMe,
  staffMfaSetup,
  staffMfaVerify,
  staffRefresh,
  type StaffUser,
} from './api';

const STORAGE_KEY = 'carecommand.mobile.session.v1';

type PatientSession = {
  kind: 'patient';
  token: string;
  displayName: string;
  clinicName: string;
  expiresAt: number;
};

type StaffSession = {
  kind: 'staff';
  token: string;
  csrfToken: string;
  user: StaffUser;
};

export type Session = PatientSession | StaffSession;
export type MfaState = {
  token: string;
  mode: 'challenge' | 'setup';
  secret?: string;
  otpauthUri?: string;
};

type AuthContextValue = {
  loading: boolean;
  session: Session | null;
  mfa: MfaState | null;
  error: string | null;
  signInStaff(input: { email: string; password: string; tenantSlug?: string }): Promise<void>;
  verifyMfa(code: string): Promise<void>;
  requestPatientLink(input: { clinicSlug: string; email?: string; phone?: string }, signup?: boolean): Promise<string>;
  verifyPatientToken(token: string): Promise<void>;
  signOut(): Promise<void>;
  clearError(): void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

async function persist(session: Session | null) {
  if (!session) return SecureStore.deleteItemAsync(STORAGE_KEY);
  return SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(session), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

function friendly(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Your sign-in could not be verified. Check your details or request a fresh link.';
    if (error.status === 403) return 'This account does not currently have access.';
    if (error.status === 423) return 'This account is temporarily locked. Try again later.';
    if (error.status === 429) return 'Too many attempts. Please wait a moment and try again.';
    return error.message;
  }
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [mfa, setMfa] = useState<MfaState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const saveSession = useCallback(async (next: Session | null) => {
    setSession(next);
    await persist(next);
  }, []);

  const restore = useCallback(async () => {
    try {
      const raw = await SecureStore.getItemAsync(STORAGE_KEY);
      if (!raw) return;
      const stored = JSON.parse(raw) as Session;
      if (stored.kind === 'patient') {
        if (stored.expiresAt <= Date.now()) { await persist(null); return; }
        const me = await patientMe(stored.token);
        await saveSession({ ...stored, displayName: me.displayName, clinicName: me.clinicName });
        return;
      }

      try {
        const me = await staffMe(stored.token);
        await saveSession({ ...stored, user: me.user });
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 401 || !stored.csrfToken) throw e;
        const refreshed = await staffRefresh(stored.csrfToken);
        await saveSession({ kind: 'staff', token: refreshed.accessToken, csrfToken: refreshed.csrfToken, user: refreshed.user });
      }
    } catch {
      await persist(null);
      setSession(null);
    } finally {
      setLoading(false);
    }
  }, [saveSession]);

  useEffect(() => { void restore(); }, [restore]);

  const signInStaff = useCallback(async (input: { email: string; password: string; tenantSlug?: string }) => {
    setError(null);
    setMfa(null);
    try {
      const result = await staffLogin(input);
      if ('status' in result && (result.status === 'mfa_required' || result.status === 'mfa_setup_required')) {
        if (result.status === 'mfa_setup_required') {
          const setup = await staffMfaSetup(result.mfaToken);
          setMfa({ token: result.mfaToken, mode: 'setup', secret: setup.secret, otpauthUri: setup.otpauthUri });
        } else {
          setMfa({ token: result.mfaToken, mode: 'challenge' });
        }
        return;
      }
      await saveSession({ kind: 'staff', token: result.accessToken, csrfToken: result.csrfToken, user: result.user });
    } catch (e) {
      setError(friendly(e));
      throw e;
    }
  }, [saveSession]);

  const verifyMfa = useCallback(async (code: string) => {
    if (!mfa) return;
    setError(null);
    try {
      const result = await staffMfaVerify(mfa.token, code.trim());
      if (!result.accessToken || !result.csrfToken || !result.user) {
        throw new Error('MFA was enabled. Please sign in again to continue.');
      }
      await saveSession({ kind: 'staff', token: result.accessToken, csrfToken: result.csrfToken, user: result.user });
      setMfa(null);
    } catch (e) {
      setError(friendly(e));
      throw e;
    }
  }, [mfa, saveSession]);

  const requestPatientLink = useCallback(async (input: { clinicSlug: string; email?: string; phone?: string }, signup = false) => {
    setError(null);
    try {
      const result = signup ? await patientSignup(input) : await patientRequestLink(input);
      return result.message;
    } catch (e) {
      setError(friendly(e));
      throw e;
    }
  }, []);

  const verifyPatientToken = useCallback(async (token: string) => {
    setError(null);
    try {
      const result = await patientVerify(token.trim());
      const me = await patientMe(result.token);
      await saveSession({
        kind: 'patient', token: result.token, displayName: me.displayName,
        clinicName: me.clinicName, expiresAt: Date.now() + result.expiresInMinutes * 60_000,
      });
    } catch (e) {
      setError(friendly(e));
      throw e;
    }
  }, [saveSession]);

  const signOut = useCallback(async () => {
    const current = session;
    setMfa(null);
    setError(null);
    try {
      if (current?.kind === 'patient') await patientLogout(current.token);
      if (current?.kind === 'staff') await staffLogout(current.token, current.csrfToken);
    } catch {
      // Local sign-out must still complete if the network or server is unavailable.
    } finally {
      await saveSession(null);
    }
  }, [session, saveSession]);

  const value = useMemo<AuthContextValue>(() => ({
    loading, session, mfa, error, signInStaff, verifyMfa, requestPatientLink,
    verifyPatientToken, signOut, clearError: () => setError(null),
  }), [loading, session, mfa, error, signInStaff, verifyMfa, requestPatientLink, verifyPatientToken, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
