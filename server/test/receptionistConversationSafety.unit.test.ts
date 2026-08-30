import { describe, expect, it } from 'vitest';
import {
  RECORDING_DISCLOSURE_EVIDENCE_TEMPLATE,
  renderRecordingDisclosure,
} from '../lib/receptionist/privacyLifecycle';
import {
  buildRetellConfig,
  generateSystemPrompt,
  type PromptConfig,
} from '../modules/receptionist/promptService';
import { promptFixture } from './fixtures/receptionistPromptConfigs';
import { EN_US } from './fixtures/receptionistPackStrings';

const fixture = promptFixture('us-full');
const baseConfig: PromptConfig = {
  ...fixture,
  clinic: {
    ...fixture.clinic,
    complianceDisclosure: 'State-specific supplemental notice.',
    doNotContactPolicy: 'Record the suppression immediately and end the call.',
  },
  agent: { ...fixture.agent, greetingOverride: 'Welcome to our scheduling line.' },
  campaign: { ...fixture.campaign, campaignType: 'reactivation', offerDescription: 'Schedule a visit.', offerScript: 'Would you like to schedule?', eligibleLocationIds: ['branch-1'] },
  locations: [{ id: 'branch-1', name: 'Main', address: '1 Main St' }],
  hours: { clinicSummary: fixture.hours!.clinicSummary, perLocation: [{ id: 'branch-1', summary: fixture.hours!.clinicSummary, closures: [] }] },
};

