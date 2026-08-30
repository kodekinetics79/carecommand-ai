// ===========================================================================
// Sentences the receptionist may never say to a caller.
//
// In August 2026 a South Yorkshire GP surgery withdrew its AI receptionist
// after a 71-year-old stroke survivor tried five times to book an appointment
// and could not get past it. Her speech was fragmented, and the line asked her
// not to use speakerphone — which she needed, because she could hold the
// handset with only one hand. Healthwatch Rotherham has since logged the same
// complaint from patients with regional accents and speech impairments.
//
// The failure is not that the model misheard her. Models mishear people. The
// failure is that the product's response to misunderstanding was to instruct
// the PATIENT to change: speak differently, hold the phone differently, move
// somewhere else. That is an accessibility failure dressed up as helpfulness,
// and it is the one thing a receptionist must never do, because the caller is
// the party who cannot change.
//
// So this module is the single list, and it has three consumers:
//
//   1. `validateLocalePackStrings` — a tenant cannot APPROVE a pack containing
//      one of these, so it cannot reach a caller even by hand.
//   2. `prohibitedPhraseRule()` — the prompt renders the ban from this same
//      list, so the rule the model reads and the rule the linter enforces are
//      the same list, and cannot drift apart.
//   3. `receptionistProhibitedPhrases.lint.test.ts` — the packs, the live-tool
//      messages and the assembled prompt are all scanned, so the phrase cannot
//      creep back in through a hardcoded `message:` either.
//
// Patterns are deliberately blunt. A false positive costs an engineer one
// reworded sentence; a false negative costs a patient their appointment.
// ===========================================================================

export interface ProhibitedPhrase {
  id: string;
  /** Matched case-insensitively against any caller-facing sentence. */
  pattern: RegExp;
  /** The banned instruction, in the words it usually arrives in. */
  example: string;
  /** Why it is banned — rendered nowhere, read by whoever wants to argue. */
  why: string;
}

export const PROHIBITED_CALLER_INSTRUCTIONS: readonly ProhibitedPhrase[] = [
  {
    id: 'speakerphone',
    pattern: /\bspeaker\s?phones?\b/i,
    example: "don't use speakerphone",
    why: 'The documented August 2026 failure. Speakerphone is an accessibility device for anyone with one usable hand.',
  },
  {
    id: 'hands_free',
    pattern: /\bhands[-\s]?free\b/i,
    example: 'take me off hands-free',
    why: 'The same instruction wearing a different name.',
  },
  {
    id: 'speak_differently',
    pattern: /\b(?:speak|talk|say (?:it|that))\s+(?:it\s+)?(?:a\s+(?:bit|little)\s+)?(?:more\s+|again\s+)?(?:clearly|slowly|slower|louder|quieter|softly|up)\b/i,
    example: 'could you speak more clearly',
    why: 'A person with dysarthria or a regional accent is not speaking unclearly; the line is listening badly.',
  },
  {
    id: 'speaking_too',
    pattern: /\byou(?:'re|’re| are)\s+(?:speaking|talking)\s+too\s+\w+/i,
    example: "you're talking too fast",
    why: 'Blames the caller for a comprehension failure that is ours.',
  },
  {
    id: 'mumbling',
    pattern: /\bmumbl\w*/i,
    example: 'you are mumbling',
    why: 'Never acceptable to a patient, under any phrasing.',
  },
  {
    id: 'somewhere_quieter',
    pattern: /\bsome\s?(?:where|place)\s+quiet(?:er)?\b|\bquiet(?:er)?\s+(?:room|place|spot|area|space|environment)\b|\b(?:move|go|step)\s+(?:to\s+)?(?:a\s+)?quiet/i,
    example: 'try moving somewhere quieter',
    why: 'Assumes the caller has another room, and that getting to it is free.',
  },
  {
    id: 'background_noise',
    pattern: /\bbackground\s+noise\b/i,
    example: 'there is a lot of background noise',
    why: 'An instruction to change the caller’s environment, phrased as an observation.',
  },
  {
    id: 'hold_the_phone',
    pattern: /\bhold\s+(?:the\s+|your\s+)?(?:phone|handset|receiver)\b|\b(?:closer|nearer)\s+to\s+(?:the\s+|your\s+)?(?:phone|handset|receiver|mouth|mic|microphone)\b/i,
    example: 'hold the phone closer to your mouth',
    why: 'The exact instruction that ended the Rotherham deployment.',
  },
  {
    id: 'your_microphone',
    pattern: /\byour\s+(?:microphone|mic|handset|receiver|headset)\b/i,
    example: 'check your microphone',
    why: 'A device instruction. The caller rang a clinic, not a support line.',
  },
  {
    id: 'different_phone',
    // Deliberately requires the adjective: "the doctor is on another line" is
    // an ordinary, true thing for a receptionist to say.
    pattern: /\b(?:different|another|landline|second|better)\s+(?:phone|handset|connection)\b/i,
    example: 'try calling from a different phone',
    why: 'Assumes the caller owns a second phone.',
  },
  {
    id: 'turn_off_noise',
    pattern: /\bturn\s+(?:(?:off|down)\s+(?:the\s+|your\s+)?(?:tv|television|radio|music|speaker)|(?:the\s+|your\s+)?(?:tv|television|radio|music|speaker)\s+(?:off|down))\b/i,
    example: 'could you turn the TV down',
    why: 'The caller’s home is not ours to arrange.',
  },
  {
    id: 'bad_line',
    pattern: /\b(?:your|the)\s+(?:line|signal|connection|reception)\s+is\s+(?:bad|poor|breaking|weak|terrible)\b/i,
    example: 'your line is breaking up',
    why: 'Reads as "your fault"; the next sentence is always an instruction to change something.',
  },
];

/** Every prohibited phrase this text contains, by id. Empty means clean. */
export function findProhibitedCallerInstructions(text: string): string[] {
  if (!text) return [];
  return PROHIBITED_CALLER_INSTRUCTIONS.filter(entry => entry.pattern.test(text)).map(entry => entry.id);
}

/**
 * The prompt's own statement of the ban, rendered from the list above so the
 * rule the model is given and the rule CI enforces cannot drift apart.
 *
 * This is the ONE place in the assembled prompt where these phrases are allowed
 * to appear, and the lint knows it by matching this exact line.
 */
export function prohibitedPhraseRule(): string {
  const examples = PROHIBITED_CALLER_INSTRUCTIONS.map(entry => `"${entry.example}"`).join(', ');
  return `- Never tell a caller to change how they speak, what they are calling from, or where they are calling from. Not once, not gently, not as a suggestion. This includes ${examples}, and every rephrasing of them. A caller using speakerphone may have one usable hand; a caller whose speech is fragmented may have had a stroke; a caller with a strong accent is speaking perfectly well. If you cannot understand someone, that is your limitation to solve — by handing them to a person — and never theirs to fix.`;
}
