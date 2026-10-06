import { defineConfig } from 'vitest/config';

// Server tests run in Node; viewer-page tests under web/ opt into jsdom per file with a
// `// @vitest-environment jsdom` pragma.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'web/**/*.test.ts', 'web/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
