import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests share one Postgres database; run files serially so they don't
    // truncate each other's data mid-flight. Within a file, tests are ordered.
    fileParallelism: false,
    hookTimeout: 20000,
    testTimeout: 20000,
  },
});
