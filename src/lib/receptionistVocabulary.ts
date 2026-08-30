// ===========================================================================
// The words a tenant is allowed to read about the AI receptionist.
//
// A clinic buys "an AI receptionist from CareCommand". It does not buy a
// named third-party voice agent wired to a named third-party speech vendor,
// and until this module existed it could read that whole supply chain off its
// own screen — 200 mentions of one supplier across 33 tenant-facing files,
// down to agent ids, published version numbers, webhook URLs and
// dynamic-variable tags.
//
// Two things were wrong with that, and only the first is obvious:
//
//   · commercially, a clinic that learns the stack can price us against going
//     direct, which hands away both the margin and the reason to stay;
//   · operationally, none of it is actionable. "Remove the default dynamic
//     variables from this version's tag in the <supplier> console" is a true
//     sentence addressed to nobody who can read it. The clinic owner cannot
//     open that console. Telling them anyway converts a support ticket into a
//     dead end with our supplier's name printed on it.
//
// So this module is the single vocabulary, imported by BOTH halves of the
// product — the browser and the API — because most of what a tenant reads
// about the line is server-authored (`server/lib/receptionist/remediation.ts`
// writes 60+ failure sentences). Two copies of these words would drift, and
// the whole point is that they can be changed in one place.
//
// THE RULE THIS MODULE DOES NOT BREAK: never make a message vaguer in order to
// hide a vendor. An operator still has to know what is wrong and what to do.
// Where the remediation genuinely requires action inside a supplier console —
// something a clinic can neither perform nor be shown — the honest answer is
// not a vague sentence, it is a DIFFERENT AUDIENCE: the tenant is told the
// line needs CareCommand, given a reference to quote, and the exact
// instruction is routed to Platform Admin (`platformAction` in the remediation
// catalogue). Vagueness is the failure mode; re-addressing is the fix.
// ===========================================================================

export const VOICE = {
  /** The supplier, never named. Lower-case, for mid-sentence use. */
  service: 'the voice service',
  /** Sentence-initial form of the same. */
  Service: 'The voice service',

  /** The tenant's own thing: the number a patient rings and what answers it. */
  line: 'voice line',
  Line: 'Voice line',

  /** What the clinic thinks it bought, because it is what it bought. */
  receptionist: 'your receptionist',
  Receptionist: 'Your receptionist',

  /**
   * The configuration published to the line. Replaces the supplier's own noun
   * for it: a clinic owner has no use for the distinction between an agent, its
   * response engine and its published version, and every one of those words
   * names a supplier's data model rather than the clinic's.
   */
  configuration: 'voice line configuration',
  Configuration: 'Voice line configuration',

  /** Deploy / publish. */
  publish: 'Publish to the line',
  publishLower: 'publish to the line',
  publishAgain: 'Publish to the line again',
  published: 'published to the line',

  /** Provider verification: reading the live line back and proving it matches. */
  check: 'Line check',
  checkLower: 'line check',
  runCheck: 'Run the line check',
  checked: 'line-checked',
} as const;

/**
 * The opaque handle. `providerAgentId`, the published version, the response
 * engine id and the deployment tag are one supplier coordinate; a tenant can
 * act on none of them individually, and support needs all of them together.
 * So they collapse to one label and one short, quotable string.
 */
export const CONFIGURATION_REFERENCE = 'Configuration reference';

/** What a tenant is told when the fix is ours to perform, not theirs. */
export const SUPPORT_ATTENTION = 'Your voice line needs attention from CareCommand support.';

/**
 * The full sentence for a support-routed failure. The reference is included
 * precisely so the tenant is NOT left with nothing to do: quoting it is the
 * action, and it is the same string Platform Admin looks the failure up by.
 */
export function supportAction(reference?: string | null): string {
  return reference
    ? `${SUPPORT_ATTENTION} Quote reference ${reference} — CareCommand can see the exact fault and apply the fix. Nothing on this screen changes it.`
    : `${SUPPORT_ATTENTION} CareCommand can see the exact fault and apply the fix. Nothing on this screen changes it.`;
}

/**
 * The quotable reference.
 *
 * Deliberately NOT the provider id, even masked: `agen…7f21` re-leaks the
 * shape of the thing it replaces and tells a curious reader exactly what to
 * search for. This is a suffix of CareCommand's OWN deployment row id, which
 * is what support looks the fault up by anyway, prefixed so it reads as a
 * reference number rather than as a truncated secret.
 */
export function configurationReference(input: { deploymentId?: string | null; agentId?: string | null }): string | null {
  const seed = input.deploymentId ?? input.agentId ?? '';
  const tail = seed.replace(/[^a-z0-9]/gi, '').slice(-6).toUpperCase();
  return tail ? `LINE-${tail}` : null;
}

/**
 * Voice option label. The catalogue upstream tags each voice with the house
 * that synthesised it, and the select used to print that after a middot — so
 * the dropdown an owner names their receptionist in also named two suppliers.
 * The traits are what an owner actually chooses on.
 */
export function voiceOptionLabel(voice: { name: string; gender?: string | null; accent?: string | null }): string {
  const traits = [voice.gender, voice.accent].filter(Boolean).join(', ');
  return traits ? `${voice.name} (${traits})` : voice.name;
}

/**
 * A stored value that is no longer in the catalogue. Printing the raw voice id
 * here was the last place a supplier-prefixed identifier reached a select
 * element, as an option's visible text.
 */
export const STORED_VOICE_NOT_IN_CATALOGUE = 'Current voice (no longer offered)';
