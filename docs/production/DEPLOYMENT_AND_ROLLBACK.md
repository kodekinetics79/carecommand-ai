# Deployment and Rollback

`render.pilot.yaml` is the canonical repository-owned pilot topology. The
legacy `render.yaml`, Vercel-only, Railway, and Docker Compose paths are demo or
developer profiles and must not be presented as full pilot production stacks.

## Repository-proven controls

- API, worker, and persistent no-eviction queue are separate services.
- Automatic deployment is disabled; release activation is an explicit action.
- Migrations run in an explicit isolated release job; the schema-owner secret is
  not present in the long-running API or worker environment.
- Runtime tenant and platform clients require separate `app_rls` and
  `app_platform` principals.
- Readiness checks include Postgres and Redis.
- Proxied deployments declare `INGRESS_MODE=trusted_proxy`; readiness fails
  until the operator supplies verified ingress CIDRs. The origin must also be
  network-isolated behind those proxies. Direct mode deliberately ignores all
  forwarded client-IP headers.
- The application fails boot when a pilot/enterprise profile uses development
  mode, loopback callbacks/origins, unprotected metrics, disabled queues, or a
  missing platform database plane.
- Selected Stripe, live Stedi, OpenAI, Claude, and Ollama Cloud modes fail boot
  when their required secrets or safe callback URLs are absent.

## Controlled staging deployment

1. Create an isolated non-production environment from `render.pilot.yaml`.
2. Supply all `sync:false` values through the provider secret manager. For an
   existing Blueprint, set newly added values manually before synchronization.
3. Confirm tenant runtime, platform runtime, and migration connections use the
   three intended database principals.
4. From an isolated approved release job, run
   `RELEASE_MIGRATION_ACK=APPLY_REVIEWED_CARECOMMAND_MIGRATIONS npm run release:migrate`.
   Supply `DATABASE_MIGRATION_URL` and the expected non-runtime username in
   `DATABASE_MIGRATION_PRINCIPAL` only to that job, then remove them on completion.
   Tenant and platform runtime URLs are optional defense-in-depth comparisons and
   should not be copied into the release job solely for this check.
5. Start the API and worker, then verify `/health/live`, `/health/ready`,
   `/health/integrations`, `/health/slo`, and protected metrics on both targets.
6. Run smoke, browser, RLS, webhook, worker retry, and PHI-canary tests against
   synthetic data only.
7. Capture deployment ID, image/commit SHA, migration version, provider modes,
   and approvers without copying credentials into evidence.

## Rollback contract

1. Stop new automated work through the application kill switches and pause
   queue consumers when duplicate external effects are possible.
2. Roll back the application image to the last accepted immutable tag.
3. Do not reverse database migrations automatically. Confirm backward schema
   compatibility or execute a separately reviewed forward repair.
4. Restart one API instance, validate readiness and login, then restore workers.
5. Verify patient lookup, scheduling, receptionist review, portal, payment
   reconciliation, audit creation, and queue drain using synthetic canaries.
6. Reopen traffic only after the named release, security, clinical, and
   operations approvers accept the evidence.

No deployment or rollback is performed merely by committing these controls.
