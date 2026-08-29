import { apiRequest } from './api';

// ===========================================================================
// Provider identity client (/v1/providers).
//
// These routes have always worked; nothing in the app called them, so a clinic
// had no way to create the ProviderProfile that every booking path requires.
// Onboarding and retiring a clinician are `admin:manage`; the console must ask
// the session for that grant before offering the controls, because the API
// answers 403 and an offered-but-refused button is the defect this product
// keeps repeating.
// ===========================================================================

export interface ProviderCandidate {
  userId: string;
  displayName: string;
  email: string;
  role: string;
  /** Branches this user may hold a provider identity in. */
  branchIds: string[];
  /** Non-null when the user already has a provider profile. */
  providerProfileId: string | null;
  providerActive: boolean | null;
}

export interface ProviderProfileRow {
  id: string;
  branchId: string;
  userId: string;
  specialty: string;
  active: boolean;
}

export const providersApi = {
  /** Users POST /v1/providers will accept as a clinician identity. */
  candidates: (branchId?: string) =>
    apiRequest<ProviderCandidate[]>(`/v1/providers/candidates${branchId ? `?branchId=${branchId}` : ''}`),

  create: (body: { userId: string; branchId: string; specialty: string }) =>
    apiRequest<ProviderProfileRow>('/v1/providers', { method: 'POST', body: JSON.stringify(body) }),

  update: (id: string, body: { specialty?: string; branchId?: string; active?: boolean }) =>
    apiRequest<ProviderProfileRow>(`/v1/providers/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
};
