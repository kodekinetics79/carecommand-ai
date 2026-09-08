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

export type AppointmentCommunicationMode = 'NONE' | 'SMS' | 'VOICE' | 'BOTH';

export interface AppointmentCommunicationPlan {
  mode: AppointmentCommunicationMode;
  status: 'ACTIVE' | 'PAUSED' | 'BLOCKED_SETUP' | 'COMPLETED' | 'CANCELLED';
  reminderLeadMinutes: number;
  revision: number | null;
  appointmentVersion: number;
  messages: Array<{
    channel: 'SMS' | 'VOICE';
    state: 'scheduled' | 'provider_accepted' | 'delivery_unknown' | 'setup_needed' | 'suppressed' | 'failed' | 'cancelled';
    dueAt: string;
  }>;
  summary: string;
}

export type AppointmentCommunicationOutcomeTone = 'neutral' | 'success' | 'warning' | 'error';

/** Plain clinic-facing truth; transport and supplier details stay in setup. */
export function appointmentCommunicationOutcome(plan: AppointmentCommunicationPlan): { tone: AppointmentCommunicationOutcomeTone; text: string } {
  if (plan.status === 'BLOCKED_SETUP') {
    const selection = plan.mode === 'SMS' ? 'Text reminder selected.'
      : plan.mode === 'VOICE' ? 'Call reminder selected.'
      : plan.mode === 'BOTH' ? 'Text and call reminders selected.'
      : 'Reminder selected.';
    return { tone: 'warning', text: `Will not send until automatic reminders are set up. ${selection}` };
  }
  if (plan.messages.some(message => message.state === 'delivery_unknown')) {
    return { tone: 'warning', text: 'Needs review. The text reminder status is unknown.' };
  }
  if (plan.messages.some(message => message.state === 'failed')) {
    return { tone: 'error', text: 'Reminder failed. Review it before relying on this appointment follow-up.' };
  }
  if (plan.messages.some(message => message.state === 'scheduled')) {
    return { tone: 'success', text: plan.summary };
  }
  if (plan.messages.some(message => message.state === 'provider_accepted')) {
    return { tone: 'neutral', text: 'Text reminder accepted for sending. Delivery is not yet confirmed.' };
  }
  return { tone: 'neutral', text: plan.summary };
}

const base = '/v1/appointments';
const schedulingBase = '/v1/scheduling';

export const appointmentsApi = {
  communicationPlan: (id: string) =>
    apiRequest<AppointmentCommunicationPlan>(`${base}/${id}/communication-plan`),

  saveCommunicationPlan: (id: string, input: {
    mode: AppointmentCommunicationMode;
    reminderLeadMinutes?: number;
    appointmentVersion: number;
    revision: number | null;
  }) => apiRequest<AppointmentCommunicationPlan>(`${base}/${id}/communication-plan`, {
    method: 'PUT',
    body: JSON.stringify(input),
  }),

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
    apiRequest<{ id: string; version: number }>(`${schedulingBase}/providers/${providerId}/book`, {
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
