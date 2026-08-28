import { describe, expect, it } from 'vitest';
import { inspectProductionArtifacts } from '../scripts/verifyNoProductionDemoArtifacts';

describe('production demo/dead-action guard', () => {
  it('finds no prohibited artifacts in production source or build output', async () => {
    expect(await inspectProductionArtifacts()).toEqual([]);
  });
});
