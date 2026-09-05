import { performance } from 'node:perf_hooks';

const acknowledgement = process.env.LOCAL_API_BENCHMARK_ACK;
const accessToken = process.env.API_BENCHMARK_TOKEN;
const expectedTenantId = process.env.API_BENCHMARK_EXPECTED_TENANT_ID;
const baseUrl = new URL(process.env.API_BENCHMARK_BASE_URL ?? 'http://127.0.0.1:3001');
const requestCount = Number(process.env.API_BENCHMARK_REQUESTS ?? 500);
const concurrency = Number(process.env.API_BENCHMARK_CONCURRENCY ?? 25);
const p95BudgetMs = Number(process.env.API_BENCHMARK_P95_MS ?? 500);
const p99BudgetMs = Number(process.env.API_BENCHMARK_P99_MS ?? 1_000);

if (acknowledgement !== 'READ_ONLY_LOCAL_API') {
  throw new Error('Set LOCAL_API_BENCHMARK_ACK=READ_ONLY_LOCAL_API to run this guarded benchmark');
}
if (!accessToken) throw new Error('API_BENCHMARK_TOKEN is required');
if (!expectedTenantId) throw new Error('API_BENCHMARK_EXPECTED_TENANT_ID is required');
if (baseUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname)) {
  throw new Error('The local API benchmark refuses every non-loopback target');
}
if (!Number.isInteger(requestCount) || requestCount < 1 || requestCount > 5_000) {
  throw new Error('API_BENCHMARK_REQUESTS must be an integer from 1 through 5000');
}
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) {
  throw new Error('API_BENCHMARK_CONCURRENCY must be an integer from 1 through 100');
}

const endpoints = [
  '/v1/auth/me',
  '/v1/dashboard/summary',
  '/v1/branches',
  '/v1/patients?limit=25',
  '/v1/appointments?limit=25',
  '/v1/campaigns?limit=25',
  '/v1/connected-care/enrollments',
  '/v1/inventory',
  '/v1/partner-reports',
  '/v1/telehealth/sessions',
  '/v1/reviews',
] as const;

type Sample = {
  endpoint: string;
  durationMs: number;
  status: number;
  bytes: number;
  ok: boolean;
};

const percentile = (sorted: number[], fraction: number): number => {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return Number(sorted[index].toFixed(2));
};

const summarize = (samples: Sample[]) => {
  const durations = samples.map(sample => sample.durationMs).sort((left, right) => left - right);
  return {
    requests: samples.length,
    failures: samples.filter(sample => !sample.ok).length,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    maxMs: Number((durations.at(-1) ?? 0).toFixed(2)),
    responseBytes: samples.reduce((total, sample) => total + sample.bytes, 0),
  };
};

async function request(endpoint: string): Promise<Sample> {
  const startedAt = performance.now();
  try {
    const response = await fetch(new URL(endpoint, baseUrl), {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.arrayBuffer();
    return {
      endpoint,
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
      status: response.status,
      bytes: body.byteLength,
      ok: response.ok,
    };
  } catch {
    return {
      endpoint,
      durationMs: Number((performance.now() - startedAt).toFixed(2)),
      status: 0,
      bytes: 0,
      ok: false,
    };
  }
}

async function assertTenantIdentity(): Promise<void> {
  const response = await fetch(new URL('/v1/auth/me', baseUrl), {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Identity check failed with HTTP ${response.status}`);
  const payload = await response.json() as { user?: { tenant?: { id?: string; name?: string } } };
  if (payload.user?.tenant?.id !== expectedTenantId) {
    throw new Error('Authenticated tenant does not match API_BENCHMARK_EXPECTED_TENANT_ID');
  }
}

async function main(): Promise<void> {
  await assertTenantIdentity();

  const warmup = await Promise.all(endpoints.map(endpoint => request(endpoint)));
  if (warmup.some(sample => !sample.ok)) {
    const failures = warmup.filter(sample => !sample.ok).map(sample => `${sample.status} ${sample.endpoint}`);
    throw new Error(`Warmup failed: ${failures.join(', ')}`);
  }

  const samples: Sample[] = [];
  let nextIndex = 0;
  const startedAt = performance.now();
  const workers = Array.from({ length: Math.min(concurrency, requestCount) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= requestCount) return;
      samples.push(await request(endpoints[index % endpoints.length]));
    }
  });
  await Promise.all(workers);
  const elapsedMs = performance.now() - startedAt;

  const aggregate = summarize(samples);
  const byEndpoint = Object.fromEntries(endpoints.map(endpoint => [
    endpoint,
    summarize(samples.filter(sample => sample.endpoint === endpoint)),
  ]));
  const statusCounts = samples.reduce<Record<string, number>>((counts, sample) => {
    const key = String(sample.status);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});

  const output = {
    target: `${baseUrl.protocol}//${baseUrl.host}`,
    tenantIdentity: 'verified',
    mode: 'read-only',
    requestCount,
    concurrency,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    throughputRequestsPerSecond: Number((requestCount / (elapsedMs / 1_000)).toFixed(2)),
    budgets: { p95Ms: p95BudgetMs, p99Ms: p99BudgetMs, failures: 0 },
    aggregate,
    statusCounts,
    byEndpoint,
    statement: 'Bounded loopback regression evidence only; not deployed capacity or provider saturation evidence.',
  };
  console.log(JSON.stringify(output, null, 2));

  if (aggregate.failures > 0) throw new Error(`${aggregate.failures} API requests failed`);
  if (aggregate.p95Ms > p95BudgetMs) throw new Error(`p95 ${aggregate.p95Ms}ms exceeded ${p95BudgetMs}ms budget`);
  if (aggregate.p99Ms > p99BudgetMs) throw new Error(`p99 ${aggregate.p99Ms}ms exceeded ${p99BudgetMs}ms budget`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
