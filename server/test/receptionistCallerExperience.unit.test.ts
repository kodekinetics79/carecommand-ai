import { describe, expect, it } from 'vitest';
import {
  buildRetellConfig,
  generateSampleTranscripts,
  generateSystemPrompt,
  inboundGreeting,
  openingTurn,
  type PromptConfig,
} from '../modules/receptionist/promptService';
import { promptFixture } from './fixtures/receptionistPromptConfigs';
import { PLATFORM_LOCALE_PACKS, platformLocalePack } from '../lib/receptionist/localePacks/defaults';
import { renderPackMessage, validateLocalePackStrings } from '../lib/receptionist/localePacks/render';
import { LOCALE_PACK_MESSAGE_KEYS } from '../lib/receptionist/localePacks/types';
import { speakTime } from '../lib/receptionist/availability';
import { DEGRADED_SAFE_TOOLS, inboundDegradePolicy, type InboundDegradeReason } from '../lib/receptionist/agentReadiness';
import { TENANT_MODE_DEMO_BLOCK } from '../lib/tenantMode';

// ===========================================================================
// Package C-words: what the caller actually hears.
//
// Every assertion here is about one sentence a patient is spoken, in both
// shipped locales. The four defects these cover all had the same shape — the
// code was already correct and the words were wrong:
//
//   C3  a privacy refusal ended the call
//   C4  the first thing a patient heard was an interrogation, then jargon
//   C6  a lapsed verification hung up on them
//   C10 hardcoded en-US wording, and a consent artefact recording words the
//       caller had never been read
//   C12 the front-desk queue's internal state, read aloud
//   C13 a preview turn that appeared nowhere in the deployed prompt
// ===========================================================================

const LOCALES = [
  { name: 'en-US', fixture: 'us-full' as const, language: 'en-US' as const, country: 'US' },
  { name: 'en-GB', fixture: 'gb-full' as const, language: 'en-GB' as const, country: 'GB' },
];

describe('locale packs carry every caller-facing sentence', () => {
  it('ships an approvable default for both locales, with no key defined in only one', () => {
    const keys = Object.keys(LOCALE_PACK_MESSAGE_KEYS).sort();
    for (const pack of PLATFORM_LOCALE_PACKS) {
      expect(validateLocalePackStrings(pack.strings).issues, `${pack.language}/${pack.country}`).toEqual([]);
      expect(Object.keys(pack.strings.messages).sort(), `${pack.language}/${pack.country}`).toEqual(keys);
    }
  });

  it('names a key for every degrade reason the policy can produce', () => {
    const reasons: InboundDegradeReason[] = [
      'agent_inactive', 'agent_unlinked', 'agent_unverified', 'agent_configuration_changed', 'agent_verification_stale',
      'provider_deployment_drift', 'provider_deployment_ambiguous',
      'provider_deployment_unverified_or_stale', 'provider_deployment_evidence_missing',
    ];
    for (const reason of reasons) {
      const { messageKey } = inboundDegradePolicy(reason);
      for (const pack of PLATFORM_LOCALE_PACKS) {
        // A degrade with no words is the silence C6 exists to remove.
        expect(pack.strings.messages[messageKey], `${pack.language} ${messageKey}`).toBeTruthy();
      }
    }
  });

  it('offers a person on every admission denial, including the demo-mode refusal', () => {
    // A demo workspace must never take a patient call, but the caller who
    // dialled still hears why and what to do (TENANT_MODE_DEMO_BLOCK).
    expect(TENANT_MODE_DEMO_BLOCK).toBe('tenant_mode_demo');
    for (const pack of PLATFORM_LOCALE_PACKS) {
      expect(pack.strings.messages['admission.denied.demo']).toMatch(/demonstration/i);
      expect(pack.strings.messages['admission.denied.capacity']).toMatch(/front desk|reception/i);
      expect(pack.strings.messages['admission.denied.unavailable']).toMatch(/front desk|reception/i);
    }
  });

  it('never leaves the caller reading a machine’s clock', () => {
    const us = platformLocalePack('en-US', 'US')!.strings;
    const gb = platformLocalePack('en-GB', 'GB')!.strings;
    expect(speakTime('14:30', { language: 'en-US', timeStyle: us.timeStyle, dateStyle: us.dateStyle })).toBe('2:30 PM');
    expect(speakTime('14:30', { language: 'en-GB', timeStyle: gb.timeStyle, dateStyle: gb.dateStyle })).toBe('14:30');
    expect(speakTime('09:00', { language: 'en-GB', timeStyle: gb.timeStyle, dateStyle: gb.dateStyle })).toBe('09:00');
    // With no resolved pack the pre-C10 form is kept rather than guessed at.
    expect(speakTime('14:30')).toBe('2:30 PM');
  });
});

