import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Migrations/CLI run as the owner role when DATABASE_MIGRATION_URL is set;
    // otherwise fall back to the runtime DATABASE_URL (single-role setups).
    url: process.env.DATABASE_MIGRATION_URL ?? env('DATABASE_URL'),
    ...(process.env.SHADOW_DATABASE_URL ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL } : {}),
  },
});
