// ===========================================================================
// Retell's request contract: what the real provider accepts on
// create/update-retell-llm and create/update-agent.
//
// This is not a test double. It is the schema half of the provider client,
// pulled out of the request path so both the simulated demo provider and the
// deploy suites can hold the payload we WOULD send against the rules the live
// account enforces, without either of them re-describing those rules and
// drifting from what ships.
//
// HOW WE LEARNED THESE RULES
//
// The simulated provider used to answer `ok` to every payload, which meant the
// whole deploy path had only ever been exercised against a provider that could
// not reject anything. An attended deploy against a real Retell account then
// died at ensure_llm with HTTP 400 invalid_request:
//
//   general_tools/0/type must be equal to one of the allowed values:
//   end_call, press_digit, custom, transfer_call, bridge_transfer,
//   cancel_transfer, mcp ... must match exactly one schema in oneOf
//
// Eleven of our thirteen tools were declared `type: 'function'` — an OpenAI
// word that is not in Retell's discriminator at all. A simulator that cannot
// say no is not a test double, it is a way of not testing. So the validators
// below re-implement the request rules the real API enforces, and the simulated
// provider refuses exactly what the live account refuses, with the same mapped
// error the live client returns for a 400 (`invalid_request`).
//
// Two deliberate non-goals. This is a SCHEMA check, not a semantic one: it
// says nothing about whether a URL is reachable or a voice id exists. And it
// deliberately does NOT enforce OpenAI's structured-output rules that
// `tool_call_strict_mode: true` may bring with it (every property listed in
// `required`, `additionalProperties: false`) — no live response has told us
// Retell applies those at create time, and asserting an unverified rule would
// put this file right back to lying about the provider, just in the other
// direction.
// ===========================================================================

/** Retell's `general_tools[]` oneOf discriminator, verbatim from its 400. */
export const RETELL_GENERAL_TOOL_TYPES = [
  'end_call',
  'press_digit',
  'custom',
  'transfer_call',
  'bridge_transfer',
  'cancel_transfer',
  'mcp',
] as const;

export type RetellGeneralToolType = typeof RETELL_GENERAL_TOOL_TYPES[number];

const RETELL_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const RETELL_TOOL_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const RETELL_TRANSFER_DESTINATION_TYPES = new Set(['predefined', 'inferred', 'dynamic_route']);
const RETELL_TRANSFER_OPTION_TYPES = new Set(['cold_transfer', 'warm_transfer']);
const RETELL_RESPONSE_ENGINE_TYPES = new Set(['retell-llm', 'conversation-flow', 'custom-llm']);
const RETELL_WEBHOOK_EVENTS = new Set(['call_started', 'call_ended', 'call_analyzed']);
const RETELL_DATA_STORAGE_SETTINGS = new Set(['everything', 'everything_except_pii', 'basic_attributes_only']);
const RETELL_ANALYSIS_FIELD_TYPES = new Set(['string', 'enum', 'boolean', 'number']);
const E164 = /^\+[1-9]\d{7,14}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAbsoluteHttpUrl(value: unknown): boolean {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function booleanIssue(path: string, value: unknown): string[] {
  return value === undefined || typeof value === 'boolean' ? [] : [`${path} must be a boolean`];
}

/**
 * The JSON Schema Retell forwards to the model. It must be an object schema
 * with named property schemas; `required` may only name properties that exist.
 */
function parametersIssues(path: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!isRecord(value)) return [`${path} must be a JSON-schema object`];
  const issues: string[] = [];
  if (value.type !== 'object') issues.push(`${path}/type must be equal to one of the allowed values: object`);
  if (!isRecord(value.properties)) {
    issues.push(`${path}/properties must be an object`);
  } else {
    for (const [key, schema] of Object.entries(value.properties)) {
      if (!isRecord(schema)) issues.push(`${path}/properties/${key} must be a JSON-schema object`);
      else if (typeof schema.type !== 'string' && !Array.isArray(schema.anyOf) && !Array.isArray(schema.oneOf)) {
        issues.push(`${path}/properties/${key}/type is required`);
      }
    }
  }
  if (value.required !== undefined) {
    if (!Array.isArray(value.required) || value.required.some(item => typeof item !== 'string')) {
      issues.push(`${path}/required must be an array of property names`);
    } else if (isRecord(value.properties)) {
      for (const key of value.required as string[]) {
        if (!(key in value.properties)) issues.push(`${path}/required references unknown property ${key}`);
      }
    }
  }
  return issues;
}