for (const locale of LOCALES) {
  describe(`the opening turn (${locale.name})`, () => {
    const config: PromptConfig = promptFixture(locale.fixture);
    const strings = config.localePack.strings;

    // C4 — the caller used to hear the consent question first, with no
    // greeting anywhere in the tree.
    it('greets the caller before asking them to agree to anything', () => {
      const turn = openingTurn(config);
      expect(turn.startsWith(inboundGreeting(config))).toBe(true);
      expect(inboundGreeting(config)).toContain(config.clinic.name);
      expect(turn).toContain('This call may be recorded');
      // ...and the turn still ends on the consent question, so the agent stops.
      expect(turn.endsWith('Is that okay?')).toBe(true);
      expect(turn.match(/Is that okay\?/g)).toHaveLength(1);
    });

    it('publishes exactly that turn as the provider begin message and shows it in the preview', () => {
      const built = buildRetellConfig(config, { webhookBaseUrl: 'https://api.example.test' });
      expect(built.beginMessage).toBe(openingTurn(config));
      // C13 — the preview cannot drift from the deployment, because it is the
      // same rendered artefact and not a hand-written turn.
      expect(generateSampleTranscripts(config).openingSequence[0].text).toBe(built.beginMessage);
    });

    it('leaves the caller a warm hand-back instead of retention jargon', () => {
      const prompt = generateSystemPrompt(config);
      expect(prompt).toContain(renderPackMessage(strings, 'consent.granted.ack'));
      // The sentence a patient used to hear second.
      expect(prompt).not.toMatch(/metadata-only unless the approved retention workflow applies/i);
    });

    // C3 — the frozen contract's REFUSED branch, in both locales.
    it('continues the call when recording is refused', () => {
      const prompt = generateSystemPrompt(config);
      expect(prompt).toContain(renderPackMessage(strings, 'consent.refused.continue'));
      expect(prompt).toMatch(/THE CALL CONTINUES/);
      expect(prompt).not.toMatch(/this AI line cannot continue/i);
      expect(prompt).not.toMatch(/provide the human fallback option, and end the call/i);
      // Only an explicit objection to the AI routes away.
      expect(prompt).toContain(renderPackMessage(strings, 'consent.declined.route'));
    });

    // C13 — the refusal branch is previewable, and the preview shows a call
    // that keeps going.
    it('previews the refusal branch as a call that keeps helping', () => {
      const spoken = generateSampleTranscripts(config).recordingRefusedSample
        .filter(turn => turn.speaker === 'agent')
        .map(turn => turn.text);
      expect(spoken).toContain(renderPackMessage(strings, 'consent.refused.continue'));
      expect(spoken.join(' ')).not.toMatch(/cannot continue|end the call/i);
    });
  });
}

describe('the two locales are genuinely different, not one translated badly', () => {
  it('speaks each jurisdiction’s own front desk, clock and emergency number', () => {
    const us = generateSystemPrompt(promptFixture('us-full'));
    const gb = generateSystemPrompt(promptFixture('gb-full'));
    expect(us).toContain('911');
    expect(gb).toContain('999');
    expect(us).toContain("You've reached the front desk");
    expect(gb).toContain("You've reached reception");
    const gbStrings = platformLocalePack('en-GB', 'GB')!.strings;
    const usStrings = platformLocalePack('en-US', 'US')!.strings;
    expect(usStrings.messages['handoff.spoken']).toContain('front desk');
    expect(gbStrings.messages['handoff.spoken']).toContain('reception');
  });
});

describe('the handoff says nothing about our queue', () => {
  // C12 — "I created a request in the front desk queue. Staff have not
  // acknowledged it yet... no transfer has occurred yet" is the sentence an
  // angry caller heard at the exact moment they asked for a human.
  it('keeps task state, acknowledgment state and transfer state out of the spoken line', () => {
    for (const pack of PLATFORM_LOCALE_PACKS) {
      for (const key of ['handoff.spoken', 'handoff.no_transfer'] as const) {
        const line = pack.strings.messages[key];
        expect(line, `${pack.language} ${key}`).toBeTruthy();
        expect(line, `${pack.language} ${key}`).not.toMatch(/queue|task|acknowledg|no transfer has occurred/i);
      }
      // ...and it still never promises a transfer that has not happened.
      expect(pack.strings.messages['handoff.spoken']).not.toMatch(/you are being transferred|putting you through now/i);
    }
  });

  it('says out loud that the tool result is not for the caller', () => {
    const prompt = generateSystemPrompt(promptFixture('us-full'));
    expect(prompt).toMatch(/Never read our internal state to a caller/i);
    expect(prompt).toMatch(/This configuration uses a cold transfer/i);
    expect(prompt).toMatch(/do not claim that you can speak to the staff member before leaving the call/i);
  });
});

describe('the degrade contract is the one the handler ships', () => {
  it('keeps take_message on the floor the receptionist degrades to', () => {
    // C6 — take_message was deployment-bound, so a lapsed verification left
    // the caller with no tool at all and the handler hung up on them.
    expect(DEGRADED_SAFE_TOOLS).toContain('take_message');
    expect(DEGRADED_SAFE_TOOLS).toContain('request_human_handoff');
    expect(DEGRADED_SAFE_TOOLS).toContain('report_emergency');
    // Nothing on this list reads or writes a patient record.
    expect(DEGRADED_SAFE_TOOLS).not.toContain('book_appointment');
    expect(DEGRADED_SAFE_TOOLS).not.toContain('verify_patient_identity');
  });
});
