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
// Wording lives in the approved locale pack, keyed by `messageKey`. Those keys
// are the platform-default `admission.denied.*` family C-words landed, so
// resolve.ts fills them in for an older approved pack and a denial can never
// resolve to silence. `fallbackMessage` is what a caller hears only when no
// pack can be resolved for the clinic at all — never the primary copy.
// ===========================================================================

import type { LocalePackMessageKey } from './localePacks/types';

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
  /** Typed locale-pack key for the sentence the caller hears. */
  messageKey: LocalePackMessageKey & `admission.denied.${string}`;
  /** Value published as the `admission_state` runtime dynamic variable. */
  admissionState: string;
  /** Spoken only when the tenant's approved pack has no entry for messageKey. */
  fallbackMessage: string;
}

// The C-words wording, kept verbatim: these are the sentences a caller hears
// when no approved pack can be resolved for the clinic at all.
const CAPACITY_FALLBACK = "We're taking more calls than usual right now, so rather than keep you waiting I'll put you through to the front desk.";
const UNAVAILABLE_FALLBACK = "I'm sorry, the automated line isn't available right now. Let me put you through to the front desk instead.";
// A demonstration workspace has no real front desk behind it, so this is the
// one denial whose words point the caller at the practice's own number rather
// than offering to transfer them into a demo.
const DEMO_FALLBACK = "Thanks for calling. This line is set up for demonstration only and isn't taking patient calls, so I won't take your details here. Please call the practice on its main number.";

/**
 * What to do about a denied call. Every branch that can face a live caller
 * transfers; nothing here ends a call.
 */
export function admissionDenialPolicy(reason: string): AdmissionDenialPolicy {
  if (reason === 'terminal_without_active_call') {
    return {
      reason,
      disposition: 'reconcile_only',
      messageKey: 'admission.denied.unavailable',
      admissionState: 'reconcile_only',
      fallbackMessage: UNAVAILABLE_FALLBACK,
    };
  }
  if (reason === 'concurrency_limit_reached') {
    return {
      reason,
      disposition: 'transfer_to_human',
      messageKey: 'admission.denied.capacity',
      admissionState: 'at_capacity',
      fallbackMessage: CAPACITY_FALLBACK,
    };
  }
  if (reason === 'voice_minutes_limit_reached') {
    // A spent allowance is not a busy switchboard. The state stays distinct for
    // staff, but the caller hears the honest "not available right now" line
    // rather than being told every line is busy.
    return {
      reason,
      disposition: 'transfer_to_human',
      messageKey: 'admission.denied.unavailable',
      admissionState: 'quota_exhausted',
      fallbackMessage: UNAVAILABLE_FALLBACK,
    };
  }
  if (reason === 'tenant_mode_demo') {
    return {
      reason,
      disposition: 'transfer_to_human',
      messageKey: 'admission.denied.demo',
      admissionState: 'demo_workspace',
      fallbackMessage: DEMO_FALLBACK,
    };
  }
  return {
    reason,
    disposition: 'transfer_to_human',
    messageKey: 'admission.denied.unavailable',
    admissionState: 'unavailable',
    fallbackMessage: UNAVAILABLE_FALLBACK,
  };
}
