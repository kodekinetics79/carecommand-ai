const DEPLOYMENT_HOST = 'carecommand.kodekinetics.com';
const VERIFICATION_ACK = 'READ_ONLY_CARECOMMAND_DEPLOYMENT';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

type FetchImplementation = typeof fetch;

export type DeployedReleaseVerificationInput = {
  acknowledgement: string | undefined;
  baseUrl: string | undefined;
  expectedSha: string | undefined;
  metricsToken: string | undefined;
};

export type DeployedReleaseVerificationResult = {
  baseUrl: string;
  expectedSha: string;
  health: {
    status: 'ok';
    release: string;
  };
  readiness: {
    status: 'ready';
    database: 'ok';
    redis: 'ok';
    ingressProxy: 'ok';
  };
  metrics: {
    status: 'protected-and-readable';
    unauthenticatedStatus: 401;
    invalidTokenStatus: 401;
    contentType: string;
    requiredSeries: ['queue_depth', 'dependency_up'];
  };
  securityHeaders: {
    strictTransportSecurity: true;
    noSniff: true;
    frameProtection: true;
  };
};

type ValidatedInput = {
  baseUrl: URL;
  expectedSha: string;
  metricsToken: string;
};

function validateInput(input: DeployedReleaseVerificationInput): ValidatedInput {
  if (input.acknowledgement !== VERIFICATION_ACK) {
    throw new Error(`Set DEPLOYED_RELEASE_VERIFY_ACK=${VERIFICATION_ACK} to acknowledge the read-only production check`);
  }
  if (!input.baseUrl) throw new Error('DEPLOYED_RELEASE_BASE_URL is required');
  if (!input.expectedSha || !/^[a-f0-9]{40}$/i.test(input.expectedSha)) {
    throw new Error('DEPLOYED_RELEASE_EXPECTED_SHA must be a full 40-character Git SHA');
  }
  if (!input.metricsToken?.trim()) {
    throw new Error('DEPLOYED_RELEASE_METRICS_TOKEN is required to prove the protected metrics route');
  }

  const baseUrl = new URL(input.baseUrl);
  if (baseUrl.protocol !== 'https:') throw new Error('Deployment verification requires HTTPS');
  if (baseUrl.hostname !== DEPLOYMENT_HOST) {
    throw new Error(`Deployment verification is restricted to ${DEPLOYMENT_HOST}`);
  }
  if (baseUrl.port || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error('Deployment URL must be the canonical origin without credentials, port, query or fragment');
  }
  if (baseUrl.pathname !== '/' && baseUrl.pathname !== '') {
    throw new Error('Deployment URL must not include a path');
  }

  return {
    baseUrl: new URL(`https://${DEPLOYMENT_HOST}/`),
    expectedSha: input.expectedSha.toLowerCase(),
    metricsToken: input.metricsToken,
  };
}

async function readBoundedText(response: Response, label: string): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} response exceeds the verification size limit`);
  }
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} response exceeds the verification size limit`);
  }
  return body;
}

