import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { db } from './db';

/**
 * What a workspace is allowed to do in the real world.
 *
 * A voice product needs one switch above every dial path, and until this there
 * was none: nothing distinguished a sales-demo workspace from a live clinic, so
 * the only thing between a demo and a real patient's phone ringing was whoever
 * happened to be clicking.
 *
 * The modes are deliberately few. Anything finer belongs in entitlements or
 * usage limits, which already exist.
 */
export const TENANT_MODES = ['demo', 'pilot', 'production'] as const;
export type TenantMode = (typeof TENANT_MODES)[number];

export function isTenantMode(value: unknown): value is TenantMode {
  return typeof value === 'string' && (TENANT_MODES as readonly string[]).includes(value);
}

/** Human-facing description, used by the console so the copy lives in one place. */
export const TENANT_MODE_DESCRIPTION: Record<TenantMode, string> = {
  demo: 'Demonstration only. Live calls are refused, so nothing here can reach a real patient.',
  pilot: 'A real clinic, operated attended. Live calling is allowed.',
  production: 'A real clinic, operated unattended. Live calling is allowed.',
};

/** The single reason string the call-admission gates return. Keep it stable: the
 * receptionist's message catalogue and staff-task copy key off it. */
export const TENANT_MODE_DEMO_BLOCK = 'tenant_mode_demo';

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * Why this tenant may not place or accept a live call right now, or null when
 * it may.
 *
 * Returns a reason rather than throwing so it composes with the existing
 * discriminated-union admission results, and so the caller-facing path (a
 * spoken line and a transfer to the clinic's human fallback) stays owned by the
 * receptionist module rather than being duplicated here.
 *
 * Fails OPEN on a missing tenant row: the admission gates already refuse an
 * unknown tenant for better reasons, and a lookup failure must not become a
 * silent outage for every clinic.
 */
export async function liveCallingBlockReason(
  tenantId: string,
  client: Client = db,
): Promise<typeof TENANT_MODE_DEMO_BLOCK | null> {
  const tenant = await client.tenant.findUnique({ where: { id: tenantId }, select: { mode: true } });
  if (!tenant) return null;
  return tenant.mode === 'demo' ? TENANT_MODE_DEMO_BLOCK : null;
}

/** True when this mode permits real calls. Demo never does. */
export function modeAllowsLiveCalling(mode: string): boolean {
  return mode !== 'demo';
}
