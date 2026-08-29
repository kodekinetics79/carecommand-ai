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

/** One recurring weekly window, in clinic-local minutes from midnight. */
export interface AvailabilityWindow {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  slotMinutes: number;
}

export interface AvailabilityResponse {
  providerId: string;
  windows: Array<AvailabilityWindow & { id: string; active: boolean }>;
}

export interface TimeOffEntry {
  id: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
}

export interface TimeOffResponse {
  providerId: string;
  from: string;
  timeOff: TimeOffEntry[];
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
  // The service is not optional once a clinic has a catalog. resolveSchedulingService
  // is fail-closed on a configured catalog, so a slots request that names no
  // service is refused with "Select an active service before checking
  // availability" — meaning the first service a clinic ever creates broke slot
  // loading as well as booking, from a screen that had no way to send one.
  slots: (providerId: string, date: string, opts?: { durationMin?: number; service?: string; serviceCatalogItemId?: string }) => {
    const params = new URLSearchParams({ date });
    if (opts?.durationMin) params.set('durationMin', String(opts.durationMin));
    if (opts?.serviceCatalogItemId) params.set('serviceCatalogItemId', opts.serviceCatalogItemId);
    else if (opts?.service) params.set('service', opts.service);
    return apiRequest<ProviderSlotsResponse>(`${schedulingBase}/providers/${providerId}/slots?${params.toString()}`);
  },

  // Conflict-safe booking — sets providerProfileId and is guarded by the DB
  // exclusion constraint. A taken slot returns 409 { error:'slot_unavailable' }.
  book: (providerId: string, body: { patientId: string; startsAt: string; durationMin?: number; service: string; serviceCatalogItemId?: string; channel?: string }) =>
    apiRequest<{ id: string }>(`${schedulingBase}/providers/${providerId}/book`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ----- What produces slots in the first place ----------------------------
  // Recurring working hours and time off. Both routes are backend-owned and
  // guarded by `schedule:manage`; without them a provider exists but has no
  // open slot, so the booking modal above can never be completed.
  availability: (providerId: string) =>
    apiRequest<AvailabilityResponse>(`${schedulingBase}/providers/${providerId}/availability`),

  /** Replace-all: the posted set becomes the provider's entire week. */
  saveAvailability: (providerId: string, windows: AvailabilityWindow[]) =>
    apiRequest<AvailabilityResponse>(`${schedulingBase}/providers/${providerId}/availability`, {
      method: 'PUT',
      body: JSON.stringify({ windows }),
    }),

  timeOff: (providerId: string) =>
    apiRequest<TimeOffResponse>(`${schedulingBase}/providers/${providerId}/time-off`),

  addTimeOff: (providerId: string, body: { startsAt: string; endsAt: string; reason?: string }) =>
    apiRequest<TimeOffEntry>(`${schedulingBase}/providers/${providerId}/time-off`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  removeTimeOff: (providerId: string, timeOffId: string) =>
    apiRequest<void>(`${schedulingBase}/providers/${providerId}/time-off/${timeOffId}`, { method: 'DELETE' }),
};
