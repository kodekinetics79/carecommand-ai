import type { AgentReadinessReason } from './agentReadiness';
import type { RetellAgentProbeError, RetellAgentReadinessFailure } from '../retell';
import type { ClinicActivationBlocker } from './activationReadiness';

// ===========================================================================
// Remediation catalogue.
//
// Every failure the receptionist can report — a provider probe error, a
// readiness failure, a blocked activation — resolves to one entry here with a
// title, the action that fixes it, and where to go. The browser never writes
// this copy: if a code has no entry the unit test fails, so a new failure
// cannot ship as a bare code on a screen.
// ===========================================================================

export type RemediationScope = 'server' | 'provider' | 'agent' | 'campaign' | 'clinic' | 'scheduling';
export type RemediationSeverity = 'blocking' | 'warning';
// B7: these ids are the Studio's own tab ids (`src/pages/ReceptionistStudio.tsx`),
// plus `scheduling`, which is a different page entirely. 33 of the 54 entries
// used to route to `deploy` and `agent`, which have never been tabs, so the
// owner was sent to the wrong screen at the moment they were stuck. The union
// is narrowed to the real ids so a dead tab cannot compile again.
export type RemediationTab =
  | 'clinic'
  | 'knowledge'
  | 'campaign'
  | 'intake'
  | 'preview'
  | 'retell'
  | 'outbound'
  | 'activity'
  | 'scheduling'
  | null;

/** Every Studio tab id a `fixHref` may land on. Package E's `isTab()` must accept each one. */
export const REMEDIATION_STUDIO_TABS = ['clinic', 'knowledge', 'campaign', 'intake', 'preview', 'retell', 'outbound', 'activity'] as const;

export interface Remediation {
  code: string;
  title: string;
  action: string;
  scope: RemediationScope;
  severity: RemediationSeverity;
  fixTab: RemediationTab;
  retryable: boolean;
}

export type DeployFailureCode =
  | 'setup_required'
  | 'mock_forbidden_in_profile'
  | 'agent_unlinked_and_not_creatable'
  | 'agent_inactive'
  | 'engine_not_owned'
  | 'placeholders_present'
  | 'cooldown'
  | 'tenant_rate_limited'
  | 'concurrent_change'
  | 'deploy_budget_exhausted'
  | 'provider_unauthorized'
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'provider_invalid_request'
  | 'locale_pack_unavailable'
  | 'verification_failed';

/**
 * The published readiness contract. Package E's client union must equal this
 * set exactly (Package F's contract test asserts it), and every key here has a
 * CATALOGUE entry below, so no checklist row can ever render as a bare code.
 */
export type ReadinessKey =
  // Clinic prerequisites — contract §6 wanted these as readiness rows rather
  // than 409s thrown after readiness had already said "ready" (B6).
  | 'clinic_country_set'
  | 'clinic_hours_set'
  | 'locale_pack_approved'
  | 'agent_language_supported'
  // Agent, deployment and the line itself.
  | 'agent_linked'
  | 'agent_verified'
  | 'deployment_current'
  | 'number_bound'
  // Where a booking can land.
  | 'location_mapped'
  | 'services_bookable'
  | 'provider_availability'
  | 'provider_resolvable'
  | 'intake_attested'
  // What the caller hears.
  | 'placeholders_absent'
  | 'disclosure_composed'
  | 'confirmation_channels'
  | 'transfer_target_distinct'
  | 'test_call_completed'
  | 'data_storage_setting';

/** Every readiness key, in checklist order. Iterated by the contract tests. */
export const READINESS_KEYS: readonly ReadinessKey[] = [
  'clinic_country_set', 'clinic_hours_set', 'locale_pack_approved', 'agent_language_supported',
  'agent_linked', 'agent_verified', 'deployment_current', 'number_bound',
  'location_mapped', 'services_bookable', 'provider_availability', 'provider_resolvable', 'intake_attested',
  'placeholders_absent', 'disclosure_composed', 'confirmation_channels', 'transfer_target_distinct',
  'test_call_completed', 'data_storage_setting',
];

