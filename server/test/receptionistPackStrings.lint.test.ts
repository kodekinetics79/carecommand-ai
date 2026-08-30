import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { HARDCODED_CALLER_MESSAGES, PACK_STRING_LINT_FILES } from './fixtures/receptionistHardcodedMessages';

// ===========================================================================
// No caller-facing words in code.
//
// Contract §2 makes locale packs the single source of everything a patient
// hears. The reason is not tidiness:
//
//   · an en-GB caller hearing "On 2026-09-03 I have 9:00 AM" is hearing a US
//     product read a database column out loud;
//   · `privacyLifecycle.ts` hashes the disclosure as consent evidence, so when
//     the code says one thing and the deployed pack says another, the consent
//     artefact records wording the caller never heard. That is the first
//     document a pilot's DPO asks for;
//   · a clinic cannot change a sentence its patients hear without a deploy.
//
// Today about 80% of the receptionist's spoken lines are literals in
// TypeScript. This lint does not pretend otherwise. It writes the debt down
// (`server/test/fixtures/receptionistHardcodedMessages.ts`) and makes it a
// ONE-WAY ratchet:
//
//   · a `message:` literal that is not on the list fails the suite;
//   · migrating one to `renderPackMessage(strings, 'tool.…')` simply removes
//     it from the source, and the list entry becomes unused;
//   · the pack-render count may not go down.
//
// So the number can only fall. Package C owns C10 and takes the booking /
// availability / handoff / consent path first.
// ===========================================================================

/**
 * Every string literal assigned to a `message:` field, normalised. Template
 * literals count — an interpolated sentence is still a sentence written in
 * en-US inside a code file — and their `${…}` holes are collapsed so the
 * entry stays stable when a variable is renamed.
 */
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
      if (quote === '`' && char === '$' && source[index + 1] === '{') {
        let depth = 1;
        let cursor = index + 2;
        while (cursor < source.length && depth > 0) {
          if (source[cursor] === '{') depth += 1;
          else if (source[cursor] === '}') depth -= 1;
          cursor += 1;
        }
        text += '${…}';
        index = cursor;
        continue;
      }
      text += char;
      index += 1;
    }
    found.push({
      line: source.slice(0, match.index).split('\n').length,
      text: text.replace(/\s+/g, ' ').trim(),
    });
  }
  return found;
}

/**
 * The pack renders that exist today. A migration only ever adds calls, so this
 * floor going down means a caller-facing string moved back into code.
 */
const PACK_RENDER_FLOOR: Record<string, number> = {
  'server/lib/receptionist/liveTools.ts': 3,
  'server/modules/receptionist/webhooks.ts': 0,
};

function read(file: string): string {
  return readFileSync(resolve(process.cwd(), file), 'utf8');
}

describe('caller-facing strings live in locale packs, not in code (C10)', () => {
  it('scans the files the receptionist actually speaks from', () => {
    expect(PACK_STRING_LINT_FILES.length).toBeGreaterThan(0);
    for (const file of PACK_STRING_LINT_FILES) {
      expect(read(file).length, `${file} is empty or missing`).toBeGreaterThan(0);
    }
  });

  it('fails on any message: literal that is not already on the C10 debt list', () => {
    const offenders: string[] = [];
    for (const file of PACK_STRING_LINT_FILES) {
      const allowed = new Set(HARDCODED_CALLER_MESSAGES[file] ?? []);
      for (const literal of messageLiterals(read(file))) {
        if (!allowed.has(literal.text)) offenders.push(`${file}:${literal.line}  ${JSON.stringify(literal.text)}`);
      }
    }
    expect(offenders, [
      'A caller-facing sentence was written in code.',
      '',
      'Put it in the locale pack instead:',
      "  renderPackMessage(strings, 'tool.<something>', { … })",
      'and add the key to server/lib/receptionist/localePacks/defaults.ts for',
      'every platform language. Keep durable evidence in structured fields, not',
      'in `message`.',
      '',
      'New literals:',
      ...offenders.map(row => `  ${row}`),
    ].join('\n')).toEqual([]);
  });

  it('never lets the pack-render count fall', () => {
    for (const [file, floor] of Object.entries(PACK_RENDER_FLOOR)) {
      const renders = (read(file).match(/renderPackMessage\(/g) ?? []).length;
      expect(renders, `${file} lost a locale-pack render`).toBeGreaterThanOrEqual(floor);
    }
  });

  it('keeps the debt list a ceiling, never a target', () => {
    // The list is generated from the tree as it was found. It may shrink to
    // nothing; it may never grow. This assertion is what makes the two
    // statements above a ratchet rather than a snapshot.
    const listed = Object.values(HARDCODED_CALLER_MESSAGES).reduce((total, rows) => total + rows.length, 0);
    expect(listed, 'the C10 debt list grew — a new hardcoded sentence was added').toBeLessThanOrEqual(59);
  });

  it('reports how much of the caller experience still ships in code', () => {
    // Not an assertion about a number, but the number itself, printed where a
    // reviewer sees it: the whole point of the pack architecture is that this
    // reaches zero.
    const remaining = PACK_STRING_LINT_FILES.map(file => ({
      file,
      literals: messageLiterals(read(file)).length,
      renders: (read(file).match(/renderPackMessage\(/g) ?? []).length,
    }));
    for (const row of remaining) {
      expect(row.literals, `${row.file}`).toBeGreaterThanOrEqual(0);
    }
    console.log('[C10] caller-facing literals still in code:', remaining
      .map(row => `${row.file.split('/').pop()} ${row.literals} literal(s) / ${row.renders} pack render(s)`)
      .join(' · '));
  });
});
