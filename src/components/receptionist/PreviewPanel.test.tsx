import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiRequestMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

import { ApiError } from '../../lib/api';
import type { PreviewResponse } from '../../lib/receptionistDeployment';
import { PreviewPanel } from './PreviewPanel';

function preview(overrides: Partial<PreviewResponse> = {}): PreviewResponse {
  return {
    openingSequence: [
      { speaker: 'agent', text: 'Hi, this is Riley, an AI assistant for Brightsmile Dental. This call is recorded.' },
      { speaker: 'caller', text: 'That is fine.' },
      { speaker: 'tool', text: 'record_call_consent(ai=ACKNOWLEDGED, recording=NOT_STATED)', note: 'Silent; the call continues.' },
    ],
    inboundSample: [{ speaker: 'caller', text: 'I need a cleaning next week.' }, { speaker: 'agent', text: 'I can help with that.' }],
    outboundSample: [{ speaker: 'agent', text: 'We have a cleaning slot open on Tuesday.' }],
    tools: [
      { name: 'book_appointment', kind: 'custom', description: 'Books a slot the caller accepted.', requiresConsent: true },
      { name: 'transfer_to_staff', kind: 'transfer', description: 'Transfers to the front desk.', requiresConsent: false },
    ],
    disclosure: { baseline: 'This call is handled by an AI assistant and is recorded.', additional: '', composed: 'This call is handled by an AI assistant and is recorded.' },
    placeholders: [],
    agent: { name: 'Riley', voice: '11labs-Anna', language: 'en-US', placeholder: false },
    systemPrompt: '# Role\nYou are Riley, the receptionist for Brightsmile Dental.',
    ...overrides,
  };
}

let respond: (path: string) => Promise<unknown>;

beforeEach(() => {
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path: string) => respond(path));
});

const PATH = '/v1/receptionist/campaigns/camp-1/preview';

describe('PreviewPanel — what the receptionist will actually say', () => {
  it('renders the opening sequence, both samples and the tool list', async () => {
    respond = path => (path === PATH ? Promise.resolve(preview()) : Promise.reject(new Error(`Unexpected request in test: ${path}`)));
    render(<PreviewPanel campaignId="camp-1" />);

    expect(await screen.findByText(/This call is recorded./)).toBeInTheDocument();
    expect(screen.getByText('record_call_consent(ai=ACKNOWLEDGED, recording=NOT_STATED)')).toBeInTheDocument();
    expect(screen.getByText('I need a cleaning next week.')).toBeInTheDocument();
    expect(screen.getByText('We have a cleaning slot open on Tuesday.')).toBeInTheDocument();
    expect(document.querySelector('[data-tool="book_appointment"]')).not.toBeNull();
    expect(screen.getByText('Transfers to the front desk.')).toBeInTheDocument();
    expect(screen.getByText('after consent')).toBeInTheDocument();
  });

  it('shows the composed baseline when the clinic added no disclosure of its own', async () => {
    respond = () => Promise.resolve(preview());
    render(<PreviewPanel campaignId="camp-1" />);

    expect(await screen.findByText('None — the baseline disclosure is used on its own.')).toBeInTheDocument();
    expect(screen.getAllByText('This call is handled by an AI assistant and is recorded.').length).toBeGreaterThan(0);
  });

  it('banners a placeholder agent and lists what would block a deploy', async () => {
    respond = () => Promise.resolve(preview({
      agent: { name: 'Riley', voice: '11labs-Adrian', language: 'en-US', placeholder: true },
      placeholders: [{ field: 'offerTitle', value: 'New offer', reason: 'known_default' }],
    }));
    render(<PreviewPanel campaignId="camp-1" />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Placeholder agent — create an agent to replace Riley');
    expect(alert).toHaveTextContent('offerTitle');
    expect(alert).toHaveTextContent('known_default');
  });

  it('offers the web call as unavailable rather than pretending it works', async () => {
    respond = () => Promise.resolve(preview());
    render(<PreviewPanel campaignId="camp-1" />);

    const button = await screen.findByRole('button', { name: /Talk to your receptionist/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringContaining('after pilot hardening'));
  });

  it('names a failed load instead of rendering an empty preview', async () => {
    respond = () => Promise.reject(new ApiError(409, 'Campaign configuration is not deployable: intake_schema_unattested.', 'INTERNAL_SERVER_ERROR'));
    render(<PreviewPanel campaignId="camp-1" />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The receptionist preview could not be loaded.');
    expect(alert).toHaveTextContent('intake_schema_unattested');
  });
});