export type RemediationCode =
  | RetellAgentProbeError
  | RetellAgentReadinessFailure
  | AgentReadinessReason
  | DeployFailureCode
  | ReadinessKey
  | 'forbidden'
  | 'rate_limited'
  | 'request_failed'
  | 'agent_scope_mismatch'
  | 'location_scope_mismatch'
  | 'intake_schema_unattested'
  | 'intake_schema_mismatch'
  | 'intake_schema_not_strict'
  | 'active_intake_contract_immutable'
  | 'active_provider_deployment_conflict'
  | 'provider_response_engine_unavailable'
  | 'provider_response_engine_unsupported'
  | 'provider_intake_contract_unattested'
  | 'provider_intake_contract_not_strict'
  | 'provider_deployment_drift'
  | 'provider_deployment_ambiguous'
  | 'retell_api_key_missing'
  | 'retell_from_number_missing'
  | 'campaign_not_ready'
  | 'campaign_not_active'
  | 'campaign_active_pause_first'
  | 'campaign_transition_not_allowed'
  | 'campaign_referenced_by_outbound'
  | 'confirmation_channel_unconfigured'
  | 'tag_assignment_unavailable'
  // B6: `transitionCampaign` throws these five after readiness has passed. They
  // had no entry, so the first-run owner got "Something went wrong — report the
  // code" from the catalogue that exists to prevent exactly that.
  | ClinicActivationBlocker
  | 'number_binding_unattested';

const ASK_ADMIN = 'Ask your CareCommand administrator to set this on the API and worker environments, then reload.';

