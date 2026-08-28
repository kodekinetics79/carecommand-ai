# Defect Log And Retest Tracker

Last updated: 2026-07-20

Use this during client-run enterprise validation. Every P0/P1 defect requires a
root-cause fix and retest evidence before acceptance.

| ID | Severity | Workflow | Environment | Repro steps | Expected | Actual | Owner | Fix commit | Retest evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TEMPLATE-001 | P1 | Example | staging | 1. Sign in 2. Run workflow | clear expected behavior | observed failure | named owner | commit SHA | command/screenshot/log link | open |

## Severity Rules

- P0: data exposure, cross-tenant access, duplicate charge, unsafe clinical alert,
  full outage, or unrecoverable data corruption.
- P1: critical workflow failure without safe workaround.
- P2: important but bounded issue with workaround.
- P3: cosmetic or low-risk improvement.

## Retest Requirements

- include original reproduction steps
- include regression test added or command rerun
- include browser/API/database evidence as applicable
- include client acceptance for any workaround
