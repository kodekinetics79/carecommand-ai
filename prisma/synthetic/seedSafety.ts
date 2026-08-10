import type { SyntheticProfile } from './scenarioCatalog';

const PROFILE_NAMES = new Set<SyntheticProfile>(['FUNCTIONAL', 'TIER1', 'PILOT', 'EDGE']);
const SAFE_DATABASE_NAME = /^(?:cc|carecommand)_(?:test|synthetic|e2e|rls)_[a-z0-9_]+$/i;

export interface SyntheticSeedTargetInput {
  nodeEnv?: string;
  profile?: string;
  connectionString?: string;
  confirmation?: string;
}

export interface SyntheticSeedTarget {
  profile: SyntheticProfile;
  databaseName: string;
  connectionString: string;
}

export function assertSyntheticSeedTarget(input: SyntheticSeedTargetInput): SyntheticSeedTarget {
  const profile = (input.profile ?? '').toUpperCase() as SyntheticProfile;
  if (!PROFILE_NAMES.has(profile)) throw new Error('SYNTHETIC_PROFILE must be FUNCTIONAL, TIER1, PILOT, or EDGE');
  if (input.nodeEnv !== 'test') throw new Error('Synthetic profiles require NODE_ENV=test');
  if (!input.connectionString) throw new Error('SYNTHETIC_DATABASE_URL or DATABASE_MIGRATION_URL is required');

  const parsed = new URL(input.connectionString);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!SAFE_DATABASE_NAME.test(databaseName)) {
    throw new Error(`Refusing synthetic seed for unsafe database name: ${databaseName || '<empty>'}`);
  }
  if (input.confirmation !== databaseName) {
    throw new Error(`Set CONFIRM_SYNTHETIC_DATABASE=${databaseName} to confirm the disposable target`);
  }
  return { profile, databaseName, connectionString: input.connectionString };
}
