# M03 Platform Administration — Pod Evidence

Date: 2026-07-30  
Embedded consultant: enterprise SaaS control-plane review  
Independent consultant: required before COMPLETE

| Feature | Closure | Evidence | Embedded verdict |
|---|---|---|---|
| Platform operator logout | Exact per-token revocation uses a cryptorandom session ID and stores only a full SHA-256 receipt in the append-only platform audit ledger; same-instant tokens cannot cross-revoke | `platformAuthHardening.integration.test.ts` PASS 6/6; remediation commit `75c22db` after consultant challenge | PASS — independent re-review pending |
| Tenant provisioning timezone | Provisioning validates IANA timezones; pilot/console tenant creation explicitly captures timezone | `foundationMasterData.integration.test.ts`; commit `b2e4068` | PASS — independent review pending |
| Tenant provisioning atomicity | Canonical `/v1/platform/tenants` uses the dedicated platform plane and commits tenant, branch, owner, baseline, subscription, entitlements, tenant audit, and platform audit atomically; canonical slug/email locks give typed race outcomes | Concurrent mixed-case email/same-slug collision, injected rollback, and clean-retry tests in `foundationMasterData.integration.test.ts`; commits `524169f`, `70923c5` | PASS — independent re-review pending |
| Legacy onboarding retirement | When legacy compatibility auth is enabled, authenticated `/v1/onboarding/tenant` returns 410 with the PlatformUser successor and unauthenticated callers receive 401; when disabled, access fails closed; the retired path performs no tenant write | Real `buildApp`/`app.inject` route coverage in `foundationMasterData.integration.test.ts`; offline helper has no default runtime DB client | PASS — independent re-review pending |
| Initial owner credential presentation | UI masks the initial password and no longer redisplays or retains plaintext after successful tenant creation; unsupported forced-change wording was removed | `src/pages/PlatformConsole.tsx`, `src/pages/PlatformPilot.tsx`; commit `b2e4068` | PASS — independent browser review pending |

Remediation checkpoint: `foundationMasterData.integration.test.ts` PASS 17/17; combined foundation/onboarding/RBAC PASS 40/40; API typecheck, targeted lint, production build, and diff hygiene PASS. Independent acceptance remains required.

Residual release evidence: secure out-of-band initial credential delivery, password-change-on-first-login if product-approved, last-platform-owner controls, support access, subscription administration, live provider health and browser accessibility remain open. No claim of HIPAA, SOC 2 or GDPR certification is made.
