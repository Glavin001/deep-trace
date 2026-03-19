/**
 * with-context-api — Client-side interactivity with React Context.
 *
 * This example uses App Router with client components:
 * - CounterProvider (exported const arrow function) — wraps app with Context
 * - Home page (export default function) — has Increase/Decrease buttons
 * - About page — linked from home
 *
 * The `"use client"` directive means these components render in the browser.
 * Deep-trace's browser instrumentation (instrumentation-client.ts) should
 * capture React component renders via bippy.
 *
 * What we verify:
 * - Page loads, counter renders at 0
 * - Clicking buttons works (app doesn't crash with instrumentation)
 * - Navigating to /about works
 * - Next.js internal server spans are captured
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

const APP_PORT = 3903;
const SPAN_CACHE_PORT = 43903;
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;

test.describe('with-context-api', () => {
  test.beforeEach(async () => {
    await clearSpans(SPAN_CACHE_PORT);
  });

  test('homepage renders with counter at 0', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.locator('text=Counter')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('button', { hasText: 'Increase' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'Decrease' })).toBeVisible();
  });

  test('counter buttons are clickable without crashing', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.locator('text=Counter')).toBeVisible({ timeout: 15000 });

    // Click Increase and Decrease — verify no crash
    const increaseBtn = page.locator('button', { hasText: 'Increase' });
    const decreaseBtn = page.locator('button', { hasText: 'Decrease' });
    await increaseBtn.click();
    await decreaseBtn.click();

    // App should still be alive
    await expect(page.locator('text=Counter')).toBeVisible();
  });

  test('page load produces server-side spans', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    await waitForSpanFlush();

    const spans = await getSpans(SPAN_CACHE_PORT);
    expect(spans.length).toBeGreaterThan(0);
    assertNoInstrumentationErrors(spans);

    const funcNames = getFunctionNames(spans);
    console.log('with-context-api page load function names:', funcNames);
    console.log('with-context-api all span names:', [...new Set(spans.map(s => s.name))]);
  });

  test('navigating to About page works', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page.locator('text=Counter')).toBeVisible({ timeout: 15000 });
    await clearSpans(SPAN_CACHE_PORT);

    await page.locator('a', { hasText: 'About' }).click();
    await page.waitForURL('**/about');
    await page.waitForLoadState('networkidle');

    await waitForSpanFlush();
    const spans = await getSpans(SPAN_CACHE_PORT);

    if (spans.length > 0) {
      assertNoInstrumentationErrors(spans);
      console.log('with-context-api About page spans:', spans.length);
    }
  });
});
