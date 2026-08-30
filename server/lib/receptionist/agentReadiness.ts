export const VERIFIED_AGENT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export interface AgentReadinessRecord {
  active: boolean;
  providerAgentId: string | null;
  providerVersion: number | null;
  providerStatus: 'UNVERIFIED' | 'VERIFIED' | 'INVALID';
  providerConfigRevision: number;
  providerVerifiedRevision: number | null;
  providerVerifiedAt: Date | null;
  providerVerificationExpiresAt: Date | null;
}

export type AgentReadinessReason =
  | 'agent_inactive'
  | 'agent_unlinked'
  | 'agent_unverified'
  | 'agent_configuration_changed'
  | 'agent_verification_stale';

export const AGENT_READINESS_REASONS: readonly AgentReadinessReason[] = [
  'agent_inactive', 'agent_unlinked', 'agent_unverified', 'agent_configuration_changed', 'agent_verification_stale',
];

/** Pure readiness predicate used both at activation and at the final dial boundary. */
export function agentReadinessReason(agent: AgentReadinessRecord, now = new Date()): AgentReadinessReason | null {
  if (!agent.active) return 'agent_inactive';
  if (!agent.providerAgentId) return 'agent_unlinked';
  if (agent.providerVersion === null || agent.providerVersion < 0) return 'agent_unverified';
  if (agent.providerStatus !== 'VERIFIED' || !agent.providerVerifiedAt || !agent.providerVerificationExpiresAt) return 'agent_unverified';
  if (agent.providerVerifiedRevision !== agent.providerConfigRevision) return 'agent_configuration_changed';
  if (agent.providerVerificationExpiresAt.getTime() <= now.getTime()
    || now.getTime() - agent.providerVerifiedAt.getTime() > VERIFIED_AGENT_MAX_AGE_MS) return 'agent_verification_stale';
  return null;
}

// ---------------------------------------------------------------------------
// Inbound degrade contract. When a live call arrives for a deployment that is
// not (or no longer) verified, the receptionist does not go dark: it keeps the
// tools that never read or write patient data and hands everything else to
// staff. The fn handler attaches this policy to its rejection; C3 maps the
// message key through locale packs.
// ---------------------------------------------------------------------------
export const DEGRADED_SAFE_TOOLS = [
  'record_recording_preference',
  'record_do_not_call',
  'request_human_handoff',
  'take_message',
  'report_emergency',
] as const;

export type InboundDegradeReason =
  | AgentReadinessReason
  | 'provider_deployment_drift'
  | 'provider_deployment_ambiguous'
  | 'provider_deployment_unverified_or_stale'
  | 'provider_deployment_evidence_missing';

export interface InboundDegradePolicy {
  mode: 'degraded';
  reason: InboundDegradeReason;
  allowedTools: readonly string[];
  messageKey: `receptionist.degraded.${string}`;
}

export function inboundDegradePolicy(reason: InboundDegradeReason): InboundDegradePolicy {
  const messageKey = reason === 'agent_verification_stale' || reason === 'provider_deployment_unverified_or_stale'
    ? 'receptionist.degraded.verification_stale'
    : reason === 'provider_deployment_drift' || reason === 'provider_deployment_ambiguous'
      ? 'receptionist.degraded.deployment_drift'
      : 'receptionist.degraded.unverified';
  return { mode: 'degraded', reason, allowedTools: DEGRADED_SAFE_TOOLS, messageKey };
}
