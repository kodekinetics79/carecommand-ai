import { describe, expect, it } from 'vitest';
import { unconfirmedOutcomeClaims, hasUnconfirmedOutcomeClaims } from '../lib/receptionist/outcomeTruth';
import { platformLocalePack } from '../lib/receptionist/localePacks/defaults';
import { validateLocalePackStrings } from '../lib/receptionist/localePacks/render';

describe('request-only outcome wording', () => {
  it.each([
    ['tool.message.recorded', 'The team will call you back.', 'unconfirmed_callback'],
    ['emergency.callback.line', 'Someone will call you straight back.', 'unconfirmed_callback'],
    ['emergency.transfer.line', 'Stay on the line; I am connecting you now.', 'emergency_exit_delayed'],
  ])('rejects %s: %s', (key, text, issue) => {
    expect(unconfirmedOutcomeClaims(key, text)).toContain(issue);
    const strings = structuredClone(platformLocalePack('en-US', 'US')!.strings);
    strings.messages[key] = text;
    expect(validateLocalePackStrings(strings).ok).toBe(false);
    expect(hasUnconfirmedOutcomeClaims(strings.messages)).toBe(true);
  });

  it('accepts truthful requests and immediate emergency instructions', () => {
    for (const pair of [['en-US', 'US'], ['en-GB', 'GB']]) {
      const pack = platformLocalePack(pair[0], pair[1])!;
      expect(hasUnconfirmedOutcomeClaims(pack.strings.messages)).toBe(false);
    }
    expect(unconfirmedOutcomeClaims('tool.message.recorded', 'I have recorded your request. I cannot confirm a callback or response time.')).toEqual([]);
  });
});