describe('AI receptionist conversation safety contract', () => {
  it('renders all supplemental disclosure text before one final consent question', () => {
    const disclosure = renderRecordingDisclosure({
      agentName: 'Avery',
      clinicName: 'Example Clinic',
      clinicDisclosure: 'State-specific supplemental notice.',
    });

    expect(disclosure).toBe(
      "Hi, I'm Avery, an AI assistant for Example Clinic. This call may be recorded or monitored for quality and documentation. State-specific supplemental notice. Is that okay?",
    );
    expect(disclosure.match(/Is that okay\?/g)).toHaveLength(1);
    expect(RECORDING_DISCLOSURE_EVIDENCE_TEMPLATE.endsWith('{{clinic_disclosure}} Is that okay?')).toBe(true);
  });

  // C4 — the begin message used to be the consent question ALONE, so the first
  // thing a patient heard was an interrogation. It is now one turn that greets
  // first and still ends on the consent question, so the agent must stop and
  // wait. The greeting override still waits for consent.
  it('greets the caller in the same turn as the disclosure, and still ends on the consent question', () => {
    const built = buildRetellConfig(baseConfig, { webhookBaseUrl: 'https://api.example.test' });

    expect(built.beginMessage.startsWith('Thanks for calling Example Clinic.')).toBe(true);
    expect(built.beginMessage).toContain('This call may be recorded or monitored');
    expect(built.beginMessage.endsWith('Is that okay?')).toBe(true);
    // The campaign greeting override is still not spoken before consent.
    expect(built.beginMessage).not.toContain('Welcome to our scheduling line.');
    expect(built.systemPrompt).toMatch(/STOP SPEAKING after that question and wait/i);
    expect(built.systemPrompt).toMatch(/Silence, voicemail, ambiguity, or simply carrying on talking is not agreement to being recorded/i);
    expect(built.systemPrompt).toContain('You may then add: "Welcome to our scheduling line."');
  });

  // C3 — the prompt used to order the agent to "explain that this AI line
  // cannot continue ... and end the call" when a caller refused recording,
  // while the handler had always degraded safely. A patient exercising a
  // privacy right was refused service by their own clinic.
  it('continues the call when recording is refused, and never orders a hang-up', () => {
    const prompt = generateSystemPrompt(baseConfig);

    expect(prompt).toContain('# Consent — what each answer means');
    expect(prompt).toContain(EN_US.strings.messages['consent.refused.continue']);
    expect(prompt).toMatch(/THE CALL CONTINUES/);
    expect(prompt).toMatch(/Never end the call because recording was refused/i);
    expect(prompt).not.toMatch(/this AI line cannot continue/i);
    // Only an objection to the AI itself routes away (contract section 2).
    expect(prompt).toContain(EN_US.strings.messages['consent.declined.route']);
    expect(prompt).toMatch(/Never treat a refusal to be recorded as an objection to talking to you/i);
  });

  // C4 — the tool must not read its own result aloud; "This pilot remains
  // metadata-only unless the approved retention workflow applies" was the
  // second sentence a patient heard.
  it('does not let the consent tool speak its own result', () => {
    const consentTool = buildRetellConfig(baseConfig, { webhookBaseUrl: 'https://api.example.test' })
      .tools.find(tool => tool.name === 'record_recording_preference') as { speak_after_execution: boolean };
    expect(consentTool.speak_after_execution).toBe(false);
    expect(generateSystemPrompt(baseConfig)).toContain(EN_US.strings.messages['consent.granted.ack']);
  });

  it('gives emergency instructions absolute precedence over disclosure and tools', () => {
    const prompt = generateSystemPrompt(baseConfig);

    expect(prompt).toMatch(/Emergency instructions override disclosure completion, consent capture, greetings, identity checks, and every tool/i);
    expect(prompt).toMatch(/mentions a possible emergency at ANY point, interrupt what you are saying/i);
    expect(prompt).toMatch(/overrides finishing the disclosure or waiting for consent/i);
    expect(prompt.indexOf('Emergency precedence:')).toBeLessThan(prompt.indexOf('# Trusted call-direction branch'));
    const emergency = buildRetellConfig(baseConfig, { webhookBaseUrl: 'https://api.example.test' }).tools
      .find(tool => tool.name === 'report_emergency') as {
        speak_during_execution: boolean;
        parameters: { required: string[]; properties: Record<string, unknown> };
      };
    expect(emergency.speak_during_execution).toBe(false);
    expect(emergency.parameters.required).not.toContain('emergency_instruction_spoken');
    const providerProtocolTrace = [
      { kind: 'spoken', value: EN_US.emergencyInstruction },
      { kind: 'tool', value: 'report_emergency' },
      { kind: 'terminated', value: 'emergency_flow' },
    ];
    expect(providerProtocolTrace[0]).toMatchObject({ kind: 'spoken', value: expect.stringContaining(EN_US.emergencyNumber) });
    expect(providerProtocolTrace.findIndex(event => event.kind === 'spoken')).toBeLessThan(providerProtocolTrace.findIndex(event => event.kind === 'tool'));
    expect(providerProtocolTrace.slice(2).some(event => event.value === 'disclosure' || event.value === 'normal_flow')).toBe(false);
  });

  it('branches only on trusted direction and fails closed for wrong parties and voicemail', () => {
    const prompt = generateSystemPrompt(baseConfig);

    expect(prompt).toMatch(/Use only the provider-supplied call direction/i);
    expect(prompt).toMatch(/INBOUND: after explicit consent is recorded, ask how you can help/i);
    expect(prompt).toMatch(/OUTBOUND: after explicit consent is recorded, confirm you reached the intended person/i);
    expect(prompt).toMatch(/direction is missing, conflicting, or untrusted: do not disclose a purpose or use patient-data tools/i);
    expect(prompt).toMatch(/Wrong party:.*reveal no offer, appointment, care relationship, patient status, or reason for calling/i);
    expect(prompt).toContain('This is Avery, an AI assistant calling for Example Clinic. Please call +12125550100. Goodbye.');
    expect(prompt).toMatch(/Do not collect information, book, transfer, or mark consent from a voicemail interaction/i);
  });

  it('fails safely for unsupported insurance, payment, language, and accessibility requests', () => {
    const prompt = generateSystemPrompt(baseConfig);

    expect(prompt).toMatch(/answer only from the accepted-plans list above/i);
    expect(prompt).toMatch(/No insurance tool is available: do not verify eligibility/i);
    expect(prompt).toMatch(/do not verify eligibility, benefits, network status, prior authorization, coverage, claim outcome, or patient responsibility/i);
    expect(prompt).toMatch(/no payment tool is available in this configuration/i);
    expect(prompt).toMatch(/Do not quote a balance as current, take a payment, create or send a payment link/i);
    expect(prompt).toMatch(/do not pretend fluency, translate clinical content yourself, or continue intake by guessing/i);
    expect(prompt).toMatch(/Never treat misunderstanding or silence as consent/i);
  });

  it('prohibits automatic tool retries and distinguishes acceptance from completion', () => {
    const built = buildRetellConfig(baseConfig, { webhookBaseUrl: 'https://api.example.test' });
    const dnc = built.tools.find(tool => tool.name === 'record_do_not_call');
    const transfer = built.tools.find(tool => tool.name === 'transfer_to_staff');

    expect(built.systemPrompt).toMatch(/Universal uncertain-tool rule/i);
    expect(built.systemPrompt).toMatch(/do not automatically retry the same or an equivalent tool/i);
    expect(built.systemPrompt).toMatch(/provider acceptance without completion evidence.*is NOT success/i);
    expect(String(dnc?.description)).toMatch(/do not retry automatically or continue the offer/i);
    expect(String(transfer?.description)).toMatch(/Provider acceptance is not a confirmed human connection/i);
    expect(built.systemPrompt).toMatch(/Say a transfer connected only when the provider returns explicit connected\/completed evidence/i);
    expect(built.systemPrompt).toMatch(/do not create a second message task/i);
    expect(String(transfer?.description)).toMatch(/do not create a duplicate message task/i);
    expect(built.systemPrompt).not.toContain('If the transfer fails, call take_message');
  });

  it('uses explicit pre-tool and evidence-bound post-tool DNC language', () => {
    const prompt = generateSystemPrompt(baseConfig);

    expect(prompt).toContain('I heard your request. I am recording it now.');
    expect(prompt).toContain('Your do-not-contact request is recorded. I will end the call now.');
    expect(prompt).toContain('I could not confirm that the request was recorded. I will end this call and flag it for staff review.');
  });

  it('fails closed when a configured eligible location cannot be mapped', () => {
    const invalid = {
      ...baseConfig,
      campaign: { ...baseConfig.campaign, eligibleLocationIds: ['missing-location'] },
    };

    expect(() => buildRetellConfig(invalid, { webhookBaseUrl: 'https://api.example.test' }))
      .toThrow('invalid_receptionist_configuration:eligible_location_mapping_unresolved');
    expect(() => generateSystemPrompt(invalid))
      .toThrow('invalid_receptionist_configuration:eligible_location_mapping_unresolved');
  });

  it('offers no-slot alternatives only from the same booking-tool result', () => {
    const prompt = generateSystemPrompt(baseConfig);

    expect(prompt).toMatch(/offer alternatives only when the same booking-tool result explicitly returns them/i);
    expect(prompt).toMatch(/do not invent a date, time, location, waitlist, or callback commitment/i);
  });

  it('describes the bundled booking answer only as a non-authorizing notification preference', () => {
    const withPreference = {
      ...baseConfig,
      intakeFields: [{
        id: 'notification-preference', fieldType: 'CONSENT' as const,
        label: 'Appointment notification preference',
        aiQuestion: 'Would you like appointment confirmations?',
        validationRule: 'yes or no', required: true, confirmationRequired: false,
        options: [], sortOrder: 1,
      }],
    };
    const built = buildRetellConfig(withPreference, { webhookBaseUrl: 'https://api.example.test' });
    const booking = built.tools.find(tool => tool.name === 'book_appointment');
    const serialized = JSON.stringify(booking);

    expect(serialized).toContain('Non-authorizing appointment-notification preference only; never marketing consent.');
    expect(generateSystemPrompt(withPreference)).toContain('Would you like appointment confirmations?');
    expect(generateSystemPrompt(withPreference)).toMatch(/never as channel or marketing consent/i);
  });

  it('keeps long system identifiers as internal evidence instead of voice copy', () => {
    const prompt = generateSystemPrompt(baseConfig);

    expect(prompt).toMatch(/The ID is internal evidence; do not read a long system identifier aloud/i);
    expect(prompt).toMatch(/Keep long system IDs as internal evidence/i);
  });
});
