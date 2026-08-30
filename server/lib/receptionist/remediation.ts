import type { AgentReadinessReason } from './agentReadiness';
import type { RetellAgentProbeError, RetellAgentReadinessFailure } from '../retell';
import type { ClinicActivationBlocker } from './activationReadiness';
// The one vocabulary, shared with the browser. Importing across the boundary
// rather than restating the words here is the whole point: these sentences are
// authored on the server but READ in the tenant's browser, and two copies of
// "the voice service" would drift the first time either was edited.
import { CONFIGURATION_REFERENCE, SUPPORT_ATTENTION, VOICE } from '../../../src/lib/receptionistVocabulary';

// ===========================================================================
// Remediation catalogue.
//
// Every failure the receptionist can report — a provider probe error, a
// readiness failure, a blocked activation — resolves to one entry here with a
// title, the action that fixes it, and where to go. The browser never writes
// this copy: if a code has no entry the unit test fails, so a new failure
// cannot ship as a bare code on a screen.
//
// TWO AUDIENCES, ONE FAULT.
//
// This catalogue used to have one voice, and it was the wrong one. It told a
// clinic owner to "remove the default dynamic variables from this version's
// tag in the Retell console" — a true sentence, naming our supplier, giving an
// instruction the reader cannot carry out and is not entitled to. So each
// entry now answers twice:
//
//   `action`         what the TENANT reads. Vendor-free, and — this is the
//                    part that matters — still exact. Most of these faults are
//                    fixed by publishing to the line, so most of them now say
//                    so, which is more actionable than the console sentence
//                    ever was.
//   `platformAction` what PLATFORM ADMIN reads: the precise, vendor-named
//                    instruction, unchanged. Present only on entries the
//                    tenant genuinely cannot resolve. Never serialised on a
//                    tenant route — `remediationFor()` drops it, and
//                    `platformRemediationFor()` is the only way to read it.
//
// When `platformAction` is set the tenant's `action` is the support hand-off
// from `receptionistVocabulary.ts`: the line needs CareCommand, here is the
// reference to quote. That is a smaller instruction, not a vaguer one — it
// names the one act the reader can actually perform.
// ===========================================================================

export type RemediationScope = 'server' | 'provider' | 'agent' | 'campaign' | 'clinic' | 'scheduling';
export type RemediationSeverity = 'blocking' | 'warning';
// B7: these ids are the Studio's own tab ids (`src/pages/ReceptionistStudio.tsx`),
// plus `scheduling`, which is a different page entirely. 33 of the 54 entries
// used to route to `deploy` and `agent`, which have never been tabs, so the
// owner was sent to the wrong screen at the moment they were stuck. The union
// is narrowed to the real ids so a dead tab cannot compile again.
//
// `retell` is gone from the union as well as from the copy. A fix link is a
// URL the tenant's browser shows and the tenant may paste into a support
// email — `/receptionist-studio?tab=retell` named the supplier in the address
// bar of the screen that exists to fix the line. The tab is `deploy` ("Go
// live"), which is what the page has called it since B7; the client keeps
// `retell` as an inbound alias so links printed before this change still land.
export type RemediationTab =
  | 'clinic'
  | 'knowledge'
  | 'campaign'
  | 'intake'
  | 'preview'
  | 'deploy'
  | 'outbound'
  | 'activity'
  | 'scheduling'
  | null;

/** Every Studio tab id a `fixHref` may land on. Package E's `isTab()` must accept each one. */
export const REMEDIATION_STUDIO_TABS = ['clinic', 'knowledge', 'campaign', 'intake', 'preview', 'deploy', 'outbound', 'activity'] as const;

export interface Remediation {
  code: string;
  title: string;
  action: string;
  scope: RemediationScope;
  severity: RemediationSeverity;
  fixTab: RemediationTab;
  retryable: boolean;
}

