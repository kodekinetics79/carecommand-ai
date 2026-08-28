import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Integration suites share one local database. Serial file execution keeps
    // exact aggregate/RLS assertions deterministic instead of allowing another
    // suite to mutate the catalog between the expected and actual reads.
    fileParallelism: false,
    include: ['server/**/*.test.ts'],
    // Load .env so modules that read validated env (e.g. the eligibility
    // service) import cleanly during tests.
    setupFiles: ['dotenv/config', './server/test/setupPlatformDatabase.ts'],
  },
});
