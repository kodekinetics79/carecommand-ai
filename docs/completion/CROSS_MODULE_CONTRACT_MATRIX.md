# Cross-Module Contract Matrix

This matrix is a release control. A consuming module may not substitute a local
implementation for a canonical provider contract. `PASS` means repository evidence
has been accepted for the cited contract; it does not activate an external service or
certify an organization.

| Contract | Canonical owner | Primary consumers | Required invariants | Current gate |
|---|---|---|---|---|
| Tenant context and RLS | M23 database/RLS | M01–M22 | authenticated tenant bound to transaction; runtime principals fail closed; platform plane separate | PASS at 69 migrations / 119 protected tables; managed database activation external |
| Staff authentication/session | M02 identity | all staff modules | strong password/session validation, revocation, CSRF, no tenant selection by caller | PASS for reviewed core; SSO/MFA provider activation remains feature-specific |
| Platform authentication/session | M03 platform | M03, M19, M24 | unique session ID, per-session revocation, separate audit plane | PASS at `75c22db` |
| Authorization vocabulary | M05 workforce | M01–M22 | server-enforced least privilege; route/action scopes; no UI-only authorization | PASS for reviewed foundation/workforce scope; catalog reconciliation continues |
| Tenant/clinic master data | M04 organization | M05–M18 | active-clinic enforcement; serialized lifecycle and access changes; atomic audit | PASS for reviewed lifecycle/access scope |
| Patient identity | M06 patient data | M07–M17 | canonical identity, deterministic duplicate handling, soft-delete policy, no fabricated demographics/consent | PASS for reviewed identity/search/lifecycle scope; indexed canonical phone is P3 scale work |
| Consent and suppression | M06/M11 | M09–M14, M17 | purpose/channel/version/source/time provenance; revocation authoritative; minimum necessary | Accepted where cited; catalog reconciliation remains |
| Scheduling/appointment mutation | M07 scheduling | M09, M10, M13, M16 | canonical availability and collision transaction; explicit ownership/policy; commit before success claim | PASS for reviewed collision/book/change paths |
| Receptionist call identity | M09 receptionist | M06, M07, M11 | call-scoped proof, attempt limits, no hints, tenant destination fail closed | PASS for reviewed protected core |
| Receptionist recording consent | M09 receptionist | M19 | versioned disclosure/hash, refusal honored, artifact lifecycle and legal hold | Repository core accepted; legal/jurisdiction/provider validation external |
| Portal identity and patient scope | M10 portal | M06–M13 | separate portal session, patient-bound records, no staff-token substitution | Accepted where cited; full module review remains |
| Outbound communication delivery | M11 communications | M09, M17 | DNC/consent before dispatch, idempotent status, provider response is not implied delivery | Live provider evidence external; repository reconciliation remains |
| Eligibility/prior authorization | M12 insurance | M06, M10, M13 | payer response provenance, no invented eligibility, deterministic lifecycle | Live payer activation external; full internal review remains |
| Money/deposit/reconciliation | M13 revenue | M07, M09, M10, M16 | integer minor units, idempotency, webhook verification, transaction before success | PASS for reviewed concurrency core; live rails external |
| Connected-care safety/evidence | M14 connected care | M06, M08, M13, M16 | device/enrollment scope, time-period evidence, alert escalation, no unsupported clinical conclusion | Reviewed fixed-period core accepted; vendors external |
| AI recommendation/action | M15 AI governance | M09, M16–M18 | bounded input, provenance, allowed action, human approval where required, immutable outcome | IN DISCOVERY |
| Operational analytics | M16 analytics | executive surfaces | source/time/scope disclosed; partial data labeled; no fabricated totals, benchmarks, or consent | IN DISCOVERY |
| Audit event durability | M19 compliance | M01–M22 | attributed event, atomic/fail-closed mandatory write, no raw secret/PHI payload | PASS for reviewed mandatory actions |
| Entitlement resolution | M20 entitlements | paid modules | server-enforced catalog key, plan/add-on/override precedence, auditable change | IN DISCOVERY |
| Queue job envelope | M21 reliability | M11, M14, M15, M19 | signed tenant envelope, idempotency, bounded retry/backoff, observable terminal state | Accepted where cited; managed Redis/alerts external |
| Production configuration | M24 release | all runtimes | production profile fails closed; no mock provider; public URL validation; isolated migration owner | PASS at `3ac14ac` |
| Accessibility structure | M22 experience | all browser modules | names for visible controls, alt/lang/title, unique IDs, no positive tabindex | PASS for sampled routes at `5634aa5`; formal WCAG/AT audit external |

## Change rule

Any change to a canonical contract must update its owner inventory, focused tests,
the consuming feature evidence, and this matrix. The authoring pod cannot provide the
independent acceptance verdict for its own change.
