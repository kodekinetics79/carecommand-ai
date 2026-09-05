import { beforeEach, describe, expect, it, vi } from 'vitest';
import html from '../../index.html?raw';
import bootstrap from '../../public/app-bootstrap.js?raw';
function setup(storage = window.sessionStorage) {
  let onError!: (event: { target: Element }) => void;
  let onTimeout!: () => void;
  const reload = vi.fn();
  const fakeWindow = {
    sessionStorage: storage, location: { reload },
    addEventListener: (_name: string, listener: typeof onError) => { onError = listener; },
    setTimeout: (listener: () => void) => { onTimeout = listener; },
  };
  new Function('window', 'document', bootstrap)(fakeWindow, document);
  return { reload, fail: (id = 'carecommand-entry') => onError({ target: id === 'carecommand-entry' ? document.querySelector('script[type="module"][src]')! : document.createElement('script') }), timeout: () => onTimeout() };
}
beforeEach(() => { document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML; window.sessionStorage.clear(); });
describe('entry module recovery', () => {
  it('ships a static nonblank fallback and installs recovery before the entry', () => {
    expect(html.indexOf('/app-bootstrap.js')).toBeLessThan(html.indexOf('/src/main.tsx'));
    expect(document.getElementById('app-startup')).toHaveTextContent('Reload this page');
    expect(document.getElementById('app-startup-reload')).toHaveAttribute('href', '');
  });
  it('reloads a missing entry once and leaves recovery visible on repeated failure', () => {
    document.querySelector('script[type="module"]')!.removeAttribute('id');
    const first = setup(); first.fail(); expect(first.reload).toHaveBeenCalledOnce();
    const second = setup(); second.fail(); expect(second.reload).not.toHaveBeenCalled();
    expect(document.getElementById('app-startup-title')).toHaveTextContent('could not finish opening');
  });
  it('does not auto-reload if the loop guard cannot be stored', () => {
    const storage = { getItem: () => null, setItem: () => { throw new Error('storage denied'); } } as unknown as Storage;
    const recovery = setup(storage); expect(() => recovery.fail()).not.toThrow();
    expect(recovery.reload).not.toHaveBeenCalled();
  });
  it('does not reload unrelated script failures or an already-mounted workspace', () => {
    const recovery = setup(); recovery.fail('other-script');
    document.getElementById('root')!.innerHTML = '<main>Working workspace</main>';
    recovery.fail(); recovery.timeout();
    expect(recovery.reload).not.toHaveBeenCalled();
    expect(document.getElementById('root')).toHaveTextContent('Working workspace');
  });
  it('provides a manual recovery message for an entry that never settles', () => {
    const recovery = setup(); recovery.timeout();
    expect(document.getElementById('app-startup-title')).toHaveTextContent('could not finish opening');
    expect(recovery.reload).not.toHaveBeenCalled();
  });
});
