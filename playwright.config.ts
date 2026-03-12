import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  workers: 1,

  use: {
    headless: true,
    // Grafana and Next.js demo are on localhost
    baseURL: 'http://127.0.0.1:3002',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],

  // Do NOT auto-start webServer here — the stack and demo must already be running.
  // See README or run: npm run stack:up && npm run demo:next:dev
});