const CATALOGUE = {
  // ---- Server configuration ----------------------------------------------
  setup_required: { title: 'The voice provider is not configured', action: ASK_ADMIN, scope: 'server', severity: 'blocking', fixTab: null, retryable: false },
  retell_api_key_missing: { title: 'Retell API key is missing', action: `RETELL_API_KEY is not set. ${ASK_ADMIN}`, scope: 'server', severity: 'blocking', fixTab: null, retryable: false },
  retell_from_number_missing: { title: 'Retell caller number is missing', action: `RETELL_FROM_NUMBER is not set. ${ASK_ADMIN}`, scope: 'server', severity: 'blocking', fixTab: null, retryable: false },
  mock_forbidden_in_profile: { title: 'A mock voice provider cannot answer patient calls', action: 'This deployment runs the mock provider. Configure a real Retell API key, or run rehearsals under the demo profile.', scope: 'server', severity: 'blocking', fixTab: null, retryable: false },

  // ---- Provider transport -------------------------------------------------
  unauthorized: { title: 'Retell rejected the API key', action: 'The configured Retell API key is invalid or lacks access to this agent. Rotate the key in the API and worker environments, then verify again.', scope: 'provider', severity: 'blocking', fixTab: null, retryable: false },
  forbidden: { title: 'Retell refused this request', action: 'The Retell account does not permit this operation. Check the key’s workspace and permissions, then try again.', scope: 'provider', severity: 'blocking', fixTab: null, retryable: false },
  not_found: { title: 'The agent no longer exists at Retell', action: 'Deploy from Studio to publish a new agent, or link the correct Retell agent id.', scope: 'agent', severity: 'blocking', fixTab: 'retell', retryable: false },
  invalid_request: { title: 'Retell rejected the request as invalid', action: 'Review the agent voice, language and prompt for values Retell does not accept, then deploy again.', scope: 'agent', severity: 'blocking', fixTab: 'campaign', retryable: false },
  provider_invalid_request: { title: 'Retell rejected the deployment as invalid', action: 'Review the agent voice, language and prompt for values Retell does not accept, then deploy again.', scope: 'agent', severity: 'blocking', fixTab: 'campaign', retryable: false },
  provider_unavailable: { title: 'Retell did not respond', action: 'The provider is unreachable or timed out. Nothing was changed. Try again in a few minutes.', scope: 'provider', severity: 'blocking', fixTab: null, retryable: true },
  provider_unauthorized: { title: 'Retell rejected the API key during deployment', action: 'The configured Retell API key is invalid or lacks access. Rotate it in the API and worker environments, then deploy again.', scope: 'provider', severity: 'blocking', fixTab: null, retryable: false },
  provider_rate_limited: { title: 'Retell is rate limiting this account', action: 'Too many provider requests. Wait a minute and deploy again.', scope: 'provider', severity: 'blocking', fixTab: null, retryable: true },
  rate_limited: { title: 'Retell is rate limiting this account', action: 'Too many provider requests. Wait a minute and verify again.', scope: 'provider', severity: 'blocking', fixTab: null, retryable: true },
  request_failed: { title: 'The provider request could not be completed', action: 'Nothing was changed. Try again in a few minutes.', scope: 'provider', severity: 'blocking', fixTab: null, retryable: true },
  invalid_response: { title: 'Retell returned an unusable response', action: 'CareCommand could not read the provider’s answer, so nothing was accepted as verified. Try again; if it repeats, check the agent in the Retell console.', scope: 'provider', severity: 'blocking', fixTab: null, retryable: true },
  deploy_budget_exhausted: { title: 'The deployment ran out of time', action: 'The provider steps that completed were recorded. Deploy again to continue from where it stopped.', scope: 'provider', severity: 'blocking', fixTab: 'retell', retryable: true },

  // ---- Provider deployment shape -----------------------------------------
  tag_dynamic_variables_not_empty: { title: 'The deployed version carries default dynamic variables', action: 'Remove the default dynamic variables from this version’s tag in the Retell console. CareCommand supplies every variable per call, and provider defaults would silently override them.', scope: 'provider', severity: 'blocking', fixTab: null, retryable: false },
  tag_unassigned: { title: 'The deployment tag is not assigned', action: 'Assign the agent’s deployment tag to the published version in the Retell console, then verify again.', scope: 'provider', severity: 'blocking', fixTab: 'retell', retryable: false },
  tag_assignment_unavailable: { title: 'Retell cannot assign version tags through the API', action: 'CareCommand pins this deployment by version number instead. Assign the tag in the Retell console if you want it there for readability; nothing depends on it.', scope: 'provider', severity: 'warning', fixTab: null, retryable: false },
  version_mismatch: { title: 'Retell is running a different version', action: 'The published version no longer matches the one CareCommand deployed. Deploy again from Studio.', scope: 'provider', severity: 'blocking', fixTab: 'retell', retryable: false },
  unpublished: { title: 'The agent version is not published', action: 'Publish the agent version in Retell, or deploy again from Studio, then verify.', scope: 'provider', severity: 'blocking', fixTab: 'retell', retryable: false },
  webhook_mismatch: { title: 'The agent posts events to the wrong address', action: 'Set the agent webhook to this CareCommand instance, or deploy from Studio, which sets it for you.', scope: 'provider', severity: 'blocking', fixTab: 'retell', retryable: false },
  webhook_events_mismatch: { title: 'The agent does not send every required call event', action: 'Enable call_started, call_ended and call_analyzed on the agent, or deploy from Studio.', scope: 'provider', severity: 'blocking', fixTab: 'retell', retryable: false },
  storage_policy_mismatch: { title: 'The agent stores more than CareCommand permits', action: 'Set the agent’s data storage to basic attributes only. Recordings and transcripts must not be retained at the provider.', scope: 'provider', severity: 'blocking', fixTab: 'retell', retryable: false },
  signed_url_disabled: { title: 'The agent does not use signed URLs', action: 'Enable signed URLs on the agent, or deploy from Studio.', scope: 'provider', severity: 'blocking', fixTab: 'retell', retryable: false },
  prompt_drift: { title: 'The provider prompt differs from the deployed prompt', action: 'The prompt was edited outside CareCommand. Redeploy from Studio to publish the current prompt, or revert the change in Retell and verify again.', scope: 'provider', severity: 'blocking', fixTab: 'retell', retryable: false },
  tools_drift: { title: 'The provider tools differ from the deployed tools', action: 'The tool set was edited outside CareCommand. Redeploy from Studio, or revert the change in Retell and verify again.', scope: 'provider', severity: 'blocking', fixTab: 'retell', retryable: false },
  provider_deployment_drift: { title: 'The live deployment changed', action: 'Pause the active and runnable campaigns, then verify again to approve the new immutable version.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  provider_deployment_ambiguous: { title: 'More than one agent claims this deployment', action: 'Two agents point at the same Retell agent and version. Deactivate the one that should not answer calls.', scope: 'agent', severity: 'blocking', fixTab: 'campaign', retryable: false },
  provider_response_engine_unavailable: { title: 'Retell did not return the agent’s response engine', action: 'The prompt and tool evidence could not be read, so verification failed closed. Try again shortly.', scope: 'provider', severity: 'blocking', fixTab: null, retryable: true },
  provider_response_engine_unsupported: { title: 'This response engine is not supported', action: 'CareCommand attests Retell LLM and Conversation Flow agents. Deploy from Studio to publish a supported engine.', scope: 'provider', severity: 'blocking', fixTab: 'retell', retryable: false },
  provider_intake_contract_unattested: { title: 'The booking tool could not be attested', action: 'CareCommand could not read exactly one book_appointment tool from the published version. Deploy from Studio.', scope: 'provider', severity: 'blocking', fixTab: 'retell', retryable: false },
  provider_intake_contract_not_strict: { title: 'Strict tool calling is off', action: 'Enable tool_call_strict_mode on the response engine, or deploy from Studio, which sets it.', scope: 'provider', severity: 'blocking', fixTab: 'retell', retryable: false },

  // ---- Agent state --------------------------------------------------------
  agent_linked: { title: 'No agent is linked to this campaign', action: 'Create an agent for this clinic and assign it to the campaign.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  agent_unlinked: { title: 'The agent is not linked to Retell', action: 'Deploy the campaign to Retell, or link an existing Retell agent id.', scope: 'agent', severity: 'blocking', fixTab: 'retell', retryable: false },
  agent_unlinked_and_not_creatable: { title: 'This campaign has no agent to deploy', action: 'Create an agent for this clinic and assign it to the campaign, then deploy.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  agent_verified: { title: 'The agent is not verified', action: 'Verify the agent against Retell. CareCommand will not place or answer calls on unverified configuration.', scope: 'agent', severity: 'blocking', fixTab: 'retell', retryable: true },
  agent_unverified: { title: 'The agent is not verified', action: 'Verify the agent against Retell. CareCommand will not place or answer calls on unverified configuration.', scope: 'agent', severity: 'blocking', fixTab: 'retell', retryable: true },
  agent_inactive: { title: 'The agent is deactivated', action: 'Reactivate the agent, or assign an active agent to this campaign.', scope: 'agent', severity: 'blocking', fixTab: 'campaign', retryable: false },
  agent_configuration_changed: { title: 'The agent changed since it was verified', action: 'Verify the agent again so the change is attested before it answers a call.', scope: 'agent', severity: 'blocking', fixTab: 'retell', retryable: true },
  agent_verification_stale: { title: 'The agent’s verification has expired', action: 'Verify the agent again. Verification is valid for 24 hours and normally renews itself hourly.', scope: 'agent', severity: 'blocking', fixTab: 'retell', retryable: true },
  agent_scope_mismatch: { title: 'That agent belongs to another clinic', action: 'Choose an agent that belongs to this campaign’s clinic.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  engine_not_owned: { title: 'This agent was built outside CareCommand', action: 'Deploying would overwrite an agent CareCommand did not create. Unlink it first, then deploy to publish a fresh agent.', scope: 'agent', severity: 'blocking', fixTab: 'campaign', retryable: false },
  concurrent_change: { title: 'The agent changed while this was running', action: 'Somebody edited the agent during the provider call. Nothing was applied. Reload and try again.', scope: 'agent', severity: 'blocking', fixTab: 'retell', retryable: true },
  cooldown: { title: 'Too soon after the last attempt', action: 'Wait for the countdown, then try again. This protects the provider account from repeated identical calls.', scope: 'agent', severity: 'blocking', fixTab: null, retryable: true },
  tenant_rate_limited: { title: 'Too many deployments this hour', action: 'This tenant reached its hourly deployment limit. Wait, then deploy again.', scope: 'server', severity: 'blocking', fixTab: null, retryable: true },
  locale_pack_unavailable: { title: 'No locale pack covers this clinic', action: 'Nothing the caller would hear can be rendered without an approved locale pack for the clinic’s country and language. Set the clinic country and approve a pack, then try again.', scope: 'clinic', severity: 'blocking', fixTab: 'clinic', retryable: false },
  verification_failed: { title: 'The deployment published but did not verify', action: 'The new version is live at Retell but CareCommand could not attest it. Open the agent to see the exact reason and verify again.', scope: 'agent', severity: 'blocking', fixTab: 'retell', retryable: true },

  // ---- Clinic prerequisites (B6) ------------------------------------------
  // Both spellings are catalogued: the readiness row key (…_set / …_approved /
  // …_supported) and the blocker code `transitionCampaign` throws.
  clinic_country_set: { title: 'The clinic has no country', action: 'Set the clinic’s country on the Clinic Profile tab. It selects the locale pack, the emergency number and the date and time the agent speaks.', scope: 'clinic', severity: 'blocking', fixTab: 'clinic', retryable: false },
  clinic_country_missing: { title: 'The clinic has no country', action: 'Set the clinic’s country on the Clinic Profile tab. It selects the locale pack, the emergency number and the date and time the agent speaks.', scope: 'clinic', severity: 'blocking', fixTab: 'clinic', retryable: false },
  clinic_hours_set: { title: 'The clinic has no opening hours', action: 'Set opening hours on the Clinic Profile tab. Without them the agent cannot say whether you are open, and every after-hours answer would be invented.', scope: 'clinic', severity: 'blocking', fixTab: 'clinic', retryable: false },
  clinic_hours_missing: { title: 'The clinic has no opening hours', action: 'Set opening hours on the Clinic Profile tab. Without them the agent cannot say whether you are open, and every after-hours answer would be invented.', scope: 'clinic', severity: 'blocking', fixTab: 'clinic', retryable: false },
  locale_pack_approved: { title: 'No approved locale pack covers this clinic', action: 'Approve a locale pack for the clinic’s country and the agent’s language on the Clinic Profile tab. Every caller-facing sentence is rendered from the pack, so nothing can be spoken without one.', scope: 'clinic', severity: 'blocking', fixTab: 'clinic', retryable: false },
  locale_pack_unapproved: { title: 'No approved locale pack covers this clinic', action: 'Approve a locale pack for the clinic’s country and the agent’s language on the Clinic Profile tab. Every caller-facing sentence is rendered from the pack, so nothing can be spoken without one.', scope: 'clinic', severity: 'blocking', fixTab: 'clinic', retryable: false },
  agent_language_supported: { title: 'The agent speaks an unsupported language', action: 'Choose a language CareCommand supports on the Agent & Campaign tab, or change the clinic’s default language.', scope: 'agent', severity: 'blocking', fixTab: 'campaign', retryable: false },
  agent_language_unsupported: { title: 'The agent speaks an unsupported language', action: 'Choose a language CareCommand supports on the Agent & Campaign tab, or change the clinic’s default language.', scope: 'agent', severity: 'blocking', fixTab: 'campaign', retryable: false },
  transfer_loops_to_agent: { title: 'The transfer number loops back to the AI line', action: 'Set a human fallback number that differs from the clinic’s AI line, or a transfer would return the caller to the agent.', scope: 'clinic', severity: 'blocking', fixTab: 'clinic', retryable: false },

  // ---- Readiness ----------------------------------------------------------
  deployment_current: { title: 'The deployed prompt is out of date', action: 'The campaign has changed since it was deployed. Deploy the changes so callers hear the current configuration.', scope: 'campaign', severity: 'blocking', fixTab: 'retell', retryable: false },
  number_bound: { title: 'The phone number does not point at this agent', action: 'Deploy the campaign; deployment binds the Retell number’s inbound agent to the published version.', scope: 'campaign', severity: 'blocking', fixTab: 'retell', retryable: false },
  number_binding_unattested: { title: 'Nothing proves the number answers with this agent', action: 'This agent was linked by hand, so CareCommand has never bound the number and cannot read back what the line points at. Deploy from Studio, which binds the number and records the evidence.', scope: 'campaign', severity: 'blocking', fixTab: 'retell', retryable: false },
  location_mapped: { title: 'No location is mapped to a scheduling branch', action: 'Map at least one active clinic location to a branch so bookings land on a real schedule.', scope: 'clinic', severity: 'blocking', fixTab: 'clinic', retryable: false },
  location_scope_mismatch: { title: 'A selected location is not usable', action: 'Every eligible location must be active, belong to this clinic, and be mapped to a branch.', scope: 'campaign', severity: 'blocking', fixTab: 'clinic', retryable: false },
  services_bookable: { title: 'No bookable service matches this campaign', action: 'Add the campaign’s appointment type to the service catalogue and mark it bookable by voice.', scope: 'clinic', severity: 'blocking', fixTab: 'clinic', retryable: false },
  provider_availability: { title: 'No provider has availability at a mapped branch', action: 'Set working hours for at least one provider at a mapped branch, otherwise the agent can never offer a time.', scope: 'scheduling', severity: 'blocking', fixTab: 'scheduling', retryable: false },
  provider_resolvable: { title: 'The agent cannot choose which provider to book', action: 'A mapped branch has more than one active provider and the voice agent has no rule for picking between them, so it takes a message instead of booking. Leave one active provider at the branch, or map the campaign to a branch that has one.', scope: 'scheduling', severity: 'blocking', fixTab: 'scheduling', retryable: false },
  intake_attested: { title: 'The intake schema is not attested', action: 'Verify the agent so the booking tool it publishes matches the intake fields configured here.', scope: 'campaign', severity: 'blocking', fixTab: 'intake', retryable: true },
  intake_schema_unattested: { title: 'The intake schema is not attested', action: 'Verify the agent so the booking tool it publishes matches the intake fields configured here.', scope: 'campaign', severity: 'blocking', fixTab: 'intake', retryable: true },
  intake_schema_mismatch: { title: 'The intake fields changed after attestation', action: 'The published booking tool no longer matches these intake fields. Deploy the campaign again, then activate.', scope: 'campaign', severity: 'blocking', fixTab: 'intake', retryable: false },
  intake_schema_not_strict: { title: 'The booking tool is not strict', action: 'Strict tool calling is required before a booking tool may run. Deploy from Studio, which sets it.', scope: 'campaign', severity: 'blocking', fixTab: 'retell', retryable: false },
  active_intake_contract_immutable: { title: 'An active campaign’s contract cannot be edited', action: 'Pause the campaign before changing its agent, appointment type or locations.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  active_provider_deployment_conflict: { title: 'Another active campaign already owns this deployment', action: 'One provider deployment answers for one active campaign. Pause the other campaign first.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  placeholders_absent: { title: 'Placeholder text is still in the configuration', action: 'Replace the pre-filled example values listed below before this agent speaks to a patient.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  placeholders_present: { title: 'Placeholder text is still in the configuration', action: 'Replace the pre-filled example values before deploying. A patient must never hear "New offer".', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  disclosure_composed: { title: 'The clinic adds no disclosure wording', action: 'The product’s baseline AI and recording disclosure is used on its own. Add clinic-specific wording if your jurisdiction requires it.', scope: 'clinic', severity: 'warning', fixTab: 'clinic', retryable: false },
  confirmation_channels: { title: 'A confirmation channel is enabled but not configured', action: 'Configure the messaging provider, or turn the confirmation off. The agent must not promise a text it cannot send.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  confirmation_channel_unconfigured: { title: 'That confirmation channel is not configured', action: 'Configure the messaging provider before enabling this confirmation, so the agent never promises a message it cannot send.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  transfer_target_distinct: { title: 'The transfer number loops back to the AI line', action: 'Set a human fallback number that differs from the clinic’s AI line, or a transfer would return the caller to the agent.', scope: 'clinic', severity: 'blocking', fixTab: 'clinic', retryable: false },
  test_call_completed: { title: 'No test call has reached this line', action: 'Call the receptionist number from a staff phone once. The call appears in Activity and this check clears.', scope: 'campaign', severity: 'blocking', fixTab: 'retell', retryable: true },
  data_storage_setting: { title: 'Provider storage is fixed to metadata only', action: 'Transcript retention has no tenant policy yet, so the provider stores basic attributes only. This is read-only for the pilot.', scope: 'server', severity: 'warning', fixTab: null, retryable: false },

  // ---- Transitions --------------------------------------------------------
  campaign_not_ready: { title: 'The campaign is not ready to activate', action: 'Clear the listed checks, then activate.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  campaign_not_active: { title: 'The campaign is not active', action: 'Only an active campaign can be paused.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  campaign_transition_not_allowed: { title: 'That status change is not allowed', action: 'A campaign moves draft or paused to active, active to paused, and draft or paused to archived. An archived campaign is final.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  campaign_active_pause_first: { title: 'Pause the campaign before archiving it', action: 'An active campaign is answering calls. Pause it first, then archive.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  campaign_referenced_by_outbound: { title: 'A runnable outbound campaign still uses this campaign', action: 'Pause or complete the outbound campaigns listed before archiving this one.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
} satisfies Record<RemediationCode, Omit<Remediation, 'code'>>;

export const REMEDIATION_CODES = Object.keys(CATALOGUE) as RemediationCode[];

export interface RemediationContext {
  clinicId?: string | null;
  campaignId?: string | null;
  agentId?: string | null;
}

function fixHref(entry: Omit<Remediation, 'code'>, ctx: RemediationContext): string | null {
  if (!entry.fixTab) return null;
  if (entry.fixTab === 'scheduling') return '/scheduling';
  const params = new URLSearchParams();
  if (ctx.clinicId) params.set('clinic', ctx.clinicId);
  if (ctx.campaignId) params.set('campaign', ctx.campaignId);
  if (ctx.agentId) params.set('agent', ctx.agentId);
  params.set('tab', entry.fixTab);
  return `/receptionist-studio?${params.toString()}`;
}

const UNKNOWN: Omit<Remediation, 'code'> = {
  title: 'Something went wrong',
  action: 'CareCommand could not classify this failure. Retry, and report the code shown if it repeats.',
  scope: 'server',
  severity: 'blocking',
  fixTab: null,
  retryable: true,
};

export function remediationFor(code: string, ctx: RemediationContext = {}): Remediation & { fixHref: string | null } {
  const entry = (CATALOGUE as Record<string, Omit<Remediation, 'code'> | undefined>)[code] ?? UNKNOWN;
  return { code, ...entry, fixHref: fixHref(entry, ctx) };
}

export function isKnownRemediationCode(code: string): code is RemediationCode {
  return Object.hasOwn(CATALOGUE, code);
}
