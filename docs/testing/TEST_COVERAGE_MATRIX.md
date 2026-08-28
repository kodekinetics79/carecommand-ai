# Test Coverage Matrix

Evidence reflects the authoritative 2026-07-30 local synthetic-data release review. “External” means the repository behavior is covered but live-provider, legal, or operational evidence is outside this execution.

| Module / boundary | Principal risk | Automated coverage | Current status |
|---|---|---|---|
| Authentication and staff sessions | takeover, replay, tenant ambiguity, cross-origin CSRF | login/MFA/rotation/replay/logout, memory-held CSRF bootstrap, suspended/archived tenant, duplicate-email selection, RBAC negatives, browser login/reload/logout | Covered locally |
| Patient portal | replayed bearer, cross-patient access, unsupported guardian authority | short memory-only bearer, HMAC-JTI server session, atomic audited logout/revocation, guardian/minor fail-closed | Covered locally |
| Tenant context and PostgreSQL RLS | cross-tenant PHI disclosure | catalog, role posture, same/cross/no-context CRUD adapters for 119/119 tables, 962 assertions, pool reuse | Covered locally; deployed topology external |
| Platform administration | tenant/platform identity or privilege confusion | separate `app_platform` plane, curated grants/functions, negative `app_rls` platform probes, platform auth/provisioning tests | Covered locally |
| Patients, intake, consent | PHI disclosure, ambiguous acceptance | branch/permission negatives, atomic intake, explicit canonical versioned acknowledgement, audits | Covered locally |
| Scheduling and appointments | double booking, timezone, false confirmation | availability/time-off/collision engines, exclusion constraint, portal/staff/receptionist paths, confirmation-token and ownership checks | Covered locally |
| AI receptionist | wrong-patient action, recording/outreach consent, runaway or stale call | signed ingress, exact disclosure hash, consent/refusal, identity proof, active-call gate, atomic admission, kill switch, canonical booking, server-held cancel/reschedule confirmation, replay and rollback tests | Covered locally; connected calls/legal approval external |
| Insurance and eligibility | wrong policy/payer, fabricated live status | policy integrity/overlap/branch tests, fail-closed live-provider gating, truthful simulation labeling | Covered locally; live payer proof external |
| Revenue, deposits, payments | cross-branch money state, duplicate links, webhook replay | billing permissions/branch scope, advisory reservation, durable reconciliation, Stripe signature/replay, atomic audit/event rollback | Covered locally; production rails external |
| Monitoring and connected care | invalid readings, duplicate alerts, stale clinical approval | signature/mapping/plausibility/dedupe, atomic alert/notification/audit, branch/provider controls, fixed-period immutable-event evidence, evidence-bound signoff, current consumer recomputation, offline/backdated invalidation | Covered locally; independently accepted |
| Mandatory audit durability | sensitive mutation without evidence | platform privileged actions/auth/MFA, cross-plane pilot receipts, receptionist tools, public intake, all payment terminal states, forced failure, concurrency and retry coverage | Covered locally; independently accepted |
| Platform privileged authentication | account enumeration or weakened distributed throttling | generic constant-work account-state response, atomic MFA success state/audit, actor/IP/UA evidence, and fail-closed production rate-limit-store coverage | Covered locally; independently accepted |
| Compliance, audit, privacy | PHI logs/cache, missing evidence | redaction, DSR, retention/legal hold, receptionist artifacts, no runtime PHI translation, append-only evidence | Covered locally; organizational evidence external |
| Frontend routes/actions/accessibility | dead actions, blank routes, mobile failure | 32 unique staff routes / 93 role-route traversals plus public/platform/patient journeys; desktop/mobile Playwright; console/network checks | Covered locally; full WCAG audit external |
| Migrations, drift, lifecycle | isolation loss or unrecoverable data | current 69-migration clean/upgrade/seed/teardown, 120 protected tenant FKs, migration-owned index manifest, earlier isolated dump/restore drill | Covered locally; managed production restore external |
| External providers and operations | false connected-state claims, outage/retry failure | deterministic contract/failure adapters and truthful configured/unconfigured states | Live proof and contracts external |

The final-tree regression passes twice at 78 files and 469/469 tests; browser coverage passes 10/10. A committed-state rerun remains part of G20.
