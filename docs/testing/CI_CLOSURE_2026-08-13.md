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
