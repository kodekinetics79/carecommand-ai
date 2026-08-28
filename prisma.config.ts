import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Prisma loads this config for EVERY CLI command. `prisma generate` does
    // not connect to the database, so preview/build environments may omit the
    // runtime URL — and env() THROWS on a missing variable, which failed every
    // preview build with PrismaConfigEnvError. Commands that genuinely need a
    // database still fail at execution time when neither URL is configured.
    url: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL ?? '',
    ...(process.env.SHADOW_DATABASE_URL ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL } : {}),
  },
});
