import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiRequest } from '../lib/api';
import { authEventName, clearSession, login, logout, type AuthMeResponse, type SessionUser } from '../lib/session';

export function useSession(options: { hydrate?: boolean } = {}) {
  const shouldHydrate = options.hydrate ?? true;
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(shouldHydrate);

  const hydrate = useCallback(async () => {
    try {
      const response = await apiRequest<AuthMeResponse>('/v1/auth/me');
      setUser({ ...response.user, effectivePermissions: response.access.permissions });
    } catch (error) {
      // Only a real authentication failure means "signed out". Treating every
      // failure as unauthenticated meant a transient 5xx or a dropped
      // connection cleared the session and bounced staff to /login in the
      // middle of a task. On a non-auth error keep whatever session we already
      // have; the request layer already handles 401 refresh and cleanup.
      const status = error instanceof ApiError ? error.status : 0;
      if (status === 401 || status === 403) setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!shouldHydrate) {
      return;
    }
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
  }, [hydrate, shouldHydrate]);

  const signIn = async (email: string, password: string, tenantSlug?: string) => {
    const result = await login(email, password, tenantSlug);
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
