import 'dotenv/config';
import { z } from 'zod';
import { booleanString } from '../lib/booleanString';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1),
  // Optional owner/superuser connection for migrations + seed. When set, the
  // runtime DATABASE_URL can be the restricted `app_rls` role while schema
  // changes and seeding keep running as the owner. Falls back to DATABASE_URL.
  DATABASE_MIGRATION_URL: z.string().optional(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
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
  DEV_TENANT_ID: z.string().uuid().default('11111111-1111-4111-8111-111111111111'),
  DEV_USER_ID: z.string().uuid().default('22222222-2222-4222-8222-222222222222'),
  PUBLIC_API_URL: z.string().url().default('http://localhost:3001'),
  RETELL_API_KEY: z.string().optional(),
  RETELL_AGENT_ID: z.string().optional(),
  RETELL_FROM_NUMBER: z.string().optional(),
  RETELL_BASE_URL: z.string().url().default('https://api.retellai.com'),
  // Platform control plane (separate from tenant UserRole). Operators present
  // this token on /v1/platform/* and /v1/onboarding/*. In non-production a dev
  // default is allowed; production MUST set a strong token.
  PLATFORM_API_TOKEN: z.string().optional(),
  // Platform Admin Console: first PLATFORM_OWNER is seeded ONLY from these env
  // vars (no weak default in production). Static token above is legacy/dev-only.
  PLATFORM_OWNER_EMAIL: z.string().optional(),
  PLATFORM_OWNER_NAME: z.string().optional(),
  PLATFORM_OWNER_PASSWORD: z.string().optional(),
  TRIAL_DAYS: z.coerce.number().int().min(1).max(365).default(14),
});

export const env = envSchema.parse(process.env);
