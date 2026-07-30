/**
 * Deterministic tenant health signal computed exclusively from persisted
 * platform fields. Platform API operations live in platformAdmin.ts.
 */
export function healthScore(input: { status: string; enabledFeatures: number; activeUsers: number; setupStatus: string }): number {
  let score = 100;
  if (input.status !== 'active') score -= 60;
  if (input.setupStatus !== 'configured') score -= 15;
  if (input.activeUsers === 0) score -= 20;
  if (input.enabledFeatures < 3) score -= 10;
  return Math.max(0, Math.min(100, score));
}
