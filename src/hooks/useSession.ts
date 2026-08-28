import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../lib/api';
import { authEventName, clearSession, login, logout, type AuthMeResponse, type SessionUser } from '../lib/session';

export function useSession() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  const hydrate = useCallback(async () => {
    try {
      const response = await apiRequest<AuthMeResponse>('/v1/auth/me');
      setUser(response.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      if (!active) return;
      await hydrate();
    })();

    const handleAuthChange = () => {
      void hydrate();
    };

    window.addEventListener(authEventName, handleAuthChange);
    return () => {
      active = false;
      window.removeEventListener(authEventName, handleAuthChange);
    };
  }, [hydrate]);

  const signIn = async (email: string, password: string) => {
    const result = await login(email, password);
    if (result.kind === 'session') {
      setUser(result.user);
      setLoading(false);
    }
    return result;
  };

  const signOut = async () => {
    await logout();
    setUser(null);
    setLoading(false);
  };

  const restore = async () => {
    try {
      await hydrate();
    } catch {
      clearSession();
      setUser(null);
    }
  };

  return {
    user,
    loading,
    isAuthenticated: !!user,
    signIn,
    signOut,
    refreshSession: restore,
  };
}
