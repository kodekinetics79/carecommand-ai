# Feature Result Log

The authoritative 202-feature inventory is `MASTER_COMPLETION_LEDGER.md`. This file
records decision checkpoints produced during production completion.

## Accepted checkpoints

### Platform logout and per-session revocation

- Result: `PASS`
- Commit: `75c22db`
- Evidence: focused integration 6/6; same-millisecond dual session; logout A returns
  401 for A while B remains 200; independent P0/P1/P2 zero.

### Production topology, configuration and release controls

- Result: `PASS`
- Commit: `3ac14ac`
- Evidence: production-engineering/env 28/28, API typecheck, focused lint,
  adversarial URL and database-principal checks, clean full-history secret scan,
  CycloneDX SBOM generation.
- External: cloud provisioning, credentials, managed database/queue, alerting,
  backup/restore drill and production authorization.

### Structural browser accessibility and realistic journey coverage

- Result: `PASS` for the tested structural contract
- Commit: `5634aa5`
- Evidence: desktop real-backend golden journeys and owner/front-desk/auditor route
  crawl 5/5 after correcting nine unnamed controls.
- External: full WCAG/contrast/assistive-technology audit.

## Rejected/open checkpoints

### M09-F02 immutable receptionist agent deployment

- Result: initial independent `REJECT`; remediated candidate awaiting re-review.
- Initial findings: call-response deployment mismatch, V0 rejection, unsafe tag repin,
  cross-tag deployment sharing, transient classification of 400/422, clinic-branch
  mapping, strict tag/DB/UI/source-of-truth gaps.
- Remediation evidence: fresh 71 migrations; focused 60/60; all receptionist
  115/115; RLS 962/962; Prisma drift 121/143 only; typecheck, lint and build;
  stop success/failure and injected review-task failure all preserve the
  INVALID/PAUSED circuit, critical operational signal and no-second-dial rule.
- External/not claimed: live Retell account transaction and browser walkthrough;
  originating-number ownership and tool-schema readiness remain later gates.

### Foundation, tenant, workforce and patient master data

- Result: initial `REJECT`, superseded by independent `PASS` for the reviewed scope.
- Commits: `524169f`, `70923c5`, `1bb1c1e`.
- Evidence: 40/40; typed user/tenant race outcomes; real retired-route 401/410
  with zero write; cross-entry slug race; typecheck, lint and production build.
- P3: remove retired compatibility after telemetry, index canonical phone for scale,
  and resolve the PostgreSQL client deprecation warning during upgrade readiness.
