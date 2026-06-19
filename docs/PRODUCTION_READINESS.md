# Production Readiness — CareCommand AI

Tracking the move from demo posture → production-grade. Status as of the
"build the foundation" track (no specific first client yet).

Legend: ✅ done · 🟡 in progress · ⬜ todo

## Phase 1 — Trust & isolation (the non-negotiables)
- ✅ CI runs typecheck + lint + **tests** + build on every push/PR (Postgres + Redis services).
- ✅ CI **secret scanning** (gitleaks) + **dependency audit** (`npm audit`).
- ✅ Production **seed guard** — refuses to load demo data into prod unless `ALLOW_PROD_SEED=true`.
- ⬜ **Enforce RLS** (DB-level tenant isolation). Today: policies exist on 3 pilot tables only, the app connects as the Neon **owner**, and `app.current_tenant_id` is never set — so RLS is effectively off. This is the crown jewel and a real refactor:
  1. App connects as the restricted `app_rls` role (not owner).
  2. A Prisma client extension wraps every operation in a transaction that runs `SELECT set_config('app.current_tenant_id', $tenant, true)` (transaction-scoped, safe with pooled/serverless connections).
  3. Extend `tenant_isolation` policies to **all** tenant-scoped tables (generated from the schema).
  4. Backfill tests proving cross-tenant reads/writes are denied at the DB layer.
  *(Primary control — every query is `where: { tenantId }` — is already in place; RLS is defense-in-depth. Do this as its own tested PR, not a hot patch.)*
- ⬜ **Observability**: Sentry (backend + frontend, env-gated by `SENTRY_DSN`), structured request logging, uptime + error-rate alerting.
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
