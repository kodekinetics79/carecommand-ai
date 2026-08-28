export type RingTone = 'emerald' | 'amber' | 'red';

// Meter rule: the unfilled track is a lighter step of the same ramp as the
// fill, so state reads across the whole ring — not a neutral gray.
const TONE: Record<RingTone, { fill: string; track: string }> = {
  emerald: { fill: 'var(--emerald)', track: '#D1FAE5' },
  amber: { fill: 'var(--amber)', track: '#FDE9C8' },
  red: { fill: 'var(--red)', track: '#FEE2E2' },
};

/** Radial meter for a 0–100 score. Pair it with an icon + label chip — the
 *  ring color never carries state alone. */
export default function HealthRing({ value, tone, size = 56 }: { value: number; tone: RingTone; size?: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  const stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const t = TONE[tone];

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Health score ${clamped} of 100`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={t.track} strokeWidth={stroke} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke={t.fill} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={`${(clamped / 100) * c} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle"
        style={{ fontSize: size * 0.3, fontWeight: 700, fill: 'var(--t1)' }}>
        {Math.round(clamped)}
      </text>
    </svg>
  );
}
