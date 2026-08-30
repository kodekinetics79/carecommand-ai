import { z } from 'zod';
import { db } from '../db';
import type { Prisma } from '../../generated/prisma/client';

// ===========================================================================
// Front desk SLA policy per clinic (C4, pilot cut: SLA only — no alert outbox).
//
// Stored on ReceptionistClinic.frontDeskPolicy as JSON and merged over the
// code defaults, so a clinic that never touched it behaves exactly like today.
// Emergency is deliberately absent: it is always critical with dueAt = now and
// is rendered read-only in Studio. Invalid stored JSON falls back to defaults
// (and is reported by `mergeFrontDeskPolicy().valid`) rather than throwing in
// the middle of a live call.
// ===========================================================================

const priority = z.enum(['critical', 'high', 'medium', 'low']);
const sla = (min: number, max: number) => z.object({
  dueMinutes: z.number().int().min(min).max(max),
  priority,
}).strict();

// No `.default()` inside: this schema is also the PATCH shape (Zod 4 keeps
// defaults through `.partial()`, which would silently reset omitted fields).
export const frontDeskPolicySchema = z.object({
  sla: z.object({
    message: sla(5, 1440).optional(),
    human_handoff: sla(1, 240).optional(),
    missed_call: sla(5, 1440).optional(),
    call_denied: sla(5, 1440).optional(),
    ai_declined: sla(1, 240).optional(),
    tool_failure: sla(5, 1440).optional(),
    identity_locked: sla(5, 1440).optional(),
    booking_review: sla(5, 1440).optional(),
  }).strict().optional(),
}).strict();

export type FrontDeskPolicyInput = z.infer<typeof frontDeskPolicySchema>;

export type SlaKind = keyof NonNullable<FrontDeskPolicyInput['sla']>;
export type SlaEntry = { dueMinutes: number; priority: z.infer<typeof priority> };

export interface FrontDeskPolicy {
  sla: Record<SlaKind, SlaEntry>;
}

export const DEFAULT_FRONT_DESK_POLICY: FrontDeskPolicy = Object.freeze({
  sla: Object.freeze({
    message: { dueMinutes: 30, priority: 'high' },
    human_handoff: { dueMinutes: 15, priority: 'high' },
    missed_call: { dueMinutes: 60, priority: 'medium' },
    call_denied: { dueMinutes: 30, priority: 'high' },
    ai_declined: { dueMinutes: 15, priority: 'high' },
    tool_failure: { dueMinutes: 30, priority: 'high' },
    identity_locked: { dueMinutes: 30, priority: 'high' },
    booking_review: { dueMinutes: 60, priority: 'medium' },
  }) as Record<SlaKind, SlaEntry>,
}) as FrontDeskPolicy;

/** Merge stored JSON over the defaults. Invalid JSON → defaults + valid:false. */
export function mergeFrontDeskPolicy(stored: unknown): { policy: FrontDeskPolicy; valid: boolean } {
  if (stored === null || stored === undefined) return { policy: DEFAULT_FRONT_DESK_POLICY, valid: true };
  const parsed = frontDeskPolicySchema.safeParse(stored);
  if (!parsed.success) return { policy: DEFAULT_FRONT_DESK_POLICY, valid: false };
  const sla = { ...DEFAULT_FRONT_DESK_POLICY.sla } as Record<SlaKind, SlaEntry>;
  for (const [kind, entry] of Object.entries(parsed.data.sla ?? {})) {
    if (entry) sla[kind as SlaKind] = entry;
  }
  return { policy: { sla }, valid: true };
}

export async function resolveFrontDeskPolicy(
  tenantId: string,
  clinicId: string | null,
  client: typeof db | Prisma.TransactionClient = db,
): Promise<FrontDeskPolicy> {
  if (!clinicId) return DEFAULT_FRONT_DESK_POLICY;
  const clinic = await client.receptionistClinic.findFirst({
    where: { id: clinicId, tenantId },
    select: { frontDeskPolicy: true },
  });
  return mergeFrontDeskPolicy(clinic?.frontDeskPolicy ?? null).policy;
}
