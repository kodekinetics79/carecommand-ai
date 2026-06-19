# Production Readiness — CareCommand AI

Tracking the move from demo posture → production-grade. Status as of the
"build the foundation" track (no specific first client yet).

Legend: ✅ done · 🟡 in progress · ⬜ todo

## Phase 1 — Trust & isolation (the non-negotiables)
- ✅ CI runs typecheck + lint + **tests** + build on every push/PR (Postgres + Redis services).
- ✅ CI **secret scanning** (gitleaks, blocking) + **dependency audit** (`npm audit --audit-level=high --omit=dev`, **blocking** — production tree at 0 high+ after pinning the dev-only `hono`/`@hono/node-server` transitive via `overrides`).
- ✅ Production **seed guard** — refuses to load demo data into prod unless `ALLOW_PROD_SEED=true`.
- 🟡 **RLS / DB-level tenant isolation** — mechanism live, enforced on 6 tables, now **CI-proven**, expansion in progress (wave rollout).
  - **How it works:** the runtime connects as the non-bypass role `app_rls`; `server/lib/tenantContext.ts` exposes `runWithTenantContext/JobTenantContext/WebhookTenantContext`, which open a Prisma interactive transaction and `set_config('app.current_tenant_id', …, is_local=true)` on the pinned connection. Policies filter `tenantId = current_setting('app.current_tenant_id')` and **fail closed** when unset.
  - **Enforced today (RLS + FORCE):** `NotificationTemplate`, `AiGuardrail`, `CustomerPreference`, `DepositRule`, `RevenueLeak`, `RevenueProtectionAlert` — every access path adopts `runWithTenantContext` (7 modules).
  - **Proof (CI-gated):** `server/test/rls.test.ts` — drops to `app_rls`, proves cross-tenant read/update/delete denied, `WITH CHECK` blocks cross-tenant writes, and unset GUC yields zero rows. Portable across the `app_rls` runtime role and the CI superuser base (via `SET LOCAL ROLE app_rls`).
  - **Intentional exclusions (do NOT enrol):** `User`, `PasswordResetToken` (login needs cross-tenant lookup), `TenantSubscription`/`TenantFeatureEntitlement`/`SubscriptionPlan*` (entitlement checks), `PaymentRequest`/`DepositRequirement` (webhook-global by design). `Tenant` + platform/global tables are correctly non-tenant.
  - **Remaining (wave work):** ~99 tenant tables not yet enrolled. Each wave: route all access through `runWithTenantContext` → enable RLS in a reversible migration → extend `rls.test.ts`. Until enrolled, the app-level `where: { tenantId }` on every query is the primary control; RLS is defense-in-depth.
  - **⚠️ Production cutover check:** the prod `DATABASE_URL` runtime role MUST be `rolbypassrls=false` (i.e., `app_rls`, not a Neon owner/superuser) or RLS is silently ineffective. Verify before relying on it in prod.
- ⬜ **Observability**: Sentry (backend + frontend, env-gated by `SENTRY_DSN`), structured request logging, uptime + error-rate alerting. *(Priority #2 — next increment.)*
- ⬜ **Secrets**: rotate the values shared in chat (Neon/Redis/Retell + JWT/encryption); confirm all are Vercel-encrypted env, none in git.

## Phase 2 — Reliability
- ⬜ **Background workers** run in prod (autopilot, campaign scheduler, compliance crons). Serverless can't host long-running BullMQ consumers — use **Vercel Cron** for schedules + a small always-on worker (Render/Fly/Railway) for queue consumers. Today `QUEUES_ENABLED=true` enqueues but nothing consumes.
- ⬜ Neon **pooled** runtime URL + connection-limit review; migration safety (no destructive auto-migrate).
- ⬜ Automated **backups** + restore drill; rate-limit tuning under load.

## Phase 3 — Real integrations (config-gated; `mock` stays the safe default)
- ⬜ **Stripe** live (deposits, RPM billing export — never auto-submit).
- ⬜ **Stedi production** eligibility (sandbox already works).
- ⬜ **Twilio** (SMS/WhatsApp) + email provider + the **Retell** phone number for the receptionist.
- ⬜ Real AI model for the gateway + **DeepL** for translation (MyMemory is the keyless default).

## Phase 4 — Go-to-market
- ⬜ Self-serve **clinic onboarding** + provisioning + Stripe **subscription billing** + entitlement enforcement.
- ⬜ Per-tenant **data import** + admin tooling.
- ⬜ **HIPAA posture**: vendor **BAAs** (Neon, Retell, Twilio, Stedi, AI provider), encryption review, audit-log retention policy, formal security/privacy review.

## Cross-cutting
- ⬜ Expand test coverage on the money paths (payments, eligibility, booking, RLS).
- ⬜ Performance: serverless cold-start budget; bundle size; key DB indexes.
- ⬜ Runbooks: incident, rollback, on-call, data-subject requests.
