// ===========================================================================
// Runtime dynamic variables (contract §3).
//
// These are the ONLY `{{placeholders}}` allowed to survive into a deployed
// prompt. Retell substitutes them per call — "are we open right now", "what is
// this caller's first name" — so they cannot be resolved at deploy time the
// way every other value is.
//
// Everything else that looks like template syntax is a defect or an attack:
// an unrendered variable a caller would hear read aloud, or text somebody
// injected hoping the provider would interpolate it. The provider probe
// rejects those and keeps these.
//
// TODO(merge C2): contract §3 makes `promptService.ts` the single source of
// truth, exporting `RUNTIME_DYNAMIC_VARIABLES` (name + default) for the prompt
// builder, C3's `call_inbound` and the outbound dial. This module holds only
// the NAMES, and lives outside promptService because `retell.ts` needs them
// and promptService already imports from `retell.ts` — importing back would
// close a cycle. At merge, have C2's definition derive its names from here (or
// re-point this list at C2's), so there is still one list.
// ===========================================================================

export const RUNTIME_DYNAMIC_VARIABLE_NAMES = [
  'is_open_now',
  'hours_today',
  'next_opening',
  'closure_reason',
  'emergency_number',
  'known_first_name',
  'human_fallback_number',
  'admission_state',
  'location_name',
  'location_address',
  'location_phone',
] as const;

export type RuntimeDynamicVariableName = (typeof RUNTIME_DYNAMIC_VARIABLE_NAMES)[number];

const ALLOWED = new Set<string>(RUNTIME_DYNAMIC_VARIABLE_NAMES);

export function isRuntimeDynamicVariable(name: string): name is RuntimeDynamicVariableName {
  return ALLOWED.has(name.trim());
}
