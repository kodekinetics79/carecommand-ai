import { apiRequest } from './api';

// ===========================================================================
// Appointment lifecycle + conflict-safe scheduling client.
// Thin wrappers over the existing backend routes so the front desk can drive
// the real appointment state machine (check-in / no-show / complete / cancel /
// reschedule) and book against a provider's real open slots.
// ===========================================================================

export type LifecycleStatus = 'ARRIVED' | 'NO_SHOW' | 'COMPLETED';

export interface ProviderSlot {
  startsAt: string;
  endsAt: string;
}

export interface ProviderSlotsResponse {
  providerId: string;
  date: string;
  slots: ProviderSlot[];
}

const base = '/v1/appointments';
const schedulingBase = '/v1/scheduling';

export const appointmentsApi = {
  // Lifecycle transitions (validated server-side; a disallowed jump returns 409).
  setStatus: (id: string, status: LifecycleStatus) =>
    apiRequest<{ id: string; status: string }>(`${base}/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),

  cancel: (id: string, reason?: string) =>
    apiRequest<{ id: string; status: string }>(`${base}/${id}/cancel`, {
      method: 'PATCH',
      body: JSON.stringify(reason ? { reason } : {}),
    }),

  reschedule: (id: string, startsAt: string, endsAt: string) =>
    apiRequest<{ id: string; status: string; startsAt: string; endsAt: string }>(`${base}/${id}/reschedule`, {
      method: 'PATCH',
      body: JSON.stringify({ startsAt, endsAt }),
    }),
};

export const schedulingApi = {
  // Real open slots for a provider on a given day (YYYY-MM-DD), backend-computed.
  slots: (providerId: string, date: string, durationMin?: number) =>
    apiRequest<ProviderSlotsResponse>(
      `${schedulingBase}/providers/${providerId}/slots?date=${date}${durationMin ? `&durationMin=${durationMin}` : ''}`,
    ),

  // Conflict-safe booking — sets providerProfileId and is guarded by the DB
  // exclusion constraint. A taken slot returns 409 { error:'slot_unavailable' }.
  book: (providerId: string, body: { patientId: string; startsAt: string; durationMin?: number; service: string; channel?: string }) =>
    apiRequest<{ id: string }>(`${schedulingBase}/providers/${providerId}/book`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};
