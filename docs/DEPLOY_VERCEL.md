# Vercel Deployment Profile

`vercel.json` packages the SPA and request-driven Fastify handler. It does not
host the always-on worker and therefore is **not**, by itself, a complete pilot
or unattended-autonomy topology.

Vercel can remain the frontend tier when it is connected to a separately
operated API/worker stack. Required browser settings are:

- `VITE_AUTH_MODE=login-required`
- `VITE_DEMO_FALLBACK=false`
- no unapproved default clinic slug
- an HTTPS API URL, or a deliberately configured same-origin API

Never place secrets in `VITE_*` variables because Vite embeds them in browser
assets. The backend environment must separately satisfy the pilot-profile
validation, restricted database roles, queue/worker, webhook, metrics, backup,
and alerting requirements in `docs/production/DEPLOYMENT_AND_ROLLBACK.md`.

The Vercel serverless handler is appropriate for a bounded demonstration only
when queues are explicitly unavailable and the UI truthfully labels affected
workflows. It must not be represented as proof that scheduled campaigns,
background compliance, RPM safety processing, retries, or unattended outbound
work are operational.

No Vercel deployment or environment mutation is performed without explicit
authorization.
