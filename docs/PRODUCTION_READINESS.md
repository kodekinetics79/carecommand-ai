# Production Readiness — CareCommand AI

Tracking the move from demo posture → production-grade. Status as of the
"build the foundation" track (no specific first client yet).

Legend: ✅ done · 🟡 in progress · ⬜ todo

## Phase 1 — Trust & isolation (the non-negotiables)
- ✅ CI runs typecheck + lint + **tests** + build on every push/PR (Postgres + Redis services).
- ✅ CI **secret scanning** (gitleaks, blocking) + **dependency audit** (`npm audit --audit-level=high --omit=dev`, **blocking** — production tree at 0 high+ after pinning the dev-only `hono`/`@hono/node-server` transitive via `overrides`).
- ✅ Production **seed guard** — refuses to load demo data into prod unless `ALLOW_PROD_SEED=true`.
- ✅ Production legacy platform token is disabled by default. `PLATFORM_API_TOKEN`
  is accepted in production only when the explicit break-glass flag
  `PLATFORM_LEGACY_TOKEN_ENABLED=true` is set; prefer PlatformUser login +
  platform JWT. Proof: `server/test/platformLegacyToken.test.ts`.
- 🟡 **RLS / DB-level tenant isolation** — mechanism live, enforced on 6 tables, now **CI-proven**, expansion in progress (wave rollout).
  - **How it works:** the runtime connects as the non-bypass role `app_rls`; `server/lib/tenantContext.ts` exposes `runWithTenantContext/JobTenantContext/WebhookTenantContext`, which open a Prisma interactive transaction and `set_config('app.current_tenant_id', …, is_local=true)` on the pinned connection. Policies filter `tenantId = current_setting('app.current_tenant_id')` and **fail closed** when unset.
  - **Enforced today (RLS + FORCE):** `NotificationTemplate`, `AiGuardrail`, `CustomerPreference`, `DepositRule`, `RevenueLeak`, `RevenueProtectionAlert` — every access path adopts `runWithTenantContext` (7 modules).
  - **Proof (CI-gated):** `server/test/rls.test.ts` — drops to `app_rls`, proves cross-tenant read/update/delete denied, `WITH CHECK` blocks cross-tenant writes, and unset GUC yields zero rows. Portable across the `app_rls` runtime role and the CI superuser base (via `SET LOCAL ROLE app_rls`).
  - **Intentional exclusions (do NOT enrol):** `User`, `PasswordResetToken` (login needs cross-tenant lookup), `TenantSubscription`/`TenantFeatureEntitlement`/`SubscriptionPlan*` (entitlement checks), `PaymentRequest`/`DepositRequirement` (webhook-global by design). `Tenant` + platform/global tables are correctly non-tenant.
  - **Remaining (wave work):** ~99 tenant tables not yet enrolled. Each wave: route all access through `runWithTenantContext` → enable RLS in a reversible migration → extend `rls.test.ts`. Until enrolled, the app-level `where: { tenantId }` on every query is the primary control; RLS is defense-in-depth.
  - **⚠️ Production cutover check:** the prod `DATABASE_URL` runtime role MUST be `rolbypassrls=false` (i.e., `app_rls`, not a Neon owner/superuser) or RLS is silently ineffective. Verify before relying on it in prod.
- 🟡 **Observability**: backend foundation shipped — **PHI-safe structured logging** (`server/config/logger.ts`: pino `redact` for auth/cookie/token/webhook-signature paths, used app-wide) and a **vendor-neutral error-capture seam** (`server/lib/observability.ts`): the HTTP error handler captures every **5xx with id-only context** (requestId/route/method/tenantId/userId/statusCode — never bodies/PHI) as a structured `event:'exception'` log and forwards to a registered reporter. **Sentry is a ~6-line boot wiring** (`setErrorReporter` + `@sentry/node`, gated by `SENTRY_DSN`) documented in the module — no premature dependency. Proven by `server/test/observability.test.ts` (redaction, capture, reporter forwarding/throw-safety, 5xx-vs-4xx routing). *Remaining:* install + wire Sentry for real, frontend error reporting, uptime + error-rate alerting.
- ⬜ **Secrets**: rotate the values shared in chat (Neon/Redis/Retell + JWT/encryption); confirm all are Vercel-encrypted env, none in git.

