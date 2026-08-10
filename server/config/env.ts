import 'dotenv/config';
import { z } from 'zod';
import { isIP } from 'node:net';
import { booleanString } from '../lib/booleanString';

// Integrations that have a mock mode and therefore need explicit
// acknowledgement outside the demo profile (see superRefine below and
// docs/INTEGRATION_MODE_REGISTER.md).
export const MOCKABLE_INTEGRATIONS = ['payments', 'insurance', 'ai'] as const;
export type MockableIntegration = (typeof MOCKABLE_INTEGRATIONS)[number];

// Parse the comma-separated ALLOWED_MOCK_INTEGRATIONS ack list. Trims and
// lowercases tokens; drops empties. Does NOT validate tokens — the superRefine
// does that so a typo fails boot with a real message instead of silently
// acknowledging nothing.
export function parseAllowedMockIntegrations(raw: string): string[] {
  return raw
    .split(',')
    .map(token => token.trim().toLowerCase())
    .filter(token => token.length > 0);
}

export function isIngressProxyConfigurationReady(config: { INGRESS_MODE: 'direct' | 'trusted_proxy'; TRUSTED_PROXY_CIDRS: string }): boolean {
  return config.INGRESS_MODE === 'direct'
    || config.TRUSTED_PROXY_CIDRS.split(',').some(value => value.trim().length > 0);
}

function publicHttpsUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const blockedSuffixes = ['.localhost', '.local', '.internal', '.test', '.example', '.invalid'];
    const valid = url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.hash
      && hostname !== 'localhost'
      && !blockedSuffixes.some(suffix => hostname.endsWith(suffix))
      && isIP(hostname) === 0
      && hostname.includes('.');
    return valid ? url : null;
  } catch {
    return null;
  }
}