async function get(
  fetchImplementation: FetchImplementation,
  baseUrl: URL,
  path: string,
  authorization?: string,
): Promise<Response> {
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl.origin) throw new Error(`Refusing cross-origin verification request: ${path}`);
  const response = await fetchImplementation(url, {
    method: 'GET',
    redirect: 'error',
    headers: authorization ? { authorization } : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (response.url && new URL(response.url).origin !== baseUrl.origin) {
    throw new Error(`${path} returned a cross-origin response`);
  }
  return response;
}

function assertSecurityHeaders(response: Response, label: string): void {
  const strictTransportSecurity = response.headers.get('strict-transport-security') ?? '';
  const maxAgeMatch = strictTransportSecurity.match(/(?:^|;)\s*max-age=(\d+)(?:;|$)/i);
  if (!maxAgeMatch || Number(maxAgeMatch[1]) < 31_536_000) {
    throw new Error(`${label} requires Strict-Transport-Security max-age of at least one year`);
  }
  if (response.headers.get('x-content-type-options')?.toLowerCase() !== 'nosniff') {
    throw new Error(`${label} is missing X-Content-Type-Options: nosniff`);
  }
  const frameHeader = response.headers.get('x-frame-options')?.toUpperCase();
  const contentSecurityPolicy = response.headers.get('content-security-policy')?.toLowerCase() ?? '';
  const restrictiveFrameHeader = frameHeader === 'DENY' || frameHeader === 'SAMEORIGIN';
  const restrictiveFramePolicy = /(?:^|;)\s*frame-ancestors\s+(?:'none'|'self')(?:\s|;|$)/.test(contentSecurityPolicy);
  if (!restrictiveFrameHeader && !restrictiveFramePolicy) {
    throw new Error(`${label} is missing clickjacking protection`);
  }
}

function parseJsonObject(body: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${label} did not return a JSON object`);
  }
}

export async function verifyDeployedRelease(
  input: DeployedReleaseVerificationInput,
  fetchImplementation: FetchImplementation = fetch,
): Promise<DeployedReleaseVerificationResult> {
  const validated = validateInput(input);

  const healthResponse = await get(fetchImplementation, validated.baseUrl, '/health');
  if (healthResponse.status !== 200) throw new Error(`/health returned HTTP ${healthResponse.status}`);
  assertSecurityHeaders(healthResponse, '/health');
  const health = parseJsonObject(await readBoundedText(healthResponse, '/health'), '/health');
  if (health.status !== 'ok') throw new Error('/health did not report status=ok');
  if (typeof health.release !== 'string' || health.release.toLowerCase() !== validated.expectedSha) {
    throw new Error(`/health release mismatch: expected ${validated.expectedSha}, received ${String(health.release)}`);
  }

  const readyResponse = await get(fetchImplementation, validated.baseUrl, '/health/ready');
  if (readyResponse.status !== 200) throw new Error(`/health/ready returned HTTP ${readyResponse.status}`);
  assertSecurityHeaders(readyResponse, '/health/ready');
  const ready = parseJsonObject(await readBoundedText(readyResponse, '/health/ready'), '/health/ready');
  const checks = ready.checks;
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) {
    throw new Error('/health/ready did not return dependency checks');
  }
  const dependencyChecks = checks as Record<string, unknown>;
  if (
    ready.status !== 'ready'
    || dependencyChecks.database !== 'ok'
    || dependencyChecks.redis !== 'ok'
    || dependencyChecks.ingressProxy !== 'ok'
  ) {
    throw new Error('/health/ready did not report database, Redis and ingress proxy ready');
  }

  const unauthenticatedMetricsResponse = await get(fetchImplementation, validated.baseUrl, '/metrics');
  if (unauthenticatedMetricsResponse.status !== 401) {
    throw new Error(`/metrics without authentication returned HTTP ${unauthenticatedMetricsResponse.status}, expected 401`);
  }
  const invalidTokenMetricsResponse = await get(
    fetchImplementation,
    validated.baseUrl,
    '/metrics',
    'Bearer carecommand-deliberately-invalid-monitoring-token',
  );
  if (invalidTokenMetricsResponse.status !== 401) {
    throw new Error(`/metrics with an invalid token returned HTTP ${invalidTokenMetricsResponse.status}, expected 401`);
  }

  const metricsResponse = await get(
    fetchImplementation,
    validated.baseUrl,
    '/metrics',
    `Bearer ${validated.metricsToken}`,
  );
  if (metricsResponse.status !== 200) throw new Error(`/metrics returned HTTP ${metricsResponse.status}`);
  const metricsContentType = metricsResponse.headers.get('content-type') ?? '';
  if (!metricsContentType.toLowerCase().includes('text/plain')) {
    throw new Error(`/metrics returned unexpected Content-Type: ${metricsContentType || 'missing'}`);
  }
  const metrics = await readBoundedText(metricsResponse, '/metrics');
  if (!/^# (?:HELP|TYPE) /m.test(metrics)) throw new Error('/metrics did not return Prometheus exposition text');
  for (const series of ['queue_depth', 'dependency_up'] as const) {
    if (!new RegExp(`(?:^|\\n)(?:# (?:HELP|TYPE) ${series} |${series}(?:\\{|\\s))`, 'm').test(metrics)) {
      throw new Error(`/metrics is missing required series ${series}`);
    }
  }

  return {
    baseUrl: validated.baseUrl.origin,
    expectedSha: validated.expectedSha,
    health: { status: 'ok', release: String(health.release) },
    readiness: {
      status: 'ready',
      database: 'ok',
      redis: 'ok',
      ingressProxy: 'ok',
    },
    metrics: {
      status: 'protected-and-readable',
      unauthenticatedStatus: 401,
      invalidTokenStatus: 401,
      contentType: metricsContentType,
      requiredSeries: ['queue_depth', 'dependency_up'],
    },
    securityHeaders: {
      strictTransportSecurity: true,
      noSniff: true,
      frameProtection: true,
    },
  };
}
