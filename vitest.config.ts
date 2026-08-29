import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Two projects, one `vitest run`. They cannot share an environment: the server
// suites need node (Prisma, Fastify, a real database) while the browser suites
// need jsdom. Splitting them keeps `npm test` a single command that covers both
// halves of the product instead of only the API.
export default defineConfig({
  test: {
    // ROOT level on purpose. Vitest resolves fileParallelism for the whole run,
    // not per project, so declaring it only inside the server project below
    // silently lost serial execution: the RLS catalog suites read a live
    // pg_policy catalog that a concurrently running suite mutates, and they
    // started failing in ways that looked like product defects. Keep it here.
    fileParallelism: false,
    projects: [
      {
        test: {
          name: 'server',
          environment: 'node',
          // Integration suites share one local database. Serial file execution
          // keeps exact aggregate/RLS assertions deterministic instead of
          // allowing another suite to mutate the catalog between the expected
          // and actual reads.
          fileParallelism: false,
          include: ['server/**/*.test.ts'],
          // Load .env so modules that read validated env (e.g. the eligibility
          // service) import cleanly during tests.
          setupFiles: ['dotenv/config', './server/test/setupPlatformDatabase.ts'],
        },
      },
      {
        // The same JSX transform the app is built with, so a component under
        // test compiles exactly as it ships.
        plugins: [react()],
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          setupFiles: ['./src/test/setup.ts'],
        },
      },
    ],
  },
});
