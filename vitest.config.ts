import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/**/*.test.ts'],
    // Load .env so modules that read validated env (e.g. the eligibility
    // service) import cleanly during tests.
    setupFiles: ['dotenv/config'],
  },
});
