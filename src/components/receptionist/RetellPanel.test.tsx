import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { receptionistApi } from '../../lib/receptionist';
import { RetellPanel } from './RetellPanel';

vi.mock('../../lib/receptionist', async () => {
  const actual = await vi.importActual<typeof import('../../lib/receptionist')>('../../lib/receptionist');
  return {
    ...actual,
    receptionistApi: {
      ...actual.receptionistApi,
      getRetellConfig: vi.fn(),
    },
  };
});

const getRetellConfig = vi.mocked(receptionistApi.getRetellConfig);

describe('RetellPanel export failures', () => {
  beforeEach(() => {
    getRetellConfig.mockReset();
  });

  it('shows the actionable configuration conflict and retries instead of rendering an empty export', async () => {
    const onConfigure = vi.fn();
    getRetellConfig
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
        webhookUrl: 'https://api.example.test/v1/receptionist/webhooks/retell',
        bookingFunction: {},
        callOutcomeFields: [],
      });

    render(<RetellPanel campaignId="campaign-1" onConfigure={onConfigure} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The RetellAI export configuration could not be loaded.');
    expect(alert).toHaveTextContent('eligible location mapping unresolved');
    expect(screen.queryByText('Preview/export configuration — not deployed')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open campaign settings' }));
    expect(onConfigure).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(getRetellConfig).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Preview/export configuration — not deployed')).toBeInTheDocument();
  });

  it('routes a malformed intake contract back to campaign settings', async () => {
    const onConfigure = vi.fn();
    getRetellConfig.mockRejectedValue(new ApiError(
      409,
      'Receptionist configuration is invalid: stale intake options. Fix the campaign intake fields before generating the prompt.',
      'invalid_intake_configuration',
    ));

    render(<RetellPanel campaignId="campaign-1" onConfigure={onConfigure} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('stale intake options');
    fireEvent.click(screen.getByRole('button', { name: 'Open campaign settings' }));
    expect(onConfigure).toHaveBeenCalledOnce();
  });
});
