import { useEffect, useRef, useState } from 'react';

// Animated counter that eases from 0 → target. Respects prefers-reduced-motion
// (jumps straight to the value). Re-animates when the target changes.
export function useCountUp(target: number, durationMs = 900): number {
  const [value, setValue] = useState(0);
  const frame = useRef<number>(0);

  useEffect(() => {
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || target === 0) {
      // Jump to the value on the next frame (avoids a synchronous setState in effect).
      frame.current = requestAnimationFrame(() => setValue(target));
      return () => cancelAnimationFrame(frame.current);
    }
    const start = performance.now();
    const from = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setValue(from + (target - from) * eased);
      if (t < 1) frame.current = requestAnimationFrame(tick);
      else setValue(target);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [target, durationMs]);

  return value;
}
