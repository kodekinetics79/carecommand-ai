# Change Attribution

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
