# Known Limitations Register

Last updated: 2026-07-20

This register keeps pilot language honest. It should be reviewed before every
customer demo, validation cycle, and go/no-go decision.

| Limitation | Current status | Customer-safe framing | Required closure |
| --- | --- | --- | --- |
| Browser golden journey evidence | Not yet captured from final deployed URL | API and production build are green locally; deployed browser validation remains an entry gate | Add Playwright/Cypress traces/videos on deployed environment |
| Live third-party integrations | Mostly sandbox/mock locally | Provider modes are explicit; live evidence requires client-approved credentials | Run live/sandbox provider validation with signed scope |
| Full DB-level RLS for every tenant table | RLS guard/runtime role proven; full table-by-table proof still required | App-level tenant controls and selected RLS tests are green; full DB proof is a security gate | Complete tenant-table inventory and SELECT/INSERT/UPDATE/DELETE proof |
| HIPAA production readiness | Not proven by code alone | Technical controls exist, but contractual/operational evidence is required | BAAs, policies, access reviews, incident process, audit evidence |
| Backup restore drill | Runbook added; actual production-like drill not yet executed | Recovery plan is documented; restore evidence required before go-live | Execute isolated restore and record evidence |
| Legacy platform token | Disabled in production by default; break-glass flag exists | Production operations should use PlatformUser login/JWT, not static tokens | Keep `PLATFORM_LEGACY_TOKEN_ENABLED=false` unless formally approved |
| Performance capacity | Concurrent simulation passed locally; no full load profile | Tested capacity is limited to local simulation | Run burst/endurance/degraded-provider performance tests |
| Caregiver/minor/dependent flows | Must be confirmed against implementation scope | Supported only where explicitly enabled in client workflow | Add browser/API tests or scope out |
| Large frontend bundle | Build passes with chunk-size warning | Not a functional blocker; performance tuning recommended | Split routes/chunks after pilot-critical gates |
| Repository history secret scan | Tool unavailable in local pass | Static scans were run; formal history scan remains required | Run `gitleaks` or equivalent |
