import type { OutboundCampaignInput } from '../../../lib/receptionist';

// Unset ids and policy are `null`, never ''. The server validates optional
// UUIDs, and '' used to be posted for fields the user never touched and answer
// 400 "Invalid UUID" for a request-only campaign (M48).
export const EMPTY_CAMPAIGN: OutboundCampaignInput = {
  clinicId: '', name: '', script: '', requiredFields: ['firstName', 'lastName', 'phone'],
  consentText: null, humanHandoffInstruction: null, bookingMode: 'APPOINTMENT_REQUEST_ONLY',
  agentId: null, receptionistCampaignId: null, purpose: 'CARE_COORDINATION', legalBasis: 'TREATMENT_OPERATIONS', policyVersion: null,
  defaultBranchId: null, defaultService: null, quietHoursStart: null, quietHoursEnd: null, maxRetryAttempts: 1,
};

/** Normalises the form for the API: blank optional strings and ids become null. */
export function toOutboundCampaignPayload(form: OutboundCampaignInput, clinicId: string): OutboundCampaignInput {
  const blankToNull = (value: string | null | undefined) => (value && value.trim() ? value.trim() : null);
  return {
    ...form,
    clinicId,
    agentId: form.agentId || null,
    receptionistCampaignId: form.receptionistCampaignId || null,
    purpose: form.purpose || null,
    legalBasis: form.legalBasis || null,
    policyVersion: blankToNull(form.policyVersion),
    defaultBranchId: form.defaultBranchId || null,
    defaultService: blankToNull(form.defaultService),
    consentText: blankToNull(form.consentText),
    humanHandoffInstruction: blankToNull(form.humanHandoffInstruction),
    quietHoursStart: blankToNull(form.quietHoursStart),
    quietHoursEnd: blankToNull(form.quietHoursEnd),
  };
}

