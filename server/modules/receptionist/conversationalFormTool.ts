export interface ConversationalFormToolField {
  key: string;
  confirmationRequired: boolean;
}

export interface ConversationalFormProviderToolOptions {
  url: string;
  fields: ConversationalFormToolField[];
}

/**
 * Retell custom-function contract for universal conversational form capture.
 *
 * The provider is intentionally never given patient, campaign, appointment,
 * lead, packet, or form-template identifiers. The signed call handler derives
 * every entity binding from the active call and server-side campaign. The model
 * can supply only answers for server-known field keys, confirmations, and the
 * request to finalize.
 */
export function buildConversationalFormProviderTool(options: ConversationalFormProviderToolOptions): Record<string, unknown> | null {
  const keys = [...new Set(options.fields.map(field => field.key.trim()).filter(Boolean))];
  if (!options.url.trim() || keys.length === 0) return null;
  const confirmationKeys = [...new Set(
    options.fields
      .filter(field => field.confirmationRequired)
      .map(field => field.key.trim())
      .filter(Boolean),
  )];

  return {
    type: 'custom',
    name: 'submit_conversational_form',
    description: [
      'Persist answers collected during this exact active call into the server-bound conversational form.',
      'Never invent entity identifiers or field keys.',
      `answers_json must be a JSON object using only these keys: ${keys.join(', ')}.`,
      confirmationKeys.length
        ? `confirmations_json may mark true only after the caller explicitly confirms these fields: ${confirmationKeys.join(', ')}.`
        : 'No fields in this form require explicit read-back confirmation.',
      'Use finalize=false while saving progress. Use finalize=true only after every required field is collected and every required confirmation was explicitly obtained.',
      'If the result lists missing_fields or invalid_fields, ask only for those fields and do not claim the form was submitted.',
    ].join(' '),
    url: options.url,
    speak_during_execution: false,
    speak_after_execution: true,
    parameters: {
      type: 'object',
      properties: {
        answers_json: {
          type: 'string',
          description: `A JSON object containing only server-known form keys (${keys.join(', ')}). Use JSON booleans for yes/no or consent fields; never include IDs or extra keys.`,
        },
        confirmations_json: {
          type: 'string',
          description: confirmationKeys.length
            ? `A JSON object whose keys are limited to ${confirmationKeys.join(', ')} and whose values are booleans. True means the caller explicitly confirmed the value.`
            : 'Use an empty JSON object because this form has no explicit confirmation fields.',
        },
        finalize: {
          type: 'boolean',
          description: 'False to save validated progress; true only when asking the server to submit the complete form.',
        },
      },
      required: ['answers_json', 'confirmations_json', 'finalize'],
    },
  };
}