function isPublicHttpsOrigin(raw: string): boolean {
  const url = publicHttpsUrl(raw);
  return Boolean(url && (url.pathname === '' || url.pathname === '/') && !url.search);
}

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Deployment posture, NOT runtime mode. Keyed separately from NODE_ENV on
  // purpose: the local E2E harness runs NODE_ENV=production under the default
  // 'demo' profile. 'pilot'/'enterprise' activate the integration-mode gate
  // below (docs/INTEGRATION_MODE_REGISTER.md): mock integrations must be
  // explicitly acknowledged, and enterprise never allows mock payments.
  DEPLOYMENT_PROFILE: z.enum(['demo', 'pilot', 'enterprise']).default('demo'),
  // Comma-separated ack list for the profile gate, e.g. "ai,insurance".
  // Valid tokens: payments | insurance | ai. Listing an integration here is a
  // deliberate, buyer-visible statement that this pilot/enterprise environment
  // knowingly runs it in mock mode. Ignored under the 'demo' profile (but
  // tokens are still validated so typos never lie in wait).
  ALLOWED_MOCK_INTEGRATIONS: z.string().default(''),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  // Declare whether the API is directly reachable or exclusively fronted by a
  // trusted reverse proxy. Proxied mode remains not-ready until the operator
  // supplies the actual private proxy CIDRs.
  INGRESS_MODE: z.enum(['direct', 'trusted_proxy']).default('direct'),
  // Comma-separated proxy IP/CIDR allowlist. Empty means do not trust forwarded
  // headers. Production ingress must list only its private/load-balancer hops;
  // never use blanket `trustProxy: true` on a directly reachable origin.
  TRUSTED_PROXY_CIDRS: z.string().default(''),
  DATABASE_URL: z.string().min(1),
  // Dedicated least-privilege control-plane role. Production requires this
  // unless the local E2E harness is explicitly enabled; it must not reuse the
  // tenant runtime principal.
  PLATFORM_DATABASE_URL: z.string().url().optional(),
  // Optional owner/superuser connection for migrations + seed. When set, the
  // runtime DATABASE_URL can be the restricted `app_rls` role while schema
  // changes and seeding keep running as the owner. Falls back to DATABASE_URL.
  DATABASE_MIGRATION_URL: z.string().optional(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  // Immutable deployment/dataset identity for BullMQ Redis keys. Tests must
  // provide a run-unique value before importing queue modules.
  QUEUE_NAMESPACE: z.string().regex(/^[A-Za-z0-9:_-]{1,80}$/).default('carecommand-local'),
  // Set false on Redis-less deploys (e.g. serverless). The app boots and all
  // request routes work; background jobs are simply not enqueued.
  QUEUES_ENABLED: booleanString(true),
  // RLS runtime-role guard. When the runtime DATABASE_URL role can bypass RLS
  // (superuser or rolbypassrls), tenant RLS policies are silently ineffective.
  // The guard always surfaces this at boot (error log in prod, warn otherwise).
  // Set true to FAIL CLOSED — refuse to boot — once the prod role is `app_rls`.
  // Default false so it can't brick a deploy that hasn't cut over yet.
  RLS_ENFORCE_RUNTIME_ROLE: booleanString(false),
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  // Dedicated HMAC key for tenant-scoped BullMQ envelopes. Optional for a
  // staged rollout; JWT_REFRESH_SECRET is used with domain separation if unset.
  // The secret never appears in queue payloads.
  JOB_ENVELOPE_SECRET: z.string().min(32).optional(),
  // Auth hardening (Phase A). Optional dedicated key for encrypting MFA secrets
  // at rest; if unset, a key is derived from JWT_SECRET.
  AUTH_ENCRYPTION_KEY: z.string().optional(),
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).max(128).default(8),
  AUTH_LOCKOUT_THRESHOLD: z.coerce.number().int().min(1).max(50).default(5),
  AUTH_LOCKOUT_DURATION_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  MFA_ISSUER: z.string().default('CareCommand AI'),
  CORS_ORIGINS: z.string().default('http://localhost:12000'),
  // Auth cookie SameSite policy. Use 'lax' for same-origin deploys; set 'none'
  // when the frontend and API are on different sites (e.g. Vercel UI + Render
  // API) so the refresh/CSRF cookies are sent on cross-site requests. 'none'
  // forces Secure (HTTPS required).
  COOKIE_SAMESITE: z.enum(['lax', 'none', 'strict']).default('lax'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Observability. When SENTRY_DSN is set, an error reporter should be wired at
  // boot (registerSentry in server/lib/observability.ts is the seam); unhandled
  // 5xx errors are captured with id-only context (never PHI). Unset → structured
  // error logs only. SERVICE_ENV/RELEASE tag events for triage when present.
  SENTRY_DSN: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
  SERVICE_ENV: z.string().optional(),
  RELEASE: z.string().optional(),
  // Logical service name stamped on traces/metrics/logs so the API and worker
  // are distinguishable in one backend. Overridden per-process where needed.
  OTEL_SERVICE_NAME: z.string().default('carecommand-api'),
  // ── Distributed tracing (OpenTelemetry) ───────────────────────────────────
  // Turn on only when an OTLP endpoint is configured; otherwise the SDK is a
  // no-op and adds zero overhead. The exporter ships spans over OTLP/HTTP to a
  // collector or vendor (Grafana Tempo, Honeycomb, Axiom, Sentry, …). Head
  // sampling keeps cost bounded; 1.0 in dev, ~0.1 in prod is a sane start.
  OTEL_ENABLED: booleanString(false),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_EXPORTER_OTLP_HEADERS: z.string().optional(), // "key=value,key2=value2"
  OTEL_TRACES_SAMPLER_RATIO: z.coerce.number().min(0).max(1).default(1),
  // ── Metrics (Prometheus) ──────────────────────────────────────────────────
  // /metrics is always exposed for scraping. In production it MUST be protected:
  // set METRICS_TOKEN and scrapers send `Authorization: Bearer <token>`. Unset
  // in production → the route returns 404 rather than leak internal cardinality.
  METRICS_ENABLED: booleanString(true),
  METRICS_TOKEN: z.string().optional(),
  // The worker records job_duration_seconds/jobs_total in ITS process, so it
  // serves the registry itself on this port (workers/metricsServer.ts) — the
  // API's /metrics can't see another process's counters.
  WORKER_METRICS_PORT: z.coerce.number().int().positive().default(9464),
  AI_PROVIDER: z.enum(['mock', 'ollama', 'openai', 'claude']).default('mock'),
  OLLAMA_MODE: z.enum(['local', 'cloud']).default('local'),
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_API_KEY: z.string().optional(),
  OLLAMA_MODEL: z.string().default('llama3.1'),
  OLLAMA_DEFAULT_MODEL: z.string().default('llama3.1'),
  // Governance: keep PHI out of AI by default; cap daily spend; gate sensitive actions.
  AI_ENABLE_PHI: booleanString(false),
  AI_COST_BUDGET_DAILY_USD: z.coerce.number().nonnegative().default(5),
  AI_REQUIRE_HUMAN_APPROVAL: booleanString(true),
  // ── Translation gateway ──────────────────────────────────────────────────
  // `auto` picks the first configured provider; MyMemory needs no key so the
  // app translates out of the box. Add a DeepL/Google key for higher quality.
  TRANSLATION_PROVIDER: z.enum(['auto', 'deepl', 'google', 'mymemory', 'off']).default('auto'),
  DEEPL_API_KEY: z.string().optional(),
  DEEPL_API_URL: z.string().url().default('https://api-free.deepl.com'),
  GOOGLE_TRANSLATE_API_KEY: z.string().optional(),
  MYMEMORY_EMAIL: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().default('gpt-4.1-mini'),
  CLAUDE_API_KEY: z.string().optional(),
  CLAUDE_BASE_URL: z.string().url().default('https://api.anthropic.com'),
  CLAUDE_MODEL: z.string().default('claude-3-5-sonnet-20241022'),
  INSURANCE_PROVIDER: z.enum(['stedi', 'mock', 'availity', 'pverify', 'optum']).default('mock'),
  STEDI_API_KEY: z.string().optional(),
  STEDI_BASE_URL: z.string().url().default('https://healthcare.us.stedi.com'),
  STEDI_TEST_MODE: booleanString(true),
  PAYMENT_PROVIDER: z.enum(['stripe', 'mock', 'square', 'authorize_net', 'clover', 'paypal']).default('mock'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_SUCCESS_URL: z.string().url().default('http://localhost:5173/revenue-protection?payment=success'),
  STRIPE_CANCEL_URL: z.string().url().default('http://localhost:5173/revenue-protection?payment=cancel'),
  SQUARE_ACCESS_TOKEN: z.string().optional(),
  AUTHORIZE_NET_API_LOGIN_ID: z.string().optional(),
  AUTHORIZE_NET_TRANSACTION_KEY: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  TWILIO_BASE_URL: z.string().url().default('https://api.twilio.com'),
  // Optional HTTP email API (e.g. SendGrid) so email can really send without an
  // SMTP TCP library. If unset, email stays configured_pending_provider.
  EMAIL_HTTP_API_URL: z.string().url().optional(),
  EMAIL_HTTP_API_KEY: z.string().optional(),
  EMAIL_FROM_ADDRESS: z.string().optional(),
  // Signing secret for the campaign delivery/status webhook (provider callbacks).
  CAMPAIGN_WEBHOOK_SECRET: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  DEV_TENANT_ID: z.string().uuid().optional(),
  DEV_USER_ID: z.string().uuid().optional(),
  PUBLIC_API_URL: z.string().url().default('http://localhost:3001'),
  RETELL_API_KEY: z.string().optional(),
  RETELL_FROM_NUMBER: z.string().optional(),
  RETELL_BASE_URL: z.string().url().default('https://api.retellai.com'),
  // Platform control plane legacy token (separate from tenant UserRole). In
  // production this token is disabled unless PLATFORM_LEGACY_TOKEN_ENABLED=true;
  // prefer PlatformUser login + platform JWT for all real environments.
  PLATFORM_API_TOKEN: z.string().optional(),
  PLATFORM_LEGACY_TOKEN_ENABLED: booleanString(false),
  // Explicit local/test delivery sink for browser E2E. When set, portal magic
  // login codes are appended as JSONL for the harness to read; they are still
  // never returned in production API responses. SECURITY: raw patient sign-in
  // tokens on disk are a credential leak, so with NODE_ENV=production this is
  // refused at boot unless E2E_TEST_MODE explicitly opts in (see superRefine).
  PORTAL_TOKEN_OUTBOX_PATH: z.string().optional(),
  // E2E harness escape hatch. The Playwright harness serves the built app with
  // NODE_ENV=production; this flag is the ONLY thing that legitimizes
  // PORTAL_TOKEN_OUTBOX_PATH in that mode. NEVER set on a real deployment.
  E2E_TEST_MODE: booleanString(false),
  // Platform Admin Console: first PLATFORM_OWNER is seeded ONLY from these env
  // vars (no weak default in production). Static token above is legacy/dev-only.
  PLATFORM_OWNER_EMAIL: z.string().optional(),
  PLATFORM_OWNER_NAME: z.string().optional(),
  PLATFORM_OWNER_PASSWORD: z.string().optional(),
  TRIAL_DAYS: z.coerce.number().int().min(1).max(365).default(14),
});

