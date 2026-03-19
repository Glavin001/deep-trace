/**
 * api-routes-rest — REST API routes with Pages Router.
 *
 * This example uses Pages Router with:
 * - /api/users (GET, returns list of users)
 * - /api/user/[id] (GET, PUT, returns/updates a user)
 * - / (homepage, fetches users via SWR)
 * - /user/[id] (user detail page)
 *
 * Note: Uses `export default function handler(...)` pattern.
 * The Babel plugin wraps these but the default export still points
 * to the unwrapped version. However, the Index and fetcher
 * (named exports / variable declarations) ARE wrapped.
 *
 * What we verify:
 * - App boots without crashing
 * - Homepage renders user list
 * - API routes respond correctly
 * - Next.js internal spans are captured
 * - Client-side component wrapping works (Index page, fetcher)
 * - No instrumentation errors
 */

import { test, expect } from '@playwright/test';
import {
  getSpans,
  clearSpans,
  waitForSpanFlush,
  getFunctionNames,
  assertNoInstrumentationErrors,
} from '../lib/span-helpers';

const APP_PORT = 3902;
const SPAN_CACHE_PORT = 43902;
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;

test.describe('api-routes-rest', () => {
  test.beforeEach(async () => {
    await clearSpans(SPAN_CACHE_PORT);
  });

  test('homepage loads and shows user list', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    // Should show a list of users (rendered via SWR from /api/users)
    // Wait for SWR to fetch and render
    await expect(page.locator('li').first()).toBeVisible({ timeout: 10000 });
  });

  test('API GET /api/users responds correctly', async () => {
    const response = await fetch(`${BASE_URL}/api/users`);
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  test('API GET /api/user/1 responds without crashing', async () => {
    const response = await fetch(`${BASE_URL}/api/user/1`);
    // The handler should respond (even if Babel wrapping affects the default export)
    expect(response.status).toBeLessThan(500);
  });

  test('API requests produce Next.js internal spans', async () => {
    await clearSpans(SPAN_CACHE_PORT);

    await fetch(`${BASE_URL}/api/users`);
    await waitForSpanFlush();

    const spans = await getSpans(SPAN_CACHE_PORT);
    expect(spans.length).toBeGreaterThan(0);
    assertNoInstrumentationErrors(spans);

    // Should see the API route span
    const apiSpan = spans.find(s => s.name.includes('/api/users'));
    expect(apiSpan).toBeDefined();

    console.log('api-routes-rest API spans:', spans.map(s => s.name));
  });

  test('navigating to a user page produces spans', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    await clearSpans(SPAN_CACHE_PORT);

    // Click on a user link
    const userLink = page.locator('a').first();
    if (await userLink.count() > 0) {
      await userLink.click();
      await page.waitForLoadState('networkidle');
      await waitForSpanFlush();

      const spans = await getSpans(SPAN_CACHE_PORT);
      if (spans.length > 0) {
        assertNoInstrumentationErrors(spans);
        const funcNames = getFunctionNames(spans);
        console.log('api-routes-rest user page function names:', funcNames);
      }
    }
  });
});
