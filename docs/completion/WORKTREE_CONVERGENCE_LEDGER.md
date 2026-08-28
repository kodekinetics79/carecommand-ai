# Worktree Convergence Ledger — Phase 0 Recovery

## 2026-08-10 CTO disposition and preservation completion

The CTO selected `baec496f46c143566138e7fd2fceb1ddd5c6dad2` plus the preserved Tier 1 working state as authoritative. Recovery commit `3be33cff2039058dd1c651fb4124846f824d642a` is retained on `recovery/tier1-authoritative-snapshot-20260810`; implementation continues only on `fix/tier1-p1-authoritative-20260810`.

The five missing worktrees with unrecoverable unstaged bytes are classified `HISTORICAL_UNRECOVERABLE_UNSTAGED_WORK`. This classification documents the loss without blocking current engineering. Their surviving commits remain reachable. The M09 staged index remains a named donor patch and was not applied. `codex/accepted-module-convergence` remains reference-only, and its 121-migration lineage is quarantined.

The verified all-refs bundle and three recovery patches are recorded in `BRANCH_AUTHORITY.md`. No worktree metadata, branch, stash, or donor artifact was pruned.

## 2026-08-10 Tier 1 P1 closure re-audit (current)

- Registered worktrees: 77; existing paths: 1; missing/prunable paths: 76.
- Do not prune: the M09 administrative index contains 16 staged files (850 insertions, 85 deletions).
- M09 staged-index patch: `/Users/zackkhan/Desktop/carecommand-recovery/carecommand-m09-staged-index-8386f1b-20260810.patch`; SHA-256 `4297eb43392156fe2e6385e9313752225e04c820243f02ae8ca472b0cbeff521`.
- The other five former `DIRTY_UNIQUE` indexes equal their HEAD commits. Their ledger-described changes were unstaged; the directories are gone and no matching named patch/stash was found. Exact bytes are not recoverable from Git metadata.
- Current Tier 1 recovery patch: `/Users/zackkhan/Desktop/carecommand-recovery/carecommand-ai-tier1-wave-baec496-20260810.patch`; SHA-256 `cf9089d6fe1b1615daba8258d3d04cf7980218ba91ae53530b713d659806546c`.

| Former dirty path | Surviving reference | Preservation result |
|---|---|---|
| `carecommand-441-clock-control.siazO9` | HEAD `4411130`; index equals HEAD | Unstaged unique bytes unproven/lost |
| `carecommand-accepted-convergence` | branch/HEAD `3dac135`; index equals HEAD | Commit survives; unstaged unique bytes unproven/lost |
| `carecommand-autopilot-recovery.t0CZH3` | HEAD `0be4163`; current Tier 1 patch has substantial functional overlap | Exact historical bytes unproven; current implementation preserved separately |
| `carecommand-m09-independent.dxnS1i` | HEAD `8386f1b`; 16-file staged index | PRESERVED by named patch above |
| `carecommand-m17-pg18-overlay.60n7Q1` | HEAD `c60a588`; index equals HEAD | Unstaged unique bytes unproven/lost |
| `carecommand-receptionist-phase2.sj6mZE` | HEAD `043ebf1`; current tree has partial functional overlap | Exact historical bytes unproven/lost |

Current closure branch: `fix/tier1-p1-closure-20260810` at `baec496`. See `BRANCH_AUTHORITY.md`. No worktree or stash was deleted, created, or modified.

Generated: 2026-08-03 (US/Eastern)

Authoritative branch for this recovery pass: `feat/complete-rls-isolation`

Authoritative integration head: `baec496f46c143566138e7fd2fceb1ddd5c6dad2`

Scope: all 77 worktrees in this repository.

Recovery targets and outcome:

- Worktrees inspected: 77  
- Dirty worktrees: 6 (all marked `DIRTY_UNIQUE`)  
- Duplicate commits identified: 18  
- Worktree classes:
  - MERGED: 6
  - CLEAN_UNMERGED: 47
  - DIRTY_UNIQUE: 6
  - DUPLICATE: 18

Rules used for phase-0 status:

