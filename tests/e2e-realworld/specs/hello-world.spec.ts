/**
 * hello-world — Minimal baseline test.
 *
 * The hello-world example is the simplest Next.js app: a single page
 * that renders "Hello, Next.js!". This verifies that deep-trace
 * doesn't break a minimal app and that basic instrumentation works.
 *
 * Note: hello-world uses `export default function Page()` which the
 * Babel plugin wraps, but the default export still points to the
 * unwrapped version. We still get Next.js internal spans though.
 */

import { test, expect } from '@playwright/test';
import {
  getSpans,
  clearSpans,
  waitForSpanFlush,
  assertNoInstrumentationErrors,
} from '../lib/span-helpers';

const APP_PORT = 3904;
const SPAN_CACHE_PORT = 43904;
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;

test.describe('hello-world', () => {
  test.beforeEach(async () => {
    await clearSpans(SPAN_CACHE_PORT);
  });

  test('app boots and renders "Hello, Next.js!" without crashing', async ({ page }) => {
    const response = await page.goto(BASE_URL);
    expect(response?.ok()).toBe(true);
    await expect(page.locator('h1')).toHaveText('Hello, Next.js!');
  });

  test('page load produces Next.js internal spans', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    await waitForSpanFlush();

    const spans = await getSpans(SPAN_CACHE_PORT);

    // Should have captured Next.js internal spans (auto-instrumentation)
    expect(spans.length).toBeGreaterThan(0);
    assertNoInstrumentationErrors(spans);

    // Should see the GET / span from Next.js
    const getSpan = spans.find(s => s.name === 'GET /');
    expect(getSpan).toBeDefined();
    expect(getSpan!.attributes['http.method']).toBe('GET');

    console.log(`hello-world: ${spans.length} spans captured`);
    console.log('  span names:', [...new Set(spans.map(s => s.name))].join(', '));
  });
});
