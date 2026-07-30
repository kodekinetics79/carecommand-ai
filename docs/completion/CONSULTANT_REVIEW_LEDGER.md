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

## Review independence

The acceptance reviewer did not author the accepted platform-session or production
topology changes. Embedded pod review is advisory and is not recorded as independent
acceptance.