/**
 * The catalogue entry as authored. `platformAction` is the vendor-named
 * instruction and is stripped before anything tenant-facing is built, so the
 * type system cannot accidentally hand it to `remediationFor()`'s callers.
 */
type CatalogueEntry = Omit<Remediation, 'code'> & { platformAction?: string };

/** What Platform Admin reads: everything, including the supplier instruction. */
export interface PlatformRemediation extends Remediation {
  platformAction: string | null;
  /** True when the tenant copy is the support hand-off rather than a fix they can perform. */
  supportRouted: boolean;
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
  // Renamed from `retell_api_key_missing` / `retell_from_number_missing`.
  // The code is not internal: `/voice-line-status` serialises it into
  // `blockers[].code` and the browser prints it beside the title, so the
  // supplier's name was reaching the screen through the identifier as well as
  // through the copy.
  | 'voice_service_key_missing'
  | 'voice_service_number_missing'
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
  | 'number_binding_unattested'
  | 'number_bound_elsewhere';

const ASK_ADMIN = 'Ask your CareCommand administrator to set this on the API and worker environments, then reload.';

/** The tenant half of a support-routed entry. See `receptionistVocabulary.ts`. */
const SUPPORT = SUPPORT_ATTENTION;

const CATALOGUE = {
  // ---- Server configuration ----------------------------------------------
  // These three are CareCommand's own configuration, not the clinic's. The
  // clinic could never act on them; naming the missing environment variable
  // only told it which supplier we buy from.
  setup_required: { title: `${VOICE.Service} is not connected`, action: ASK_ADMIN, scope: 'server', severity: 'blocking', fixTab: null, retryable: false },
  voice_service_key_missing: {
    title: `${VOICE.Service} has no credential`, action: ASK_ADMIN,
    platformAction: `RETELL_API_KEY is not set. ${ASK_ADMIN}`,
    scope: 'server', severity: 'blocking', fixTab: null, retryable: false,
  },
  voice_service_number_missing: {
    title: `${VOICE.Service} has no outbound caller number`, action: ASK_ADMIN,
    platformAction: `RETELL_FROM_NUMBER is not set. ${ASK_ADMIN}`,
    scope: 'server', severity: 'blocking', fixTab: null, retryable: false,
  },
  mock_forbidden_in_profile: {
    title: 'A simulated voice line cannot answer patient calls',
    action: 'This environment is running a simulated line. Ask your CareCommand administrator to connect the live service, or run rehearsals under the demo profile.',
    platformAction: 'This deployment runs the mock provider. Configure a real Retell API key, or run rehearsals under the demo profile.',
    scope: 'server', severity: 'blocking', fixTab: null, retryable: false,
  },

  // ---- Provider transport -------------------------------------------------
  // Credential faults are ours to rotate. The tenant is told the line is down
  // and who fixes it; which key, in which environment, is a platform fact.
  unauthorized: {
    title: `${VOICE.Service} rejected CareCommand’s credential`, action: ASK_ADMIN,
    platformAction: 'The configured Retell API key is invalid or lacks access to this agent. Rotate the key in the API and worker environments, then verify again.',
    scope: 'provider', severity: 'blocking', fixTab: null, retryable: false,
  },
  forbidden: {
    title: `${VOICE.Service} refused this request`, action: ASK_ADMIN,
    platformAction: 'The Retell account does not permit this operation. Check the key’s workspace and permissions, then try again.',
    scope: 'provider', severity: 'blocking', fixTab: null, retryable: false,
  },
  not_found: {
    title: `${VOICE.Receptionist} is no longer present on ${VOICE.service}`,
    action: `${VOICE.publish} from the Go live tab to republish this configuration.`,
    scope: 'agent', severity: 'blocking', fixTab: 'deploy', retryable: false,
  },
  invalid_request: {
    title: `${VOICE.Service} rejected this configuration`,
    action: `Review the voice, language and prompt for values ${VOICE.service} does not accept, then ${VOICE.publishLower} again.`,
    scope: 'agent', severity: 'blocking', fixTab: 'campaign', retryable: false,
  },
  provider_invalid_request: {
    title: `${VOICE.Service} rejected this configuration`,
    action: `Review the voice, language and prompt for values ${VOICE.service} does not accept, then ${VOICE.publishLower} again.`,
    scope: 'agent', severity: 'blocking', fixTab: 'campaign', retryable: false,
  },
  provider_unavailable: { title: `${VOICE.Service} did not respond`, action: `${VOICE.Service} is unreachable or timed out. Nothing was changed. Try again in a few minutes.`, scope: 'provider', severity: 'blocking', fixTab: null, retryable: true },
  provider_unauthorized: {
    title: `${VOICE.Service} rejected CareCommand’s credential while publishing`, action: ASK_ADMIN,
    platformAction: 'The configured Retell API key is invalid or lacks access. Rotate it in the API and worker environments, then deploy again.',
    scope: 'provider', severity: 'blocking', fixTab: null, retryable: false,
  },
  provider_rate_limited: { title: `${VOICE.Service} is rate limiting this account`, action: `Too many requests to ${VOICE.service}. Wait a minute and ${VOICE.publishLower} again.`, scope: 'provider', severity: 'blocking', fixTab: null, retryable: true },
  rate_limited: { title: `${VOICE.Service} is rate limiting this account`, action: `Too many requests to ${VOICE.service}. Wait a minute and run the ${VOICE.checkLower} again.`, scope: 'provider', severity: 'blocking', fixTab: null, retryable: true },
  request_failed: { title: `The request to ${VOICE.service} could not be completed`, action: 'Nothing was changed. Try again in a few minutes.', scope: 'provider', severity: 'blocking', fixTab: null, retryable: true },
  invalid_response: {
    title: `${VOICE.Service} returned an unusable answer`,
    action: `CareCommand could not read the answer, so nothing was accepted as ${VOICE.checked}. Try again; if it repeats, ${SUPPORT}`,
    platformAction: 'CareCommand could not read the provider’s answer, so nothing was accepted as verified. Try again; if it repeats, check the agent in the Retell console.',
    scope: 'provider', severity: 'blocking', fixTab: null, retryable: true,
  },
  deploy_budget_exhausted: { title: 'Publishing ran out of time', action: `The steps that completed were recorded. ${VOICE.publish} again to continue from where it stopped.`, scope: 'provider', severity: 'blocking', fixTab: 'deploy', retryable: true },

  // ---- Provider deployment shape -----------------------------------------
  // Nearly all of these are repaired by publishing again — CareCommand sets
  // the webhook, the events, the storage policy, the strict-tool flag and the
  // signed URLs on every publish. The old copy buried that behind a supplier
  // console instruction, so the one action the tenant COULD take was the
  // clause after the comma. It is now the whole sentence.
  //
  // The two tag entries are the genuine exception: a version tag is set in the
  // supplier's console and publishing does not clear it. Those are the
  // support-routed ones.
  tag_dynamic_variables_not_empty: {
    title: `${VOICE.Receptionist} may be given values CareCommand did not send`,
    action: SUPPORT,
    platformAction: 'Remove the default dynamic variables from this version’s tag in the Retell console. CareCommand supplies every variable per call, and provider defaults would silently override them.',
    scope: 'provider', severity: 'blocking', fixTab: null, retryable: false,
  },
  tag_unassigned: {
    title: `The published ${VOICE.configuration} is not tagged`,
    action: SUPPORT,
    platformAction: 'Assign the agent’s deployment tag to the published version in the Retell console, then verify again.',
    scope: 'provider', severity: 'blocking', fixTab: null, retryable: false,
  },
  tag_assignment_unavailable: {
    title: 'This line is pinned by version rather than by tag',
    action: 'No action is needed. CareCommand pins the exact version that answers calls; nothing depends on the tag.',
    platformAction: 'Retell cannot assign version tags through the API. CareCommand pins this deployment by version number instead. Assign the tag in the Retell console if you want it there for readability; nothing depends on it.',
    scope: 'provider', severity: 'warning', fixTab: null, retryable: false,
  },
  version_mismatch: { title: 'The line is running a different version', action: `What answers calls no longer matches what CareCommand published. ${VOICE.publish} again from the Go live tab.`, scope: 'provider', severity: 'blocking', fixTab: 'deploy', retryable: false },
  unpublished: { title: `This ${VOICE.configuration} is not live`, action: `${VOICE.publish} from the Go live tab, then run the ${VOICE.checkLower}.`, scope: 'provider', severity: 'blocking', fixTab: 'deploy', retryable: false },
  webhook_mismatch: {
    title: 'The line reports call events to the wrong address',
    action: `${VOICE.publish} from the Go live tab. Publishing points the line back at this CareCommand instance.`,
    platformAction: 'Set the agent webhook to this CareCommand instance, or deploy from Studio, which sets it for you.',
    scope: 'provider', severity: 'blocking', fixTab: 'deploy', retryable: false,
  },
  webhook_events_mismatch: {
    title: 'The line does not report every call event',
    action: `Calls would be missing from Activity. ${VOICE.publish} from the Go live tab; publishing enables every required event.`,
    platformAction: 'Enable call_started, call_ended and call_analyzed on the agent, or deploy from Studio.',
    scope: 'provider', severity: 'blocking', fixTab: 'deploy', retryable: false,
  },
  storage_policy_mismatch: {
    title: `${VOICE.Service} is retaining more than CareCommand permits`,
    action: `Recordings and transcripts must not be retained outside CareCommand. ${VOICE.publish} from the Go live tab; publishing restores the metadata-only policy.`,
    platformAction: 'Set the agent’s data storage to basic attributes only. Recordings and transcripts must not be retained at the provider.',
    scope: 'provider', severity: 'blocking', fixTab: 'deploy', retryable: false,
  },
  signed_url_disabled: {
    title: 'The line does not use signed callbacks',
    action: `${VOICE.publish} from the Go live tab; publishing enables signed callbacks.`,
    platformAction: 'Enable signed URLs on the agent, or deploy from Studio.',
    scope: 'provider', severity: 'blocking', fixTab: 'deploy', retryable: false,
  },
  prompt_drift: {
    title: 'The live prompt differs from the published prompt',
    action: `The prompt was edited outside CareCommand. ${VOICE.publish} again to restore the prompt shown here.`,
    platformAction: 'The prompt was edited outside CareCommand. Redeploy from Studio to publish the current prompt, or revert the change in Retell and verify again.',
    scope: 'provider', severity: 'blocking', fixTab: 'deploy', retryable: false,
  },
  tools_drift: {
    title: 'The live tools differ from the published tools',
    action: `The tool set was edited outside CareCommand. ${VOICE.publish} again to restore it.`,
    platformAction: 'The tool set was edited outside CareCommand. Redeploy from Studio, or revert the change in Retell and verify again.',
    scope: 'provider', severity: 'blocking', fixTab: 'deploy', retryable: false,
  },
  provider_deployment_drift: { title: 'The live deployment changed', action: `Pause the active and runnable campaigns, then run the ${VOICE.checkLower} again to approve the new immutable version.`, scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  provider_deployment_ambiguous: { title: `More than one campaign claims this ${VOICE.configuration}`, action: 'Two campaigns publish the same configuration to the same line. Deactivate the one that should not answer calls.', scope: 'agent', severity: 'blocking', fixTab: 'campaign', retryable: false },
  provider_response_engine_unavailable: { title: `${VOICE.Service} did not return what the line is running`, action: `The prompt and tool evidence could not be read, so the ${VOICE.checkLower} failed closed. Try again shortly.`, scope: 'provider', severity: 'blocking', fixTab: null, retryable: true },
  provider_response_engine_unsupported: {
    title: 'This line was not built by CareCommand',
    action: `CareCommand cannot attest a configuration it did not publish. ${VOICE.publish} from the Go live tab to replace it with one it can.`,
    platformAction: 'CareCommand attests Retell LLM and Conversation Flow agents. Deploy from Studio to publish a supported engine.',
    scope: 'provider', severity: 'blocking', fixTab: 'deploy', retryable: false,
  },
  provider_intake_contract_unattested: {
    title: 'The booking step could not be attested',
    action: `CareCommand could not read exactly one booking step from the live line. ${VOICE.publish} from the Go live tab.`,
    platformAction: 'CareCommand could not read exactly one book_appointment tool from the published version. Deploy from Studio.',
    scope: 'provider', severity: 'blocking', fixTab: 'deploy', retryable: false,
  },
  provider_intake_contract_not_strict: {
    title: 'The booking step accepts fields it was not given',
    action: `A booking step must accept exactly the intake fields configured here. ${VOICE.publish} from the Go live tab; publishing sets it.`,
    platformAction: 'Enable tool_call_strict_mode on the response engine, or deploy from Studio, which sets it.',
    scope: 'provider', severity: 'blocking', fixTab: 'deploy', retryable: false,
  },

  // ---- Agent state --------------------------------------------------------
  agent_linked: { title: 'No agent is linked to this campaign', action: 'Create an agent for this clinic and assign it to the campaign.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  agent_unlinked: {
    title: `Nothing is published to the ${VOICE.line} yet`,
    action: `${VOICE.publish} from the Go live tab. Until then the number rings nothing CareCommand controls.`,
    platformAction: 'Deploy the campaign to Retell, or link an existing Retell agent id.',
    scope: 'agent', severity: 'blocking', fixTab: 'deploy', retryable: false,
  },
  agent_unlinked_and_not_creatable: { title: 'This campaign has no agent to deploy', action: 'Create an agent for this clinic and assign it to the campaign, then deploy.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  agent_verified: { title: `The ${VOICE.line} has not passed a ${VOICE.checkLower}`, action: `${VOICE.runCheck}. CareCommand will not place or answer calls on a configuration it has not read back from the live line.`, scope: 'agent', severity: 'blocking', fixTab: 'deploy', retryable: true },
  agent_unverified: { title: `The ${VOICE.line} has not passed a ${VOICE.checkLower}`, action: `${VOICE.runCheck}. CareCommand will not place or answer calls on a configuration it has not read back from the live line.`, scope: 'agent', severity: 'blocking', fixTab: 'deploy', retryable: true },
  agent_inactive: { title: 'The agent is deactivated', action: 'Reactivate the agent, or assign an active agent to this campaign.', scope: 'agent', severity: 'blocking', fixTab: 'campaign', retryable: false },
  agent_configuration_changed: { title: `The receptionist changed since its last ${VOICE.checkLower}`, action: `${VOICE.runCheck} again so the change is attested before it answers a call.`, scope: 'agent', severity: 'blocking', fixTab: 'deploy', retryable: true },
  agent_verification_stale: { title: `The last ${VOICE.checkLower} has expired`, action: `${VOICE.runCheck} again. A check is valid for 24 hours and normally renews itself hourly.`, scope: 'agent', severity: 'blocking', fixTab: 'deploy', retryable: true },
  agent_scope_mismatch: { title: 'That receptionist belongs to another clinic', action: 'Choose a receptionist that belongs to this campaign’s clinic.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  engine_not_owned: {
    title: `This ${VOICE.line} was not built by CareCommand`,
    action: `Publishing would overwrite a configuration CareCommand did not create. Clear the ${CONFIGURATION_REFERENCE.toLowerCase()} first, then ${VOICE.publishLower} a fresh one.`,
    platformAction: 'Deploying would overwrite an agent CareCommand did not create. Unlink it first, then deploy to publish a fresh agent.',
    scope: 'agent', severity: 'blocking', fixTab: 'campaign', retryable: false,
  },
  concurrent_change: { title: 'The receptionist changed while this was running', action: `Somebody edited it while CareCommand was talking to ${VOICE.service}. Nothing was applied. Reload and try again.`, scope: 'agent', severity: 'blocking', fixTab: 'deploy', retryable: true },
  cooldown: { title: 'Too soon after the last attempt', action: `Wait for the countdown, then try again. This protects the ${VOICE.line} from repeated identical requests.`, scope: 'agent', severity: 'blocking', fixTab: null, retryable: true },
  tenant_rate_limited: { title: 'Too many publishes this hour', action: `This clinic reached its hourly publishing limit. Wait, then ${VOICE.publishLower} again.`, scope: 'server', severity: 'blocking', fixTab: null, retryable: true },
  locale_pack_unavailable: { title: 'No locale pack covers this clinic', action: 'Nothing the caller would hear can be rendered without an approved locale pack for the clinic’s country and language. Set the clinic country and approve a pack, then try again.', scope: 'clinic', severity: 'blocking', fixTab: 'clinic', retryable: false },
  verification_failed: {
    title: `Published, but the ${VOICE.checkLower} did not pass`,
    action: `The new version is live but CareCommand could not attest it, so calls stay blocked. Open the Go live tab for the exact reason and run the ${VOICE.checkLower} again.`,
    platformAction: 'The new version is live at Retell but CareCommand could not attest it. Open the agent to see the exact reason and verify again.',
    scope: 'agent', severity: 'blocking', fixTab: 'deploy', retryable: true,
  },

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
  deployment_current: { title: 'The live prompt is out of date', action: `The campaign has changed since it was last published. ${VOICE.publish} so callers hear the current configuration.`, scope: 'campaign', severity: 'blocking', fixTab: 'deploy', retryable: false },
  number_bound: { title: 'The phone number does not point at this receptionist', action: `${VOICE.publish}; publishing points the number at the version that just went live.`, scope: 'campaign', severity: 'blocking', fixTab: 'deploy', retryable: false },
  number_bound_elsewhere: {
    title: 'Something else answers this number',
    action: `The number was pointed elsewhere outside CareCommand, so a caller reaches something we do not control. ${VOICE.publish} to point it back at this campaign.`,
    platformAction: 'The number\u2019s inbound agent was changed outside CareCommand, so a caller reaches something else. Deploy from Studio to bind it back to this campaign\u2019s published version.',
    scope: 'provider', severity: 'blocking', fixTab: 'deploy', retryable: false,
  },
  number_binding_unattested: {
    title: 'Nothing proves this number reaches your receptionist',
    action: `This ${VOICE.configuration} was linked by hand, so CareCommand has never pointed the number itself and cannot read back what it reaches. ${VOICE.publish}, which points the number and records the evidence.`,
    platformAction: 'This agent was linked by hand, so CareCommand has never bound the number and cannot read back what the line points at. Deploy from Studio, which binds the number and records the evidence.',
    scope: 'campaign', severity: 'blocking', fixTab: 'deploy', retryable: false,
  },
  location_mapped: { title: 'No location is mapped to a scheduling branch', action: 'Map at least one active clinic location to a branch so bookings land on a real schedule.', scope: 'clinic', severity: 'blocking', fixTab: 'clinic', retryable: false },
  location_scope_mismatch: { title: 'A selected location is not usable', action: 'Every eligible location must be active, belong to this clinic, and be mapped to a branch.', scope: 'campaign', severity: 'blocking', fixTab: 'clinic', retryable: false },
  services_bookable: { title: 'No bookable service matches this campaign', action: 'Add the campaign’s appointment type to the service catalogue and mark it bookable by voice.', scope: 'clinic', severity: 'blocking', fixTab: 'clinic', retryable: false },
  provider_availability: { title: 'No provider has availability at a mapped branch', action: 'Set working hours for at least one provider at a mapped branch, otherwise the agent can never offer a time.', scope: 'scheduling', severity: 'blocking', fixTab: 'scheduling', retryable: false },
  provider_resolvable: { title: 'The agent cannot choose which provider to book', action: 'A mapped branch has more than one active provider and the voice agent has no rule for picking between them, so it takes a message instead of booking. Leave one active provider at the branch, or map the campaign to a branch that has one.', scope: 'scheduling', severity: 'blocking', fixTab: 'scheduling', retryable: false },
  intake_attested: { title: 'The intake questions are not attested', action: `${VOICE.runCheck} so the questions the receptionist asks on the live line match the intake fields configured here.`, scope: 'campaign', severity: 'blocking', fixTab: 'intake', retryable: true },
  intake_schema_unattested: { title: 'The intake questions are not attested', action: `${VOICE.runCheck} so the questions the receptionist asks on the live line match the intake fields configured here.`, scope: 'campaign', severity: 'blocking', fixTab: 'intake', retryable: true },
  intake_schema_mismatch: { title: 'The intake fields changed after attestation', action: `The live booking step no longer matches these intake fields. ${VOICE.publish} again, then activate.`, scope: 'campaign', severity: 'blocking', fixTab: 'intake', retryable: false },
  intake_schema_not_strict: { title: 'The booking step accepts fields it was not given', action: `A booking step must accept exactly these intake fields before it may run. ${VOICE.publish}; publishing sets it.`, scope: 'campaign', severity: 'blocking', fixTab: 'deploy', retryable: false },
  active_intake_contract_immutable: { title: 'An active campaign’s contract cannot be edited', action: 'Pause the campaign before changing its agent, appointment type or locations.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  active_provider_deployment_conflict: { title: 'Another active campaign already owns this deployment', action: 'One provider deployment answers for one active campaign. Pause the other campaign first.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  placeholders_absent: { title: 'Placeholder text is still in the configuration', action: 'Replace the pre-filled example values listed below before this agent speaks to a patient.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  placeholders_present: { title: 'Placeholder text is still in the configuration', action: 'Replace the pre-filled example values before deploying. A patient must never hear "New offer".', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  disclosure_composed: { title: 'The clinic adds no disclosure wording', action: 'The product’s baseline AI and recording disclosure is used on its own. Add clinic-specific wording if your jurisdiction requires it.', scope: 'clinic', severity: 'warning', fixTab: 'clinic', retryable: false },
  confirmation_channels: { title: 'A confirmation channel is enabled but not configured', action: 'Configure the messaging provider, or turn the confirmation off. The agent must not promise a text it cannot send.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  confirmation_channel_unconfigured: { title: 'That confirmation channel is not configured', action: 'Configure the messaging provider before enabling this confirmation, so the agent never promises a message it cannot send.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  transfer_target_distinct: { title: 'The transfer number loops back to the AI line', action: 'Set a human fallback number that differs from the clinic’s AI line, or a transfer would return the caller to the agent.', scope: 'clinic', severity: 'blocking', fixTab: 'clinic', retryable: false },
  test_call_completed: { title: 'No test call has reached this line', action: 'Call the receptionist number from a staff phone once. The call appears in Activity and this check clears.', scope: 'campaign', severity: 'blocking', fixTab: 'deploy', retryable: true },
  data_storage_setting: {
    title: 'Call storage is fixed to metadata only',
    action: `Transcript retention has no clinic-level policy yet, so ${VOICE.service} keeps basic call attributes only — no recordings, no transcripts. This is read-only for the pilot.`,
    platformAction: 'Transcript retention has no tenant policy yet, so the provider stores basic attributes only (RETELL_DATA_STORAGE_SETTING = basic_attributes_only). This is read-only for the pilot.',
    scope: 'server', severity: 'warning', fixTab: null, retryable: false,
  },

  // ---- Transitions --------------------------------------------------------
  campaign_not_ready: { title: 'The campaign is not ready to activate', action: 'Clear the listed checks, then activate.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  campaign_not_active: { title: 'The campaign is not active', action: 'Only an active campaign can be paused.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  campaign_transition_not_allowed: { title: 'That status change is not allowed', action: 'A campaign moves draft or paused to active, active to paused, and draft or paused to archived. An archived campaign is final.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  campaign_active_pause_first: { title: 'Pause the campaign before archiving it', action: 'An active campaign is answering calls. Pause it first, then archive.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
  campaign_referenced_by_outbound: { title: 'A runnable outbound campaign still uses this campaign', action: 'Pause or complete the outbound campaigns listed before archiving this one.', scope: 'campaign', severity: 'blocking', fixTab: 'campaign', retryable: false },
} satisfies Record<RemediationCode, CatalogueEntry>;

export const REMEDIATION_CODES = Object.keys(CATALOGUE) as RemediationCode[];

export interface RemediationContext {
  clinicId?: string | null;
  campaignId?: string | null;
  agentId?: string | null;
}

function fixHref(entry: CatalogueEntry, ctx: RemediationContext): string | null {
  if (!entry.fixTab) return null;
  if (entry.fixTab === 'scheduling') return '/scheduling';
  const params = new URLSearchParams();
  if (ctx.clinicId) params.set('clinic', ctx.clinicId);
  if (ctx.campaignId) params.set('campaign', ctx.campaignId);
  if (ctx.agentId) params.set('agent', ctx.agentId);
  params.set('tab', entry.fixTab);
  return `/receptionist-studio?${params.toString()}`;
}

const UNKNOWN: CatalogueEntry = {
  title: 'Something went wrong',
  action: 'CareCommand could not classify this failure. Retry, and report the code shown if it repeats.',
  scope: 'server',
  severity: 'blocking',
  fixTab: null,
  retryable: true,
};

function entryFor(code: string): CatalogueEntry {
  return (CATALOGUE as Record<string, CatalogueEntry | undefined>)[code] ?? UNKNOWN;
}

/**
 * The TENANT view. `platformAction` is destructured out rather than merely
 * left unread: every caller of this function spreads the result straight into
 * a JSON response body, so an entry that carried the supplier instruction as a
 * spare property would ship it to the browser the day it was added. Removing
 * it here means there is exactly one gate rather than one per route.
 */
export function remediationFor(code: string, ctx: RemediationContext = {}): Remediation & { fixHref: string | null } {
  const entry = entryFor(code);
  const { platformAction: _platformOnly, ...tenantSafe } = entry;
  void _platformOnly;
  return { code, ...tenantSafe, fixHref: fixHref(entry, ctx) };
}

/**
 * The PLATFORM view: the same fault with the instruction that actually fixes
 * it. Reachable only from `server/modules/platform/*`, which authenticates a
 * PlatformUser against a separate JWT — the tenant's token cannot reach it.
 */
export function platformRemediationFor(code: string, ctx: RemediationContext = {}): PlatformRemediation & { fixHref: string | null } {
  const entry = entryFor(code);
  const { platformAction = null, ...rest } = entry;
  return {
    code,
    ...rest,
    platformAction,
    supportRouted: entry.action === SUPPORT_ATTENTION,
    fixHref: fixHref(entry, ctx),
  };
}

/** The whole catalogue, for the Platform Console's failure-code lookup. */
export function platformRemediationCatalogue(): PlatformRemediation[] {
  return REMEDIATION_CODES.map(code => {
    const { fixHref: _href, ...row } = platformRemediationFor(code);
    void _href;
    return row;
  });
}

export function isKnownRemediationCode(code: string): code is RemediationCode {
  return Object.hasOwn(CATALOGUE, code);
}
