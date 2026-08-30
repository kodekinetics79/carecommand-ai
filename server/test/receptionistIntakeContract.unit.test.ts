import { describe, expect, it } from 'vitest';
import {
  bookAppointmentToolFingerprint,
  compileIntakeContract,
  validateIntakeFieldConfiguration,
} from '../modules/receptionist/intakeContract';
import { buildRetellConfig, type PromptConfig } from '../modules/receptionist/promptService';
import { promptFixture } from './fixtures/receptionistPromptConfigs';

// A finished prompt still carries the runtime {{variables}} Retell substitutes
// per call; only those are allowed to survive rendering.
const RUNTIME_PLACEHOLDER = /\{\{\s*(is_open_now|hours_today|next_opening|closure_reason|emergency_number|known_first_name|human_fallback_number|admission_state|location_name|location_address|location_phone)\s*\}\}/g;
const stripRuntimeVariables = (value: string) => value.replace(RUNTIME_PLACEHOLDER, '');


const clinicId = '11111111-1111-4111-8111-111111111111';
const campaignId = '22222222-2222-4222-8222-222222222222';
const customId = '33333333-3333-4333-8333-333333333333';
const toolUrl = `https://api.example.test/v1/receptionist/webhooks/retell/fn?clinicId=${clinicId}`;

function fields() {
  return [
    {
      id: '44444444-4444-4444-8444-444444444444', fieldType: 'PHONE' as const,
      label: 'Best phone', aiQuestion: 'What is the best number?', options: [], required: true,
      confirmationRequired: true, sortOrder: 0,
    },
    {
      id: customId, fieldType: 'CUSTOM_TEXT' as const,
      label: 'Accessibility request', aiQuestion: 'Do you need an accessibility accommodation?', options: [], required: true,
      confirmationRequired: true, sortOrder: 1,
    },
  ];
}

