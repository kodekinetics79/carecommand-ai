import 'dotenv/config';
import { describe, expect, it } from 'vitest';
import { fingerprintTools, hashPrompt, normalizePromptText } from '../lib/retell';
import { findPlaceholders } from '../lib/receptionist/placeholders';
import { REMEDIATION_CODES, isKnownRemediationCode, remediationFor } from '../lib/receptionist/remediation';
import { DEGRADED_SAFE_TOOLS, inboundDegradePolicy } from '../lib/receptionist/agentReadiness';
import type { PromptConfig } from '../modules/receptionist/promptService';
import { generateSampleTranscripts } from '../modules/receptionist/promptService';
import { promptFixture } from './fixtures/receptionistPromptConfigs';

// C2 made hours, approved knowledge, catalog services and the locale pack part
// of the prompt config; borrow them from the shared fixture so this suite keeps
// testing what it is about (fingerprints, remediation, transcripts).
const promptFacts = promptFixture('us-full');

const baseConfig: PromptConfig = {
  clinic: {
    id: 'clinic-1', name: 'Example Clinic', phone: '+12125550100', website: null, addressLine: '1 Main St',
    country: 'US', timezone: 'America/New_York', defaultLanguage: 'en-US',
    complianceDisclosure: 'Clinic-specific compliance language.',
    humanFallbackNumber: '+12125550200', doNotContactPolicy: 'Record opt out.',
  },
  agent: { name: 'Avery', voice: 'mock-voice-nova', tone: 'Warm and professional', language: 'en-US', persona: null, greetingOverride: null },
  campaign: {
    id: 'campaign-1', name: 'Front desk', campaignType: 'Inbound reception',
    offerTitle: 'Book a consultation', offerDescription: 'We are welcoming new patients.',
    offerScript: 'I can check availability and book you in now.',
    appointmentType: 'New patient consultation', eligibleLocationIds: [],
    smsConfirmation: false, emailConfirmation: false, intakeSchemaRevision: 1,
  },
  locations: [{ id: 'loc-1', name: 'Main', address: '1 Main St' }],
  intakeFields: [
    { fieldType: 'FIRST_NAME', label: 'First name', aiQuestion: 'Can I start with your first name?', required: true, confirmationRequired: false, sortOrder: 0 },
  ],
  knowledge: promptFacts.knowledge,
  hours: promptFacts.hours,
  services: promptFacts.services,
  localePack: promptFacts.localePack,
};

describe('deployment fingerprints', () => {
  it('ignores formatting the provider would not preserve anyway', () => {
    // Trailing whitespace and CRLF differ between what we send and what a
    // provider returns; treating those as drift would cry wolf every hour.
    expect(hashPrompt('Line one  \r\nLine two\t\n')).toBe(hashPrompt('Line one\nLine two'));
    expect(normalizePromptText('  padded  ')).toBe('padded');
  });

  it('distinguishes a real prompt change from a cosmetic one', () => {
    expect(hashPrompt('Book the caller in.')).not.toBe(hashPrompt('Book anyone in.'));
  });

  it('marks a mock deployment so its evidence can never read as live', () => {
    expect(hashPrompt('x', { mock: true }).startsWith('mock:')).toBe(true);
    expect(hashPrompt('x').startsWith('mock:')).toBe(false);
  });

  it('fingerprints tools by content, not by the order the provider returns them', () => {
    const a = [{ name: 'book_appointment', url: 'https://x' }, { name: 'take_message' }];
    const b = [{ name: 'take_message' }, { name: 'book_appointment', url: 'https://x' }];
    expect(fingerprintTools(a)).toBe(fingerprintTools(b));
    expect(fingerprintTools(a)).not.toBe(fingerprintTools([{ name: 'book_appointment', url: 'https://y' }, { name: 'take_message' }]));
  });
});

