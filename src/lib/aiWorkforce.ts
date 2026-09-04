import { apiRequest } from './api';

export type WorkforceCapabilityState = 'ready' | 'needs_setup' | 'building';

export interface WorkforceOverview {
  generatedAt: string;
  workload: {
    appointmentsNeedingConfirmationNext24h: number;
    appointmentsPatientConfirmedNext24h: number;
    appointmentRequestsNeedingReview: number;
    missedOrEscalatedInboundCallsLast24h: number;
    incompleteIntakePackets: number;
    receptionistTasksNeedingStaff: number;
    outboundTargetsWaiting: number;
    callsCurrentlyInProgress: number;
  };
  operations: {
    activeBranches: number;
    outboundCampaigns: {
      draft: number;
      scheduled: number;
      running: number;
      paused: number;
      completed: number;
      failed: number;
    };
  };
  capabilities: {
    inboundAiReceptionist: { state: WorkforceCapabilityState; readyAgents: number };
    liveAppointmentBooking: { state: WorkforceCapabilityState; voiceBookableServices: number; activeProviders: number };
    governedOutboundCalling: { state: WorkforceCapabilityState; pendingTargets: number };
    autonomousOutboundDialer: { state: WorkforceCapabilityState; reason?: string };
    conversationalIntake: { state: WorkforceCapabilityState; incompletePackets: number };
    universalConversationalForms: { state: WorkforceCapabilityState; reason?: string };
  };
}

export interface WorkforceClinic {
  id: string;
  name: string;
  active: boolean;
}

export interface PreparedConfirmationCampaign {
  status: 'prepared';
  campaignId: string;
  campaignName: string;
  clinicName: string;
  targetsPrepared: number;
  appointmentsConsidered: number;
  invalidPhoneSkipped: number;
  duplicateDestinationSkipped: number;
  approvalRequired: true;
  callsPlaced: 0;
  nextStep: string;
}

export const aiWorkforceService = {
  overview: () => apiRequest<WorkforceOverview>('/v1/receptionist/workforce/overview'),
  clinics: () => apiRequest<WorkforceClinic[]>('/v1/receptionist/clinics'),
  prepareAppointmentConfirmations: (input: {
    clinicId: string;
    horizonHours?: number;
    maxTargets?: number;
  }) => apiRequest<PreparedConfirmationCampaign>('/v1/receptionist/workforce/appointment-confirmations/prepare', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
};
