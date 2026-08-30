import { describe, expect, it } from 'vitest';
import {
  RUNTIME_DYNAMIC_VARIABLES,
  buildRetellConfig,
  generateSystemPrompt,
  promptHash,
} from '../modules/receptionist/promptService';
import { promptFixture } from './fixtures/receptionistPromptConfigs';

const RUNTIME_NAMES = RUNTIME_DYNAMIC_VARIABLES.map(item => item.name);
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

function leakedPlaceholders(prompt: string): string[] {
  return [...prompt.matchAll(PLACEHOLDER_RE)].map(match => match[1]).filter(name => !RUNTIME_NAMES.includes(name as never));
}

describe('generated prompt snapshots', () => {
  for (const name of ['us-full', 'gb-full', 'minimal-no-knowledge', 'multi-location'] as const) {
    it(`renders a stable prompt for ${name}`, () => {
      expect(generateSystemPrompt(promptFixture(name))).toMatchSnapshot();
    });

    it(`renders stable dynamic variables for ${name}`, () => {
      const built = buildRetellConfig(promptFixture(name), { webhookBaseUrl: 'https://api.example.test' });
      expect(built.dynamicVariables).toMatchSnapshot();
    });

    it(`leaves no unresolved placeholder in ${name}`, () => {
      // The ONLY {{tokens}} a finished prompt may contain are the runtime
      // variables Retell substitutes per call. Anything else would be spoken
      // to a caller literally.
      expect(leakedPlaceholders(generateSystemPrompt(promptFixture(name)))).toEqual([]);
    });
  }

  it('speaks the caller\'s own emergency number', () => {
    const us = generateSystemPrompt(promptFixture('us-full'));
    const gb = generateSystemPrompt(promptFixture('gb-full'));
    expect(us).toContain('911');
    expect(us).not.toContain('999');
    expect(gb).toContain('999');
    expect(gb).not.toContain('911');
    expect(gb).toContain('A&E');
  });

  it('uses the pack time style for the hours it states', () => {
    expect(generateSystemPrompt(promptFixture('us-full'))).toContain('9 AM to 5 PM');
    expect(generateSystemPrompt(promptFixture('gb-full'))).toContain('09:00 to 17:00');
  });

  it('states clinic facts the agent may answer from directly', () => {
    const prompt = generateSystemPrompt(promptFixture('us-full'));
    expect(prompt).toContain('# Clinic facts');
    expect(prompt).toContain('Country: US');
    expect(prompt).toContain('Street parking on Main.');
    expect(prompt).toContain('Closed Thursday, December 25: Public holiday');
    // The website renders as a hostname, never a full URL the agent might read out.
    expect(prompt).toContain('example-clinic.test');
    expect(prompt).not.toContain('https://example-clinic.test/book');
  });

  it('renders services from the catalog and marks what voice may book', () => {
    const prompt = generateSystemPrompt(promptFixture('us-full'));
    expect(prompt).toContain('# Services (only these may be described or booked)');
    expect(prompt).toContain('Consultation: A first visit to talk through your options. Typically about 30 minutes.');
    expect(prompt).toContain('Bookable on this call.');
    expect(prompt).toContain('Whitening');
    expect(prompt).toContain('Not bookable on this call: take a message instead.');
    expect(prompt).toContain('Prices start at $95.00');
  });

  it('separates clinically urgent from life-threatening', () => {
    const prompt = generateSystemPrompt(promptFixture('us-full'));
    expect(prompt).toContain('# Urgent but not life-threatening');
    expect(prompt).toContain('Swelling, a lost filling, or pain that stops you sleeping.');
    expect(prompt).toContain('+12125550444');
    expect(prompt).toMatch(/clinically urgent but non-life-threatening request is NOT an emergency/i);
  });

  it('answers insurance only from the accepted list', () => {
    const prompt = generateSystemPrompt(promptFixture('us-full'));
    expect(prompt).toContain('Accepted plans: Delta Dental (PPO, Premier), Cigna.');
    expect(prompt).toMatch(/answer only from the accepted-plans list above/i);
    expect(prompt).toMatch(/Never state eligibility, benefits, coverage, network status/i);
  });

  it('says plainly that nothing is configured rather than inventing answers', () => {
    const prompt = generateSystemPrompt(promptFixture('minimal-no-knowledge'));
    expect(prompt).toContain('No approved clinic knowledge is configured.');
    expect(prompt).not.toContain('# Insurance and payment');
    expect(prompt).not.toContain('# Frequently asked questions');
    expect(prompt).toContain('No services are configured for voice.');
    expect(prompt).toContain('Regular hours: not configured');
  });

  it('registers transfer_to_staff only when a real transfer target exists', () => {
    const ready = promptFixture('us-full');
    expect(buildRetellConfig(ready, { webhookBaseUrl: 'https://api.example.test' }).tools.some(tool => tool.name === 'transfer_to_staff')).toBe(true);

    const noFallback = { ...ready, clinic: { ...ready.clinic, humanFallbackNumber: null } };
    expect(buildRetellConfig(noFallback, { webhookBaseUrl: 'https://api.example.test' }).tools.some(tool => tool.name === 'transfer_to_staff')).toBe(false);
    expect(generateSystemPrompt(noFallback)).toContain('No staff transfer is available on this line right now.');

    // A fallback that is the clinic's own number would ring the agent back.
    const loops = { ...ready, clinic: { ...ready.clinic, humanFallbackNumber: ready.clinic.phone } };
    expect(buildRetellConfig(loops, { webhookBaseUrl: 'https://api.example.test' }).tools.some(tool => tool.name === 'transfer_to_staff')).toBe(false);
  });

  it('exports a default for every runtime variable', () => {
    const built = buildRetellConfig(promptFixture('gb-full'), { webhookBaseUrl: 'https://api.example.test' });
    for (const variable of RUNTIME_DYNAMIC_VARIABLES) {
      expect(built.dynamicVariables, variable.name).toHaveProperty(variable.name);
    }
    // The emergency number is a real value at export time, not a placeholder.
    expect(built.dynamicVariables.emergency_number).toBe('999');
    expect(built.dynamicVariables.is_open_now).toBe('unknown');
  });

  it('hashes the prompt so a deployment can attest to exact wording', () => {
    const prompt = generateSystemPrompt(promptFixture('us-full'));
    expect(promptHash(prompt)).toMatch(/^[a-f0-9]{64}$/);
    expect(promptHash(prompt)).toBe(promptHash(generateSystemPrompt(promptFixture('us-full'))));
    expect(promptHash(prompt)).not.toBe(promptHash(generateSystemPrompt(promptFixture('gb-full'))));
  });
});