describe('placeholder detection', () => {
  it('accepts configuration a clinic actually wrote', () => {
    expect(findPlaceholders(baseConfig)).toEqual([]);
  });

  it('catches the values our own forms pre-fill', () => {
    const untouched: PromptConfig = {
      ...baseConfig,
      agent: { ...baseConfig.agent, name: 'Riley', voice: '11labs-Adrian' },
      campaign: { ...baseConfig.campaign, offerTitle: 'New offer', offerDescription: 'Describe the offer here.' },
    };
    const fields = findPlaceholders(untouched).map(item => item.field);
    expect(fields).toEqual(expect.arrayContaining(['agent.name', 'agent.voice', 'campaign.offerTitle', 'campaign.offerDescription']));
    expect(findPlaceholders(untouched).every(item => item.reason === 'known_default')).toBe(true);
  });

  it('catches unrendered template syntax and left-behind markers', () => {
    const broken: PromptConfig = {
      ...baseConfig,
      campaign: { ...baseConfig.campaign, offerTitle: 'Visit {{clinic_name}}', offerScript: 'TODO: write the script' },
    };
    const byField = new Map(findPlaceholders(broken).map(item => [item.field, item.reason]));
    expect(byField.get('campaign.offerTitle')).toBe('template_syntax');
    expect(byField.get('campaign.offerScript')).toBe('todo_marker');
  });

  it('does not flag a clinic that genuinely offers a consultation', () => {
    // The check is for text nobody edited, not for text somebody dislikes.
    const real = { ...baseConfig, campaign: { ...baseConfig.campaign, appointmentType: 'Consultation' } };
    expect(findPlaceholders(real)).toEqual([]);
  });
});

describe('remediation catalogue', () => {
  it('gives every code a title and an action a person can act on', () => {
    for (const code of REMEDIATION_CODES) {
      const remediation = remediationFor(code);
      expect(remediation.title.length, code).toBeGreaterThan(5);
      expect(remediation.action.length, code).toBeGreaterThan(15);
      expect(['server', 'provider', 'agent', 'campaign', 'clinic', 'scheduling']).toContain(remediation.scope);
    }
  });

  it('builds a fix link that lands on the tab that fixes it', () => {
    const remediation = remediationFor('placeholders_absent', { clinicId: 'c1', campaignId: 'k1' });
    expect(remediation.fixHref).toBe('/receptionist-studio?clinic=c1&campaign=k1&tab=campaign');
    expect(remediationFor('provider_availability').fixHref).toBe('/scheduling');
    // A server-side fault has no tab to send anybody to, and says so.
    expect(remediationFor('retell_api_key_missing').fixHref).toBeNull();
  });

  it('answers for an unknown code instead of throwing at the operator', () => {
    expect(isKnownRemediationCode('something_new')).toBe(false);
    expect(remediationFor('something_new').title.length).toBeGreaterThan(5);
  });
});

describe('inbound degrade policy', () => {
  it('keeps only the tools that touch no patient data', () => {
    const policy = inboundDegradePolicy('agent_verification_stale');
    expect(policy.mode).toBe('degraded');
    expect(policy.allowedTools).toEqual(DEGRADED_SAFE_TOOLS);
    // Booking, identity and appointment tools are exactly what must NOT run on
    // an unattested deployment.
    expect(policy.allowedTools).not.toContain('book_appointment');
    expect(policy.allowedTools).not.toContain('verify_patient_identity');
    expect(policy.messageKey).toBe('receptionist.degraded.verification_stale');
  });

  it('names drift distinctly, because the fix differs', () => {
    expect(inboundDegradePolicy('provider_deployment_drift').messageKey).toBe('receptionist.degraded.deployment_drift');
    expect(inboundDegradePolicy('agent_unlinked').messageKey).toBe('receptionist.degraded.unverified');
  });
});

describe('sample transcripts', () => {
  it('opens with the mandatory disclosure and records consent before anything else', () => {
    const transcripts = generateSampleTranscripts(baseConfig);
    expect(transcripts.openingSequence[0].speaker).toBe('agent');
    expect(transcripts.openingSequence[0].text).toMatch(/recorded or monitored/i);
    expect(transcripts.openingSequence.at(-1)?.text).toContain('record_recording_preference');
    // Intake only ever follows consent.
    const consentIndex = transcripts.inboundSample.findIndex(turn => turn.text.includes('record_recording_preference'));
    const intakeIndex = transcripts.inboundSample.findIndex(turn => turn.text.includes('your first name'));
    expect(consentIndex).toBeGreaterThanOrEqual(0);
    expect(intakeIndex).toBeGreaterThan(consentIndex);
  });

  it('offers do-not-contact on the outbound script', () => {
    expect(generateSampleTranscripts(baseConfig).outboundSample.some(turn => /rather not hear from us/i.test(turn.text))).toBe(true);
  });

  it('says it cannot book when no intake field is configured', () => {
    const noIntake = { ...baseConfig, intakeFields: [] };
    expect(generateSampleTranscripts(noIntake).inboundSample.some(turn => /take a message/i.test(turn.text))).toBe(true);
  });
});
