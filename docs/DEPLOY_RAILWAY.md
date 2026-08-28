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
- `INGRESS_MODE=trusted_proxy`, the actual private Railway ingress CIDRs in
  `TRUSTED_PROXY_CIDRS`, and provider-level proof that the origin is reachable
  only through that ingress. Railway CIDRs are deployment evidence and are not
  guessed or hard-coded by this repository.
- explicit provider modes and required credentials
- backup/restore, alert delivery, rollback, and synthetic staging evidence

The application now fails boot when a pilot/enterprise profile lacks the
repository-verifiable parts of that posture. Use `render.pilot.yaml` as the
canonical topology reference when reproducing the same services on Railway.

Do not point `DATABASE_URL` at the Postgres owner. Do not disable queues while
claiming campaign, compliance, monitoring, retry, or unattended workflow
readiness. Do not seed production; provision tenants through audited platform
workflows.

`/health/ready` returns NOT READY when trusted-proxy mode lacks CIDRs. Leaving
`INGRESS_MODE=direct` is valid only for a genuinely direct-origin topology; when
used behind a load balancer it collapses all users into the proxy's global rate
bucket and loses reliable client-IP attribution in audit records.

No Railway deployment is performed by this repository procedure without an
explicit production/staging authorization and externally supplied credentials.