- `MERGED`: worktree HEAD is in primary ancestry and clean.
- `CLEAN_UNMERGED`: clean worktree not yet merged into primary.
- `DIRTY_UNIQUE`: dirty worktree with workspace edits that are not duplicated elsewhere.
- `DUPLICATE`: clean worktree shares a duplicate HEAD with one or more others.
- `UNKNOWN`/`SUPERSEDED`/`ABANDONED`: not assigned in this pass.

Current state from this pass:

- Primary branch remains clean.
- No feature work has been merged in this phase.
- No tests were executed for reconciliation changes in this pass.
- Six dirty worktrees are all candidate recovery items and require explicit module-level review before integration.

## Worktree Classification Ledger

| Path | Branch | HEAD (short) | Dirty | Class | Module (inferred) | Feature summary | Tests in workspace | Integrated status | Disposition |
|---|---|---|---|---|---|---|---|---|---|
| /Users/zackkhan/carecommand-ai | feat/complete-rls-isolation | baec496f46c1 | clean | MERGED | Needs module review | No local diff this phase | Not assessed (clean snapshot) | In primary ancestry | Already reconciled |
| /private/tmp/auth-security-acceptance-lZLLWQ/worktree | HEAD | a7f2ee51878d | clean | CLEAN_UNMERGED | Authentication, IAM, Session Management | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/autopilot-acceptance-oiZbjJ | HEAD | f087dbc00962 | clean | DUPLICATE | AI Receptionist and Telephony | No local diff this phase | Not assessed (clean snapshot) | Clean duplicate commit | Mark as duplicate; keep one canonical copy |
| /private/tmp/autopilot-fence-verify-FIrrRv | HEAD | 0a20faab6468 | clean | DUPLICATE | AI Receptionist and Telephony | No local diff this phase | Not assessed (clean snapshot) | Clean duplicate commit | Mark as duplicate; keep one canonical copy |
| /private/tmp/carecommand-441-clock-control.siazO9 | HEAD | 441113002ec4 | dirty | DIRTY_UNIQUE | Messaging and Notifications | Messaging comms reliability and truthful provider behavior tests | Yes (working-tree changes) | Pending merge; not yet in primary HEAD | Preserve: test-only recovery artifact for communications integrity |
| /private/tmp/carecommand-6ce5a9c-2MACzr | HEAD | 6ce5a9cb858a | clean | MERGED | Needs module review | No local diff this phase | Not assessed (clean snapshot) | In primary ancestry | Already reconciled |
| /private/tmp/carecommand-accepted-convergence | codex/accepted-module-convergence | 3dac135235bf | dirty | DIRTY_UNIQUE | Needs module review | Receptionist destination recovery, probe provisioning, and migration boundary checks | Yes (working-tree changes) | Pending merge; not yet in primary HEAD | Preserve: candidate for destination guard/recovery recovery workflows |
| /private/tmp/carecommand-ai-governance-root | HEAD | b5978f44448e | clean | CLEAN_UNMERGED | Platform Administration | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-analytics-integration.3Djyjo | codex/analytics-release-integration-carecommand-analytics-integration.3Djyjo | ce89fedb36e7 | clean | DUPLICATE | Search, Dashboards, Analytics and Reporting | No local diff this phase | Not assessed (clean snapshot) | Clean duplicate commit | Mark as duplicate; keep one canonical copy |
| /private/tmp/carecommand-audit-privacy | HEAD | 1c6d097d0255 | clean | CLEAN_UNMERGED | Audit, Privacy, Compliance and Data Lifecycle | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-autopilot-0be41637.FesQBF | HEAD | 0be41637cb17 | clean | DUPLICATE | AI Receptionist and Telephony | No local diff this phase | Not assessed (clean snapshot) | Clean duplicate commit | Mark as duplicate; keep one canonical copy |
| /private/tmp/carecommand-autopilot-recovery.t0CZH3 | HEAD | 0be41637cb17 | dirty | DIRTY_UNIQUE | AI Receptionist and Telephony | Autopilot queued dispatch reconciliation + recovery worker | Yes (working-tree changes) | Pending merge; not yet in primary HEAD | Preserve: startup/periodic recovery for queued autopilot approvals |
| /private/tmp/carecommand-autopilot-review-qTVL0J | HEAD | 0a20faab6468 | clean | DUPLICATE | AI Receptionist and Telephony | No local diff this phase | Not assessed (clean snapshot) | Clean duplicate commit | Mark as duplicate; keep one canonical copy |
| /private/tmp/carecommand-booking-branch-fix | HEAD | 01ddcceca477 | clean | CLEAN_UNMERGED | Scheduling, Waitlist, Check-In and Appointment Operations | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-cace-baseline.TGLNyK | HEAD | cacefa14f699 | clean | CLEAN_UNMERGED | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-callback-tenant-fix | HEAD | 1b12883a07f0 | clean | CLEAN_UNMERGED | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-campaigner-governed-ui | HEAD | 75231165ff1a | clean | CLEAN_UNMERGED | Messaging and Notifications | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-clinical-audit | HEAD | d39677276d7a | clean | CLEAN_UNMERGED | Clinical Encounters and Documentation | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-clinical-integration.lzCDyH | codex/clinical-release-integration | 3537407cdf81 | clean | CLEAN_UNMERGED | Clinical Encounters and Documentation | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-clinical-os8aGp | HEAD | 5f535a7d9783 | clean | CLEAN_UNMERGED | Clinical Encounters and Documentation | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-clinical-tl-fix | codex/clinical-telehealth-labs-fix | 432a28285011 | clean | CLEAN_UNMERGED | Clinical Encounters and Documentation | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-command-analytics | HEAD | ff4933844897 | clean | CLEAN_UNMERGED | Search, Dashboards, Analytics and Reporting | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-connected-care-fix | HEAD | c6c3f7f886ce | clean | CLEAN_UNMERGED | Connected Care, RPM and Device Events | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-crm-acceptance.4zrNtM/worktree | HEAD | 1b054213d74b | clean | CLEAN_UNMERGED | CRM, Intake and Patient Acquisition | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-crm-acceptance.GwrnWE | HEAD | d1c474d037f4 | clean | CLEAN_UNMERGED | CRM, Intake and Patient Acquisition | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-crm-baseline-eorPZm | HEAD | 0a20faab6468 | clean | DUPLICATE | CRM, Intake and Patient Acquisition | No local diff this phase | Not assessed (clean snapshot) | Clean duplicate commit | Mark as duplicate; keep one canonical copy |
| /private/tmp/carecommand-crm-review-hISdJ0 | HEAD | a2c30dca96ad | clean | CLEAN_UNMERGED | CRM, Intake and Patient Acquisition | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-destination-pg18 | codex/destination-recovery-pg18 | 8386f1b5f792 | clean | DUPLICATE | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean duplicate commit | Mark as duplicate; keep one canonical copy |
| /private/tmp/carecommand-destination-recovery.ope153 | codex/destination-recovery-redteam-fix-20260802 | 14f3e0431ec2 | clean | CLEAN_UNMERGED | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-dsr-retention.HYjnxT | HEAD | f4070f21041a | clean | CLEAN_UNMERGED | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-f01.6uftqt | HEAD | 499809aa3fbf | clean | MERGED | Needs module review | No local diff this phase | Not assessed (clean snapshot) | In primary ancestry | Already reconciled |
| /private/tmp/carecommand-f10-reaudit.zdkMgc | HEAD | 3d87d70a3a15 | clean | MERGED | Audit, Privacy, Compliance and Data Lifecycle | No local diff this phase | Not assessed (clean snapshot) | In primary ancestry | Already reconciled |
| /private/tmp/carecommand-f10-review.L7yS2a | HEAD | a62d22b6ef2c | clean | MERGED | Needs module review | No local diff this phase | Not assessed (clean snapshot) | In primary ancestry | Already reconciled |
| /private/tmp/carecommand-final-convergence.BZZef4 | codex/final-release-convergence-carecommand-final-convergence.BZZef4 | 74f0b548945b | clean | CLEAN_UNMERGED | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-health-sec-acceptance.Uc9wNk/worktree | HEAD | 2af19ac3eaa4 | clean | CLEAN_UNMERGED | Authentication, IAM, Session Management | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-insurance-acceptance.GfTp7Y | HEAD | e607a7f23940 | clean | CLEAN_UNMERGED | Insurance and Eligibility | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-insurance-date-final.YtRSrg/worktree | HEAD | 7f2d57facabc | clean | CLEAN_UNMERGED | Insurance and Eligibility | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-insurance-final.uvAYZx | HEAD | b16b587bee97 | clean | CLEAN_UNMERGED | Insurance and Eligibility | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-insurance-review-M5sM6e | HEAD | f087dbc00962 | clean | DUPLICATE | Insurance and Eligibility | No local diff this phase | Not assessed (clean snapshot) | Clean duplicate commit | Mark as duplicate; keep one canonical copy |
| /private/tmp/carecommand-intake-lifecycle-fix | HEAD | 70d81da8f336 | clean | CLEAN_UNMERGED | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-inventory-integrations | HEAD | 16d1727997f4 | clean | CLEAN_UNMERGED | Integrations, Webhooks, Workers and Queues | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-login-fix.hjHmrH/worktree | codex/login-security-remediation-20260801 | 2885465fab50 | clean | CLEAN_UNMERGED | Authentication, IAM, Session Management | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-login-release.Rkkyg2 | codex/login-release-integration-carecommand-login-release.Rkkyg2 | 9de3e1d7c82b | clean | CLEAN_UNMERGED | Authentication, IAM, Session Management | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-m09-independent.dxnS1i | HEAD | 8386f1b5f792 | dirty | DIRTY_UNIQUE | Needs module review | Receptionist intake contract/prompt service hardening and env validation | Yes (working-tree changes) | Pending merge; not yet in primary HEAD | Preserve: AI receptionist intake/prompt and production readiness candidate |
| /private/tmp/carecommand-m09-reaccept.jxdPt5 | HEAD | 043ebf12efce | clean | DUPLICATE | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean duplicate commit | Mark as duplicate; keep one canonical copy |
| /private/tmp/carecommand-m09-remediation.PB6uiP | codex/m09-pg18-remediation | 043ebf12efce | clean | DUPLICATE | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean duplicate commit | Mark as duplicate; keep one canonical copy |
| /private/tmp/carecommand-m17-docs-remediation.KyLvtI | HEAD | c590bcbf0d26 | clean | DUPLICATE | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean duplicate commit | Mark as duplicate; keep one canonical copy |
| /private/tmp/carecommand-m17-docs-review | HEAD | c590bcbf0d26 | clean | DUPLICATE | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean duplicate commit | Mark as duplicate; keep one canonical copy |
| /private/tmp/carecommand-m17-independent.xzQ1Rq | HEAD | c60a5880c7f7 | clean | DUPLICATE | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean duplicate commit | Mark as duplicate; keep one canonical copy |
| /private/tmp/carecommand-m17-pg18-overlay.60n7Q1 | HEAD | c60a5880c7f7 | dirty | DIRTY_UNIQUE | Needs module review | Disposable RLS database identity and role hardening | Yes (working-tree changes) | Pending merge; not yet in primary HEAD | Preserve: RLS disposable database safety planning |
| /private/tmp/carecommand-m18-d1-remediation | codex/m18-d1-independent-remediation | f373c570cf1b | clean | DUPLICATE | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean duplicate commit | Mark as duplicate; keep one canonical copy |
| /private/tmp/carecommand-m18-independent.9lxRSN | HEAD | d30bf91c1f1b | clean | CLEAN_UNMERGED | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-m18-remediation | codex/m18-independent-remediation | 2aed963fcb12 | clean | CLEAN_UNMERGED | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-m18-remediation-independent.6QrqwV | HEAD | a71aac5bb51b | clean | CLEAN_UNMERGED | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-m18-remediation.0UBzXE | codex/m18-remediation-current | 32c57bacc260 | clean | CLEAN_UNMERGED | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-m18-trust-independent.8prda8 | HEAD | f373c570cf1b | clean | DUPLICATE | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean duplicate commit | Mark as duplicate; keep one canonical copy |
| /private/tmp/carecommand-patient-identity-fix | HEAD | 7cfce2ae5b7d | clean | CLEAN_UNMERGED | Patient Master and Patient Identity | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-patient-portal-48071 | HEAD | f1abdbf64b25 | clean | CLEAN_UNMERGED | Patient Portal | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-pg-query-fix | HEAD | 441113002ec4 | clean | DUPLICATE | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean duplicate commit | Mark as duplicate; keep one canonical copy |
| /private/tmp/carecommand-portal-findings.0DNyLu | HEAD | e3a1384dfd9c | clean | CLEAN_UNMERGED | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-portal-revenue.zsYkMj | feat/integrate-portal-revenue | 37f826ee1688 | clean | CLEAN_UNMERGED | Billing, Invoices, Payments and Refunds | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-receptionist-integration.iwhNmO | codex/receptionist-release-integration-carecommand-receptionist-integration.iwhNmO | 23391f5faabf | clean | CLEAN_UNMERGED | AI Receptionist and Telephony | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-receptionist-multiprovider | codex/receptionist-multiprovider-m09 | f45464780504 | clean | CLEAN_UNMERGED | AI Receptionist and Telephony | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-receptionist-phase2.sj6mZE | HEAD | 043ebf12efce | dirty | DIRTY_UNIQUE | AI Receptionist and Telephony | Signed callback collision governance, RLS, and data lifecycle upgrades | Yes (working-tree changes) | Pending merge; not yet in primary HEAD | Preserve: provider callback governance and lifecycle controls |
| /private/tmp/carecommand-receptionist-pilot.t2WKuS/worktree | codex/receptionist-synthetic-pilot | 4d7fc1f3fbb0 | clean | CLEAN_UNMERGED | AI Receptionist and Telephony | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-release-evidence | HEAD | 1f6578b40d93 | clean | CLEAN_UNMERGED | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-remediation-ECI6gg | HEAD | ce89fedb36e7 | clean | DUPLICATE | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean duplicate commit | Mark as duplicate; keep one canonical copy |
| /private/tmp/carecommand-reputation | HEAD | 80bfc7a6973a | clean | CLEAN_UNMERGED | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-reputation-rebuild.Xi59vg | codex/reputation-security-rebuild-20260802 | 50bf5317f2d4 | clean | CLEAN_UNMERGED | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-retell-third.BNSRVv | HEAD | c951a1a84f74 | clean | MERGED | AI Receptionist and Telephony | No local diff this phase | Not assessed (clean snapshot) | In primary ancestry | Already reconciled |
| /private/tmp/carecommand-revenue-findings.B9j43L | HEAD | 0794c3f9884f | clean | CLEAN_UNMERGED | Billing, Invoices, Payments and Refunds | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-revenue-payments | HEAD | 830655f614cb | clean | CLEAN_UNMERGED | Billing, Invoices, Payments and Refunds | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/carecommand-scheduling-timezone-fix | HEAD | a0ea222d8af5 | clean | CLEAN_UNMERGED | Scheduling, Waitlist, Check-In and Appointment Operations | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/cc-m17-rebuild-d1-remediation | codex/m17-rebuild-d1-remediation | c60a5880c7f7 | clean | DUPLICATE | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean duplicate commit | Mark as duplicate; keep one canonical copy |
| /private/tmp/cc-reputation-remediate.j7FVTO | codex/reputation-remediation-j7fvto | cebcc6cda418 | clean | CLEAN_UNMERGED | Needs module review | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/login-acceptance.iJYTJh | HEAD | a0146c925e95 | clean | CLEAN_UNMERGED | Authentication, IAM, Session Management | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |
| /private/tmp/login-rereview.fwFRtI | HEAD | b9528b5beb12 | clean | CLEAN_UNMERGED | Authentication, IAM, Session Management | No local diff this phase | Not assessed (clean snapshot) | Clean unmerged snapshot | Preserve for future wave |

