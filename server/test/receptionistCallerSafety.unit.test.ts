import { describe, expect, it } from 'vitest';

import {
  buildRetellConfig,
  closingDisclosureEvidenceHash,
  generateSystemPrompt,
  mandatoryClosingDisclosure,
  mandatoryOpeningDisclosure,
} from '../modules/receptionist/promptService';
import { promptFixture, type PromptFixtureName } from './fixtures/receptionistPromptConfigs';
import { PLATFORM_LOCALE_PACKS } from '../lib/receptionist/localePacks/defaults';
import { LOCALE_PACK_MESSAGE_KEYS } from '../lib/receptionist/localePacks/types';
import { MAX_UNPARSEABLE_TURNS, comprehensionDecision } from '../lib/receptionist/comprehension';
import { findProhibitedCallerInstructions } from '../lib/receptionist/prohibitedPhrases';

const FIXTURES: PromptFixtureName[] = ['us-full', 'gb-full', 'minimal-no-knowledge', 'multi-location'];

// ===========================================================================
// Caller safety — the parts that are pure functions of the configuration.
//
// Two items live here because they have to be true before any database exists:
// the closing disclosure (California AB 3030 requires the AI disclaimer at the
// END of an audio clinical interaction as well as the start, and our packs had
// no closing key at all), and the comprehension ceiling (the rule that the
// receptionist stops after two turns it cannot parse, expressed as arithmetic
// so it can be reasoned about rather than hoped for).
// ===========================================================================

describe('the closing AI disclosure (California AB 3030)', () => {
  it('is a first-class, required key in every platform pack', () => {
    // Not an optional extra a clinic may leave blank. The key is in the
    // contract, so `validateLocalePackStrings` requires it of every pack, in
    // exactly the way the opening disclosure is required.
    expect(LOCALE_PACK_MESSAGE_KEYS).toHaveProperty('disclosure.closing');
    for (const pack of PLATFORM_LOCALE_PACKS) {
      const closing = pack.strings.messages['disclosure.closing'];
      expect(closing, `${pack.language}/${pack.country}`).toBeTruthy();
      // AB 3030 requires the disclaimer AND clear instructions for reaching a
      // human, so the closing line has to do both jobs.
      expect(closing, `${pack.language}/${pack.country} must name the AI`).toMatch(/AI assistant/i);
      expect(closing, `${pack.language}/${pack.country} must say how to reach a person`).toMatch(/person|reception|front desk/i);
    }
  });

  it('renders the clinic and the agent by name, in the caller’s own locale', () => {
    const us = mandatoryClosingDisclosure(promptFixture('us-full'));
    const gb = mandatoryClosingDisclosure(promptFixture('gb-full'));
    expect(us).toContain('Avery');
    expect(us).toContain('Example Clinic');
    expect(gb).toContain('Harley Street Practice');
    // An en-GB caller is not read US front-desk vocabulary.
    expect(gb).toContain('reception');
    expect(us).not.toBe(gb);
    // No unresolved placeholder ever reaches a caller.
    expect(us).not.toContain('{{');
    expect(gb).not.toContain('{{');
  });

  it('is hashed as evidence, exactly like the opening disclosure', () => {
    // The point of the hash is that months later we can prove which words a
    // caller was actually read. Decorative text does not get one.
    const config = promptFixture('us-full');
    const hash = closingDisclosureEvidenceHash(mandatoryClosingDisclosure(config));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toBe(closingDisclosureEvidenceHash(mandatoryOpeningDisclosure(config)));
    // Same words in, same hash out — reproducible, not incidental.
    expect(closingDisclosureEvidenceHash(mandatoryClosingDisclosure(config))).toBe(hash);
  });

  it('is a required FINAL turn in the prompt, on every configuration', () => {
    for (const name of FIXTURES) {
      const config = promptFixture(name);
      const prompt = generateSystemPrompt(config);
      expect(prompt, name).toContain('# Closing turn (say this last, word for word, on every call)');
      expect(prompt, name).toContain(mandatoryClosingDisclosure(config));
      // "Required" has to be said in words a model cannot read as advisory.
      expect(prompt, name).toMatch(/not optional, not shortenable and not paraphrasable/i);
      expect(prompt, name).toMatch(/final thing the caller hears/i);
    }
  });

  it('ships with the deployment as its own field, not buried in prose', () => {
    // Rehearsal renders it, the deployment carries it, and an auditor can read
    // it without parsing a system prompt.
    for (const name of FIXTURES) {
      const config = promptFixture(name);
      const built = buildRetellConfig(config, { webhookBaseUrl: 'https://api.example.test' });
      expect(built.closingMessage, name).toBe(mandatoryClosingDisclosure(config));
      expect(built.closingMessage, name).not.toBe(built.beginMessage);
    }
  });
});

