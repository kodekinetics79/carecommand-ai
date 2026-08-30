import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma/client';

// ===========================================================================
// One place that knows what a receptionist clinic minimally needs. Since C2,
// country + timezone + defaultLanguage are required columns (no Prisma
// defaults), so a suite that creates a clinic by hand must supply them.
// ===========================================================================

type Client = Pick<PrismaClient, 'receptionistClinic'>;

export interface ClinicFixtureInput {
  tenantId: string;
  name?: string;
  phone?: string;
  country?: string;
  timezone?: string;
  defaultLanguage?: string;
  [key: string]: unknown;
}

export function fixturePhone(seed = randomUUID()): string {
  const digits = (BigInt(`0x${seed.replace(/-/g, '').slice(0, 14)}`) % 10_000_000_000n).toString().padStart(10, '0');
  return `+1${digits}`;
}

/** Defaults for a US/en-US clinic; every field stays overridable per suite. */
export function clinicFixtureData(input: ClinicFixtureInput) {
  const { tenantId, name, phone, country, timezone, defaultLanguage, ...rest } = input;
  return {
    tenantId,
    name: name ?? `Clinic ${randomUUID().slice(0, 8)}`,
    phone: phone ?? fixturePhone(),
    country: country ?? 'US',
    timezone: timezone ?? 'America/New_York',
    defaultLanguage: defaultLanguage ?? 'en-US',
    ...rest,
  };
}

export async function createClinicFixture<T extends Client>(db: T, input: ClinicFixtureInput) {
  return db.receptionistClinic.create({ data: clinicFixtureData(input) as never });
}
