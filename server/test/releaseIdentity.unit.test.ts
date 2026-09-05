import { describe, expect, it } from 'vitest';
import { resolveReleaseIdentity } from '../lib/releaseIdentity';

describe('release identity', () => {
  it('prefers an explicit release, then the current hosting platform identity', () => {
    expect(resolveReleaseIdentity({
      RELEASE: 'release-override',
      RENDER_GIT_COMMIT: 'render-sha',
      VERCEL_GIT_COMMIT_SHA: 'vercel-sha',
    })).toBe('release-override');
    expect(resolveReleaseIdentity({ RENDER_GIT_COMMIT: 'render-sha' })).toBe('render-sha');
    expect(resolveReleaseIdentity({ VERCEL_GIT_COMMIT_SHA: 'vercel-sha' })).toBe('vercel-sha');
  });

  it('ignores blank values and reports no identity when none exists', () => {
    expect(resolveReleaseIdentity({ RELEASE: ' ', VERCEL_GIT_COMMIT_SHA: 'vercel-sha' })).toBe('vercel-sha');
    expect(resolveReleaseIdentity({})).toBeUndefined();
  });
});
