import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    pool: 'forks',
    include: ['src/__tests__/integration/**/*.test.ts'],
    testTimeout: 25000,
    sequence: {
      concurrent: false,
    },
  },
});
