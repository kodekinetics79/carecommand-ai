import { createHash } from 'node:crypto';
import { z } from 'zod';
import { containsInstructionOverride, sanitizePromptText } from '../promptSafety';
import {
  DATE_STYLES,
  LOCALE_PACK_MESSAGE_KEYS,
  TIME_STYLES,
  type LocaleFormat,
  type LocalePackMessageKey,
  type LocalePackStrings,
} from './types';

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const MAX_MESSAGE_LENGTH = 600;

export function placeholdersIn(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER_RE)].map(match => match[1]);
}

/**
 * Resolve every `{{var}}` in a pack string. Throws when a placeholder has no
 * value: the renderer is the last line before text reaches a prompt or a
 * caller, and an unresolved placeholder there is a configuration defect, not
 * something to speak aloud.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER_RE, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`locale_pack_placeholder_unresolved:${name}`);
    return value;
  });
}

export function renderPackMessage(strings: LocalePackStrings, key: LocalePackMessageKey, vars: Record<string, string> = {}): string {
  const template = strings.messages[key];
  if (typeof template !== 'string') throw new Error(`locale_pack_message_missing:${key}`);
  return renderTemplate(template, vars);
}

/** Stable JSON (sorted object keys) so a hash depends on content, not key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, sortKeys((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export function localePackEvidenceHash(strings: LocalePackStrings): string {
  return createHash('sha256').update(canonicalJson(strings)).digest('hex');
}

export interface LocalePackIssue { path: string; message: string }

/**
 * Content rules a pack must satisfy before it may be approved (and that a
 * platform default must satisfy in its snapshot test). Structural shape is
 * checked by `localePackStringsSchema`; this is the semantic layer.
 */
export function validateLocalePackStrings(strings: LocalePackStrings): { ok: boolean; issues: LocalePackIssue[] } {
  const issues: LocalePackIssue[] = [];
  if (!/^\d{2,4}$/.test(strings.emergencyNumber)) issues.push({ path: 'emergencyNumber', message: 'Emergency number must be 2 to 4 digits.' });
  if (!TIME_STYLES.includes(strings.timeStyle)) issues.push({ path: 'timeStyle', message: 'Unsupported time style.' });
  if (!DATE_STYLES.includes(strings.dateStyle)) issues.push({ path: 'dateStyle', message: 'Unsupported date style.' });
  const known = LOCALE_PACK_MESSAGE_KEYS as Record<string, { vars: readonly string[]; mustContain?: readonly string[] }>;
  for (const key of Object.keys(known)) {
    if (typeof strings.messages[key] !== 'string' || !strings.messages[key].trim()) issues.push({ path: `messages.${key}`, message: 'Required message is missing.' });
  }
  for (const [key, template] of Object.entries(strings.messages)) {
    const contract = known[key];
    if (!contract) { issues.push({ path: `messages.${key}`, message: 'Unknown message key.' }); continue; }
    if (typeof template !== 'string') { issues.push({ path: `messages.${key}`, message: 'Message must be text.' }); continue; }
    if (template.length > MAX_MESSAGE_LENGTH) issues.push({ path: `messages.${key}`, message: `Message exceeds ${MAX_MESSAGE_LENGTH} characters.` });
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(template)) issues.push({ path: `messages.${key}`, message: 'Message contains control characters.' });
    if (/\{%|%\}/.test(template) || /\{\{(?!\s*[A-Za-z0-9_]+\s*\}\})/.test(template)) issues.push({ path: `messages.${key}`, message: 'Only {{variable}} placeholders are allowed.' });
    if (containsInstructionOverride(template)) issues.push({ path: `messages.${key}`, message: 'Message contains instruction-override phrasing.' });
    const used = placeholdersIn(template);
    for (const name of used) {
      if (!contract.vars.includes(name)) issues.push({ path: `messages.${key}`, message: `Placeholder {{${name}}} is not allowed here (allowed: ${contract.vars.join(', ') || 'none'}).` });
    }
    for (const name of contract.mustContain ?? []) {
      if (!used.includes(name)) issues.push({ path: `messages.${key}`, message: `Message must contain {{${name}}}.` });
    }
  }
  return { ok: issues.length === 0, issues };
}

/** Structural Zod schema for API input. Strings keep their placeholders; content rules run separately. */
export const localePackStringsSchema = z.object({
  emergencyNumber: z.string().trim().regex(/^\d{2,4}$/, 'Emergency number must be 2 to 4 digits.'),
  timeStyle: z.enum(['12h', '24h']),
  dateStyle: z.enum(['weekday-month-day', 'weekday-day-month']),
  messages: z.record(z.string().min(1).max(80), z.string().max(MAX_MESSAGE_LENGTH).transform(value => sanitizePromptText(value, { keepPlaceholders: true }))),
}).strict();

/** Runtime guard for JSON read back from the database. */
export function isLocalePackStrings(value: unknown): value is LocalePackStrings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.emergencyNumber === 'string'
    && TIME_STYLES.includes(candidate.timeStyle as never)
    && DATE_STYLES.includes(candidate.dateStyle as never)
    && !!candidate.messages && typeof candidate.messages === 'object' && !Array.isArray(candidate.messages)
    && Object.values(candidate.messages as Record<string, unknown>).every(item => typeof item === 'string');
}

export function localeFormatOf(strings: LocalePackStrings, language: string): LocaleFormat {
  return { language, timeStyle: strings.timeStyle, dateStyle: strings.dateStyle };
}

/** Merge partial overrides onto a source pack; messages merge key-by-key. */
export function mergeLocalePackStrings(base: LocalePackStrings, overrides?: Partial<LocalePackStrings> | null): LocalePackStrings {
  return {
    emergencyNumber: overrides?.emergencyNumber ?? base.emergencyNumber,
    timeStyle: overrides?.timeStyle ?? base.timeStyle,
    dateStyle: overrides?.dateStyle ?? base.dateStyle,
    messages: { ...base.messages, ...(overrides?.messages ?? {}) },
  };
}
