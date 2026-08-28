# CI Closure Evidence — 2026-08-13

Branch: `fix/release-hardening-retell-eligibility-20260811`
Pull request: `#4`

This checkpoint records repository-side CI remediation only. It does not represent a production deployment, production migration, live Retell call, real PHI use, payment, claim, or unattended receptionist authorization.

## Remediation applied

- CI installs and verifies the PostgreSQL 17 client before backup/restore lifecycle checks against PostgreSQL 17.
- Gitleaks receives the repository-scoped GitHub Actions token with read-only repository permissions; secret scanning remains release-blocking.
- Prisma generation may run in a frontend preview without a runtime database URL. Database commands still require an explicit migration or runtime URL.
- Disposable PostgreSQL suites preserve the configured local `app_platform` password rather than changing the cluster-wide role password and breaking later integration suites.
- The RPM offline-detector/signoff race now accepts both safe advisory-lock orderings:
  - signoff succeeds against current evidence and is retained or subsequently invalidated; or
  - signoff fails closed with `409` when its preview became stale before the locked write.
  A stale evidence conflict must leave readiness at `NEEDS_REVIEW` with no provider signoff evidence.

## Deployment boundary

- Vercel frontend preview build is expected to succeed without database access.
- A full preview runtime remains intentionally fail-closed until isolated Preview values exist for database, platform database, Redis, JWT, and encryption configuration.
- Preview must not reuse production PHI infrastructure.
- Production PHI remains blocked until the runtime database uses the restricted `app_rls` role, the platform plane uses `app_platform`, migration credentials remain separate, and runtime RLS-role enforcement is enabled.

## Live voice boundary

The Retell adapter, live-UAT controls, installed-Chrome harness, call-ID fencing, DNC/consent controls, polling fallback, audit, and usage paths are present on this branch. No live call has been placed from this checkpoint. Live acceptance requires private Retell credentials and the explicitly authorized, runtime-only test destination; neither belongs in Git history or CI logs.

## Final real-backend browser startup correction

CI run `31657657314` passed every quality step through browser installation, but the Playwright web server exited before test collection. The disposable runner had applied all 89 migrations; the child API then started with `NODE_ENV=production` while CI supplied neither the production-required deployment queue namespace nor the stable eligibility HMAC key.

The guarded Playwright runner now generates per-run ephemeral values only after `RLS_DISPOSABLE_DB` proves it is inside the repository's authorized local disposable lifecycle. Explicit valid values remain authoritative, the unsafe `carecommand-local` namespace is rejected, and normal production startup remains fail-closed. No value is hardcoded or logged.

Local final evidence on the PR head plus this correction:

- Startup reproduction before correction: API env validation failed and no browser test was collected.
- Focused environment regression: 2/2 passed.
- Real-backend staff eligibility journey with both values absent at the command boundary: 3/3 independent disposable runs passed.
- Normal full regression: 119 files and 954 tests passed. The two suites intentionally disabled outside disposable mode are also enforced by a dedicated guarded CI step and passed 33/33 locally.
- Full real-backend browser certification: 14/14 authorized desktop/mobile scenarios passed. The two live-call cases remained gated because external credentials and an authorized destination were absent.
- RLS behavior: 1,002/1,002; catalog 132 application tables, 124 protected tables, 526 policies, ENABLE/FORCE 124/124.
- Release database lifecycle: PASS with 89 migrations, deterministic seed, backup/restore parity, 124 forced-RLS tables, and 123 tenant-integrity FKs.
- Prisma drift, API typecheck, lint, production build, production-artifact scan, 570 registry signatures, 191 attestations, and production high-severity dependency audit: PASS.