## Deep-dive for DIRTY_UNIQUE worktrees

1) `/private/tmp/carecommand-441-clock-control.siazO9`

- Branch: `HEAD`
- HEAD: `441113002ec41a674778c053c1ebf8277bcdf731`
- Module: Messaging and Notifications
- Feature: Comms provider integrity tests for truthful delivery, truthful failure states, and no provider payload leakage
- Working files with diff (6.3k lines total): `server/test/commsDelivery.integration.test.ts`
- Test presence: **Yes** (modified test file)
- Same implementation in primary HEAD: **No** (new/changed test path)
- Unique: **Likely unique**, no obvious duplicate hash share
- Conflicting newer work: **No known conflict identified**
- Decision: **Preserve as recovery candidate**

2) `/private/tmp/carecommand-accepted-convergence`

- Branch: `codex/accepted-module-convergence`
- HEAD: `3dac135235bfa08af0ace81c709313b1541367f7`
- Module: AI Receptionist and Telephony (receptionist destination recovery)
- Feature: Destination recovery + probe provisioning + migration boundary controls + migration + scripts + tests
- Working diff files include docs, scripts, tests, `prisma` migration, and package changes.
- Test presence: **Yes** (`server/test/databaseDeployOrchestrator.unit.test.ts`, `server/test/providerProbeProvisioning.unit.test.ts`, `server/test/receptionistDestinationGuardBoundary.unit.test.ts`)
- Same implementation in primary HEAD: **No** matching code
- Unique: **Yes**
- Conflicts with newer work: **No known conflicting overwrite**
- Decision: **Preserve as recovery candidate**

