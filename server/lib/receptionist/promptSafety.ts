import { z } from 'zod';

// ===========================================================================
// M54 prompt safety. Every tenant-authored string that can reach a voice-agent
// prompt passes through here: control characters are stripped, whitespace is
// collapsed, provider template syntax is refused (so a clinic cannot smuggle a
// `{{dynamic_variable}}` into its own prompt), and the classic instruction-
// override phrases are refused outright.
// ===========================================================================

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const INSTRUCTION_OVERRIDE = /\b(?:ignore\s+(?:all|any|the|previous|prior|above|earlier)\s+(?:\w+\s+)?instructions?|system\s+prompt|you\s+are\s+now|disregard\s+(?:all|any|the|previous|prior|your)|act\s+as\s+(?:a|an|the)?\s*(?:different|new|another)|reveal\s+your|repeat\s+your\s+(?:prompt|instructions))\b/i;

export function sanitizePromptText(value: string, options: { keepPlaceholders?: boolean } = {}): string {
  const stripped = value.replace(CONTROL_CHARS, ' ').replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  return options.keepPlaceholders ? stripped : stripped;
}

/** `{{`, `}}` and `{%` are provider/template syntax and never legitimate clinic text. */
export function containsProviderTemplateSyntax(value: string): boolean {
  return /\{\{|\}\}|\{%|%\}/.test(value);
}

export function containsInstructionOverride(value: string): boolean {
  return INSTRUCTION_OVERRIDE.test(value);
}

/** Zod builder for any prompt-bearing text field. */
export function promptText(max: number) {
  return z.string().max(max).transform(value => sanitizePromptText(value))
    .refine(value => !containsProviderTemplateSyntax(value), { message: 'Template syntax ({{ }} or {% %}) is not allowed in clinic text.' })
    .refine(value => !containsInstructionOverride(value), { message: 'This text contains instruction-override phrasing and cannot be used in a voice prompt.' });
}

/** Optional prompt text where '' normalises to null (clearable fields). */
export function optionalPromptText(max: number) {
  return z.preprocess(value => (typeof value === 'string' && value.trim() === '' ? null : value), promptText(max).nullable().optional());
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** http(s) URL, max 300 chars; '' normalises to null. The prompt renders the hostname only. */
export const httpUrl = z.preprocess(
  value => (typeof value === 'string' && value.trim() === '' ? null : typeof value === 'string' ? value.trim() : value),
  z.string().max(300).refine(isHttpUrl, { message: 'Must be an http(s) URL.' }).nullable().optional(),
);

export function urlHostname(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname || null;
  } catch {
    return null;
  }
}
