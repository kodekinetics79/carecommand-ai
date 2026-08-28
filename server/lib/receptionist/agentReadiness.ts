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