describe('receptionist typed intake contract', () => {
  it('builds one deterministic wrapped POST contract without a model-controlled phone', () => {
    const first = compileIntakeContract({
      campaignId, revision: 7, appointmentType: 'Consultation',
      eligibleLocations: [{ id: clinicId, name: 'Main' }], fields: fields(), toolUrl,
    });
    const second = compileIntakeContract({
      campaignId, revision: 7, appointmentType: 'Consultation',
      eligibleLocations: [{ id: clinicId, name: 'Main' }], fields: [...fields()].reverse(), toolUrl,
    });
    expect(first).toEqual(second);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.snapshot.bookAppointmentToolContract).toMatchObject({
      type: 'custom', name: 'book_appointment', url: toolUrl, method: 'POST', args_at_root: false,
    });
    const parameters = first.snapshot.bookAppointmentToolContract.parameters as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(parameters.additionalProperties).toBe(false);
    expect(parameters.properties).not.toHaveProperty('phone');
    // C9: `service` is an enum over the voice-bookable catalogue, not one
    // pinned const. A single-service campaign still offers exactly one option.
    expect(parameters.properties).toHaveProperty('service', expect.objectContaining({ enum: ['Consultation'] }));
    expect(parameters.properties).toHaveProperty('intake_contract_fingerprint', expect.objectContaining({ const: first.snapshot.semanticFingerprint }));
    expect(parameters.properties).toHaveProperty('intake_schema_revision', expect.objectContaining({ const: 7 }));
    expect(parameters.properties).toHaveProperty(`custom_${customId.replaceAll('-', '')}_confirmed`, expect.objectContaining({ const: true }));
    expect(parameters.required).toContain(`custom_${customId.replaceAll('-', '')}_confirmed`);
    expect(bookAppointmentToolFingerprint(first.snapshot.bookAppointmentToolContract)).toBe(first.snapshot.bookAppointmentToolFingerprint);
    expect(bookAppointmentToolFingerprint({ ...first.snapshot.bookAppointmentToolContract, type: 'function' })).toBeNull();
  });

  it('cryptographically binds question/validation semantics and rejects an impossible location question', () => {
    const base = compileIntakeContract({
      campaignId, revision: 7, appointmentType: 'Consultation',
      eligibleLocations: [{ id: clinicId, name: 'Main' }], fields: fields(), toolUrl,
    });
    const questionDrift = compileIntakeContract({
      campaignId, revision: 7, appointmentType: 'Consultation',
      eligibleLocations: [{ id: clinicId, name: 'Main' }],
      fields: fields().map((field, index) => index === 1 ? { ...field, aiQuestion: 'Which accommodation should staff prepare?', validationRule: 'brief' } : field),
      toolUrl,
    });
    expect(questionDrift.snapshot.semanticFingerprint).not.toBe(base.snapshot.semanticFingerprint);
    expect(questionDrift.snapshot.bookAppointmentToolFingerprint).not.toBe(base.snapshot.bookAppointmentToolFingerprint);

    expect(() => compileIntakeContract({
      campaignId, revision: 1, appointmentType: 'Consultation', eligibleLocations: [], toolUrl,
      fields: [{
        id: customId, fieldType: 'PREFERRED_LOCATION', label: 'Clinic', aiQuestion: 'Which clinic?', options: [],
        required: true, confirmationRequired: false, sortOrder: 0,
      }],
    })).toThrow(/requires at least one eligible active mapped location/i);
  });

  it('rejects duplicate semantics/order, unsafe minimum-necessary prompts, and malformed dropdowns', () => {
    const invalid = [
      ...fields(),
      { ...fields()[0], id: '55555555-5555-4555-8555-555555555555', sortOrder: 0 },
      {
        id: '66666666-6666-4666-8666-666666666666', fieldType: 'CUSTOM_DROPDOWN' as const,
        label: 'SSN selection', aiQuestion: 'Choose your social security number', options: ['same'], required: false,
        confirmationRequired: false, sortOrder: 3,
      },
    ];
    expect(validateIntakeFieldConfiguration(invalid).join(' ')).toMatch(/Only one PHONE|sort orders|high-risk|between 2 and 20/i);
  });

  it('rejects provider dynamic-variable templates in every attested critical surface', () => {
    const base = {
      campaignId, revision: 1, appointmentType: 'Consultation',
      eligibleLocations: [{ id: clinicId, name: 'Main' }], fields: fields(), toolUrl,
    };
    expect(() => compileIntakeContract({ ...base, appointmentType: '{{appointment_type}}' })).toThrow(/dynamic-variable templates/i);
    expect(() => compileIntakeContract({
      ...base, eligibleLocations: [{ id: clinicId, name: '${preferred_location}' }],
    })).toThrow(/dynamic-variable templates/i);
    expect(() => compileIntakeContract({
      ...base, fields: fields().map((field, index) => index === 1 ? { ...field, label: '{{intake_label}}' } : field),
    })).toThrow(/dynamic-variable templates/i);
    expect(() => compileIntakeContract({
      ...base, fields: fields().map((field, index) => index === 1 ? { ...field, aiQuestion: '${intake_question}' } : field),
    })).toThrow(/dynamic-variable templates/i);
    expect(() => compileIntakeContract({ ...base, toolUrl: `${toolUrl}&campaignId={{campaign_id}}` })).toThrow(/dynamic-variable templates/i);

    const compiled = compileIntakeContract(base);
    const mutated = structuredClone(compiled.snapshot.bookAppointmentToolContract) as unknown as {
      parameters: { properties: { service: { enum: string[] } } };
    };
    mutated.parameters.properties.service.enum = ['{{per_call_service}}'];
    expect(bookAppointmentToolFingerprint(mutated)).toBeNull();
  });

  it('exports the compatibility alias and tools array from the same executable object', () => {
    const base = promptFixture('us-full');
    const config: PromptConfig = {
      ...base,
      clinic: { ...base.clinic, id: clinicId, complianceDisclosure: 'Approved disclosure.', doNotContactPolicy: 'Record opt out.' },
      agent: { ...base.agent, voice: 'voice' },
      campaign: { ...base.campaign, id: campaignId, name: 'Pilot', offerTitle: 'Care', offerDescription: 'Schedule care', offerScript: 'Would you like to schedule?', eligibleLocationIds: [clinicId], intakeSchemaRevision: 7 },
      locations: [{ id: clinicId, name: 'Main', address: '1 Main Street' }],
      hours: { clinicSummary: base.hours!.clinicSummary, perLocation: [{ id: clinicId, summary: base.hours!.clinicSummary, closures: [] }] },
      intakeFields: fields(),
    };
    const exported = buildRetellConfig(config, { webhookBaseUrl: 'https://api.example.test' });
    const bookingTools = exported.tools.filter(tool => tool.name === 'book_appointment');
    expect(bookingTools).toHaveLength(1);
    expect(exported.bookingFunction).toEqual(bookingTools[0]);
    expect(exported.intakeSchemaRevision).toBe(7);
    expect(exported.intakeToolFingerprint).toBe(bookAppointmentToolFingerprint(exported.bookingFunction));
    expect(stripRuntimeVariables(exported.systemPrompt)).not.toMatch(/\{\{|\$\{/);
    expect(stripRuntimeVariables(JSON.stringify(exported))).not.toMatch(/\{\{|\$\{/);
  });
});
