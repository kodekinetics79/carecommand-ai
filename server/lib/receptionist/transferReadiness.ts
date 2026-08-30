// Single predicate for "can this clinic transfer a live call to a human".
// Used by the prompt (fallback branch), buildRetellConfig (transfer tool
// registration), GET /clinics readiness and the activation blockers.

export const E164_RE = /^\+[1-9]\d{7,14}$/;

export type TransferReadinessReason = 'missing' | 'not_e164' | 'loops_to_agent';

export interface TransferReadiness {
  ready: boolean;
  reason: TransferReadinessReason | null;
}

export function transferReadiness(
  clinic: { humanFallbackNumber?: string | null; phone?: string | null },
  options: { inboundLineNumbers?: Array<string | null | undefined> } = {},
): TransferReadiness {
  const fallback = clinic.humanFallbackNumber?.trim() ?? '';
  if (!fallback) return { ready: false, reason: 'missing' };
  if (!E164_RE.test(fallback)) return { ready: false, reason: 'not_e164' };
  const lines = [clinic.phone, ...(options.inboundLineNumbers ?? [])].filter((value): value is string => typeof value === 'string' && value.length > 0);
  // Transferring to the number the AI itself answers would ring straight
  // back into the agent (CX-R04).
  if (lines.includes(fallback)) return { ready: false, reason: 'loops_to_agent' };
  return { ready: true, reason: null };
}
