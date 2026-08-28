# Security Abuse Test Matrix

Last updated: 2026-07-20

Use this matrix for enterprise security validation. Local automated tests cover
several items; the client-run environment must add browser, DAST, and provider
boundary evidence.

## Abuse Cases

| Category | Test | Expected result |
| --- | --- | --- |
| IDOR | swap patient, appointment, payment, export, alert IDs across tenants | denied without object details |
| JWT abuse | malformed, expired, forged, wrong audience, replayed token | denied |
| Session fixation | login after attacker-provided session material | new session issued; attacker session useless |
| CSRF | state-changing request without valid CSRF/cookie context | denied |
| XSS | stored and reflected payloads in patient, intake, notes, messages | encoded or rejected |
| SQL injection | query filters, imports, IDs, reports | parameterized handling; no data leak |
| CORS | unauthorized origin with credentials | blocked |
| Rate limiting | auth, portal code, payment, public status endpoints | throttled and logged |
| Upload abuse | invalid MIME, oversized file, formula injection CSV | rejected or sanitized |
| Webhook replay | duplicate provider event | idempotent, no duplicate charge/alert |
| Webhook forgery | invalid signature | rejected and audited/logged |
| SSRF | user-controlled URL fields, webhook callback config | blocked or allowlisted |
| Logging leak | forced errors with PHI-like data | logs redact sensitive values |
| Bundle leak | production frontend build | no local paths, demo secrets, dev-token endpoint, seeded credentials |
| Metrics/docs exposure | production `/metrics` and `/docs` without auth/token | hidden or denied |

## Local Evidence

Latest local evidence:

- unauthenticated protected route returned 401
- production `/v1/auth/dev-token` returned 404 in prior smoke pass
- production `/docs` returned 404 in prior smoke pass
- production `/metrics` without token returned 404 in prior smoke pass
- focused security regression passed
- production bundle scan found no local path/dev-token/demo credential markers
- `npm audit --audit-level=high --omit=dev` found no high-severity production dependency issues

## Required External Evidence

- repository/history secret scan with `gitleaks` or equivalent
- DAST scan against deployed staging URL
- container/image scan if containers are used for deployment
- penetration-test report or client security test evidence for real enterprise launch
- provider signature and replay evidence for live/sandbox Stripe, eligibility,
  communication, and device vendors
