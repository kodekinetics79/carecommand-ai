// ===========================================================================
// The comprehension bail-out.
//
// From the August 2026 incident review: a 71-year-old stroke survivor tried
// FIVE times to book an appointment through an AI receptionist and gave up. Her
// speech was fragmented after her stroke; the line asked her not to use
// speakerphone, which she needed because she could hold the handset with only
// one hand. She never reached her surgery.
//
// The requirement that falls out of that is not "understand her better". It is
// "know when to stop". After two consecutive turns the receptionist cannot
// parse, it stops trying, apologises plainly, and hands the call to a person —
// a transfer if one can be placed, an immediate callback if not.
//
// The decision is the SERVER'S, not the model's, which is the entire point of
// this module. A prompt instruction to "give up after two attempts" is a
// suggestion that a confident model routinely talks itself out of on attempt
// three. A counter the server owns, incremented by the tool the agent must call
// to admit it did not understand, is a guarantee: once the count reaches the
// ceiling, every subsequent call returns bail-out and there is no retry branch
// left to take.
//
// The count is CONSECUTIVE: a turn the receptionist understood resets it, so a
// caller who is understood, then misheard once, then understood again is not
// walked to a handover for two unrelated stumbles across a long call.
// ===========================================================================

/**
 * Consecutive turns the receptionist may fail to parse before it must hand the
 * call to a person. Two, from the incident review — the third attempt is the
 * one that made a patient give up.
 */
export const MAX_UNPARSEABLE_TURNS = 2;

export type ComprehensionOutcome = 'retry' | 'bail_out';

export interface ComprehensionDecision {
  outcome: ComprehensionOutcome;
  /** Consecutive unparseable turns INCLUDING the one just reported. */
  unparseableTurns: number;
  /** How many further attempts the receptionist may make. Zero once bailing. */
  attemptsRemaining: number;
  /** True once the ceiling is reached; never returns to false on this call. */
  bailOut: boolean;
}

/**
 * The whole rule, as a pure function of the count, so it can be reasoned about
 * and tested without a database: at or above the ceiling there is no retry, and
 * `attemptsRemaining` can never go negative however many times the agent asks.
 */
export function comprehensionDecision(unparseableTurns: number): ComprehensionDecision {
  const turns = Math.max(0, Math.trunc(unparseableTurns));
  const bailOut = turns >= MAX_UNPARSEABLE_TURNS;
  return {
    outcome: bailOut ? 'bail_out' : 'retry',
    unparseableTurns: turns,
    attemptsRemaining: bailOut ? 0 : MAX_UNPARSEABLE_TURNS - turns,
    bailOut,
  };
}
