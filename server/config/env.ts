import 'dotenv/config';
import { z } from 'zod';

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
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  AI_PROVIDER: z.enum(['mock', 'ollama', 'openai', 'claude']).default('mock'),
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_MODEL: z.string().default('llama3.1'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().default('gpt-4.1-mini'),
  CLAUDE_API_KEY: z.string().optional(),
  CLAUDE_BASE_URL: z.string().url().default('https://api.anthropic.com'),
  CLAUDE_MODEL: z.string().default('claude-3-5-sonnet-20241022'),
  INSURANCE_PROVIDER: z.enum(['stedi', 'mock', 'availity', 'pverify', 'optum']).default('mock'),
  STEDI_API_KEY: z.string().optional(),
  STEDI_BASE_URL: z.string().url().default('https://healthcare.us.stedi.com'),
  STEDI_TEST_MODE: z.coerce.boolean().default(true),
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
  TRIAL_DAYS: z.coerce.number().int().min(1).max(365).default(14),
});

export const env = envSchema.parse(process.env);