## Phase 2 — Reliability
- 🟡 **Background workers** — a **unified worker runtime** (`server/workers/index.ts`, `npm run worker:start`) now drains **all three** queues in one always-on process (autopilot execution, campaign scheduler, compliance maintenance) and registers every repeatable schedule idempotently, with a `QUEUES_ENABLED` guard, graceful shutdown, and worker faults routed to `captureException`. Previously `worker:start` booted autopilot + compliance but **not** campaign, so the campaign queue had no consumer. Proven by `server/test/worker.integration.test.ts` — enqueues an APPROVED autopilot action and asserts the worker executes it (status → EXECUTED + audit) against real Redis + Postgres. *Remaining:* deploy this process to a small always-on host (Render/Fly/Railway) next to the serverless API; the API/Vercel deploy does not host it.
- ⬜ Neon **pooled** runtime URL + connection-limit review; migration safety (no destructive auto-migrate).
- 🟡 Automated **backups** + restore drill; rate-limit tuning under load.
  Runbook added: [docs/BACKUP_RESTORE_ROLLBACK_RUNBOOK.md](/Users/zackkhan/carecommand-ai/docs/BACKUP_RESTORE_ROLLBACK_RUNBOOK.md).
  The runbook still needs execution against the actual pilot hosting stack.

## Phase 3 — Real integrations (config-gated; `mock` stays the safe default)
- ✅ **Deployment profile gates** — mock integrations can no longer masquerade as
  a validation environment. `DEPLOYMENT_PROFILE` (`demo`|`pilot`|`enterprise`,
  default `demo`; independent of `NODE_ENV` so the E2E harness keeps booting)
  activates a boot-time gate in `server/config/env.ts`: under `pilot`/`enterprise`,
  any of `PAYMENT_PROVIDER`/`INSURANCE_PROVIDER`/`AI_PROVIDER` still `mock` fails
  boot unless explicitly acknowledged via `ALLOWED_MOCK_INTEGRATIONS`
  (comma-separated: `payments,insurance,ai`; unknown tokens always fail boot).
  `enterprise` additionally **never** allows mock payments, acknowledged or not
  (money path). Effective posture is truthfully reported at
  `GET /health/integrations` (provider ids + configured/not_configured flags,
  no secrets). Proof: `server/test/envSchema.test.ts`,
  `server/test/observabilityPillars.test.ts`. Contract:
  [docs/INTEGRATION_MODE_REGISTER.md](/Users/zackkhan/carecommand-ai/docs/INTEGRATION_MODE_REGISTER.md).
- ⬜ **Stripe** live (deposits, RPM billing export — never auto-submit).
- ⬜ **Stedi production** eligibility (sandbox already works).
- ⬜ **Twilio** (SMS/WhatsApp) + email provider + the **Retell** phone number for the receptionist.
- ⬜ Real AI model for the gateway + **DeepL** for translation (MyMemory is the keyless default).

## Phase 4 — Go-to-market
- ⬜ Self-serve **clinic onboarding** + provisioning + Stripe **subscription billing** + entitlement enforcement.
- 🟡 Operator-only **pilot launchpad**: tenant provisioning + checklist + downloadable CSV templates + saved clinic mapping presets + shareable customer status links + CSV preview/commit import for patients, appointments, and insurance, with platform audit trail. Still not self-serve, still not generalized ETL.
  - Pilot handoff checklist: [docs/PILOT_HANDOVER_CHECKLIST.md](/Users/zackkhan/carecommand-ai/docs/PILOT_HANDOVER_CHECKLIST.md)
- 🟡 **Enterprise client validation**: the local synthetic suite is green, but
  client implementation readiness requires the client to run real-data,
  real-scenario acceptance testing with evidence capture and formal go/no-go
  gates. Runbook: [docs/ENTERPRISE_CLIENT_VALIDATION_RUNBOOK.md](/Users/zackkhan/carecommand-ai/docs/ENTERPRISE_CLIENT_VALIDATION_RUNBOOK.md)
- ⬜ **HIPAA posture**: vendor **BAAs** (Neon, Retell, Twilio, Stedi, AI provider), encryption review, audit-log retention policy, formal security/privacy review.

