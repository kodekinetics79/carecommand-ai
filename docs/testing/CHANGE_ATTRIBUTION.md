# Change Attribution

## 2026-08-10 authoritative Tier 1 P1 closure attribution

| Commit | Attribution |
|---|---|
| `3be33cf` | Non-release recovery snapshot: attributed Tier 1 source, tests, deterministic profiles, Chrome fixes, simulations, and evidence |
| `ac415d7` | Provider call-ID collision fail-closed handling and autopilot dispatch safety |
| `c78a840` | Bounded autopilot recovery, queue generation fencing, and terminal-retry handling |
| `c693f4a` | Production queue namespace guard, exact signed identity replay, emergency claim truthfulness, real retry lifecycle and role coverage |
| `48c2b56` | Durable eligibility execution identity, state machine, RLS model, and forward migration |
| `1a37610` | Eligibility audit/outbox, HMAC rotation, client logical-action keys, provenance/date truthfulness, and database guards |

The two eligibility commits contain only work from the eligibility/RCM lane. The three AI/queue commits contain no Prisma migration. The final evidence reconciliation is documentation-only. `.playwright-no-server.config.ts` and `.tmp_inspect.ts` were excluded from Git and preserved in the manifest-backed local archive recorded in `BRANCH_AUTHORITY.md`.

No donor migration, M09 patch, provider payload, credential, PHI, database dump, Playwright artifact, build output, or temporary log was committed.

## 2026-08-10 Tier 1 working-state attribution (current)

The exact pre-closure state contains 29 unstaged tracked paths and 20 untracked leaf files (10 untracked status entries), with no staged, deleted, renamed, or unmerged paths. It is preserved by the SHA-verified Desktop patch recorded in `docs/completion/BRANCH_AUTHORITY.md`.

| Category | Paths / ownership |
|---|---|
| Tier 1 evidence and release recovery (14) | Two tracked testing reports, the convergence ledger, and 11 simulation evidence files |
| Tier 1 deterministic profile (5) | `prisma/seedSynthetic.ts`, three `prisma/synthetic/*` files, and `server/test/syntheticDataCatalog.test.ts` |
| Historical agent work carried into Tier 1 — autopilot/queue (9) | Autopilot routes, worker/index/queues, worker test, and untracked dispatch/recovery sources and tests |
| Historical agent work carried into Tier 1 — voice (4) | Receptionist outbound plus configuration, signed-booking, and outbound-target tests |
| Tier 1 finance/eligibility/portal work (8) | Control plane, portal, revenue-protection, money/payment tests, ControlPlane UI, portal-insurance integration and E2E |
| Tier 1 Chrome core fixes (5) | Branch route/foundation test, content test, Dashboard, Scheduling |
| Historical pilot simulation/status work (2) | Platform pilot route and pilot simulation script |
| Generated/local helpers (2) | `.playwright-no-server.config.ts`, `.tmp_inspect.ts`; neither is production code |

The categories attribute custody and wave origin; they do not assert that each historical hunk has a known human author. No current path is discarded. The five scoped-pass implementations remain in the durable patch, but no focused commit was made because the repository-authority gate remains blocked by lost dirty snapshots and divergent migration authority.

Date: 2026-07-30

## Preserved starting state

- Baseline commit: `dc77a7f`.
- Working branch: `feat/complete-rls-isolation`.
- Convergence-start worktree: 104 tracked changes and 38 untracked paths; nothing staged.
- Exact convergence recovery stash retained: `41567d7204d18bdba53f300b265cab862fa5b1ee` (`codex-release-convergence-20260730T061019-0400`).
- Earlier RLS recovery stash also retained: `d70c8aeef49767cf740c37a12cbadf3edb2e868e` (`codex-rls-recovery-20260730T0125-0400`).
- External patch copy: `/Users/zackkhan/.codex/recovery/carecommand-ai/release-convergence-20260730T061019-0400.patch`.

The starting worktree was restored exactly after the snapshot. No user work was discarded or reset.

## Attribution classes

| Class | Scope |
|---|---|
| Pre-existing application/RLS work | The tracked and untracked convergence-start snapshot; retained as one recoverable baseline |
| Completion-run implementation | Demo/dead-code cleanup, synthetic profiles, platform plane, Prisma guard, exhaustive RLS harness, receptionist/portal/intake/clinical/connected-care/payment/revenue/auth fixes, tests and evidence added during this run |
| Generated artifacts | Build output, Playwright runtime files, disposable database dumps and transient test output; not intended for staging unless already tracked documentation |
| Safe removals | Legacy production mock datasets, obsolete demo seed scripts and unused fake-data UI component removed after source/import checks |
| Ownership uncertain | None silently discarded; overlapping baseline files are preserved in the recovery stash and patch above |

## Release integrity

G1-G19 passed before staging. Reviewed implementation commits:

- `34e527b` — frontend demo/dead-path cleanup, dependency/browser certification;
- `0e54bb6` — deterministic synthetic profiles and pilot benchmark;
- `61e865f` — platform database plane, schema/migrations, Prisma/RLS guards;
- `aed5b51` — receptionist, clinical, auth, audit, connected-care and revenue hardening.

The evidence/CI commit follows these implementation commits. The full release suite is repeated from committed state before annotated local tag `rc/pilot-convergence-2026-07-30` is applied. No remote push, deployment, production migration, production data access, real PHI, live call/message/claim/payment, or other external provider transaction was performed.
