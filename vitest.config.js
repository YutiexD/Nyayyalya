import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // Each suite owns a MongoDB and a set of collections. Running files in parallel
    // against one server produces cross-test interference that looks like flakiness
    // but is really shared state, so suites are serialised by default.
    fileParallelism: false,
    pool: 'forks',
    maxForks: 1,
    minForks: 1,
    setupFiles: ['./backend/tests/setup.js'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: ['backend/tests/**/*.test.js'],
    exclude: ['node_modules', 'contracts/**', 'frontend/**'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['backend/**/*.js', 'shared/**/*.js'],
      exclude: ['backend/tests/**', '**/node_modules/**'],
    },
  },
});