describe('the comprehension ceiling', () => {
  it('stops at two, because the third attempt is the one that made a patient give up', () => {
    // From the August 2026 incident review: a stroke survivor tried five times
    // and gave up. Two is the ceiling, and it is a number in one place.
    expect(MAX_UNPARSEABLE_TURNS).toBe(2);
    expect(comprehensionDecision(1)).toMatchObject({ outcome: 'retry', bailOut: false, attemptsRemaining: 1 });
    expect(comprehensionDecision(2)).toMatchObject({ outcome: 'bail_out', bailOut: true, attemptsRemaining: 0 });
  });

  it('never offers a retry once the ceiling is reached, however many times it is asked', () => {
    // The property the whole design turns on. A confident model asking a fourth
    // and fifth time must still be told no, and `attemptsRemaining` must never
    // go negative and wrap into something a caller pays for.
    for (const turns of [2, 3, 4, 5, 9, 40]) {
      const decision = comprehensionDecision(turns);
      expect(decision.bailOut, `turn ${turns}`).toBe(true);
      expect(decision.outcome, `turn ${turns}`).toBe('bail_out');
      expect(decision.attemptsRemaining, `turn ${turns}`).toBe(0);
    }
  });

  it('treats nonsense counts as safely as it treats real ones', () => {
    expect(comprehensionDecision(0)).toMatchObject({ outcome: 'retry', attemptsRemaining: 2 });
    expect(comprehensionDecision(-3)).toMatchObject({ outcome: 'retry', unparseableTurns: 0 });
    expect(comprehensionDecision(2.7)).toMatchObject({ outcome: 'bail_out', unparseableTurns: 2 });
  });

  it('says nothing that asks the caller to change how they speak', () => {
    // The three comprehension lines are the exact place the Rotherham failure
    // happened: the moment the line did not understand somebody. Every one of
    // them, in every language, has to apologise without instructing.
    for (const pack of PLATFORM_LOCALE_PACKS) {
      for (const key of ['comprehension.retry', 'comprehension.bail_out.transfer', 'comprehension.bail_out.callback'] as const) {
        const text = pack.strings.messages[key];
        expect(text, `${pack.language} ${key}`).toBeTruthy();
        expect(findProhibitedCallerInstructions(text), `${pack.language} ${key}`).toEqual([]);
        // It apologises, and it puts the failure where it belongs.
        expect(text, `${pack.language} ${key}`).toMatch(/sorry/i);
      }
    }
  });

  it('tells the agent, in the prompt, that there is no third attempt', () => {
    for (const name of FIXTURES) {
      const prompt = generateSystemPrompt(promptFixture(name));
      expect(prompt, name).toContain('# When you cannot understand the caller');
      expect(prompt, name).toContain('report_comprehension_failure');
      expect(prompt, name).toMatch(/There is no third attempt\./);
      expect(prompt, name).toMatch(/do not argue with a result that says bail_out/i);
    }
  });
});

describe('the emergency path and pre-answer routing appear in the prompt', () => {
  it('tells the agent to act on the emergency result during the call, not to file a task and stop', () => {
    for (const name of FIXTURES) {
      const prompt = generateSystemPrompt(promptFixture(name));
      expect(prompt, name).toMatch(/DO WHAT ITS next_action FIELD SAYS, on this call, while the caller is still on the line/);
      // The reason, stated where somebody editing this will read it.
      expect(prompt, name).toMatch(/not handled by a task appearing on a screen/i);
    }
  });

  it('reads the routing state before it reads the opening turn', () => {
    for (const name of FIXTURES) {
      const prompt = generateSystemPrompt(promptFixture(name));
      const routing = prompt.indexOf('# Before anything else: is this call yours to handle?');
      const opening = prompt.indexOf('# Opening turn');
      expect(routing, name).toBeGreaterThanOrEqual(0);
      expect(routing, `${name}: routing must be read before the opening turn`).toBeLessThan(opening);
      expect(prompt, name).toContain('"human_only"');
      expect(prompt, name).toContain('"repeat_caller"');
      expect(prompt, name).toMatch(/do not take a single turn of front-desk work/i);
    }
  });
});
