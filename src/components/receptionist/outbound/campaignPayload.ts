import type { Campaign, OutboundCampaignInput } from '../../../lib/receptionist';

export const RECOMMENDED_CALL_BRIEFS: Record<NonNullable<OutboundCampaignInput['purpose']>, string> = {
  CARE_COORDINATION: 'After confirming you reached the intended patient, explain that the clinic is calling for a routine care-coordination follow-up. Ask if now is a good time. Complete only the approved follow-up steps, and route clinical questions to staff.',
  APPOINTMENT_REMINDER: 'After verifying the intended patient, explain that the clinic is calling about their upcoming appointment. Use only the appointment details supplied for this specific call. Ask whether they plan to attend; if they need a change, use approved availability and never invent a date, time, clinician, or location.',
  PATIENT_REACTIVATION: 'After confirming you reached the intended patient, explain that the clinic is calling to help arrange a routine follow-up visit. Ask if now is a good time. If they are interested, help with the approved service without pressure; route clinical questions to staff.',
};

export function recommendedCallBrief(purpose: OutboundCampaignInput['purpose']): string {
  return purpose ? RECOMMENDED_CALL_BRIEFS[purpose] : RECOMMENDED_CALL_BRIEFS.CARE_COORDINATION;
}

export function bookingAuthorityCallBrief(authority: Pick<Campaign, 'appointmentType' | 'offerDescription'>): string {
  return `After confirming and securely verifying the intended patient, explain that the clinic is calling to help with ${authority.appointmentType}. Use this approved scope: ${authority.offerDescription} Help with the linked booking workflow, and route clinical questions to staff.`;
}

// Unset ids and policy are `null`, never ''. The server validates optional
// UUIDs, and '' used to be posted for fields the user never touched and answer
// 400 "Invalid UUID" for a request-only campaign (M48).
export const EMPTY_CAMPAIGN: OutboundCampaignInput = {
  clinicId: '', name: '', script: RECOMMENDED_CALL_BRIEFS.CARE_COORDINATION, requiredFields: ['firstName', 'lastName', 'phone'],
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