## Cross-cutting
- 🟡 **Backend-enforcement test coverage** (proves rules can't be bypassed by direct API calls):
  - ✅ `server/test/security.integration.test.ts` — unauthenticated → 401, forged token → 401, **RBAC** (PROVIDER cannot create patient → 403, ADMIN → 201), **tenant isolation** (tenant A cannot read tenant B by id → 404, nor via list), suspended tenant → 403.
  - ✅ `server/test/rls.test.ts` — DB-level isolation (see Phase 1).
- 🟡 **Permission/action RBAC (enforced + tenant-customisable)** — `server/lib/permissions.ts` adds an action-level layer (`resource:action` grants) on top of the coarse `UserRole` enum. `requirePermission()` enforces server-side (403 `insufficient_permission`); `ROLE_PERMISSIONS` is the fail-safe default matrix, calibrated to reproduce the prior `requireRoles(...)` membership. A tenant can OVERRIDE a role's grant set via `RoleDefinition.permissions` (nullable JSON; null → defaults), which makes the per-tenant role editor a real control rather than a cosmetic catalogue. **Wired on:** patient mutations (`patient:write`), settings writes (`settings:write`), tenant-admin surface (`admin:manage`). **Remaining (wave work):** the other ~60 `requireRoles(...)` sites still gate by role label — migrate per module to `requirePermission` as each is touched.
  - **Proof (CI-gated):** `server/test/rbac.permissions.test.ts` — default matrix enforced (FRONT_DESK/ADMIN 201, PROVIDER 403 on patient create); a tenant **override grants** `patient:write` to PROVIDER (now 201); an override **revokes** it from FRONT_DESK (now 403); overrides are **tenant-scoped** (grant in A does not leak to B); `settings:write` and `admin:manage` enforced.
  - **Migration:** `20260629000000_role_definition_permissions` adds nullable `RoleDefinition.permissions` (JSONB). Additive/backward-compatible. Rollback: `ALTER TABLE "RoleDefinition" DROP COLUMN "permissions";`.
  - 🟡 Money paths: ✅ `server/test/payments.integration.test.ts` — **Stripe webhook signature verification** (invalid sig → 400, nothing collected), **idempotency** on the Stripe event id (redelivery → `duplicate:true`, no second `paymentTransaction`), verified success → `collected` + transaction + `payment.succeeded` audit, unmatched event acknowledged (200), **tokenized public checkout** is patient-safe (no tenant/PHI ids leaked; 404 on unknown token), and authed payment routes require auth (401). Eligibility has authed coverage in `connectedCare.integration.test.ts`. ⬜ still: booking/no-show money flows, mobile/loading/error UI states, large-dataset pagination.
- ⬜ Expand test coverage on the money paths (payments, eligibility, booking, RLS).
- ✅ **Module demo-data coverage** — `npm run verify:modules` reports, per the demo tenant, which module tables are empty (a "dead module" renders empty in the UI); it bypasses RLS (owner role) for accurate counts and exits non-zero if any non-ephemeral module is empty. `npm run db:seed:coverage` (idempotent) backfills the modules that had no demo data: compliance policy/risk/task/evidence/exception, security incidents + scans + vendor risk, platform integration, support-access session, the billing/usage/add-on/request commercial layer, outbound-calling targets, consent/intake detail records, and pilot import/share records. Demo tenant now at **107/107 non-ephemeral modules covered**.
- 🟡 Performance/abuse-hardening: ✅ explicit request **`bodyLimit` (1 MiB)** caps oversized payloads (memory-exhaustion defense), and list pagination is **bounded** (cursor + `limit` max 100). Proven by `server/test/hardening.test.ts` — oversized body → 413; `limit=99999` → 400; a 30-row dataset walks in stable, non-overlapping pages covering every row exactly once. ⬜ still: serverless cold-start budget; bundle size (index chunk ~533 KB); key DB index review.
- 🟡 Runbooks: incident, rollback, on-call, data-subject requests.
  Added operational runbooks for enterprise validation:
  [backup/restore/rollback](/Users/zackkhan/carecommand-ai/docs/BACKUP_RESTORE_ROLLBACK_RUNBOOK.md),
  [incident and integration failure](/Users/zackkhan/carecommand-ai/docs/INCIDENT_AND_INTEGRATION_FAILURE_RUNBOOK.md),
  and client-run validation in [docs/ENTERPRISE_CLIENT_VALIDATION_RUNBOOK.md](/Users/zackkhan/carecommand-ai/docs/ENTERPRISE_CLIENT_VALIDATION_RUNBOOK.md).
  These are documented gates until executed in the deployed environment.
