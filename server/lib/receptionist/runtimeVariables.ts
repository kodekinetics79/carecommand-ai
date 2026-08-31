// ===========================================================================
// Runtime dynamic variables (contract §3). THE single source of truth.
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
// This module — not `promptService.ts` — is the home for the list, because
// `retell.ts` needs it for `containsProviderTemplateSyntax` and promptService
// already imports from `retell.ts`; defining it there would close an import
// cycle. `promptService.ts` re-exports `RUNTIME_DYNAMIC_VARIABLES` for the
// prompt builder, C3's `call_inbound` and the outbound dial, so consumers keep
// their existing import site while there is still only one list.
// ===========================================================================

/** Name + the value Retell falls back to when it has nothing to substitute. */
export const RUNTIME_DYNAMIC_VARIABLES = [
  { name: 'is_open_now', default: 'unknown' },
  { name: 'hours_today', default: '' },
  { name: 'next_opening', default: '' },
  { name: 'closure_reason', default: '' },
  { name: 'emergency_number', default: '' },
  { name: 'known_first_name', default: '' },
  { name: 'human_fallback_number', default: '' },
  { name: 'admission_state', default: '' },
  { name: 'location_name', default: '' },
  { name: 'location_address', default: '' },
  { name: 'location_phone', default: '' },
  // The appointment THIS call is about. Per-patient by definition, so they can
  // only be resolved at dial time; the reminder campaign that carried them as
  // static script text read one patient's clinician, day and time to everybody
  // on the list. Every one defaults to empty: a call with no bound appointment
  // must state nothing rather than a plausible-sounding placeholder.
  { name: 'appointment_id', default: '' },
  { name: 'appointment_clinician', default: '' },
  { name: 'appointment_date', default: '' },
  { name: 'appointment_time', default: '' },
  { name: 'appointment_service', default: '' },
  { name: 'appointment_location', default: '' },
] as const;

export type RuntimeDynamicVariable = (typeof RUNTIME_DYNAMIC_VARIABLES)[number]['name'];

export const RUNTIME_DYNAMIC_VARIABLE_NAMES: readonly RuntimeDynamicVariable[] =
  RUNTIME_DYNAMIC_VARIABLES.map(item => item.name);

export type RuntimeDynamicVariableName = RuntimeDynamicVariable;

const ALLOWED = new Set<string>(RUNTIME_DYNAMIC_VARIABLE_NAMES);

export function isRuntimeDynamicVariable(name: string): name is RuntimeDynamicVariableName {
  return ALLOWED.has(name.trim());
}

export function runtimeDynamicVariableDefaults(): Record<string, string> {
  return Object.fromEntries(RUNTIME_DYNAMIC_VARIABLES.map(item => [item.name, item.default]));
}
