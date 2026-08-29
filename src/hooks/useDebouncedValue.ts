import { useEffect, useState } from 'react';

/**
 * Trails a fast-changing value so it can drive a request.
 *
 * Search boxes that query the server need to stop firing on every keystroke;
 * this returns the last value that stayed still for `delayMs`. The first value
 * is returned immediately, so a screen that mounts with a term already in hand
 * does not wait a beat before showing anything.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    if (value === settled) return;
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, settled, delayMs]);

  return settled;
}
