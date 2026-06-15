import { useId } from 'react';

// CareCommand brand mark — a rounded "command" badge with an AI/health pulse
// and a subtle glass sheen. Crisp from 20px (sidebar) to 48px (login). Pure SVG,
// no external assets. Unique gradient ids per instance avoid <defs> collisions.
export default function Logo({ size = 28, className = '', glow = false }: { size?: number; className?: string; glow?: boolean }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" role="img" aria-label="CareCommand" className={className}>
      <defs>
        <linearGradient id={`${id}-bg`} x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6366F1" />
          <stop offset="0.55" stopColor="#4F46E5" />
          <stop offset="1" stopColor="#7C3AED" />
        </linearGradient>
        <linearGradient id={`${id}-sheen`} x1="6" y1="3" x2="20" y2="18" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFFFFF" stopOpacity="0.45" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
        {glow && (
          <filter id={`${id}-glow`} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="1.1" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        )}
      </defs>

      {/* Badge */}
      <rect x="2" y="2" width="28" height="28" rx="9" fill={`url(#${id}-bg)`} />
      {/* Glass sheen (top-left highlight) */}
      <path d="M8 4 Q4 4 4 9 L4 15 Q11 7 22 8 Q22 4 17 4 Z" fill={`url(#${id}-sheen)`} />
      {/* AI/health pulse — a heartbeat that resolves into an upward command tick */}
      <path
        d="M7 18 H11.2 L13 13.5 L16 21 L18.2 16.5 H21 L24 12.5"
        stroke="#FFFFFF" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"
        filter={glow ? `url(#${id}-glow)` : undefined}
      />
      {/* Command node */}
      <circle cx="24" cy="12.5" r="1.7" fill="#FFFFFF" />
      {/* Inner ring for crisp edge */}
      <rect x="2.6" y="2.6" width="26.8" height="26.8" rx="8.4" stroke="#FFFFFF" strokeOpacity="0.16" strokeWidth="1.2" />
    </svg>
  );
}
