const PRELOAD_RELOAD_KEY = 'carecommand:preload-reload';

type PreloadErrorEvent = Event & { payload?: unknown };

function failureSignature(payload: unknown): string {
  if (payload instanceof Error) return `${payload.name}:${payload.message}`;
  return String(payload ?? 'unknown-preload-error');
}

/**
 * A user can keep an old application shell open while a deployment replaces
 * its hashed route chunks. Vite reports that exact stale-chunk condition with
 * `vite:preloadError`. Reload once so the browser receives the current shell.
 * Remember the failed asset signature in session storage so a genuinely broken
 * deployment cannot trap the user in an infinite refresh loop.
 */
export function shouldReloadPreloadFailure(storage: Storage, payload: unknown): boolean {
  const signature = failureSignature(payload);
  if (storage.getItem(PRELOAD_RELOAD_KEY) === signature) return false;
  storage.setItem(PRELOAD_RELOAD_KEY, signature);
  return true;
}

export function installPreloadRecovery(
  target: Pick<Window, 'addEventListener'> = window,
  storage: Storage = window.sessionStorage,
  reload: () => void = () => window.location.reload(),
) {
  target.addEventListener('vite:preloadError', event => {
    const preloadEvent = event as PreloadErrorEvent;
    if (!shouldReloadPreloadFailure(storage, preloadEvent.payload)) return;
    // The reload is now responsible for rendering the route. Suppress Vite's
    // rejected dynamic import so React never replaces the app with a blank root.
    event.preventDefault();
    reload();
  });
}

