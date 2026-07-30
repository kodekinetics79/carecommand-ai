# Independent Consultant Review Ledger

This is an append-only decision log. `REJECT` keeps the feature or module gate closed
until a later independent entry explicitly supersedes it.

| Scope | Decision | Severity/findings | Remediation/evidence | Independent status |
|---|---|---|---|---|
| Platform logout/session isolation | REJECT | P2: timestamp identity allowed same-millisecond sessions to share revocation | random UUID session ID, full SHA-256 audit lookup, dual-session regression | Superseded by PASS |
| Platform logout/session isolation | PASS | P0/P1/P2: 0; P3 metadata lookup performance only | `75c22db`; focused 6/6; session A revoked while B remained valid | ACCEPTED |
| Pilot topology/release controls | REJECT | P1 invalid environment-group secret prompting; P1 cross-site cookie omission; P2 public-URL and migration-principal bypasses; accessibility false negatives | service-level external vars, SameSite=None, strict URL classes, isolated principal guard, strengthened browser contract | Superseded by PASS |
| Pilot topology/release controls/accessibility | PASS | Residual repository P0/P1/P2: 0 | `3ac14ac`, `a07ba0f`, `5634aa5`; structural 28/28; desktop browser 5/5; gitleaks full history; CycloneDX SBOM | ACCEPTED; environment and formal WCAG gates external |
| Foundation/master data | REJECT | P1 fabricated/bounded patient facts presented as network metrics; P1 front-desk task regression; P1 clinician-owner identity and provisioning integrity; P2 patient/clinic races and lifecycle collisions | implementation pod remediation in progress | OPEN — cannot be marked complete |
| Foundation/master data | PASS | P0/P1/P2: 0; P3 retired compatibility removal, indexed canonical phone at scale, pg client warning | `524169f`, `70923c5`, `1bb1c1e`; 40/40; real route and cross-entry race proofs | ACCEPTED for reviewed F1–F7 scope |
| Market/AI Receptionist pilot review | REJECT | P1 unsupported parity/advantage claims, unsegmented/narrow market set and non-quantitative acceptance; P2 provider coopetition, TCO, adversarial scenarios and unbuilt-roadmap ambiguity | claims demoted, ICP/market expanded, quantitative phased protocol and stop rules added, roadmap labeled NOT BUILT | Superseded by PASS |
| Market/AI Receptionist pilot review | PASS | P0/P1/P2: 0; P3 named live approvers and pre-result threshold calibration | `8f9f0e5`; seven vendor primary-source families; 300-call simulation, 100 shadow and capped live protocol | ACCEPTED as review artifact; live evidence not implied |
| M09-F02 immutable receptionist agent deployment | REJECT | P0: create-call response deployment mismatch not stopped/contained; P1: V0, moving-tag repin, cross-tag deployment ownership, 400/422 permanence, clinic-branch mapping; P2: tag grammar, global agent fallback surfaces, unique conflict, DB shape and UI truthfulness/evidence | Remediated candidate passes fresh 71 migrations, focused 60/60, receptionist 115/115, RLS 962/962, drift/typecheck/lint/build; mismatch stop success/failure plus simultaneous signal/task outage preserve INVALID/PAUSED/FAILED and no-second-dial with truthful review flags | Superseded by later PASS |
| M09-F02 immutable receptionist agent deployment | PASS | Repository-scope P0/P1/P2: 0; live Retell account execution remains external release validation | Exact `499809aa3fbf0b55a7e51e73d70648be89550726`; independent detached fresh 71-migration database, 47/47 focused tests, typecheck, targeted lint, production build, diff check and clean hash; pod evidence 117/117 receptionist and 962/962 RLS | ACCEPTED for deterministic repository scope |

## Review independence

The acceptance reviewer did not author the accepted platform-session or production
topology changes. Embedded pod review is advisory and is not recorded as independent
acceptance.
