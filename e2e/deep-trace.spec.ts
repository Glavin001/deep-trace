/**
 * End-to-end tests for the deep-trace local stack.
 *
 * Prerequisites (must be running before tests):
 *   npm run stack:up        — ClickHouse, OTEL Collector, Grafana
 *   npm run demo:next:dev   — Next.js demo on :3000
 *
 * Run:
 *   npx playwright test
 */
import { test, expect } from '@playwright/test';

const DEMO_URL = process.env.DEMO_URL ?? 'http://127.0.0.1:3000';
const GRAFANA_URL = process.env.GRAFANA_URL ?? 'http://127.0.0.1:3002';
const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? 'http://127.0.0.1:8123';

/** Poll ClickHouse until a trace appears (collector batches on ~5s interval). */
async function waitForTrace(traceId: string, minSpans = 2, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${CLICKHOUSE_URL}/?database=otel`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from('otel:otel').toString('base64')}`,
        'content-type': 'text/plain',
      },
      body: `SELECT count() AS cnt FROM otel_traces WHERE TraceId = '${traceId}' FORMAT JSONEachRow`,
    });
    const text = await res.text();
    // ClickHouse JSONEachRow returns numbers unquoted: {"cnt":7} or {"cnt":"7"}
    const match = text.match(/"cnt":(\d+)/) || text.match(/"cnt":"(\d+)"/);
    if (match && parseInt(match[1], 10) >= minSpans) return;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Trace ${traceId} did not appear in ClickHouse within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// 1. Demo app: emit a trace and get back a trace ID
// ---------------------------------------------------------------------------
test.describe('Demo app', () => {
  test('emits a trace via the UI and displays the trace ID', async ({ page }) => {
    await page.goto(DEMO_URL);

    // The page should render the input and button
    const input = page.locator('input[placeholder*="Describe the request"]');
    await expect(input).toBeVisible({ timeout: 10_000 });

    // Clear default and type a custom term
    await input.fill('playwright e2e test');

    // Click the emit button
    const emitButton = page.getByRole('button', { name: /emit frontend/i });
    await expect(emitButton).toBeEnabled();
    await emitButton.click();

    // After emitting, the status pill changes to "Trace stored"
    await expect(page.locator('.status-pill')).toHaveText('Trace stored', { timeout: 15_000 });

    // The second result-card holds the trace ID in a <code> element
    const traceIdCode = page.locator('.result-card:nth-child(2) code');
    const traceId = await traceIdCode.textContent();
    expect(traceId).toBeTruthy();
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});

// ---------------------------------------------------------------------------
// 2. Grafana dashboard: shows recent spans in the table panel
// ---------------------------------------------------------------------------
test.describe('Grafana dashboard', () => {
  test('deep-trace overview dashboard loads and shows span rows', async ({ page }) => {
    await page.goto(`${GRAFANA_URL}/d/deep-trace-overview/deep-trace-overview`);

    // Wait for dashboard to load
    await expect(page.locator('[data-testid="data-testid dashboard controls"]')).toBeVisible({ timeout: 10_000 });

    // The panel title "Recent trace spans" should be visible
    await expect(page.getByText('Recent trace spans')).toBeVisible();

    // Grafana's table panel renders data in a virtual grid (role="gridcell").
    // The dashboard auto-refreshes every 10s, so give it time to populate.
    // Look for at least one gridcell containing a known service name.
    await expect(
      page.getByRole('gridcell', { name: /seed-api|next-fullstack-api/ }).first()
    ).toBeVisible({ timeout: 30_000 });
  });
});

// ---------------------------------------------------------------------------
// 3. Full pipeline: demo → collector → ClickHouse → Grafana waterfall
// ---------------------------------------------------------------------------
test.describe('Trace waterfall in Grafana', () => {
  let traceId: string;

  test.beforeAll(async () => {
    // Emit a trace via the API so we have a known trace ID
    const res = await fetch(`${DEMO_URL}/api/demo?term=e2e-waterfall-test`, {
      headers: { 'x-demo-source': 'playwright-e2e' },
    });
    const json = await res.json();
    traceId = json.traceId;
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);

    // Wait for spans to land in ClickHouse (collector batches every ~5s, ClickHouse may buffer)
    await waitForTrace(traceId, 3, 45_000);
  });

  test('Grafana Explore shows the trace waterfall for a known trace ID', async ({ page }) => {
    await page.goto(`${GRAFANA_URL}/explore`);

    // Wait for Explore to load
    await expect(page.getByTestId('data-testid RefreshPicker run button')).toBeVisible({ timeout: 10_000 });

    // Switch Query Type from "Table" to "Traces" (radio IDs have dynamic suffixes)
    await page.locator('input[id^="option-traces-radiogroup"]').click({ force: true });

    // Select "Trace ID" mode (the ClickHouse plugin uses "true"/"false" for Trace ID/Trace Search)
    await page.locator('input[id^="option-true-radiogroup"]').click({ force: true });

    // Remove default filters (e.g. "ParentSpanId IS EMPTY") that would hide child spans
    const removeButtons = page.getByTestId('query-builder-filters-remove-button');
    while ((await removeButtons.count()) > 0) {
      await removeButtons.first().click();
      await page.waitForTimeout(300);
    }

    // Fill in the Trace ID field (identified by data-testid, no placeholder)
    const traceIdInput = page.getByTestId('query-builder__trace-id-input__input');
    await expect(traceIdInput).toBeVisible({ timeout: 5_000 });
    await traceIdInput.fill(traceId);

    // Click Run Query (use the inline button in the query editor)
    await page.locator('button:has-text("Run Query")').first().click();

    // Wait for the trace waterfall panel to appear with our known span names
    const panel = page.getByTestId('data-testid panel content');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText('demo.lookupRecommendation')).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText('demo.buildNarrative')).toBeVisible();
    await expect(panel.getByText('demo.api.handle_recommendation')).toBeVisible();
  });

  test('Grafana Explore Trace Search finds recent traces', async ({ page }) => {
    await page.goto(`${GRAFANA_URL}/explore`);

    // Wait for Explore to load
    await expect(page.getByTestId('data-testid RefreshPicker run button')).toBeVisible({ timeout: 10_000 });

    // Switch Query Type to "Traces" (radio IDs have dynamic suffixes)
    await page.locator('input[id^="option-traces-radiogroup"]').click({ force: true });

    // Default Trace Mode is "Trace Search" — click Run Query
    await page.locator('button:has-text("Run Query")').first().click();

    // Trace Search returns a table of root spans — our trace ID should appear
    await expect(page.getByText(traceId)).toBeVisible({ timeout: 30_000 });
  });
});
