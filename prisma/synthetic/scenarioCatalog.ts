export type SyntheticProfile = 'FUNCTIONAL' | 'PILOT' | 'EDGE';

export interface SyntheticScenario {
  scenarioId: string;
  profile: SyntheticProfile;
  tenant: string;
  actors: string[];
  preconditions: string[];
  inputEvent: string;
  expectedDatabaseState: string;
  expectedApiResult: string;
  expectedUiResult: string;
  expectedAuditEvents: string[];
  expectedAuthorization: string;
  evidenceStatus: 'EXECUTABLE' | 'SPECIFICATION_ONLY';
  executableEvidence: string[];
  resetStrategy: 'DROP_DISPOSABLE_DATABASE';
}

const scenarioEvidence: Record<string, string[]> = {
  'AUTH-001': ['server/test/authSession.integration.test.ts'],
  'PAT-001': ['server/test/clinicalWorkflowHardening.integration.test.ts'],
  'PAT-002': ['server/test/rlsBehavioralCoverage.integration.test.ts'],
  'PAT-004': ['server/test/portalSignup.integration.test.ts'],
  'SCH-001': ['server/test/appointmentCorrectness.integration.test.ts'],
  'SCH-002': ['server/test/portalBooking.integration.test.ts'],
  'SCH-003': ['server/test/crossPathBooking.integration.test.ts'],
  'SCH-005': ['server/test/clinicalWorkflowHardening.integration.test.ts'],
  'SCH-006': ['server/test/portalAppointmentSelfService.integration.test.ts'],
  'SCH-007': ['server/test/schedulingTimezone.unit.test.ts'],
  'REC-001': ['server/test/receptionistSafety.integration.test.ts'],
  'REC-002': ['server/test/receptionistInboundBootstrap.integration.test.ts'],
  'REC-003': ['server/test/receptionistInboundBootstrap.integration.test.ts'],
  'REC-004': ['server/test/receptionistSecurity.integration.test.ts'],
  'REC-005': ['server/test/receptionistSafety.integration.test.ts'],
  'REC-006': ['server/test/receptionistSafety.integration.test.ts'],
  'REC-007': ['server/test/receptionistSafety.integration.test.ts'],
  'REC-008': ['server/test/receptionistInboundBootstrap.integration.test.ts'],
  'REC-009': ['server/test/receptionistOutboundTargets.integration.test.ts'],
  'REC-010': ['server/test/receptionistLifecycle.integration.test.ts'],
  'REC-011': ['server/test/receptionistP0Reliability.unit.test.ts'],
  'REC-012': ['server/test/receptionistAgentProvider.unit.test.ts', 'server/test/receptionistConfiguration.integration.test.ts'],
  'REC-013': ['server/test/receptionistAgentProvider.unit.test.ts'],
  'REC-014': ['server/test/receptionistConfiguration.integration.test.ts'],
  'REC-015': ['server/test/receptionistConfiguration.integration.test.ts'],
  'REC-016': ['server/test/receptionistConfiguration.integration.test.ts'],
  'REC-017': ['server/test/receptionistConfiguration.integration.test.ts', 'server/test/receptionistOutboundTargets.integration.test.ts'],
  'FIN-001': ['server/test/insurancePolicyIntegrity.integration.test.ts'],
  'FIN-003': ['server/test/payments.integration.test.ts'],
  'FIN-004': ['server/test/moneyPathHardening.integration.test.ts'],
  'FIN-005': ['server/test/providerFailureHonesty.unit.test.ts'],
  'PLAT-001': ['server/test/platformDatabasePlane.integration.test.ts'],
  'PLAT-003': ['server/test/identityPlaneIsolation.integration.test.ts'],
  'RLS-001': ['server/test/rlsBehavioralCoverage.integration.test.ts'],
  'RLS-002': ['server/test/rlsBehavioralCoverage.integration.test.ts'],
  'RLS-003': ['server/test/rlsBehavioralCoverage.integration.test.ts'],
  'OPS-001': ['server/test/worker.integration.test.ts'],
  'OPS-002': ['tests/e2e/role-route-action-crawl.spec.ts'],
  'OPS-003': ['server/test/rlsBehavioralCoverage.integration.test.ts'],
};

