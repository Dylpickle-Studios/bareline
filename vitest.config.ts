import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['tests/e2e/**', 'node_modules/**', 'release/**'],
    // The integration suites boot a full application, spawn real Git subprocesses, and hash
    // passwords with deliberately expensive Argon2 parameters. Under the default 5s limit those
    // tests fail intermittently on a loaded machine, so the limit is raised enough to stay a
    // genuine deadlock detector without producing false negatives.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
