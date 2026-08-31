import { RUNTIME_DYNAMIC_VARIABLES } from '../../lib/receptionist/runtimeVariables';

// ===========================================================================
// A finished prompt still carries the runtime {{variables}} Retell substitutes
// per call; only those may survive rendering, and every other `{{` or `${` is
// either an unrendered value a caller would hear read aloud or an injection
// somebody hoped the provider would interpolate.
//
// Built from the registry rather than retyped. Two suites had their own copy of
// the name list, so adding a runtime variable failed both of them for a reason
// that had nothing to do with what they assert. There is one list, in
// `lib/receptionist/runtimeVariables.ts`, and this reads it.
// ===========================================================================

const RUNTIME_PLACEHOLDER = new RegExp(
  `\\{\\{\\s*(?:${RUNTIME_DYNAMIC_VARIABLES.map(item => item.name).join('|')})\\s*\\}\\}`,
  'g',
);

/** Remove the approved runtime tokens so anything left is a genuine leak. */
export function stripRuntimeVariables(value: string): string {
  return value.replace(RUNTIME_PLACEHOLDER, '');
}
