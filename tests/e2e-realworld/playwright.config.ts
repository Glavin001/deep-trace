import { defineConfig } from '@playwright/test';
import * as path from 'path';

/**
 * Playwright config for real-world Next.js app e2e tests.
 *
 * These tests assume the apps are already running on their configured ports.
 * The run-all.sh script handles starting/stopping servers.
 */
export default defineConfig({
  testDir: path.join(__dirname, 'specs'),
  timeout: 60_000,
  retries: 1,
  workers: 1, // Run serially — each app shares the span cache state
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    // Use system chromium if available (avoids version mismatch issues)
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    },
  },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: path.join(__dirname, '../../test-results/e2e-realworld-report') }],
  ],
  outputDir: path.join(__dirname, '../../test-results/e2e-realworld'),
});
