# P0 Pilot Control and Evidence Matrix

Last reviewed: 2026-07-30

> Current checkpoint: the authoritative release status and current test totals are in `docs/testing/RELEASE_READINESS_REPORT.md` and `docs/testing/TEST_EXECUTION_EVIDENCE.md`. The dated implementation-wave notes below are retained as historical evidence and do not override those files.

## Purpose and decision rule

This is the authoritative implementation gate for the autonomous-receptionist
pilot. It maps one control backlog to HIPAA Security Rule readiness, SOC 2 Trust
Services Criteria readiness, and GDPR engineering obligations. It is not a
certification, legal opinion, HIPAA compliance determination, SOC 2 report, or
GDPR conformity assessment.

A control is **closed** only when all four conditions are true:

1. the production path enforces it;
2. an automated test proves both allow and deny/failure behavior;
3. deployment evidence is attached to the evidence ledger; and
4. the named operational owner has accepted the control.

Code, a passing local test, or a policy document alone is not sufficient. Any
older readiness document that reports a different test count or status is
historical evidence, not the current go/no-go record.

## Pilot boundary

The current safe target is an attended, low-volume pilot using synthetic data.
Real PHI, unattended autonomy, and generalized front-desk claims remain out of
scope until every P0 gate below is closed and legal/security owners approve the
data flows and contracts.

## P0 control matrix

| ID | Control objective | Primary readiness mapping | Current state | Required evidence to close | Pilot disposition |
| --- | --- | --- | --- | --- | --- |
| P0-01 | Least-privilege access to call summaries, transcripts, recordings, and mutations | HIPAA 164.308(a)(4), 164.312(a); SOC 2 CC6; GDPR Art. 5(1)(f), 25, 32 | Locally implemented and tested; deployment grants/access review remain | Allow/deny integration tests by role; tenant-isolation test; denied-access audit event; permission-override migration; quarterly access-review owner | Blocking for real PHI |
| P0-02 | Mandatory AI identity and recording disclosure with recorded consent/refusal | HIPAA state-law/organizational policy dependency; SOC 2 CC2/CC7; GDPR Art. 5, 6, 7, 13 | Partial; non-overridable disclosure plus immutable local consent/refusal evidence and fail-closed artifact ingestion are implemented, but jurisdiction/counsel approval and connected-provider behavior are unproven | Connected provider recording-disable/refusal trace; jurisdiction policy and counsel-approved script; deployed evidence review | Blocking for real calls |
| P0-03 | Authentic, replay-safe provider callbacks tied to a canonical call lifecycle | HIPAA 164.312(c); SOC 2 CC6.6, CC7; GDPR Art. 5(1)(f), 32 | Partial; signed webhooks and documented per-call callback payload are locally tested; connected lifecycle is unproven | Provider contract test; signature rejection; replay/idempotency test; initiated-to-terminal-state production trace | Blocking for autonomous calls |
| P0-04 | Canonical appointment confirmation: no success without a persisted appointment | HIPAA integrity 164.312(c); SOC 2 PI1/CC7; GDPR Art. 5(1)(d) | Partial; staff, portal and receptionist now share provider availability/conflict checks, canonical service duration, DB collision protection and appointment-backed replay handling; connected end-to-end behavior remains unproven | Deployed end-to-end tests for success, collision, rollback, webhook replay and no false confirmation; monitored production trace | Blocking for autonomous booking |
| P0-05 | Human handoff, emergency response, acknowledged message/callback, and safe fallback | HIPAA risk management 164.308(a)(1); SOC 2 CC7; GDPR Art. 25, 32 | Partial; locally implemented acknowledgment-required staff tasks, critical emergency signals, provider-native transfer configuration, replay safety, and focused tests | Deployed transfer success/failure trace; staff alert-delivery/acknowledgment SLA evidence; clinical-operations script approval; production synthetic monitoring | Blocking for unattended autonomy |
| P0-06 | Patient identity verification before protected patient-specific actions | HIPAA 164.312(d); SOC 2 CC6; GDPR Art. 5(1)(f), 25, 32 | Implemented and focused-tested locally using provider-observed caller number plus DOB, bounded lockout, call-scoped evidence, and human review for proxy/minor/failed verification; connected-provider and approved-policy evidence remain open | Approved verification policy; connected positive/negative trace; attempt/lockout evidence; proxy/minor path approval; operational owner acceptance | Blocking for real PHI |
| P0-07 | Tenant isolation at application and database layers | HIPAA 164.312(a); SOC 2 CC6; GDPR Art. 25, 32 | Locally implemented: 119/119 protected tables use ENABLE + FORCE RLS; 962 restricted-role behaviors cover same/cross/no-context access; tenant and platform database planes are separated | Re-run role/catalog/behavior probes against the deployed database topology and attach production access review | Blocking for enterprise/real PHI until deployed evidence |
| P0-08 | Retention, deletion, legal hold, and vendor deletion for recordings/transcripts | HIPAA 164.310(d), 164.316; SOC 2 CC8/A1; GDPR Art. 5(1)(e), 17, 28 | Partial; immutable lifecycle evidence, retention deadlines, legal holds and local purge controls are implemented/tested; provider deletion receipts and deployed schedules are unproven | Approved schedule; deployed purge trace; legal-hold operations evidence; vendor deletion receipt; backup/restore behavior | Blocking for real recordings |
| P0-09 | Clinic kill switch, concurrency/spend limits, quiet hours, opt-out and campaign state enforcement | HIPAA risk management; SOC 2 CC7/A1; GDPR Art. 21, 25, 32 | Partial; provider-boundary kill recheck, active-call stop integration, RUNNING-only campaigns, atomic target claim, replay-safe usage accounting, DNC, quiet hours, tenant concurrency and voice-minute reservations are locally implemented and focused-tested | Deployed kill-switch test under load; live active-call cancellation/provider stop proof; alert delivery and spend evidence; production opt-out and quiet-hours receipts | Blocking for autonomous outbound |
| P0-10 | Production operations: durable queues, monitoring, incident response, backup restore and vendor BAAs/DPAs | HIPAA 164.308(a)(1),(7), 164.314; SOC 2 CC7/A1; GDPR Art. 28, 32, 33 | Runbooks exist; connected-environment evidence is not current/proven | Deployed worker/Redis health; paging receipt; restore drill; incident exercise; executed BAAs/DPAs/subprocessor review | Blocking for real PHI |
| P0-11 | Dependency and secure-development risk closure | HIPAA risk management; SOC 2 CC8; GDPR Art. 25, 32 | Locally closed at the configured severity threshold: compatible React/Router upgrade applied and production audit reports zero high/critical findings | Preserve lockfile; repeat audit, signatures, typecheck, build and browser regression from the commit-bound release candidate | Reopens on a high/critical production advisory |
| P0-12 | Accurate system claims and one commit-bound evidence record | HIPAA documentation 164.316; SOC 2 CC2/CC4; GDPR accountability Art. 5(2), 24 | Locally closed: reconciled evidence, attributed commits, committed-state results, and annotated local RC tag are recorded | Deployment environment, provider modes, operational approvers and external evidence must still be attached before production approval | Local synthetic gate closed; production gate external |

