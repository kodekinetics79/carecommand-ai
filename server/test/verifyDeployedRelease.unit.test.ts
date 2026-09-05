import { describe, expect, it, vi } from 'vitest';
import { verifyDeployedRelease } from '../scripts/verifyDeployedReleaseCore';

const SHA = '1234567890abcdef1234567890abcdef12345678';
const BASE_URL = 'https://carecommand.kodekinetics.com';
const SECURITY_HEADERS = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
};

function input(overrides: Partial<Parameters<typeof verifyDeployedRelease>[0]> = {}) {
  return {
    acknowledgement: 'READ_ONLY_CARECOMMAND_DEPLOYMENT',
    baseUrl: BASE_URL,
    expectedSha: SHA,
    metricsToken: 'synthetic-monitoring-token',
    ...overrides,
  };
}

function response(body: string, options: ResponseInit & { url?: string } = {}): Response {
  const result = new Response(body, options);
  Object.defineProperty(result, 'url', { value: options.url ?? BASE_URL });
  return result;
}

function passingFetch() {
  return vi.fn<typeof fetch>(async (request, options) => {
    const url = new URL(typeof request === 'string' ? request : request.toString());
    if (url.pathname === '/health') {
      return response(JSON.stringify({ status: 'ok', release: SHA }), {
        status: 200,
        headers: { ...SECURITY_HEADERS, 'content-type': 'application/json' },
        url: url.toString(),
      });
    }
    if (url.pathname === '/health/ready') {
      return response(JSON.stringify({
        status: 'ready',
        checks: { database: 'ok', redis: 'ok', ingressProxy: 'ok' },
      }), {
        status: 200,
        headers: { ...SECURITY_HEADERS, 'content-type': 'application/json' },
        url: url.toString(),
      });
    }
    const authorization = new Headers(options?.headers).get('authorization');
    if (authorization !== 'Bearer synthetic-monitoring-token') {
      return response('', { status: 401, url: url.toString() });
    }
    return response([
      '# HELP queue_depth Current queue depth',
      '# TYPE queue_depth gauge',
      'queue_depth{queue="notifications"} 0',
      '# HELP dependency_up Dependency status',
      '# TYPE dependency_up gauge',
      'dependency_up{dependency="database"} 1',
    ].join('\n'), {
      status: 200,
      headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
      url: url.toString(),
    });
  });
}

