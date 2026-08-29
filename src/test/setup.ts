import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// `globals` is off in this config (the server project relies on explicit
// imports), so Testing Library's automatic cleanup hook never registers.
// Unmount by hand instead: a component left mounted keeps its timers running
// and leaks state into the next file.
afterEach(() => {
  cleanup();
});
