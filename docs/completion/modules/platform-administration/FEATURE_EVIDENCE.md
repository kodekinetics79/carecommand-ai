# M03 Platform Administration — Pod Evidence

Date: 2026-07-30  
Embedded consultant: enterprise SaaS control-plane review  
Independent consultant: required before COMPLETE

| Feature | Closure | Evidence | Embedded verdict |
|---|---|---|---|
| Platform operator logout | Exact per-token revocation uses a cryptorandom session ID and stores only a full SHA-256 receipt in the append-only platform audit ledger; same-instant tokens cannot cross-revoke | `platformAuthHardening.integration.test.ts` PASS 6/6; remediation commit `75c22db` after consultant challenge | PASS — independent re-review pending |
| Tenant provisioning timezone | Provisioning validates IANA timezones; pilot/console tenant creation explicitly captures timezone | `foundationMasterData.integration.test.ts`; commit `b2e4068` | PASS — independent review pending |
| Tenant provisioning atomicity | Legacy and platform paths serialize canonical global owner email and commit tenant, branch, owner, baseline, subscription, entitlements, and audit as one transaction | Concurrent mixed-case email collision, injected mid-provision rollback, and clean-retry tests in `foundationMasterData.integration.test.ts`; commit `524169f` | PASS — independent re-review pending |
| Initial owner credential presentation | UI masks the initial password and no longer redisplays or retains plaintext after successful tenant creation; unsupported forced-change wording was removed | `src/pages/PlatformConsole.tsx`, `src/pages/PlatformPilot.tsx`; commit `b2e4068` | PASS — independent browser review pending |

Remediation checkpoint: combined foundation/onboarding/RBAC run PASS 37/37; API typecheck, targeted lint, and diff hygiene PASS. Independent acceptance remains required.

Residual release evidence: secure out-of-band initial credential delivery, password-change-on-first-login if product-approved, last-platform-owner controls, support access, subscription administration, live provider health and browser accessibility remain open. No claim of HIPAA, SOC 2 or GDPR certification is made.