describe('deployed release verifier', () => {
  it('proves the exact SHA, dependencies, protected metrics and security headers with GET requests only', async () => {
    const fetchImplementation = passingFetch();
    const result = await verifyDeployedRelease(input(), fetchImplementation);

    expect(result.expectedSha).toBe(SHA);
    expect(result.readiness).toEqual({
      status: 'ready',
      database: 'ok',
      redis: 'ok',
      ingressProxy: 'ok',
    });
    expect(result.metrics.requiredSeries).toEqual(['queue_depth', 'dependency_up']);
    expect(result.metrics).toMatchObject({ unauthenticatedStatus: 401, invalidTokenStatus: 401 });
    expect(fetchImplementation).toHaveBeenCalledTimes(5);
    for (const [, options] of fetchImplementation.mock.calls) {
      expect(options?.method).toBe('GET');
      expect(options?.redirect).toBe('error');
    }
  });

  it.each([
    ['http://carecommand.kodekinetics.com', 'requires HTTPS'],
    ['https://example.com', 'restricted to carecommand.kodekinetics.com'],
    ['https://carecommand.kodekinetics.com/unexpected', 'must not include a path'],
  ])('refuses an unsafe deployment URL: %s', async (baseUrl, expectedMessage) => {
    await expect(verifyDeployedRelease(input({ baseUrl }), passingFetch())).rejects.toThrow(expectedMessage);
  });

  it('rejects a release SHA mismatch', async () => {
    await expect(verifyDeployedRelease(input({
      expectedSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }), passingFetch())).rejects.toThrow('/health release mismatch');
  });

  it('rejects an HTML response masquerading as metrics', async () => {
    const baseFetch = passingFetch();
    const fetchImplementation = vi.fn<typeof fetch>(async (request, options) => {
      const url = new URL(request.toString());
      const authorization = new Headers(options?.headers).get('authorization');
      if (url.pathname === '/metrics' && authorization === 'Bearer synthetic-monitoring-token') {
        return response('<!doctype html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
          url: request.toString(),
        });
      }
      return baseFetch(request, options);
    });

    await expect(verifyDeployedRelease(input(), fetchImplementation)).rejects.toThrow(
      '/metrics returned unexpected Content-Type',
    );
  });

  it('rejects a failed dependency and a missing security header', async () => {
    const missingHeaderFetch = passingFetch();
    missingHeaderFetch.mockImplementationOnce(async request => response(JSON.stringify({ status: 'ok', release: SHA }), {
      status: 200,
      headers: { 'strict-transport-security': 'max-age=31536000', 'x-frame-options': 'SAMEORIGIN' },
      url: request.toString(),
    }));
    await expect(verifyDeployedRelease(input(), missingHeaderFetch)).rejects.toThrow('X-Content-Type-Options');

    const failedReadyFetch = passingFetch();
    failedReadyFetch.mockImplementationOnce(failedReadyFetch.getMockImplementation()!);
    failedReadyFetch.mockImplementationOnce(async request => response(JSON.stringify({
      status: 'not-ready',
      checks: { database: 'ok', redis: 'down', ingressProxy: 'ok' },
    }), {
      status: 503,
      headers: SECURITY_HEADERS,
      url: request.toString(),
    }));
    await expect(verifyDeployedRelease(input(), failedReadyFetch)).rejects.toThrow('/health/ready returned HTTP 503');
  });

  it('rejects public or incorrectly protected metrics', async () => {
    const publiclyReadableFetch = passingFetch();
    publiclyReadableFetch.mockImplementationOnce(publiclyReadableFetch.getMockImplementation()!);
    publiclyReadableFetch.mockImplementationOnce(publiclyReadableFetch.getMockImplementation()!);
    publiclyReadableFetch.mockImplementationOnce(async request => response('public metrics', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
      url: request.toString(),
    }));
    await expect(verifyDeployedRelease(input(), publiclyReadableFetch)).rejects.toThrow(
      '/metrics without authentication returned HTTP 200, expected 401',
    );

    const invalidTokenAcceptedFetch = passingFetch();
    invalidTokenAcceptedFetch.mockImplementationOnce(invalidTokenAcceptedFetch.getMockImplementation()!);
    invalidTokenAcceptedFetch.mockImplementationOnce(invalidTokenAcceptedFetch.getMockImplementation()!);
    invalidTokenAcceptedFetch.mockImplementationOnce(invalidTokenAcceptedFetch.getMockImplementation()!);
    invalidTokenAcceptedFetch.mockImplementationOnce(async request => response('accepted invalid token', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
      url: request.toString(),
    }));
    await expect(verifyDeployedRelease(input(), invalidTokenAcceptedFetch)).rejects.toThrow(
      '/metrics with an invalid token returned HTTP 200, expected 401',
    );
  });

  it('rejects ineffective transport and frame protections', async () => {
    const weakHstsFetch = passingFetch();
    weakHstsFetch.mockImplementationOnce(async request => response(JSON.stringify({ status: 'ok', release: SHA }), {
      status: 200,
      headers: { ...SECURITY_HEADERS, 'strict-transport-security': 'max-age=0' },
      url: request.toString(),
    }));
    await expect(verifyDeployedRelease(input(), weakHstsFetch)).rejects.toThrow('max-age of at least one year');

    const weakFrameFetch = passingFetch();
    weakFrameFetch.mockImplementationOnce(async request => response(JSON.stringify({ status: 'ok', release: SHA }), {
      status: 200,
      headers: {
        ...SECURITY_HEADERS,
        'x-frame-options': 'ALLOWALL',
        'content-security-policy': 'frame-ancestors *',
      },
      url: request.toString(),
    }));
    await expect(verifyDeployedRelease(input(), weakFrameFetch)).rejects.toThrow('clickjacking protection');
  });
});
