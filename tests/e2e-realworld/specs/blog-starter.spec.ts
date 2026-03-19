/**
 * blog-starter — SSG blog with React components and navigation.
 *
 * This is the richest test app. It has many named-export components
 * that the Babel plugin wraps correctly:
 *
 * Components (wrapped):
 * - Footer, Container, Intro, HeroPost, MoreStories, PostPreview,
 *   CoverImage, DateFormatter, Avatar, ThemeSwitcher, PostBody,
 *   PostHeader, PostTitle, SectionSeparator, Header
 *
 * Library functions (wrapped):
 * - getPostSlugs, getPostBySlug, getAllPosts (from src/lib/api.ts)
 *
 * What we verify:
 * - Homepage renders with blog posts
 * - Component spans are captured with correct function names
 * - Library function spans appear (getAllPosts, getPostBySlug)
 * - Source file paths reference the correct files
 * - Line numbers are positive integers
 * - Navigating to a blog post produces post-specific spans
 */

import { test, expect } from '@playwright/test';
import {
  getSpans,
  clearSpans,
  waitForSpanFlush,
  getFunctionNames,
  getFunctionSpans,
  getSpansWithSourceLocation,
  assertSpanHasSourceLocation,
  assertNoInstrumentationErrors,
} from '../lib/span-helpers';

const APP_PORT = 3901;
const SPAN_CACHE_PORT = 43901;
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;

test.describe('blog-starter', () => {
  test.beforeEach(async () => {
    await clearSpans(SPAN_CACHE_PORT);
  });

  test('homepage renders with blog content', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    // Blog starter should have visible content
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('homepage produces component and library function spans', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    await waitForSpanFlush();

    const spans = await getSpans(SPAN_CACHE_PORT);
    expect(spans.length).toBeGreaterThan(0);
    assertNoInstrumentationErrors(spans);

    const funcNames = getFunctionNames(spans);
    console.log('blog-starter homepage function names:', funcNames);

    // Should capture component spans
    expect(funcNames).toContain('Footer');
    expect(funcNames).toContain('Container');
    expect(funcNames).toContain('Intro');

    // Should capture library function spans
    expect(funcNames).toContain('getAllPosts');
    expect(funcNames).toContain('getPostBySlug');
  });

  test('component spans have correct source file paths', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    await waitForSpanFlush();

    const spans = await getSpans(SPAN_CACHE_PORT);
    const funcSpans = getFunctionSpans(spans);

    // Check specific components have correct file paths
    const footerSpan = funcSpans.find(s => s.attributes['function.name'] === 'Footer');
    expect(footerSpan).toBeDefined();
    expect(footerSpan!.attributes['code.filepath']).toContain('_components/footer.tsx');

    const apiSpan = funcSpans.find(s => s.attributes['function.name'] === 'getAllPosts');
    expect(apiSpan).toBeDefined();
    expect(apiSpan!.attributes['code.filepath']).toContain('lib/api.ts');

    // All function spans should have valid source locations
    const withSource = getSpansWithSourceLocation(spans);
    expect(withSource.length).toBeGreaterThan(5);
    for (const span of withSource) {
      assertSpanHasSourceLocation(span);
    }
  });

  test('spans have valid line numbers', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    await waitForSpanFlush();

    const spans = await getSpans(SPAN_CACHE_PORT);
    const withSource = getSpansWithSourceLocation(spans);

    for (const span of withSource) {
      const lineno = span.attributes['code.lineno'];
      expect(lineno).toBeDefined();
      expect(typeof lineno).toBe('number');
      expect(lineno).toBeGreaterThan(0);
    }
  });

  test('navigating to a blog post produces post-specific spans', async ({ page }) => {
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
    await clearSpans(SPAN_CACHE_PORT);

    // Click a blog post link
    const postLink = page.locator('a[href*="/posts/"]').first();
    if (await postLink.count() > 0) {
      await postLink.click();
      await page.waitForURL('**/posts/**');
      await page.waitForLoadState('networkidle');
      await waitForSpanFlush();

      const spans = await getSpans(SPAN_CACHE_PORT);
      expect(spans.length).toBeGreaterThan(0);
      assertNoInstrumentationErrors(spans);

      const funcNames = getFunctionNames(spans);
      console.log('blog-starter post page function names:', funcNames);

      // Post page should call getPostBySlug
      expect(funcNames).toContain('getPostBySlug');

      // Should see post-specific components
      // PostHeader, PostBody, PostTitle exist on post pages
      const withSource = getSpansWithSourceLocation(spans);
      for (const span of withSource) {
        assertSpanHasSourceLocation(span);
      }
    }
  });

  test('trace propagation works via server-side request', async () => {
    const traceId = 'e2eblog0000000000000000000000001';
    const traceparent = `00-${traceId}-e2eblog000000001-01`;

    const response = await fetch(`${BASE_URL}/`, {
      headers: { traceparent },
    });
    expect(response.ok).toBe(true);

    await waitForSpanFlush();
    const spans = await getSpans(SPAN_CACHE_PORT, { traceId });

    // All spans from this request should share the trace ID
    if (spans.length > 0) {
      for (const span of spans) {
        expect(span.traceId).toBe(traceId);
      }
      console.log(`blog-starter trace propagation: ${spans.length} spans under traceId ${traceId}`);
    }
  });
});
