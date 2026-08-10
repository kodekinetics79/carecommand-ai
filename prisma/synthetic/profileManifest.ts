import type { SyntheticProfile } from './scenarioCatalog';

export interface SyntheticProfileManifest {
  profile: SyntheticProfile;
  fixedSeed: number;
  controlledClock: string;
  tenants: number;
  clinics: number;
  users: number;
  portalAccounts: number;
  patients: number;
  appointments: number;
  calls: number;
  paymentRequests: number;
  documents: number;
  notifications: number;
  auditEvents: number;
  description: string;
}

export const SYNTHETIC_CLOCK = '2026-07-15T14:00:00.000Z';
export const SYNTHETIC_SEED = 20260730;

export const syntheticProfiles: Record<SyntheticProfile, SyntheticProfileManifest> = {
  FUNCTIONAL: {
    profile: 'FUNCTIONAL', fixedSeed: SYNTHETIC_SEED, controlledClock: SYNTHETIC_CLOCK,
    tenants: 2, clinics: 3, users: 12, portalAccounts: 2, patients: 24, appointments: 48, calls: 16, paymentRequests: 12, documents: 12, notifications: 24, auditEvents: 48,
    description: 'Small deterministic dataset for unit, integration and browser journeys.',
  },
  TIER1: {
    profile: 'TIER1', fixedSeed: SYNTHETIC_SEED, controlledClock: SYNTHETIC_CLOCK,
    tenants: 4, clinics: 8, users: 40, portalAccounts: 4, patients: 1_000, appointments: 1_600, calls: 400, paymentRequests: 250, documents: 500, notifications: 1_000, auditEvents: 2_000,
    description: 'Functional-scale multi-client wave with exactly 1,000 synthetic patients and representative dependent records.',
  },
  PILOT: {
    profile: 'PILOT', fixedSeed: SYNTHETIC_SEED, controlledClock: SYNTHETIC_CLOCK,
    tenants: 4, clinics: 8, users: 40, portalAccounts: 4, patients: 2_000, appointments: 4_000, calls: 1_000, paymentRequests: 500, documents: 1_000, notifications: 2_000, auditEvents: 5_000,
    description: 'Realistic concentrated multi-clinic volume for supervised demonstrations and local performance evidence.',
  },
  EDGE: {
    profile: 'EDGE', fixedSeed: SYNTHETIC_SEED, controlledClock: SYNTHETIC_CLOCK,
    tenants: 5, clinics: 6, users: 20, portalAccounts: 5, patients: 40, appointments: 60, calls: 40, paymentRequests: 24, documents: 24, notifications: 40, auditEvents: 80,
    description: 'Boundary, denial, suspended, archived, ambiguous-identity and provider-failure cases.',
  },
};
