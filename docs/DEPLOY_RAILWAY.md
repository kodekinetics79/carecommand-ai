# Railway Deployment Profile

`railway.json` defines an API service only. It is suitable for developer or
request-path demonstrations, but it is **not** the full CareCommand pilot
topology and must not be used to claim autonomous operational readiness.

The complete pilot requires, at minimum:

- an always-on API and separate always-on worker
- persistent Redis configured with no eviction for BullMQ
- separate `app_rls`, `app_platform`, and migration-owner database connections
- `NODE_ENV=production`, `DEPLOYMENT_PROFILE=pilot`, and protected metrics
- HTTPS `PUBLIC_API_URL`, exact HTTPS CORS origins, and non-loopback Stripe URLs
- explicit provider modes and required credentials
- backup/restore, alert delivery, rollback, and synthetic staging evidence

The application now fails boot when a pilot/enterprise profile lacks the
repository-verifiable parts of that posture. Use `render.pilot.yaml` as the
canonical topology reference when reproducing the same services on Railway.

Do not point `DATABASE_URL` at the Postgres owner. Do not disable queues while
claiming campaign, compliance, monitoring, retry, or unattended workflow
readiness. Do not seed production; provision tenants through audited platform
workflows.

No Railway deployment is performed by this repository procedure without an
explicit production/staging authorization and externally supplied credentials.