3) `/private/tmp/carecommand-autopilot-recovery.t0CZH3`

- Branch: `HEAD`
- HEAD: `0be41637cb17ee8de963da68e5bbf5066b643ea8`
- Module: AI Receptionist and Telephony / Workers
- Feature: Autopilot queued-dispatch recovery worker and startup recovery pass; dispatch recovery tests
- Test presence: **Yes** (`server/test/autopilotRecovery.integration.test.ts`, plus modified `worker.integration.test.ts`)
- Same implementation in primary HEAD: **No** equivalent implementation found in primary working tree
- Unique: **Yes**
- Conflicts with newer work: **No**
- Decision: **Preserve as recovery candidate**

4) `/private/tmp/carecommand-m09-independent.dxnS1i`

- Branch: `HEAD`
- HEAD: `8386f1b5f792a8f075fad4b8803d5049982fa9b2`
- Module: AI Receptionist and Telephony
- Feature: Receptionist intake contract/prompt service hardening, environment schema, production readyness tests
- Test presence: **Yes** (multiple integration and unit tests under `server/test/`)
- Same implementation in primary HEAD: **No**
- Unique: **Yes** (has related duplicate commit with destination-pg18, but different implementation scope)
- Conflicts with newer work: **No immediate conflict**
- Decision: **Preserve as recovery candidate**

