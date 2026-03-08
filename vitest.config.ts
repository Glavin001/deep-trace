import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    pool: 'forks',
    // Each test file gets its own fork so OTel global provider is isolated
    sequence: {
      concurrent: false,
    },
  },
});
