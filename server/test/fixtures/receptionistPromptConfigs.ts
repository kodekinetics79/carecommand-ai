import { PLATFORM_LOCALE_PACKS, platformLocalePackHash } from '../../lib/receptionist/localePacks/defaults';
import type { KnowledgeDocument } from '../../lib/receptionist/knowledge';
import type { PromptConfig, PromptLocalePack } from '../../modules/receptionist/promptService';

// ===========================================================================
// One prompt fixture builder for every suite that renders a prompt. Since C2 a
// PromptConfig carries hours, knowledge, catalog services and a locale pack,
// so hand-written literals drift immediately.
// ===========================================================================

export type PromptFixtureName = 'us-full' | 'gb-full' | 'minimal-no-knowledge' | 'multi-location';

export function packFor(language: 'en-US' | 'en-GB'): PromptLocalePack {
  const platform = PLATFORM_LOCALE_PACKS.find(pack => pack.language === language);
  if (!platform) throw new Error(`No platform locale pack for ${language}`);
  return { id: null, strings: platform.strings, evidenceHash: platformLocalePackHash(platform) };
}

const KNOWLEDGE: KnowledgeDocument = {
  acceptedPayers: [
    { id: '11111111-1111-4111-8111-111111111111', name: 'Delta Dental', plans: ['PPO', 'Premier'], source: 'manual' },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Cigna', source: 'manual' },
  ],
  paymentPolicy: 'Payment is due at the time of service. We accept card and bank transfer.',
  newPatientPolicy: 'New patients should arrive ten minutes early with a photo ID.',
  urgentCare: {
    whatCountsAsUrgent: 'Swelling, a lost filling, or pain that stops you sleeping.',
    sameDayPolicy: 'We hold two same-day slots each morning for urgent problems.',
    onCallNumber: '+12125550444',
  },
  faq: [
    { id: '33333333-3333-4333-8333-333333333333', question: 'Do you have parking?', answer: 'Yes, there is a free lot behind the building.' },
    { id: '44444444-4444-4444-8444-444444444444', question: 'Do you see children?', answer: 'Yes, from age three upwards.' },
  ],
};

function baseConfig(): PromptConfig {
  return {
    clinic: {
      id: 'clinic-1',
      name: 'Example Clinic',
      phone: '+12125550100',
      website: 'https://example-clinic.test/book',
      addressLine: '1 Main St',
      country: 'US',
      timezone: 'America/New_York',
      defaultLanguage: 'en-US',
      complianceDisclosure: null,
      humanFallbackNumber: '+12125550200',
      doNotContactPolicy: null,
    },
    agent: { name: 'Avery', voice: 'voice-1', tone: 'warm', language: 'en-US' },
    campaign: {
      id: 'campaign-1',
      name: 'Scheduling',
      campaignType: 'inbound',
      offerTitle: 'Appointment',
      offerDescription: 'Schedule an appointment.',
      offerScript: 'How can I help?',
      appointmentType: 'Consultation',
      eligibleLocationIds: [],
      smsConfirmation: true,
      emailConfirmation: false,
      intakeSchemaRevision: 1,
    },
    locations: [{ id: 'location-1', name: 'Main', address: '1 Main St', phone: '+12125550111', accessNotes: 'Street parking on Main.' }],
    intakeFields: [],
    knowledge: KNOWLEDGE,
    services: [
      { id: 'service-1', name: 'Consultation', spokenDescription: 'A first visit to talk through your options.', voiceDurationMinutes: 30, priceFrom: 95, bookableByVoice: true },
      { id: 'service-2', name: 'Whitening', spokenDescription: 'A cosmetic whitening appointment.', voiceDurationMinutes: 60, priceFrom: null, bookableByVoice: false },
    ],
    hours: {
      clinicSummary: 'Monday to Friday 9 AM to 5 PM, Saturday 9 AM to 1 PM, closed Sunday',
      perLocation: [{ id: 'location-1', summary: 'Monday to Friday 9 AM to 5 PM, Saturday 9 AM to 1 PM, closed Sunday', closures: ['Closed Thursday, December 25: Public holiday'] }],
    },
    localePack: packFor('en-US'),
  };
}

export function promptFixture(name: PromptFixtureName = 'us-full'): PromptConfig {
  const config = baseConfig();
  if (name === 'us-full') return config;
  if (name === 'gb-full') {
    return {
      ...config,
      clinic: { ...config.clinic, name: 'Harley Street Practice', country: 'GB', timezone: 'Europe/London', defaultLanguage: 'en-GB', phone: '+442075550100', humanFallbackNumber: '+442075550200' },
      agent: { ...config.agent, language: 'en-GB' },
      locations: [{ id: 'location-1', name: 'Harley Street', address: '10 Harley Street, London', phone: '+442075550111', accessNotes: 'Nearest tube is Oxford Circus.' }],
      hours: {
        clinicSummary: 'Monday to Friday 09:00 to 17:00, Saturday 09:00 to 13:00, closed Sunday',
        perLocation: [{ id: 'location-1', summary: 'Monday to Friday 09:00 to 17:00, Saturday 09:00 to 13:00, closed Sunday', closures: ['Closed Thursday 25 December: Bank holiday'] }],
      },
      localePack: packFor('en-GB'),
    };
  }
  if (name === 'minimal-no-knowledge') {
    return { ...config, knowledge: null, hours: null, services: [], locations: [{ id: 'location-1', name: 'Main', address: '1 Main St' }] };
  }
  return {
    ...config,
    locations: [
      { id: 'location-1', name: 'Main', address: '1 Main St', phone: '+12125550111', accessNotes: 'Street parking on Main.' },
      { id: 'location-2', name: 'Uptown', address: '99 North Ave', phone: null, accessNotes: null },
    ],
    hours: {
      clinicSummary: 'Monday to Friday 9 AM to 5 PM, closed Saturday, closed Sunday',
      perLocation: [
        { id: 'location-1', summary: 'Monday to Friday 9 AM to 5 PM, closed Saturday, closed Sunday', closures: [] },
        { id: 'location-2', summary: 'Monday to Thursday 8 AM to 4 PM, closed Friday, closed Saturday, closed Sunday', closures: ['Closed Monday, July 6 to Friday, July 10: Refurbishment'] },
      ],
    },
  };
}
