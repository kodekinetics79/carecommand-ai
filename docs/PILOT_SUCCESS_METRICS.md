# Pilot Success Metrics

Last updated: 2026-07-20

These are measurable outcomes for an enterprise-grade customer validation. Each
metric needs an owner, source system, baseline, target, and evidence link.

## Patient Experience

| Metric | Target |
| --- | --- |
| portal sign-in success rate | 95% or higher for provisioned patients |
| booking completion without staff help | 85% or higher |
| intake completion before appointment | 80% or higher |
| payment success after request | client-defined baseline improvement |
| accessibility smoke pass | no critical keyboard/screen-reader blockers |

## Clinic Operations

| Metric | Target |
| --- | --- |
| imported patient/appointment/insurance accuracy | 99% for accepted rows |
| front-desk appointment status accuracy | 99% after booking/reschedule/cancel |
| duplicate-patient prevention | no unsafe duplicate merge during validation |
| staff task completion time | measurable reduction against baseline |

## Clinical And Connected Care

| Metric | Target |
| --- | --- |
| critical device reading routing | 100% reaches authorized queue/responder in test |
| alert acknowledgment auditability | 100% of tested alerts have audit trail |
| unsafe clinical language defects | zero P0/P1 |
| AI recommendation PHI policy violations | zero |

## Financial

| Metric | Target |
| --- | --- |
| duplicate charges | zero |
| payment status reconciliation | 100% for tested success/failure/refund/dispute cases |
| eligibility status clarity | 100% of tested active/inactive/uncertain responses show staff next action |
| revenue leakage signal creation | 100% for tested failed-payment workflows |

## Security And IT

| Metric | Target |
| --- | --- |
| cross-tenant access attempts | zero successful |
| unauthorized role escalations | zero successful |
| production bundle leakage | zero local paths, dev endpoints, demo secrets, seeded credentials |
| high-severity production dependency vulnerabilities | zero |
| backup restore drill | passed or formally waived before go-live |

## Sales Conversion

| Metric | Target |
| --- | --- |
| buyer-visible critical journeys demonstrated | all scoped journeys |
| customer-run scenarios completed without engineering intervention | 90% or higher |
| P0/P1 defects at final review | zero open, unless client-approved workaround |
| signed rollout decision | target date and commercial owner assigned |
