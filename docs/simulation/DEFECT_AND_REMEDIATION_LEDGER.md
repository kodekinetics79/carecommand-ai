# Defect and Remediation Ledger

| ID | Severity | Finding / root cause | Remediation and evidence | Status |
|---|---|---|---|---|
| D-001 | P0 | Autopilot worker marked approvals executed without performing the payload action | Strict allowlisted staff-task executor, transaction, receipt, audit, attempt fence; worker 4/4 | RETESTED; awaiting independent review |
| D-002 | P0 | Stale BullMQ jobs could execute a newer approval generation | Require exact queued dispatch attempt and conditional transactional execution; stale test passes | RETESTED; awaiting independent review |
| D-003 | P1 | Refund-before-success was discarded and partial refunds terminalized the entire payment | Retryable incomplete result plus cumulative delta accounting; finance 42/42 | RETESTED; awaiting independent review |
| D-004 | P1 | Success after failed/expired was permanently ignored | Allow legitimate later settlement recovery; finance 42/42 | RETESTED; awaiting independent review |
| D-005 | P1 | Both eligibility POST paths lack tenant-scoped idempotency and atomically durable provider-result workflows | Requires durable pending/result state and atomic canonical/derived/audit persistence | OPEN — release blocker |
| D-006 | P2 | Control plane always reported sandbox and advertised payer-connected prior auth | Derive Stedi mode and label prior auth manual-only; TypeScript and finance tests pass | RETESTED |
| D-007 | P1 | Branch list applied `branchId` to a Branch model query, causing Chrome-visible HTTP 500 | Map branch scope to Branch `id`; focused foundation test pass | RETESTED |
| D-008 | P1 | Dashboard `Promise.all` made all panels unavailable when one unentitled endpoint returned 403 | Independent settled panel states; Chrome and 14/14 content tests pass | RETESTED |
| D-009 | P1 | Scheduling UI offered an explicitly unconstrained confirmed-booking fallback without provider/conflict guard | Remove fallback; require provider and canonical slot API; Chrome and 14/14 content tests pass | RETESTED |
| D-010 | P1 | Persistent, unnamespaced BullMQ jobs crossed disposable dataset boundaries and repeatedly referenced unknown tenants | Requires environment/database queue namespace plus bounded purge/recovery policy | OPEN — release blocker |
| D-011 | P1 | Recovery of 101 missing jobs is serial (~17.5 s) and recovered `dispatch_failed` approvals have no tenant retry action | Bounded concurrency and authorized new-attempt retry path required | OPEN — release blocker |
| D-012 | P2 | Emergency precedence is prompt-string tested, not provider transcript/audio ordering tested | Add protocol fixture asserting spoken emergency instruction precedes tool action and no disclosure resumes | OPEN verification gap |
| D-013 | P2 | Exact negative identity-tool replay can consume lockout attempts | Add delivery-id/nonce dedupe and replay regression | OPEN |
| D-014 | P1 | Worktree ledger reports six deleted dirty worktrees with unpreserved unique changes; integration branch is ambiguous | Reconcile stashes/refs/backups and designate authority before release | OPEN — release blocker |
| D-015 | P2 | End-wave default timing gate fails in autopilot recovery, endpoint authorization, and receptionist booking | Focused 30 s rerun passes 60/60; optimize tests/queries and retain realistic explicit budgets | OPEN |
| D-016 | P2 | Static umbrella gate lint fails on two `no-explicit-any` errors in pre-existing untracked Playwright config | Reconcile ownership and type the config without `any`; build was not reached | OPEN |
| D-017 | P1 | Outbound Retell call-ID collision skips binding but can continue the successful launch path, leaving the new provider intent unbound/untracked | Fail closed and escalate on collision; add exact collision regression | OPEN — independent-review blocker |
| D-018 | P1 | BullMQ `failed` event is recorded as terminal even when another retry is scheduled; payload changes to `dispatch_failed`, preventing the next attempt from validating | Terminalize only after retry exhaustion and add multi-attempt regression | OPEN — independent-review blocker |

No production data or external provider was used to reproduce these findings.

Independent acceptance: F1/F2/F4 REJECTED; F3/F5/F6 scoped PASS; F7/F8 narrow defect-level PASS. Overall release REJECTED / NO-GO.
