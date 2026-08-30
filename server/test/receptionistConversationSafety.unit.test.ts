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

  it('makes the provider begin message a consent-only turn and waits before greeting', () => {
    const built = buildRetellConfig(baseConfig, { webhookBaseUrl: 'https://api.example.test' });

    expect(built.beginMessage.endsWith('Is that okay?')).toBe(true);
    expect(built.beginMessage).not.toContain('Welcome to our scheduling line.');
    expect(built.systemPrompt).toMatch(/STOP SPEAKING after that question and wait/i);
    expect(built.systemPrompt).toMatch(/Silence, voicemail, ambiguity, or continuing to speak is not consent/i);
    expect(built.systemPrompt).toContain('After consent is granted, you may say: "Welcome to our scheduling line."');
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

    expect(prompt).toMatch(/No insurance tool is available in this configuration/i);
    expect(prompt).toMatch(/do not verify network status, eligibility, benefits, prior authorization, coverage, claim outcome, or patient responsibility/i);
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
