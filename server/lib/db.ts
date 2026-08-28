import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { env } from '../config/env';

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

// PilotImportPreset and PilotStatusShare are in the schema and generated
// client, so the previous `as PrismaClient & { ...: any }` cast is obsolete.
// It was a workaround for a stale client and silently erased type safety on
// both delegates.
export const db = new PrismaClient({ adapter });