## Delivery order and ownership

| Wave | Work package | Engineering owner | Independent acceptance owner |
| --- | --- | --- | --- |
| 1 | P0-01, P0-02, P0-03 and dependency remediation | Security and receptionist reliability SMEs | Principal consultant plus security owner |
| 2 | P0-04, P0-05, P0-06 and P0-09 | Receptionist workflow team | Clinical operations/safety owner |
| 3 | P0-07 and P0-08 | Platform security/data engineering | Privacy and security owners |
| 4 | P0-10 and P0-12 | SRE/compliance operations | Executive go/no-go committee |

No later wave may be used to mark an earlier blocking control complete. Partial
modules remain explicitly partial until their production behavior and evidence
meet the closure rule above.

## Required commit-bound evidence record

For every release candidate, append one record to `docs/EVIDENCE_LEDGER.md` with:

- commit SHA and clean/dirty worktree statement;
- test environment and synthetic/real-data classification;
- exact validation commands and unedited outcomes;
- deployed provider modes and integration health output;
- security exceptions with owner and expiry date;
- backup/restore and alert-delivery artifact links;
- P0 control IDs closed, still open, or regressed;
- engineering, security/privacy, clinical-operations, and business approvers.

The release decision is **NO-GO** for any use of real PHI or unattended autonomy
while a blocking control is open. A synthetic, attended demonstration may be
approved only with documented compensating controls and a rehearsed stop path.

## Historical local implementation checkpoints

The 2026-07-28 P0 implementation wave added first-class receptionist read,
recording-read, and manage permissions; PHI-bearing receptionist read guards;
recording URL redaction; allow/deny/read audit evidence; tenant-scoped detail
access; mandatory AI/recording disclosure text; Retell per-call callback
propagation; and canonical appointment-backed idempotency.

Supervisor verification on the shared worktree:

