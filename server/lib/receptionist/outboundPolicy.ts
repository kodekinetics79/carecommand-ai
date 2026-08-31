// ===========================================================================
// Campaign dialling policy — the rules about what happens to a target, with
// no dependency on HTTP.
//
// WHY THIS IS ITS OWN MODULE
//
// These rules are needed by two processes that must agree exactly: the Fastify
// route that handles a provider webhook, and the background worker that
// reconciles calls the provider never reported. A target released by the
// reconciler has to land in precisely the state the webhook would have put it
// in, so there must be ONE definition, not two that drift.
//
// They used to live in `modules/receptionist/outbound.ts`, a route module.
// Importing them from the worker dragged the entire HTTP dependency graph into
// a process that serves no requests — including `providerCredentials`, which
// derives an encryption key at module scope and therefore CRASHED the worker
// boot path outright when the credential env was not present. A worker should
// not fail to start because of a module it only needed a pure function from.
//
// Nothing here may import a route, a Fastify type, or the database.
// ===========================================================================

/** Voice-minute allowance a tenant gets before an explicit limit is recorded. */
export const DEFAULT_VOICE_MINUTES_LIMIT = 500;

/** The only target status a dialler may pick up. Anything else is either
 *  finished, in flight, or deliberately withheld. */
export const DIALABLE_TARGET_STATUS = 'PENDING';

export function isTargetDialable(status: string, attempts: number, maxRetryAttempts: number): boolean {
  return status === DIALABLE_TARGET_STATUS && attempts <= maxRetryAttempts;
}

/**
 * Where a target goes once its call reaches a terminal outcome, or `null` when
 * the outcome is not terminal and the target must be left alone.
 *
 * Every terminal `ReceptionistCallOutcome` is covered deliberately: a terminal
 * call must always release its target from CALLING, because only PENDING is
 * dialable and a target stranded in CALLING can never be called by anyone
 * again. `null` is reserved for IN_PROGRESS and for strings that are not
 * outcomes at all.
 */
export function targetStatusAfterOutcome(
  outcome: string,
  attempts: number,
  maxRetryAttempts: number,
): 'PENDING' | 'COMPLETED' | 'FAILED' | 'OPTED_OUT' | null {
  if (outcome === 'OPTED_OUT') return 'OPTED_OUT';
  if (['BOOKED', 'NOT_INTERESTED', 'ESCALATED'].includes(outcome)) return 'COMPLETED';
  if (['NO_ANSWER', 'VOICEMAIL', 'FAILED'].includes(outcome)) {
    return attempts <= maxRetryAttempts ? 'PENDING' : 'FAILED';
  }
  return null;
}
