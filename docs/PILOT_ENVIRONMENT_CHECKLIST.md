# Pilot Environment Checklist

Last updated: 2026-07-20

This checklist is required before a client performs full enterprise-grade
autonomous testing with realistic data.

## Required Configuration

| Area | Required state |
| --- | --- |
| Runtime | `NODE_ENV=production` |
| Frontend auth | `VITE_AUTH_MODE=login-required` |
| Demo fallback | `VITE_DEMO_FALLBACK=false` |
| Default clinic slug | `VITE_DEFAULT_CLINIC_SLUG` set only if client approves prefill |
| API URL | same-origin or explicit deployed API URL |
| CORS | exact client frontend origins only |
| Cookies | secure cookies; `COOKIE_SAMESITE=none` only for cross-site HTTPS |
| Database | app runtime role without superuser or `BYPASSRLS` |
| Redis | required and monitored |
| Workers | always-on worker service deployed, not only serverless API |
| Metrics | protected by token or private network |
| Docs/dev routes | disabled or protected in production |
| Legacy platform token | `PLATFORM_LEGACY_TOKEN_ENABLED=false` unless approved break-glass |
| Secrets | stored in platform secret manager, never committed |
| Backups | automated, encrypted, restore-tested |

## Provider Mode Labels

| Provider | Allowed pilot mode | Evidence required |
| --- | --- | --- |
| Stripe | sandbox or live as contract permits | webhook signature, idempotency, reconciliation |
| Eligibility | sandbox or live payer connection | active/inactive/uncertain responses and retry behavior |
| Email/SMS/voice | sandbox/live with opt-out rules | delivery, failure, and opt-out evidence |
| Device/RPM | sandbox/live device vendor | reading ingestion and alert routing evidence |
| AI | approved provider or deterministic mock | data-sharing approval and PHI controls |

Full register: [docs/INTEGRATION_MODE_REGISTER.md](/Users/zackkhan/carecommand-ai/docs/INTEGRATION_MODE_REGISTER.md).

## Entry Gate

Do not start client-run validation until:

- signed testing scope and data classification are approved
- synthetic, masked, or legally approved real data set is ready
- emergency/clinical escalation ownership is named
- support channel and war-room owners are active
- rollback owner is available
- evidence ledger is open for updates

## Exit Gate

Pilot environment can advance only when:

- no open P0
- no open P1 without client-approved workaround
- all critical journeys have browser/API/database evidence
- provider modes are visibly labeled
- backup/restore drill is passed or formally accepted as a limitation
