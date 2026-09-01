import { describe, expect, it, vi } from 'vitest';
import { installPreloadRecovery, shouldReloadPreloadFailure } from './preloadRecovery';

describe('deployment chunk recovery', () => {
  it('reloads once per failed chunk signature and prevents a refresh loop', () => {
    const storage = window.sessionStorage;
    storage.clear();

    expect(shouldReloadPreloadFailure(storage, new Error('missing IntakeQueue-old.js'))).toBe(true);
    expect(shouldReloadPreloadFailure(storage, new Error('missing IntakeQueue-old.js'))).toBe(false);
    expect(shouldReloadPreloadFailure(storage, new Error('missing FrontDesk-new.js'))).toBe(true);
  });

  it('suppresses the rejected import only when it can perform the recovery reload', () => {
    const storage = window.sessionStorage;
    storage.clear();
    const reload = vi.fn();
    installPreloadRecovery(window, storage, reload);

    const first = new Event('vite:preloadError', { cancelable: true }) as Event & { payload?: unknown };
    first.payload = new Error('Failed to fetch dynamically imported module: IntakeQueue-old.js');
    window.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    const repeat = new Event('vite:preloadError', { cancelable: true }) as Event & { payload?: unknown };
    repeat.payload = new Error('Failed to fetch dynamically imported module: IntakeQueue-old.js');
    window.dispatchEvent(repeat);
    expect(repeat.defaultPrevented).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

