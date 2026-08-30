import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PACK_STRING_LINT_FILES } from './fixtures/receptionistHardcodedMessages';
import { PLATFORM_LOCALE_PACKS } from '../lib/receptionist/localePacks/defaults';
import { validateLocalePackStrings } from '../lib/receptionist/localePacks/render';
import type { LocalePackStrings } from '../lib/receptionist/localePacks/types';
import {
  PROHIBITED_CALLER_INSTRUCTIONS,
  findProhibitedCallerInstructions,
  prohibitedPhraseRule,
} from '../lib/receptionist/prohibitedPhrases';
import { generateSystemPrompt } from '../modules/receptionist/promptService';
import { promptFixture, type PromptFixtureName } from './fixtures/receptionistPromptConfigs';

// ===========================================================================
// The receptionist never tells a caller to change how they speak.
//
// In August 2026 a South Yorkshire GP surgery withdrew its AI receptionist
// after a 71-year-old stroke survivor tried five times to book an appointment
// and gave up. Her speech was fragmented; the line asked her not to use
// speakerphone, which she needed because she could hold the handset with only
// one hand. Healthwatch Rotherham has since logged the same complaint from
// patients with regional accents and speech impairments.
//
// That sentence was not malicious. Somebody wrote it trying to be helpful, and
// nothing in the product disagreed with them — which is why the rule cannot be
// a paragraph in a style guide. This suite is the mechanism: the phrase cannot
// enter through a locale pack, through a hardcoded tool message, or through the
// prompt, and a tenant cannot type one into the Studio and approve it.
//
// Sibling of `receptionistPackStrings.lint.test.ts`, deliberately: that one
// enforces WHERE caller-facing words live, this one enforces WHAT they may say.
// ===========================================================================

function read(file: string): string {
  return readFileSync(resolve(process.cwd(), file), 'utf8');
}

/** Same extractor as the C10 pack lint: every literal assigned to `message:`. */
function messageLiterals(source: string): Array<{ line: number; text: string }> {
  const found: Array<{ line: number; text: string }> = [];
  const opener = /\bmessage:\s*(['"`])/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    const quote = match[1];
    let index = match.index + match[0].length;
    let text = '';
    while (index < source.length) {
      const char = source[index];
      if (char === '\\') { text += source[index] + source[index + 1]; index += 2; continue; }
      if (char === quote) break;
      text += char;
      index += 1;
    }
    found.push({ line: source.slice(0, match.index).split('\n').length, text });
  }
  return found;
}

const FIXTURES: PromptFixtureName[] = ['us-full', 'gb-full', 'minimal-no-knowledge', 'multi-location'];

describe('the receptionist never asks the caller to adapt', () => {
  it('ships no platform locale-pack string that instructs a caller about their speech, device or surroundings', () => {
    const offenders: string[] = [];
    for (const pack of PLATFORM_LOCALE_PACKS) {
      for (const [key, template] of Object.entries(pack.strings.messages)) {
        for (const id of findProhibitedCallerInstructions(template)) {
          offenders.push(`${pack.language}/${pack.country} ${key} (${id}): ${JSON.stringify(template)}`);
        }
      }
    }
    expect(offenders, [
      'A locale pack tells a caller to change how they speak, what they are calling',
      'from, or where they are. That is the failure that ended a real deployment.',
      'Hand the caller to a person instead; never ask them to adapt.',
      ...offenders.map(row => `  ${row}`),
    ].join('\n')).toEqual([]);
  });

  it('ships no hardcoded tool message that does either', () => {
    const offenders: string[] = [];
    for (const file of PACK_STRING_LINT_FILES) {
      for (const literal of messageLiterals(read(file))) {
        for (const id of findProhibitedCallerInstructions(literal.text)) {
          offenders.push(`${file}:${literal.line} (${id}) ${JSON.stringify(literal.text)}`);
        }
      }
    }
    expect(offenders, `A live-tool message instructs the caller to adapt:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('states the ban in the prompt, and states it nowhere else', () => {
    const rule = prohibitedPhraseRule();
    for (const name of FIXTURES) {
      const prompt = generateSystemPrompt(promptFixture(name));
      // The model is told, in the assembled prompt, using the same list this
      // suite enforces — so the rule and its enforcement cannot drift apart.
      expect(prompt, name).toContain(rule);

      // Everything OUTSIDE that one line must be clean. This is what catches a
      // future engineer adding "ask them to speak more clearly" to an
      // accessibility bullet with the best of intentions.
      const rest = prompt.split(rule).join('\n');
      const leaked = findProhibitedCallerInstructions(rest);
      expect(leaked, `${name}: the prompt instructs the caller to adapt outside the prohibition rule (${leaked.join(', ')})`).toEqual([]);
    }
  });

  it('names every banned phrase in the rule the model reads', () => {
    const rule = prohibitedPhraseRule();
    expect(PROHIBITED_CALLER_INSTRUCTIONS.length).toBeGreaterThanOrEqual(10);
    for (const entry of PROHIBITED_CALLER_INSTRUCTIONS) {
      expect(rule, `${entry.id} is banned but never shown to the model`).toContain(entry.example);
      // The list has to actually match its own examples, or it bans nothing.
      expect(findProhibitedCallerInstructions(entry.example), entry.id).toContain(entry.id);
    }
  });

  it('refuses to approve a tenant pack that contains one', () => {
    // The lint guards CI. This guards the path that reaches a patient: a
    // practice manager typing a "helpful" sentence into the Studio.
    const base = PLATFORM_LOCALE_PACKS.find(pack => pack.language === 'en-US')!;
    for (const sentence of [
      "I'm having trouble hearing you — could you take me off speakerphone?",
      'Could you speak more clearly for me?',
      'Try moving somewhere quieter and call us back.',
      'Please hold the phone closer to your mouth.',
    ]) {
      const strings: LocalePackStrings = structuredClone(base.strings);
      strings.messages['not_interested.line'] = sentence;
      const result = validateLocalePackStrings(strings);
      expect(result.ok, `approved: ${sentence}`).toBe(false);
      expect(result.issues.map(issue => issue.message).join(' ')).toMatch(/change how they speak/i);
    }
  });

  it('still approves a pack that apologises without blaming the caller', () => {
    // The ban is on instructing the caller, not on admitting we did not hear.
    // A rule that also forbids "I'm sorry, I didn't catch that" would push
    // every engineer back toward blaming the patient instead.
    const base = PLATFORM_LOCALE_PACKS.find(pack => pack.language === 'en-US')!;
    const strings: LocalePackStrings = structuredClone(base.strings);
    strings.messages['not_interested.line'] = "I'm sorry, that's my fault — I didn't catch that. Let me put you through to a person.";
    expect(validateLocalePackStrings(strings).issues).toEqual([]);
  });
});