5) `/private/tmp/carecommand-m17-pg18-overlay.60n7Q1`

- Branch: `HEAD`
- HEAD: `c60a5880c7f733d61387a546019b4e21c37a44e8`
- Module: Database / RLS
- Feature: `withDisposableRlsDatabase()` hardened role/name safety planning
- Test presence: **Not confirmed in workspace diff** (file-only change)
- Same implementation in primary HEAD: **No**
- Unique: **Yes**
- Conflicts with newer work: **No known**
- Decision: **Preserve as recovery candidate**

6) `/private/tmp/carecommand-receptionist-phase2.sj6mZE`

- Branch: `HEAD`
- HEAD: `043ebf12efce1a511bd47bab3cd04ebbaead4ee0`
- Module: AI Receptionist and Telephony
- Feature: Provider callback governance, provider rate-limits, RLS catalog verification, inbound call lifecycle tests
- Test presence: **Yes** (numerous receptionist integration/security tests plus new unit tests)
- Same implementation in primary HEAD: **No**
- Unique: **Yes**
- Conflicts with newer work: **Noted shared 043ebf* family with two clean duplicates, but content differs from duplicates**
- Decision: **Preserve as recovery candidate**

## Recovery exit condition status (phase-0)

- All 6 dirty worktrees are classified and reviewed at a high level.
- Unique dirty work is not yet patched/committed into primary during this pass.
- Duplicate-only worktrees are identified and marked for canonical retention only.
- No migration conflicts detected between the six workspace-dirty snapshots at this stage, but several have migration additions and must be conflict-reviewed before integration.
- One authoritative integration branch identified: `feat/complete-rls-isolation`.
