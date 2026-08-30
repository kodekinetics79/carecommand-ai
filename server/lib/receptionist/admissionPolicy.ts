// ===========================================================================
// Call admission policy — how many calls a tenant may have in flight, and what
// a refused caller hears.
//
// Both halves used to live inside `modules/receptionist/outbound.ts`, where a
// hardcoded tenant-wide `3` silently decided that the fourth simultaneous
// caller to a three-site practice was hung up on. Monday morning exceeds three
// calls constantly, so those callers heard the disclosure, said yes, and then
// the line died.
//
// Two rules follow from that, and they are the whole point of this module:
//
//   1. The concurrency ceiling is a policy value with one home, not a literal
//      buried in a route file. `outbound.ts` and the inbound webhook both read
//      it from here.
//   2. **A denied call is never hung up on.** Admission returns a reason; this
//      module maps the reason to a spoken line and a transfer to the clinic's
//      human fallback. `stopPhoneCall` is for provider-integrity failures (an
//      unverified deployment reaching patient data), never for "we are busy".
//
// Wording lives in the approved locale pack, keyed by `messageKey`. The
// `fallbackMessage` below is only what a caller hears while a tenant's pack
// still predates the `receptionist.degraded.*` keys — never the primary copy.
// ===========================================================================

/**
 * Simultaneous live calls one tenant may hold.
 *
 * Raised from 3. Three was below the Monday-morning inbound rate of a single
 * multi-site practice, so the limit was reached in ordinary operation rather
 * than under abuse — and the caller who hit it was disconnected. The real fix
 * is a per-tenant `TenantUsageLimit` row; until that lands, the default is set
 * where a busy pilot practice will not reach it by simply being busy, while
 * still bounding a runaway provider loop.
 */
export const DEFAULT_MAX_TENANT_ACTIVE_CALLS = 25;

/** Kept under the historical name: every existing call site reads this. */
export const MAX_TENANT_ACTIVE_CALLS = DEFAULT_MAX_TENANT_ACTIVE_CALLS;

export const ADMISSION_DENIAL_REASONS = [
  'feature_locked',
  'kill_switch',
  'tenant_mode_demo',
  'concurrency_limit_reached',
  'voice_minutes_limit_reached',
  'terminal_without_active_call',
] as const;

export type AdmissionDenialReason = (typeof ADMISSION_DENIAL_REASONS)[number];

export type AdmissionDisposition =
  /** Speak the line, then hand the caller to the clinic's human fallback. */
  | 'transfer_to_human'
  /** No live caller to speak to (a terminal reconciliation event). */
  | 'reconcile_only';

export interface AdmissionDenialPolicy {
  reason: string;
  disposition: AdmissionDisposition;
  /** Locale-pack key for the sentence the caller hears. */
  messageKey: `receptionist.degraded.${string}`;
  /** Value published as the `admission_state` runtime dynamic variable. */
  admissionState: string;
  /** Spoken only when the tenant's approved pack has no entry for messageKey. */
  fallbackMessage: string;
}

const CAPACITY_FALLBACK = 'All of our lines are busy at the moment. Let me put you through to the front desk.';
const UNAVAILABLE_FALLBACK = 'I cannot take this call automatically right now. Let me put you through to the front desk.';

/**
 * What to do about a denied call. Every branch that can face a live caller
 * transfers; nothing here ends a call.
 */
export function admissionDenialPolicy(reason: string): AdmissionDenialPolicy {
  if (reason === 'terminal_without_active_call') {
    return {
      reason,
      disposition: 'reconcile_only',
      messageKey: 'receptionist.degraded.unavailable',
      admissionState: 'reconcile_only',
      fallbackMessage: UNAVAILABLE_FALLBACK,
    };
  }
  if (reason === 'concurrency_limit_reached') {
    return {
      reason,
      disposition: 'transfer_to_human',
      messageKey: 'receptionist.degraded.at_capacity',
      admissionState: 'at_capacity',
      fallbackMessage: CAPACITY_FALLBACK,
    };
  }
  if (reason === 'voice_minutes_limit_reached') {
    return {
      reason,
      disposition: 'transfer_to_human',
      messageKey: 'receptionist.degraded.quota_exhausted',
      admissionState: 'quota_exhausted',
      fallbackMessage: CAPACITY_FALLBACK,
    };
  }
  return {
    reason,
    disposition: 'transfer_to_human',
    messageKey: 'receptionist.degraded.unavailable',
    admissionState: reason === 'tenant_mode_demo' ? 'demo_workspace' : 'unavailable',
    fallbackMessage: UNAVAILABLE_FALLBACK,
  };
}
