import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { receptionistApi } from '../../lib/receptionist';
import { GoLivePanel } from './GoLivePanel';

// GoLivePanel now hosts DeployPanel, which issues its own apiRequest for the
// provider status. Left unmocked it resolves on its own schedule, so a second
// alert could appear mid-assertion — the test passed only while that request
// happened to still be pending. Mock it so the panel under test is the only
// thing that decides what is on screen.
const apiRequestMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api');
  return { ...actual, apiRequest: apiRequestMock };
});

vi.mock('../../lib/receptionist', async () => {
  const actual = await vi.importActual<typeof import('../../lib/receptionist')>('../../lib/receptionist');
  return {
    ...actual,
    receptionistApi: {
      ...actual.receptionistApi,
      getVoiceLineConfiguration: vi.fn(),
    },
  };
});

const getVoiceLineConfiguration = vi.mocked(receptionistApi.getVoiceLineConfiguration);

describe('GoLivePanel export failures', () => {
  beforeEach(() => {
    getVoiceLineConfiguration.mockReset();
    apiRequestMock.mockReset();
    // A never-settling status keeps DeployPanel in its own loading state without
    // an unhandled rejection; this suite is about the export failure path.
    apiRequestMock.mockImplementation(() => new Promise(() => {}));
  });

  it('shows the actionable configuration conflict and retries instead of rendering an empty export', async () => {
    const onConfigure = vi.fn();
    getVoiceLineConfiguration
      .mockRejectedValueOnce(new ApiError(
        409,
        'Receptionist configuration is invalid: eligible location mapping unresolved. Fix the campaign\'s locations and agent before generating the prompt.',
        'invalid_receptionist_configuration',
      ))
      .mockResolvedValueOnce({
        systemPrompt: 'Verified prompt',
        voiceId: 'voice-1',
        language: 'en-US',
        beginMessage: 'Hello',
        dynamicVariables: {},
        webhookUrl: 'https://api.example.test/v1/receptionist/webhooks/voice',
        bookingFunction: {},
        callOutcomeFields: [],
      });

    render(<GoLivePanel campaignId="campaign-1" onConfigure={onConfigure} />);

    const alert = (await screen.findAllByRole('alert'))
      .find(node => node.textContent?.includes('The voice line configuration could not be loaded.'));
    expect(alert, 'the export failure alert should be on screen').toBeDefined();
    expect(alert!).toHaveTextContent('The voice line configuration could not be loaded.');
    expect(alert!).toHaveTextContent('eligible location mapping unresolved');
    expect(screen.queryByText('Provider export — not deployed')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open campaign settings' }));
    expect(onConfigure).toHaveBeenCalledWith('campaign');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(getVoiceLineConfiguration).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Provider export — not deployed')).toBeInTheDocument();
  });

  it('routes a malformed intake contract to the Intake Builder', async () => {
    const onConfigure = vi.fn();
    getVoiceLineConfiguration.mockRejectedValue(new ApiError(
      409,
      'Receptionist configuration is invalid: stale intake options. Fix the campaign intake fields before generating the prompt.',
      'invalid_intake_configuration',
    ));

    render(<GoLivePanel campaignId="campaign-1" onConfigure={onConfigure} />);

    expect((await screen.findAllByRole('alert')).some(node => node.textContent?.includes('stale intake options'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Open Intake Builder' }));
    expect(onConfigure).toHaveBeenCalledWith('intake');
  });
});
