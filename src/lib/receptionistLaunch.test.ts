import { describe, expect, it } from 'vitest';

import { parseLaunchResult, presentLaunchResult } from './receptionist';

describe('outbound launch safety presentation', () => {
  it('preserves and explains the human-fallback destination block', () => {
    const result = parseLaunchResult({
      status: 'blocked',
      reason: 'destination_matches_human_fallback',
    });

    expect(result).toEqual({ status: 'blocked', reason: 'destination_matches_human_fallback' });
    expect(presentLaunchResult(result)).toEqual({
      kind: 'err',
      text: 'No call was placed. Launch was blocked: destination matches human fallback. Correct the authority or safety condition before retrying.',
      refresh: true,
    });
  });
});
