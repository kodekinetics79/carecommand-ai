import 'dotenv/config';
import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../config/env';
import { effectivePlatformToken } from '../lib/platform';

const original = {
  NODE_ENV: env.NODE_ENV,
  PLATFORM_API_TOKEN: env.PLATFORM_API_TOKEN,
  PLATFORM_LEGACY_TOKEN_ENABLED: env.PLATFORM_LEGACY_TOKEN_ENABLED,
};

afterEach(() => {
  (env as typeof env).NODE_ENV = original.NODE_ENV;
  (env as typeof env).PLATFORM_API_TOKEN = original.PLATFORM_API_TOKEN;
  (env as typeof env).PLATFORM_LEGACY_TOKEN_ENABLED = original.PLATFORM_LEGACY_TOKEN_ENABLED;
});

describe('legacy platform operator token', () => {
  it('uses the dev fallback token only outside production', () => {
    (env as typeof env).NODE_ENV = 'development';
    (env as typeof env).PLATFORM_API_TOKEN = undefined;
    (env as typeof env).PLATFORM_LEGACY_TOKEN_ENABLED = false;

    expect(effectivePlatformToken()).toBe('dev-platform-operator-token');
  });

  it('disables configured legacy static tokens in production by default', () => {
    (env as typeof env).NODE_ENV = 'production';
    (env as typeof env).PLATFORM_API_TOKEN = 'configured-static-platform-token';
    (env as typeof env).PLATFORM_LEGACY_TOKEN_ENABLED = false;

    expect(effectivePlatformToken()).toBeNull();
  });

  it('requires explicit production break-glass opt-in for the legacy token', () => {
    (env as typeof env).NODE_ENV = 'production';
    (env as typeof env).PLATFORM_API_TOKEN = 'configured-static-platform-token';
    (env as typeof env).PLATFORM_LEGACY_TOKEN_ENABLED = true;

    expect(effectivePlatformToken()).toBe('configured-static-platform-token');
  });
});
