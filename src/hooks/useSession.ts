import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiRequest } from '../lib/api';
import { authEventName, clearSession, login, logout, type AuthChangeState, type AuthMeResponse, type SessionUser } from '../lib/session';

// Shared by every useSession instance in this browser tab. A cleared session
// invalidates every hydrate that began under the previous generation, even if
// its /auth/me response arrives after logout.
let authGeneration = 0;

export function useSession(options: { hydrate?: boolean } = {}) {
  const shouldHydrate = options.hydrate ?? true;
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(shouldHydrate);

  const hydrate = useCallback(async () => {
    const generation = authGeneration;
    try {
      const response = await apiRequest<AuthMeResponse>('/v1/auth/me');
      if (generation !== authGeneration) return;
      setUser({ ...response.user, effectivePermissions: response.access.permissions });
    } catch (error) {
      if (generation !== authGeneration) return;
      // Only a real authentication failure means "signed out". Treating every
      // failure as unauthenticated meant a transient 5xx or a dropped
      // connection cleared the session and bounced staff to /login in the
      // middle of a task. On a non-auth error keep whatever session we already
      // have; the request layer already handles 401 refresh and cleanup.
      const status = error instanceof ApiError ? error.status : 0;
      if (status === 401 || status === 403) setUser(null);
    } finally {
      if (generation === authGeneration) setLoading(false);
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

    const handleAuthChange = (event: Event) => {
      const state = (event as CustomEvent<{ state?: AuthChangeState }>).detail?.state;
      // Logout is a definitive local boundary. Rehydrating every independent
      // useSession instance here races the cookie-clearing response and can
      // resurrect a protected shell from the just-revoked session. Clear every
      // consumer synchronously; initial mount still performs normal refresh-
      // cookie hydration, and "available" events still refresh user/grants.
      if (state === 'cleared') {
        authGeneration += 1;
        setUser(null);
        setLoading(false);
        return;
      }
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
