export type ReleaseIdentityEnvironment = {
  RELEASE?: string;
  RENDER_GIT_COMMIT?: string;
  VERCEL_GIT_COMMIT_SHA?: string;
};

/**
 * Resolve the immutable source revision of the process that is actually
 * answering the request. RELEASE is an operator override; platform-provided
 * identities are fallbacks for the Render API/worker and Vercel API function.
 */
export function resolveReleaseIdentity(environment: ReleaseIdentityEnvironment): string | undefined {
  return [
    environment.RELEASE,
    environment.RENDER_GIT_COMMIT,
    environment.VERCEL_GIT_COMMIT_SHA,
  ].find(value => value?.trim())?.trim();
}
