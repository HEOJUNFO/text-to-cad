import { defineConfig } from 'vitest/config';

// The server's units and the viewer page's run in Node (a file that needs the DOM says so with
// `// @vitest-environment jsdom`); the one browser test under test/ drives a real Chromium over a
// real export and the built page, and sets its own timeout.
export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'web/**/*.test.{ts,tsx}', 'test/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
  },
});
