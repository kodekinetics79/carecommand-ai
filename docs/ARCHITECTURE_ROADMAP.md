# Backend Architecture & Extensibility Roadmap

Prepared by the principal backend architect + DB architect + security/InfoSec lead +
DevOps/SRE. This is the forward plan: the **extensibility model** that lets the
platform absorb new modules, roles, devices, payers, billing models, and AI
workflows without architectural collapse — grounded in primitives that already
exist in the repo — followed by the **phased build roadmap** derived from
[COMPETITIVE_INTELLIGENCE.md](COMPETITIVE_INTELLIGENCE.md) and gated by
[CLINICAL_VALIDATION.md](CLINICAL_VALIDATION.md).

The product brain is the backend. The frontend is the display/interaction layer.
Every business rule lives in services, policies, DB constraints, and the audit
system — never frontend-only.

---

## 1. The eight extensibility seams (already in the code)

These are the load-bearing patterns. New capability is added by *plugging into*
them, not by rewriting.

1. **Module registration** — each domain is a `FastifyPluginAsync` mounted under a
   prefix in `server/app.ts`. Public/webhook routes live outside the auth scope;
   tenant routes register inside the `authenticate`-guarded `/v1` scope. *Add a
   module = add a plugin + register it.*
2. **Three identity planes** — tenant JWT (`plugins/auth.ts`), platform operator
   token (`lib/platformAuth.ts`), patient portal JWT (`lib/portalAuth.ts`). New
   actor types get their own plane; they never blur.
3. **Action-permission RBAC** — `lib/permissions.ts` vocabulary +
   `requirePermission()` + per-tenant `RoleDefinition.permissions` override. *Add a
   capability = add a permission key + default-matrix entry; tenants can customize
   without code.*
4. **Feature/package entitlements** — `lib/entitlements.ts` resolves plan + add-ons
   into `TenantFeatureEntitlement`; `requireFeature()` gates routes (`feature_locked`
   403). *Add a paid module = add a feature key + guard; packaging is data, not code.*
5. **Tenant isolation, defense-in-depth** — app-level `where: { tenantId }`
   everywhere + DB-level RLS via `lib/tenantContext.ts` (transaction-scoped GUC) +
   the boot-time `lib/rlsGuard.ts`. *New tenant tables join the RLS wave via a
   reversible migration; isolation is structural, not hopeful.*
6. **Event-driven intelligence** — `recordWorkflowEvent`/`emitBusinessEvent` →
   `BusinessEvent`/`OperationalSignal`/`MorningBriefingSignal`/`AIRecommendation`.
   *New workflows emit events; intelligence/briefing/reporting consume them without
   touching the producer.*
7. **Integration abstraction (config-gated, mock-default)** — payments, insurance,
   AI, translation, and device providers are behind interfaces with a safe `mock`
   default and signature-verified, idempotent webhooks (raw-body capture in
   `app.ts`; `claimIdempotency`). *New payer/device/provider = a new adapter behind
   the existing interface; `mock` keeps demos truthful.*
8. **Async work** — BullMQ queues + idempotent schedules drained by the unified
   `server/workers/index.ts`; faults flow to the observability seam
   (`lib/observability.ts`). *New background job = a queue + a consumer in the
   runtime.*

Cross-cutting guarantees that every seam inherits: **audit** (`lib/audit.ts`,
148+ call sites), **PHI-safe logging** (redaction), **input validation** (zod),
**bounded pagination**, and **request-body caps**.

---

## 2. Recipes — adding X without a rewrite

**A new clinical/ops module**
1. Model the domain in `schema.prisma` with `tenantId` (+ `branchId` where
   multi-site), lifecycle status enums, soft-delete where needed, and indexes.
2. Reversible migration; enrol tenant tables in the RLS wave.
3. `modules/<name>/routes.ts` as a plugin: zod validation, `requirePermission`,
   `requireFeature` (if paid), tenant/branch scoping, audit on writes.
4. Emit workflow events for anything intelligence/billing should react to.
5. Tests: success + negative (auth, RBAC, tenant isolation, feature-disabled,
   direct-API bypass). Update docs. Run `verify:modules` so it isn't a dead module.

**A new role** — add the enum value; add a default permission set in
`ROLE_PERMISSIONS`; tenants refine via `RoleDefinition.permissions`. No route edits
if the route already gates on the right permission key.

**A new device/payer/AI provider** — implement the existing adapter interface; keep
`mock` as the default; verify webhook signatures + idempotency; surface
configuration through the platform/settings layer (never secrets to the client).

**A new billing model** — extend `SubscriptionPlan`/`SubscriptionAddon`/
`TenantUsageLimit`; entitlements recompute; guards already enforce. Platform owns
billing rules; tenant admins cannot edit their own package.

**A new AI workflow** — go through the AI gateway with guardrails, PHI-off by
default, human-approval state, usage caps, and PHI-safe logging. Emit
`AIRecommendation`; never let it act without an approval state unless clinically
validated.

---

## 3. Known architectural debts (tracked, prioritized)

| Debt | Risk | Plan |
|---|---|---|
| RLS enrolled on 6 of ~105 tenant tables | Medium (app-level scoping is primary) | Wave rollout: route access through `runWithTenantContext` → enable RLS in reversible migration → extend `rls.test.ts` |
| ~60 routes still gate by `requireRoles` (role label) | Low | Migrate to `requirePermission` per module as touched |
| Multi-branch-per-user access thin | Medium for multi-site | Wire `UserClinicAccess` into scoping + reporting |
| Observability reporter not wired (Sentry) | Medium | `setErrorReporter` at boot once DSN provisioned; add frontend + alerting |
| Workers not yet deployed in prod | Medium | Deploy `worker:start` to an always-on host beside the serverless API |
| Real integrations mock-gated | By design | Flip per provider behind config when BAAs/keys land |

---

## 4. Phased build roadmap (from competitive intel, clinically gated)

**Phase A — Access & revenue flywheel (build-now)**
- Patient self-scheduling on real provider availability (guardrails per
  CLINICAL_VALIDATION §3).
- Unified **intake → eligibility → estimate → deposit** state machine (all engines
  exist; orchestrate + surface in morning briefing).
- RPM **time-accrual → CPT evidence export** (extend `RPMBillingReadiness`; never
  auto-bill). *Thresholds gated on physician validation.*

**Phase B — GTM unlock (soon)**
- Self-serve onboarding → tenant provision → plan select → **Stripe subscription** →
  entitlement enforcement.
- Payment plans; post-visit review-request automation; ROI/value dashboard
  (`$ recovered`, no-shows prevented, RPM enabled).

**Phase C — Enterprise & interop (later)**
- FHIR-shaped read API over our domain as the integration seam.
- Partner-based clearinghouse claims (Availity/Waystar) — integrate, don't build.
- Behavioral-health/Part 2 PHI segmentation (legal + clinical gated).

**Continuous — reliability/compliance hardening**
- Expand RLS waves; finish `requireRoles → requirePermission` migration; wire
  Sentry + alerting; deploy the worker; Neon pooled URL + connection-limit review;
  backups + restore drill; runbooks (incident, rollback, on-call, DSR).

---

## 5. Definition of done (non-negotiable for every item)

Schema → backend service enforcement → API route protection → tenant checks →
RBAC/permission → feature/package guard (if applicable) → input validation → audit
→ error handling → success tests → **negative/security tests** → CI green → docs →
migration + rollback notes. Anything missing one of these is **partial**, not done.
No "production-ready" claim without verification output. No clinical reliance on an
assumption still marked **needs clinical validation**.