- `npm run api:typecheck` — passed;
- `npx vitest run server/test/receptionistP0Reliability.unit.test.ts server/test/receptionistCanonicalLifecycle.integration.test.ts server/test/receptionist.test.ts server/test/receptionistArtifactAccess.compliance.integration.test.ts` — 4 files, 16 tests passed;
- `git diff --check` — passed.

The front-desk safety wave locally added `request_human_handoff`, `take_message`,
and `report_emergency` live tools. Handoffs/messages create open StaffTask records
that require staff acknowledgment; emergency mentions additionally create a
critical OperationalSignal. Audit metadata excludes caller names, numbers, and
message text. Valid E.164 clinic fallback numbers add Retell's provider-native
transfer tool, but task creation never reports that a transfer completed.
`server/test/receptionistSafety.integration.test.ts` covers call-scoped and
missing-call-id replay safety, minimum-necessary audit metadata, emergency
instructions/signals, and transfer configuration. This is local engineering
evidence only; P0-05 remains open pending deployed and operational evidence.

The outbound reliability wave locally added RUNNING-only campaign enforcement,
tenant/campaign-bound target identity, an atomic PENDING-to-CALLING claim,
retry-aware terminal transitions, and a tenant fail-safe stop that reuses the
existing platform-governed AI kill switch. Campaign state and the stop control
are rechecked immediately before the provider boundary. Tenant users can stop
outbound but cannot clear a platform safety stop. P0-09 remains open pending
active-call cancellation, deployed load evidence, concurrency and spend limits
with alarms, and production opt-out/quiet-hours evidence.

Combined supervisor verification after both wave-2 tracks converged:

- `npm run api:typecheck` — passed;
- `npx vitest run server/test/receptionistSafety.integration.test.ts server/test/receptionistOutboundCompliance.unit.test.ts server/test/receptionistOutboundTargets.integration.test.ts server/test/receptionistBooking.integration.test.ts server/test/receptionistP0Reliability.unit.test.ts server/test/receptionistCanonicalLifecycle.integration.test.ts server/test/receptionistSecurity.integration.test.ts server/test/receptionistArtifactAccess.compliance.integration.test.ts server/test/receptionist.test.ts` — 9 files, 41 tests passed;
- `git diff --check` — passed.

Root integration verification after both supervised waves converged:

- `npm run check` — passed (schema validation, server typecheck, full lint, production build);
- `npm test` — 49 files and 285 tests passed;
- At that historical checkpoint, `npm audit --omit=dev --audit-level=high` reported two high React Router findings; the current authoritative checkpoint reports zero vulnerabilities after the compatible upgrade;
- local PostgreSQL and Redis containers were healthy for the integration run;
- data classification remained synthetic/local; no real PHI was used.

Wave 3 and Wave 4 local convergence added bounded tenant-context adoption,
recording consent/retention/legal-hold controls, multi-policy insurance integrity,
and clinic-timezone scheduling. Insurance policies now carry coordination order
and inclusive/exclusive effective dates, reject overlapping active coverage at
the same order, and bind eligibility to one tenant/branch policy and payer.
Provider mode is fail-closed: tenant configuration authorizes a mode while the
deployment environment must provide the actual live Stedi capability. Scheduling
uses the branch IANA timezone, canonical provider/service duration and the same
availability/time-off/collision engine across staff, portal and receptionist.
Ambiguous receptionist location/provider/service selection routes to review and
does not create provider-null capacity.

Wave 4 supervisor evidence:

- fresh temporary PostgreSQL database: all 59 migrations applied successfully,
  including the corrected pre-release insurance migration and reconciliation
  migration; the temporary database was removed afterward;
- `npx vitest run` focused scheduling/receptionist set — 8 files, 44 tests passed;
- `npx vitest run server/test/insurancePolicyIntegrity.integration.test.ts server/test/connectedCare.integration.test.ts server/test/moneyIntegrity.integration.test.ts` — 3 files, 15 tests passed;
- `npm run db:validate` and `npm run api:typecheck` — passed;
- synthetic/local data only; no real PHI and no compliance certification claim.

These are engineering controls, not closure of P0-02, P0-04, P0-07, P0-08,
P0-10 or P0-12. Connected-provider traces, complete RLS coverage, operational
retention/deletion evidence, BAAs/DPAs, restore/incident exercises and formal
approvals remain required. Real-PHI and unattended-autonomy disposition remains
NO-GO.

Before deployment, review every non-empty `RoleDefinition.permissions` override.
Overrides replace defaults, so the new `receptionist:call-artifacts:read`,
`receptionist:recordings:read`, and `receptionist:manage` grants must be assigned
explicitly where approved. The fail-closed behavior is intentional but can
otherwise remove existing receptionist access at rollout.