// Cross-field production hardening. Exported so tests can exercise the schema
// in isolation (see server/test/envSchema.test.ts).
export const envSchema = baseEnvSchema.superRefine((cfg, ctx) => {
  // Missing production configuration is rejected when platformDb is
  // constructed. Keeping that boot-time check outside this reusable schema
  // preserves isolated env-schema tests and tooling that never load platform.
  if (cfg.PLATFORM_DATABASE_URL) {
    try {
      const platformUser = new URL(cfg.PLATFORM_DATABASE_URL).username;
      const tenantUser = new URL(cfg.DATABASE_URL).username;
      if (!platformUser || platformUser !== 'app_platform') {
        ctx.addIssue({ code: 'custom', path: ['PLATFORM_DATABASE_URL'], message: 'PLATFORM_DATABASE_URL must authenticate as app_platform.' });
      }
      if (platformUser === tenantUser) {
        ctx.addIssue({ code: 'custom', path: ['PLATFORM_DATABASE_URL'], message: 'PLATFORM_DATABASE_URL must use a principal distinct from DATABASE_URL.' });
      }
    } catch {
      ctx.addIssue({ code: 'custom', path: ['PLATFORM_DATABASE_URL'], message: 'PLATFORM_DATABASE_URL must be a valid PostgreSQL URL.' });
    }
  }
  // PORTAL_TOKEN_OUTBOX_PATH writes RAW patient magic-login tokens to disk —
  // a PHI/credential leak on any real production host. Fail the boot closed
  // unless the E2E harness explicitly opted in.
  if (cfg.NODE_ENV === 'production' && cfg.PORTAL_TOKEN_OUTBOX_PATH && !cfg.E2E_TEST_MODE) {
    ctx.addIssue({
      code: 'custom',
      path: ['PORTAL_TOKEN_OUTBOX_PATH'],
      message:
        'PORTAL_TOKEN_OUTBOX_PATH must not be set when NODE_ENV=production: it writes raw patient sign-in tokens to disk. ' +
        'Unset it, or set E2E_TEST_MODE=true ONLY for the local browser E2E harness (never on a real deployment).',
    });
  }

  // ── Deployment-profile integration gate (docs/INTEGRATION_MODE_REGISTER.md) ─
  // Keyed on DEPLOYMENT_PROFILE, never NODE_ENV: the E2E harness runs
  // NODE_ENV=production with the default 'demo' profile and must keep booting.
  const allowedMocks = parseAllowedMockIntegrations(cfg.ALLOWED_MOCK_INTEGRATIONS);

  // Unknown ack tokens are always an error (any profile): a typo like
  // "payment" must fail loudly, not silently acknowledge nothing.
  const known = new Set<string>(MOCKABLE_INTEGRATIONS);
  for (const token of allowedMocks) {
    if (!known.has(token)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ALLOWED_MOCK_INTEGRATIONS'],
        message:
          `ALLOWED_MOCK_INTEGRATIONS contains unknown integration "${token}". ` +
          `Valid tokens: ${MOCKABLE_INTEGRATIONS.join(', ')} (comma-separated).`,
      });
    }
  }

  if (cfg.DEPLOYMENT_PROFILE === 'pilot' || cfg.DEPLOYMENT_PROFILE === 'enterprise') {
    const addProfileIssue = (path: string, message: string) => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };

    if (cfg.NODE_ENV !== 'production') {
      addProfileIssue('NODE_ENV', `${cfg.DEPLOYMENT_PROFILE} deployments require NODE_ENV=production.`);
    }
    if (cfg.E2E_TEST_MODE) {
      addProfileIssue(
        'E2E_TEST_MODE',
        `${cfg.DEPLOYMENT_PROFILE} deployments must not enable the local E2E escape hatch. Use DEPLOYMENT_PROFILE=demo for synthetic browser certification.`,
      );
    }
    if (!cfg.PLATFORM_DATABASE_URL) {
      addProfileIssue(
        'PLATFORM_DATABASE_URL',
        `${cfg.DEPLOYMENT_PROFILE} deployments require the dedicated app_platform database principal.`,
      );
    }
    if (!cfg.QUEUES_ENABLED) {
      addProfileIssue(
        'QUEUES_ENABLED',
        `${cfg.DEPLOYMENT_PROFILE} deployments require queues and an always-on worker for scheduled and retryable workflows.`,
      );
    }
    if (!isPublicHttpsOrigin(cfg.PUBLIC_API_URL)) {
      addProfileIssue(
        'PUBLIC_API_URL',
        `${cfg.DEPLOYMENT_PROFILE} deployments require a non-loopback HTTPS PUBLIC_API_URL for signed callbacks.`,
      );
    }
    const origins = cfg.CORS_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean);
    if (origins.length === 0 || origins.some(origin => !isPublicHttpsOrigin(origin))) {
      addProfileIssue(
        'CORS_ORIGINS',
        `${cfg.DEPLOYMENT_PROFILE} deployments require explicit non-loopback HTTPS browser origins.`,
      );
    }
    if (!cfg.METRICS_ENABLED || !cfg.METRICS_TOKEN) {
      addProfileIssue(
        'METRICS_TOKEN',
        `${cfg.DEPLOYMENT_PROFILE} deployments require enabled, bearer-protected operational metrics.`,
      );
    }
    if (cfg.PLATFORM_LEGACY_TOKEN_ENABLED) {
      addProfileIssue(
        'PLATFORM_LEGACY_TOKEN_ENABLED',
        `${cfg.DEPLOYMENT_PROFILE} deployments must keep the legacy platform token disabled.`,
      );
    }
    if (cfg.COOKIE_SAMESITE !== 'none') {
      addProfileIssue(
        'COOKIE_SAMESITE',
        `${cfg.DEPLOYMENT_PROFILE} deployments require COOKIE_SAMESITE=none so split-site HTTPS refresh, CSRF, and logout cookies remain operational.`,
      );
    }

    const mockModes: Array<{ integration: MockableIntegration; envKey: string }> = [];
    if (cfg.PAYMENT_PROVIDER === 'mock') mockModes.push({ integration: 'payments', envKey: 'PAYMENT_PROVIDER' });
    if (cfg.INSURANCE_PROVIDER === 'mock') mockModes.push({ integration: 'insurance', envKey: 'INSURANCE_PROVIDER' });
    if (cfg.AI_PROVIDER === 'mock') mockModes.push({ integration: 'ai', envKey: 'AI_PROVIDER' });

    for (const { integration, envKey } of mockModes) {
      // Enterprise: payments are the money path — mock is NEVER acceptable,
      // acknowledged or not. A validation environment that "collects" fake
      // money produces buyer-facing claims that are untrue.
      if (cfg.DEPLOYMENT_PROFILE === 'enterprise' && integration === 'payments') {
        ctx.addIssue({
          code: 'custom',
          path: [envKey],
          message:
            'DEPLOYMENT_PROFILE=enterprise forbids mock payments — payments are the money path and cannot be ' +
            'mocked in an enterprise validation environment, even via ALLOWED_MOCK_INTEGRATIONS. ' +
            'Fix: set PAYMENT_PROVIDER to a real provider (e.g. stripe, with STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET), ' +
            'or use DEPLOYMENT_PROFILE=pilot if this environment genuinely is not an enterprise validation.',
        });
        continue;
      }
      if (!allowedMocks.includes(integration)) {
        ctx.addIssue({
          code: 'custom',
          path: [envKey],
          message:
            `Integration "${integration}" is in mock mode (${envKey}=mock) but DEPLOYMENT_PROFILE=${cfg.DEPLOYMENT_PROFILE} ` +
            'requires every integration to be explicitly live/sandbox/mock-acknowledged (docs/INTEGRATION_MODE_REGISTER.md). ' +
            `Fix: configure a real provider for ${envKey}, or explicitly acknowledge the mock by adding "${integration}" ` +
            'to ALLOWED_MOCK_INTEGRATIONS (comma-separated).',
        });
      }
    }

    if (cfg.PAYMENT_PROVIDER === 'stripe') {
      if (!cfg.STRIPE_SECRET_KEY) {
        addProfileIssue('STRIPE_SECRET_KEY', 'Stripe mode requires STRIPE_SECRET_KEY.');
      }
      if (!cfg.STRIPE_WEBHOOK_SECRET) {
        addProfileIssue('STRIPE_WEBHOOK_SECRET', 'Stripe mode requires STRIPE_WEBHOOK_SECRET.');
      }
      if (!publicHttpsUrl(cfg.STRIPE_SUCCESS_URL)) {
        addProfileIssue('STRIPE_SUCCESS_URL', 'Stripe mode requires a non-loopback HTTPS success URL.');
      }
      if (!publicHttpsUrl(cfg.STRIPE_CANCEL_URL)) {
        addProfileIssue('STRIPE_CANCEL_URL', 'Stripe mode requires a non-loopback HTTPS cancellation URL.');
      }
    }
    if (cfg.INSURANCE_PROVIDER === 'stedi' && !cfg.STEDI_TEST_MODE && !cfg.STEDI_API_KEY) {
      addProfileIssue('STEDI_API_KEY', 'Live Stedi mode requires STEDI_API_KEY; use STEDI_TEST_MODE=true for sandbox validation.');
    }
    if (cfg.AI_PROVIDER === 'openai' && !cfg.OPENAI_API_KEY) {
      addProfileIssue('OPENAI_API_KEY', 'OpenAI mode requires OPENAI_API_KEY.');
    }
    if (cfg.AI_PROVIDER === 'claude' && !cfg.CLAUDE_API_KEY) {
      addProfileIssue('CLAUDE_API_KEY', 'Claude mode requires CLAUDE_API_KEY.');
    }
    if (cfg.AI_PROVIDER === 'ollama' && cfg.OLLAMA_MODE === 'cloud' && !cfg.OLLAMA_API_KEY) {
      addProfileIssue('OLLAMA_API_KEY', 'Ollama cloud mode requires OLLAMA_API_KEY.');
    }
  }
});

export const env = envSchema.parse(process.env);
