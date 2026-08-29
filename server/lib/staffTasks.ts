import type { TenantTxClient } from './tenantContext';
import type { Prisma } from '../generated/prisma/client';

// ============================================================================
// Staff task hand-off helper.
//
// Several controls in the product tell a user that work has been handed to the
// front desk ("Send to Front Desk", "Escalated to a human", "flagged for
// billing review"). Each of those must land a real StaffTask, or the control is
// asserting work it did not do. This helper is the single way those hand-offs
// create a task.
//
// Idempotency follows the pattern already used by the receptionist recovery
// paths and automationRules: the originating workflow + entity is stamped into
// `metadata`, and an existing non-terminal task for the same origin is reused
// instead of creating a second one. Repeating the action is therefore safe and
// reports `created: false` so the caller can tell the user the truth.
// ============================================================================

/** Non-terminal statuses. A COMPLETED/CANCELED task does not block a new hand-off. */
const LIVE_STATUSES = ['OPEN', 'IN_PROGRESS'] as const;

export interface StaffTaskOrigin {
  /** Stable identifier of the control that hands work over, e.g. 'opportunity_handoff'. */
  workflow: string;
  /** The record the hand-off is about, e.g. 'opportunity' / 'conversation' / 'appointment'. */
  entityType: string;
  entityId: string;
  /** Distinguishes two different hand-offs from the same entity (e.g. two CTAs). */
  verb?: string;
}

export interface EnsureStaffTaskInput {
  tenantId: string;
  branchId?: string | null;
  title: string;
  priority: string;
  dueAt?: Date | null;
  assignedToId?: string | null;
  origin: StaffTaskOrigin;
  /** Extra origin context stored alongside the idempotency keys. */
  context?: Prisma.InputJsonObject;
}

export interface HandoffTask {
  id: string;
  title: string;
  status: string;
  assignedToId: string | null;
  branchId: string | null;
}

export interface EnsureStaffTaskResult {
  task: HandoffTask;
  /** False when a live task for this exact origin already existed and was reused. */
  created: boolean;
}

/** Build the metadata blob written on every hand-off task. */
export function staffTaskOriginMetadata(origin: StaffTaskOrigin, context?: Prisma.InputJsonObject): Prisma.InputJsonObject {
  return {
    ...(context ?? {}),
    workflow: origin.workflow,
    entityType: origin.entityType,
    entityId: origin.entityId,
    ...(origin.verb ? { verb: origin.verb } : {}),
    source: 'handoff',
  };
}

/** The JSON-path predicate that makes a hand-off idempotent for one origin. */
function originWhere(tenantId: string, origin: StaffTaskOrigin): Prisma.StaffTaskWhereInput {
  return {
    tenantId,
    status: { in: [...LIVE_STATUSES] },
    AND: [
      { metadata: { path: ['workflow'], equals: origin.workflow } },
      { metadata: { path: ['entityType'], equals: origin.entityType } },
      { metadata: { path: ['entityId'], equals: origin.entityId } },
      ...(origin.verb ? [{ metadata: { path: ['verb'], equals: origin.verb } }] : []),
    ],
  };
}

/**
 * Create the hand-off task for `origin`, or return the live one that already
 * exists. Must be called inside a tenant transaction so the advisory lock and
 * the lookup/insert are one unit — two concurrent clicks then produce one task.
 */
export async function ensureStaffTask(tx: TenantTxClient, input: EnsureStaffTaskInput): Promise<EnsureStaffTaskResult> {
  const { tenantId, origin } = input;
  const lockKey = `staff-task-handoff:${tenantId}:${origin.workflow}:${origin.entityType}:${origin.entityId}:${origin.verb ?? ''}`;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}::text, 0))::text AS locked`;

  const existing = await tx.staffTask.findFirst({
    where: originWhere(tenantId, origin),
    orderBy: { createdAt: 'desc' },
    select: { id: true, title: true, status: true, assignedToId: true, branchId: true },
  });
  if (existing) return { task: existing, created: false };

  const task = await tx.staffTask.create({
    data: {
      tenantId,
      branchId: input.branchId ?? undefined,
      assignedToId: input.assignedToId ?? undefined,
      title: input.title,
      priority: input.priority,
      dueAt: input.dueAt ?? undefined,
      metadata: staffTaskOriginMetadata(origin, input.context),
    },
    select: { id: true, title: true, status: true, assignedToId: true, branchId: true },
  });
  return { task, created: true };
}