const scenario = (
  scenarioId: string,
  profile: SyntheticProfile,
  tenant: string,
  actors: string[],
  preconditions: string[],
  inputEvent: string,
  expectedDatabaseState: string,
  expectedApiResult: string,
  expectedUiResult: string,
  expectedAuditEvents: string[],
  expectedAuthorization: string,
): SyntheticScenario => ({
  scenarioId,
  profile,
  tenant,
  actors,
  preconditions,
  inputEvent,
  expectedDatabaseState,
  expectedApiResult,
  expectedUiResult,
  expectedAuditEvents,
  expectedAuthorization,
  evidenceStatus: scenarioEvidence[scenarioId]?.length ? 'EXECUTABLE' : 'SPECIFICATION_ONLY',
  executableEvidence: scenarioEvidence[scenarioId] ?? [],
  resetStrategy: 'DROP_DISPOSABLE_DATABASE',
});

export const syntheticScenarioCatalog: readonly SyntheticScenario[] = [
  scenario('AUTH-001', 'FUNCTIONAL', 'functional-family', ['clinic-owner'], ['active tenant', 'active owner'], 'Password login and browser reload', 'One active refresh-token family', '200 login and refresh', 'Authenticated dashboard remains visible', ['auth.login.succeeded'], 'Only the matching tenant owner is admitted'),
  scenario('AUTH-002', 'EDGE', 'edge-suspended', ['suspended-owner'], ['suspended tenant'], 'Attempt password login', 'No active session created', '403 inactive tenant', 'Neutral access-denied message', ['auth.login.denied'], 'Suspended tenant actors are denied'),
  scenario('AUTH-003', 'EDGE', 'edge-archived', ['archived-owner'], ['archived tenant'], 'Attempt API and object access', 'No mutation', '401 or 403', 'Session is cleared', ['auth.access.denied'], 'Archived actors are denied'),
  scenario('PAT-001', 'FUNCTIONAL', 'functional-family', ['front-desk', 'new-adult'], ['active clinic'], 'Register new adult patient', 'One patient in selected branch', '201 patient', 'Patient profile opens', ['patient.created'], 'Front desk may create within its tenant'),
  scenario('PAT-002', 'EDGE', 'edge-multitenant', ['front-desk-a', 'matching-patient-a', 'matching-patient-b'], ['same email and phone across tenants'], 'Search and open by known foreign ID', 'No cross-tenant change', '404 or empty result', 'No foreign patient shown', ['patient.access.denied'], 'Tenant A cannot observe Tenant B'),
  scenario('PAT-003', 'EDGE', 'functional-family', ['front-desk', 'duplicate-name-1', 'duplicate-name-2'], ['same legal name', 'different DOB'], 'Run duplicate detection', 'Both identities retained', '200 with bounded candidates', 'Requires operator disambiguation', ['patient.duplicate.checked'], 'Authorized staff only'),
  scenario('PAT-004', 'FUNCTIONAL', 'functional-family', ['guardian-contact', 'minor-patient'], ['unique contact match', 'patient is minor or age is unknown'], 'Attempt self-signup for the minor record', 'Pending access request only; no portal account or token', '200 generic review response', 'No PHI is displayed; staff-review message remains generic', ['portal.signup.unmatched'], 'Automatic access is denied until a reviewed guardian/proxy authority model is implemented'),
  scenario('PAT-005', 'EDGE', 'functional-family', ['patient-restricted-consent'], ['consent restriction'], 'Request restricted communication', 'No outbound delivery', '409 suppressed', 'Restriction explanation displayed', ['communication.suppressed'], 'Consent policy overrides workflow role'),
  scenario('SCH-001', 'FUNCTIONAL', 'functional-family', ['front-desk', 'existing-patient', 'provider'], ['available provider slot'], 'Book new-patient appointment', 'One confirmed appointment', '201 appointment', 'Calendar shows persisted booking', ['appointment.created'], 'Front desk may book in assigned clinic'),
  scenario('SCH-002', 'FUNCTIONAL', 'functional-family', ['patient', 'provider'], ['portal self-service enabled'], 'Book through patient portal', 'One patient-owned appointment', '201 appointment', 'Confirmation shown after reload', ['appointment.created'], 'Patient may book only for self'),
  scenario('SCH-003', 'EDGE', 'functional-family', ['front-desk', 'provider'], ['occupied provider slot'], 'Attempt double booking', 'Original appointment unchanged', '409 already_booked', 'Conflict message and alternatives', ['appointment.conflict'], 'No bypass of provider conflict guard'),
  scenario('SCH-004', 'EDGE', 'functional-family', ['front-desk', 'provider'], ['provider time off'], 'Attempt unavailable booking', 'No appointment created', '409 unavailable', 'Unavailable state shown', ['appointment.unavailable'], 'No role may override without explicit workflow'),
  scenario('SCH-005', 'FUNCTIONAL', 'functional-family', ['front-desk', 'patient'], ['confirmed appointment'], 'Reschedule appointment', 'Same appointment receives new slot', '200 appointment', 'Calendar reflects new slot', ['appointment.rescheduled'], 'Clinic-scoped staff only'),
  scenario('SCH-006', 'FUNCTIONAL', 'functional-family', ['patient'], ['patient-owned future appointment'], 'Cancel in portal', 'Appointment becomes canceled', '200 canceled', 'Canceled badge shown', ['appointment.canceled'], 'Patient cannot cancel another patient appointment'),
  scenario('SCH-007', 'EDGE', 'edge-dst', ['front-desk', 'provider'], ['America/New_York DST boundary'], 'Book ambiguous/nonexistent local time', 'No invalid instant stored', '400 with timezone detail', 'Corrective time guidance', ['appointment.validation.failed'], 'Authorized actor remains subject to time validation'),
  scenario('REC-001', 'FUNCTIONAL', 'functional-family', ['verified-caller', 'receptionist-agent'], ['signed call', 'stored call mapping'], 'Existing caller verifies identity', 'Call-scoped identity evidence stored', '200 tool result', 'Verified flow continues', ['receptionist.identity.verified'], 'Protected actions require call-scoped proof'),
  scenario('REC-002', 'FUNCTIONAL', 'functional-family', ['new-caller', 'receptionist-agent'], ['signed inbound number mapping'], 'First inbound call starts', 'Idempotent call mapping created', '200 safe call bootstrap', 'Approved new-caller intake begins', ['receptionist.call.mapped'], 'Tenant derives only from trusted provider destination'),
  scenario('REC-003', 'EDGE', 'functional-family', ['unknown-caller'], ['valid signature', 'unknown destination'], 'First inbound call has no unique mapping', 'Configuration alert only; no patient mutation', '202 manual handling', 'Supervised fallback indicated', ['receptionist.mapping.unresolved'], 'No tenant guessing or autonomous action'),
  scenario('REC-004', 'EDGE', 'functional-family', ['caller'], ['invalid raw-body HMAC'], 'Send forged webhook', 'No call or patient record created', '401 invalid signature', 'No action', ['receptionist.signature.denied'], 'Unauthenticated ingress denied'),
  scenario('REC-005', 'EDGE', 'functional-family', ['dnc-patient'], ['active DNC'], 'Request outbound or continued call action', 'No autonomous contact', '409 suppressed', 'DNC confirmation and stop', ['receptionist.dnc.enforced'], 'DNC cannot be overridden by AI'),
  scenario('REC-006', 'EDGE', 'functional-family', ['caller'], ['emergency-language phrase'], 'Caller describes urgent emergency', 'Escalation record only', '200 escalation directive', 'Emergency disclaimer and transfer guidance', ['receptionist.emergency.escalated'], 'No clinical diagnosis or booking continuation'),
  scenario('REC-007', 'EDGE', 'functional-family', ['caller'], ['three failed verification attempts'], 'Retry identity proof', 'Call verification locked', '423 locked', 'Human fallback offered', ['receptionist.identity.locked'], 'Protected actions denied'),
  scenario('REC-008', 'EDGE', 'functional-family', ['receptionist-agent'], ['kill switch enabled'], 'Attempt inbound tool action', 'No protected mutation; durable review signal', '202 supervised fallback', 'Human fallback only', ['RECEPTIONIST_INGRESS_REVIEW'], 'Kill switch is authoritative'),
  scenario('REC-009', 'EDGE', 'functional-family', ['receptionist-agent'], ['concurrency limit reached'], 'Admit another call', 'No reservation added; durable review signal', '202 supervised fallback', 'Human fallback only', ['RECEPTIONIST_INGRESS_REVIEW'], 'Atomic capacity control enforced'),
  scenario('REC-010', 'EDGE', 'functional-family', ['provider-webhook'], ['previously processed event'], 'Replay duplicate/out-of-order webhook', 'Single canonical event state', '200 idempotent or 409 conflict', 'No duplicate activity', ['receptionist.webhook.deduplicated'], 'Signed webhook remains tenant-scoped'),
  scenario('REC-011', 'EDGE', 'functional-family', ['receptionist-agent'], ['provider simulator outage'], 'Start provider operation', 'No fabricated success', '503 provider unavailable', 'Retry/manual state', ['receptionist.provider.failed'], 'No local bypass'),
  scenario('REC-012', 'FUNCTIONAL', 'functional-family', ['receptionist-manager'], ['published Retell agent', 'production tag assigned', 'approved webhook and privacy controls'], 'Verify production agent deployment', 'Immutable provider version and safe readiness snapshot persisted', '200 verified agent', 'Verified badge and pinned version shown', ['RECEPTIONIST_AGENT_PROVIDER_VERIFIED'], 'Receptionist managers may verify only agents in their clinic and tenant'),
  scenario('REC-013', 'EDGE', 'functional-family', ['receptionist-manager'], ['Retell agent missing requested environment tag or required privacy control'], 'Verify unsafe provider deployment', 'Agent remains invalid or unverified; no runnable deployment created', '422 provider configuration rejected', 'Safe corrective checklist shown without provider secret or prompt', ['RECEPTIONIST_AGENT_PROVIDER_VERIFICATION_FAILED'], 'Provider response cannot bypass production readiness controls'),
  scenario('REC-014', 'EDGE', 'edge-multitenant', ['tenant-a-manager'], ['Tenant B clinic and agent identifiers known'], 'Bind foreign agent to campaign', 'No cross-tenant or cross-clinic relationship stored', '404 or database foreign-key denial', 'No foreign agent shown', ['security.cross_tenant.denied'], 'Tenant and clinic ownership are enforced by API and composite database constraints'),
  scenario('REC-015', 'EDGE', 'functional-family', ['receptionist-manager'], ['previously verified agent', 'provider timeout', 'verification freshness expires'], 'Retry provider verification then activate campaign', 'Last safe snapshot retained with failed probe evidence; stale deployment remains non-runnable', '503 verify failure then 409 activation blocked', 'Previous snapshot and safe failure state shown', ['RECEPTIONIST_AGENT_PROVIDER_VERIFICATION_FAILED'], 'A transient provider failure never silently authorizes a stale deployment'),
  scenario('REC-016', 'EDGE', 'functional-family', ['receptionist-manager'], ['verification in flight', 'agent relinked concurrently'], 'Complete stale provider verification response', 'Relinked configuration remains unchanged', '409 configuration changed', 'Operator is prompted to verify the current link', ['RECEPTIONIST_AGENT_UPDATED'], 'Optimistic revision prevents stale verification overwrite'),
  scenario('REC-017', 'FUNCTIONAL', 'functional-family', ['receptionist-manager'], ['fresh verified immutable agent', 'eligible outbound target'], 'Activate and launch outbound campaign', 'Campaign audit commits atomically and call binds the verified agent version', '201/200 with exact provider ID and numeric version override', 'Runnable campaign and truthful call state shown', ['RECEPTIONIST_CAMPAIGN_CREATED', 'RECEPTIONIST_OUTBOUND_CALL_STARTED'], 'Every activation and dial rechecks same-tenant, same-clinic, fresh verified readiness'),
  scenario('FIN-001', 'FUNCTIONAL', 'functional-family', ['billing-user', 'insured-patient'], ['active synthetic policy'], 'Run eligibility simulator', 'Verification and estimate persisted', '200 simulated eligibility', 'Clearly labeled simulator result', ['insurance.eligibility.checked'], 'Billing role within tenant only'),
  scenario('FIN-002', 'EDGE', 'functional-family', ['billing-user', 'uninsured-patient'], ['no policy'], 'Request eligibility', 'No fabricated policy', '422 insurance required', 'Self-pay option shown', ['insurance.eligibility.skipped'], 'No payer call without policy'),
  scenario('FIN-003', 'FUNCTIONAL', 'functional-family', ['patient', 'billing-user'], ['synthetic payment request'], 'Complete simulator payment', 'One successful transaction', '200 paid', 'Receipt state after reload', ['payment.succeeded'], 'Opaque public token is resource-bound'),
  scenario('FIN-004', 'EDGE', 'functional-family', ['provider-webhook'], ['successful callback already applied'], 'Replay payment callback', 'No duplicate transaction', '200 idempotent', 'Single receipt', ['payment.webhook.deduplicated'], 'Signature and provider reference required'),
  scenario('FIN-005', 'EDGE', 'functional-family', ['patient'], ['simulator failure configured'], 'Submit payment', 'Request remains unpaid/failed', '402 simulated failure', 'Truthful retry state', ['payment.failed'], 'No fabricated success'),
  scenario('INT-001', 'FUNCTIONAL', 'functional-family', ['tenant-admin'], ['integration disconnected'], 'Open integration status', 'Configuration unchanged', '200 unconfigured', 'Setup-required state', ['integration.status.viewed'], 'Secrets never returned'),
  scenario('INT-002', 'EDGE', 'functional-family', ['provider-simulator'], ['rate limit enabled'], 'Invoke integration', 'Retry metadata recorded', '429 rate limited', 'Recoverable retry state', ['integration.rate_limited'], 'No silent fallback'),
  scenario('INT-003', 'EDGE', 'functional-family', ['worker'], ['deterministic timeout'], 'Process integration job', 'Job retained for bounded retry', 'retry scheduled', 'Pending state', ['integration.timeout'], 'Worker reestablishes tenant context'),
  scenario('PLAT-001', 'PILOT', 'pilot-multispecialty', ['platform-admin'], ['app_platform session'], 'Create tenant and owner', 'Tenant, branch and owner persisted', '201 tenant', 'Tenant appears in platform list', ['platform.tenant.created'], 'Platform admin only; no PHI access'),
  scenario('PLAT-002', 'PILOT', 'pilot-multispecialty', ['platform-admin'], ['existing subscription'], 'Change plan and features', 'Entitlements recomputed', '200 subscription', 'Accurate feature state', ['platform.subscription.updated'], 'Platform billing permission required'),
  scenario('PLAT-003', 'PILOT', 'pilot-multispecialty', ['platform-admin'], ['active tenant'], 'Suspend then reactivate tenant', 'Lifecycle transitions persisted', '200 each transition', 'Status and analytics update', ['platform.tenant.suspended', 'platform.tenant.reactivated'], 'Tenant sessions denied while suspended'),
  scenario('PLAT-004', 'EDGE', 'pilot-multispecialty', ['platform-support'], ['time-bound support grant'], 'Impersonate selected tenant', 'Audited scoped support session', '200 tenant-scoped session', 'Impersonation banner', ['platform.support.started'], 'No platform-wide PHI connection'),
  scenario('PLAT-005', 'EDGE', 'pilot-multispecialty', ['expired-platform-support'], ['ended support grant'], 'Reuse ended impersonation', 'No mutation', '401 or 403', 'Access-denied state', ['platform.support.denied'], 'Ended grant cannot reenter tenant'),
  scenario('RLS-001', 'EDGE', 'edge-multitenant', ['tenant-a-user'], ['known Tenant B object IDs'], 'SELECT/list/aggregate/export Tenant B', 'Zero foreign rows', '404 or empty response', 'No foreign data', ['security.cross_tenant.denied'], 'Restricted role and RLS deny access'),
  scenario('RLS-002', 'EDGE', 'edge-multitenant', ['tenant-a-user'], ['Tenant B parent ID'], 'INSERT/update/reassign using foreign parent', 'No invalid relationship', 'database denial', 'Safe validation error', ['security.cross_tenant.denied'], 'Composite tenant relationship enforced'),
  scenario('RLS-003', 'EDGE', 'edge-multitenant', ['unscoped-runtime'], ['no tenant GUC'], 'Run model and raw query', 'No read or mutation', 'fail closed', 'No user-visible leakage', ['security.context.denied'], 'No-context runtime cannot access protected tables'),
  scenario('OPS-001', 'PILOT', 'pilot-multispecialty', ['worker'], ['signed tenant job envelope'], 'Retry completed job', 'Single idempotent result', 'completed/idempotent', 'No duplicate activity', ['worker.job.completed'], 'Worker context derives from verified envelope'),
  scenario('OPS-002', 'EDGE', 'pilot-multispecialty', ['browser-user'], ['network simulator failure'], 'API request fails', 'No fabricated database state', 'network error', 'Truthful retry UI', ['client.request.failed'], 'No authorization fallback'),
  scenario('OPS-003', 'PILOT', 'pilot-multispecialty', ['auditor'], ['months of synthetic audit data'], 'Search and paginate audit events', 'No mutation', '200 bounded page', 'Stable pagination', ['audit.search.performed'], 'Auditor reads only permitted tenant events'),
];

export function scenariosForProfile(profile: SyntheticProfile): readonly SyntheticScenario[] {
  return syntheticScenarioCatalog.filter(item => item.profile === profile);
}
