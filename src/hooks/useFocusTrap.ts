import { useEffect, type RefObject } from 'react';

// ===========================================================================
// Modal focus containment (E15).
//
// `aria-modal="true"` is a promise to assistive technology that nothing behind
// the dialog is reachable. A dialog that does not also trap Tab breaks that
// promise for the people who rely on it most: a keyboard user tabs straight out
// of "Book it" into the lanes underneath and can activate Reject on a request
// they never meant to touch.
//
// The behaviour was already correct in ConfirmationModal and nowhere else, so
// it lives here now and every dialog shares one implementation.
// ===========================================================================

const FOCUSABLE = [
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export interface FocusTrapOptions {
  /** Escape closes the dialog. Required: a trap with no way out is a cage. */
  onClose: () => void;
  /** Focused on open; falls back to the container itself. */
  initialFocus?: RefObject<HTMLElement | null>;
  enabled?: boolean;
}

/**
 * Contains Tab within `containerRef` while the dialog is open, focuses into it
 * on mount, routes Escape to `onClose`, and returns focus to whatever was
 * focused before on unmount.
 */
export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, options: FocusTrapOptions): void {
  const { onClose, initialFocus, enabled = true } = options;
  useEffect(() => {
    if (!enabled) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (initialFocus?.current ?? containerRef.current)?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const container = containerRef.current;
      if (!container) return;
      const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (focusable.length === 0) {
        // Nothing to move to, so Tab must not leave the dialog either.
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!container.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previouslyFocused?.focus();
    };
  }, [containerRef, onClose, initialFocus, enabled]);
}