function generalToolIssues(value: unknown, index: number): string[] {
  const path = `general_tools/${index}`;
  if (!isRecord(value)) return [`${path} must be an object`];
  const type = value.type;
  if (typeof type !== 'string' || !(RETELL_GENERAL_TOOL_TYPES as readonly string[]).includes(type)) {
    // The discriminator decides which branch of the oneOf applies, so nothing
    // further about this tool is knowable once it fails. This is the exact
    // message the live 400 carried.
    return [`${path}/type must be equal to one of the allowed values: ${RETELL_GENERAL_TOOL_TYPES.join(', ')}`];
  }
  const issues: string[] = [];
  if (!isNonEmptyString(value.name) || !RETELL_TOOL_NAME.test(value.name)) {
    issues.push(`${path}/name must match ${RETELL_TOOL_NAME.source}`);
  }
  if (value.description !== undefined && typeof value.description !== 'string') issues.push(`${path}/description must be a string`);
  issues.push(...booleanIssue(`${path}/speak_during_execution`, value.speak_during_execution));
  issues.push(...booleanIssue(`${path}/speak_after_execution`, value.speak_after_execution));

  if (type === 'custom') {
    // A webhook-backed tool is useless without somewhere to call.
    if (!isAbsoluteHttpUrl(value.url)) issues.push(`${path}/url must be an absolute http(s) URL`);
    if (value.method !== undefined && (typeof value.method !== 'string' || !RETELL_TOOL_METHODS.has(value.method.toUpperCase()))) {
      issues.push(`${path}/method must be equal to one of the allowed values: ${[...RETELL_TOOL_METHODS].join(', ')}`);
    }
    issues.push(...booleanIssue(`${path}/args_at_root`, value.args_at_root));
    if (value.timeout_ms !== undefined && (!Number.isSafeInteger(value.timeout_ms) || Number(value.timeout_ms) <= 0)) {
      issues.push(`${path}/timeout_ms must be a positive integer`);
    }
    issues.push(...parametersIssues(`${path}/parameters`, value.parameters));
  } else if (type === 'transfer_call') {
    // Only transfer_call is asserted here. bridge_transfer and cancel_transfer
    // are in the enum but we have never sent one, so their required fields are
    // not something this file knows first-hand — and inventing a rule would be
    // the same mistake as the unconditional `ok` it replaces, pointed the
    // other way.
    const destination = value.transfer_destination;
    if (!isRecord(destination)) {
      issues.push(`${path}/transfer_destination must be an object`);
    } else {
      const destinationType = destination.type;
      if (typeof destinationType !== 'string' || !RETELL_TRANSFER_DESTINATION_TYPES.has(destinationType)) {
        issues.push(`${path}/transfer_destination/type must be equal to one of the allowed values: ${[...RETELL_TRANSFER_DESTINATION_TYPES].join(', ')}`);
      } else if (destinationType === 'predefined' && destination.ignore_e164_validation !== true && !E164.test(String(destination.number ?? ''))) {
        issues.push(`${path}/transfer_destination/number must be an E.164 number`);
      }
      issues.push(...booleanIssue(`${path}/transfer_destination/ignore_e164_validation`, destination.ignore_e164_validation));
    }
    const option = value.transfer_option;
    if (option !== undefined) {
      if (!isRecord(option) || typeof option.type !== 'string' || !RETELL_TRANSFER_OPTION_TYPES.has(option.type)) {
        issues.push(`${path}/transfer_option/type must be equal to one of the allowed values: ${[...RETELL_TRANSFER_OPTION_TYPES].join(', ')}`);
      } else {
        issues.push(...booleanIssue(`${path}/transfer_option/show_transferee_as_caller`, option.show_transferee_as_caller));
      }
    }
  } else if (type === 'press_digit') {
    if (!isNonEmptyString(value.digit) || !/^[0-9*#]+$/.test(value.digit)) issues.push(`${path}/digit must be a DTMF digit string`);
  } else if (type === 'mcp') {
    if (!isAbsoluteHttpUrl(value.url)) issues.push(`${path}/url must be an absolute http(s) URL`);
  }
  return issues;
}

/**
 * Every rule we are confident Retell applies to create/update-retell-llm.
 * Exported so a deploy test can assert the payload the deploy WOULD send is
 * schema-valid without going near a real account.
 */
export function retellLlmRequestIssues(body: unknown): string[] {
  if (!isRecord(body)) return ['request body must be an object'];
  const issues: string[] = [];
  if (!isNonEmptyString(body.general_prompt)) issues.push('general_prompt must be a non-empty string');
  if (body.begin_message !== undefined && body.begin_message !== null && typeof body.begin_message !== 'string') {
    issues.push('begin_message must be a string or null');
  }
  if (body.model !== undefined && !isNonEmptyString(body.model)) issues.push('model must be a non-empty string');
  issues.push(...booleanIssue('tool_call_strict_mode', body.tool_call_strict_mode));
  if (body.default_dynamic_variables !== undefined && !isRecord(body.default_dynamic_variables)) {
    issues.push('default_dynamic_variables must be an object');
  }
  if (body.general_tools !== undefined) {
    if (!Array.isArray(body.general_tools)) {
      issues.push('general_tools must be an array');
    } else {
      const seen = new Set<string>();
      body.general_tools.forEach((tool, index) => {
        issues.push(...generalToolIssues(tool, index));
        const name = isRecord(tool) && typeof tool.name === 'string' ? tool.name : null;
        if (name) {
          if (seen.has(name)) issues.push(`general_tools/${index}/name duplicates an earlier tool name`);
          seen.add(name);
        }
      });
    }
  }
  return issues;
}

/** The same treatment for create/update-agent. */
export function retellAgentRequestIssues(body: unknown): string[] {
  if (!isRecord(body)) return ['request body must be an object'];
  const issues: string[] = [];
  if (!isNonEmptyString(body.agent_name)) issues.push('agent_name must be a non-empty string');
  if (!isNonEmptyString(body.voice_id)) issues.push('voice_id must be a non-empty string');
  if (body.language !== undefined && !isNonEmptyString(body.language)) issues.push('language must be a non-empty string');
  const engine = body.response_engine;
  if (!isRecord(engine)) {
    issues.push('response_engine must be an object');
  } else {
    if (typeof engine.type !== 'string' || !RETELL_RESPONSE_ENGINE_TYPES.has(engine.type)) {
      issues.push(`response_engine/type must be equal to one of the allowed values: ${[...RETELL_RESPONSE_ENGINE_TYPES].join(', ')}`);
    }
    if (engine.type === 'retell-llm' && !isNonEmptyString(engine.llm_id)) issues.push('response_engine/llm_id must be a non-empty string');
    if (engine.version !== undefined && (!Number.isSafeInteger(engine.version) || Number(engine.version) < 0)) {
      issues.push('response_engine/version must be a non-negative integer');
    }
  }
  if (body.webhook_url !== undefined && body.webhook_url !== null && !isAbsoluteHttpUrl(body.webhook_url)) {
    issues.push('webhook_url must be an absolute http(s) URL');
  }
  if (body.webhook_events !== undefined) {
    if (!Array.isArray(body.webhook_events)) issues.push('webhook_events must be an array');
    else {
      for (const event of body.webhook_events) {
        if (typeof event !== 'string' || !RETELL_WEBHOOK_EVENTS.has(event)) {
          issues.push(`webhook_events must be equal to one of the allowed values: ${[...RETELL_WEBHOOK_EVENTS].join(', ')}`);
        }
      }
    }
  }
  if (body.data_storage_setting !== undefined && (typeof body.data_storage_setting !== 'string' || !RETELL_DATA_STORAGE_SETTINGS.has(body.data_storage_setting))) {
    issues.push(`data_storage_setting must be equal to one of the allowed values: ${[...RETELL_DATA_STORAGE_SETTINGS].join(', ')}`);
  }
  issues.push(...booleanIssue('opt_in_signed_url', body.opt_in_signed_url));
  if (body.max_call_duration_ms !== undefined && (!Number.isSafeInteger(body.max_call_duration_ms) || Number(body.max_call_duration_ms) <= 0)) {
    issues.push('max_call_duration_ms must be a positive integer');
  }
  if (body.post_call_analysis_data !== undefined) {
    if (!Array.isArray(body.post_call_analysis_data)) {
      issues.push('post_call_analysis_data must be an array');
    } else {
      body.post_call_analysis_data.forEach((field, index) => {
        const path = `post_call_analysis_data/${index}`;
        if (!isRecord(field)) {
          issues.push(`${path} must be an object`);
          return;
        }
        if (!isNonEmptyString(field.name)) issues.push(`${path}/name must be a non-empty string`);
        if (typeof field.type !== 'string' || !RETELL_ANALYSIS_FIELD_TYPES.has(field.type)) {
          issues.push(`${path}/type must be equal to one of the allowed values: ${[...RETELL_ANALYSIS_FIELD_TYPES].join(', ')}`);
        } else if (field.type === 'enum' && (!Array.isArray(field.choices) || field.choices.length === 0 || field.choices.some(choice => typeof choice !== 'string'))) {
          issues.push(`${path}/choices must be a non-empty array of strings for an enum field`);
        }
      });
    }
  }
  return issues;
}
