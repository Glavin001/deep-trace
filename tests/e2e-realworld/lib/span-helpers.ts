/**
 * Shared helpers for querying the deep-trace span cache in Playwright tests.
 *
 * The span cache is an HTTP server that stores captured spans in memory.
 * API: GET /remote-debug/spans, DELETE /remote-debug/spans, etc.
 */

export interface CapturedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTime: string;
  endTime: string;
  durationMs: number;
  status: { code: number; message?: string };
  attributes: Record<string, any>;
  events: any[];
  links: any[];
}

export interface SpanCacheResponse {
  success: boolean;
  data: {
    spans: CapturedSpan[];
    total: number;
  };
}

/**
 * Query all spans from the span cache.
 */
export async function getSpans(spanCachePort: number, params?: { traceId?: string; functionName?: string; limit?: number }): Promise<CapturedSpan[]> {
  const url = new URL(`http://127.0.0.1:${spanCachePort}/remote-debug/spans`);
  if (params?.traceId) url.searchParams.set('traceId', params.traceId);
  if (params?.functionName) url.searchParams.set('functionName', params.functionName);
  if (params?.limit) url.searchParams.set('limit', String(params.limit));

  const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });
  if (!resp.ok) throw new Error(`Span cache returned ${resp.status}: ${await resp.text()}`);
  const body: SpanCacheResponse = await resp.json();
  if (!body.success) throw new Error(`Span cache error: ${JSON.stringify(body)}`);
  return body.data.spans;
}

/**
 * Clear all spans from the span cache.
 */
export async function clearSpans(spanCachePort: number): Promise<void> {
  const resp = await fetch(`http://127.0.0.1:${spanCachePort}/remote-debug/spans`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`Failed to clear spans: ${resp.status}`);
}

/**
 * Wait for spans to be flushed from the OTel pipeline to the cache.
 * The pipeline is async, so we need a small delay after triggering spans.
 */
export async function waitForSpanFlush(ms = 3000): Promise<void> {
  await new Promise(r => setTimeout(r, ms));
}

/**
 * Wait for the span cache server to be ready.
 */
export async function waitForSpanCache(port: number, timeoutMs = 60000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/remote-debug/spans/stats`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Span cache at port ${port} did not start within ${timeoutMs}ms`);
}

/**
 * Get spans that have a function.name attribute.
 */
export function getFunctionSpans(spans: CapturedSpan[]): CapturedSpan[] {
  return spans.filter(s => s.attributes['function.name']);
}

/**
 * Get unique function names from spans.
 */
export function getFunctionNames(spans: CapturedSpan[]): string[] {
  return [...new Set(getFunctionSpans(spans).map(s => s.attributes['function.name'] as string))];
}

/**
 * Get spans that have source location metadata (from Babel plugin).
 */
export function getSpansWithSourceLocation(spans: CapturedSpan[]): CapturedSpan[] {
  return spans.filter(s => s.attributes['code.filepath']);
}

/**
 * Assert that a span has valid source location metadata.
 */
export function assertSpanHasSourceLocation(span: CapturedSpan): void {
  const filepath = span.attributes['code.filepath'];
  if (filepath === undefined) {
    throw new Error(`Span "${span.name}" (function: ${span.attributes['function.name']}) missing code.filepath`);
  }
  // filepath should not be empty
  if (typeof filepath !== 'string' || filepath.length === 0) {
    throw new Error(`Span "${span.name}" has empty code.filepath`);
  }
  // filepath should not reference node_modules (we only trace user code)
  if (filepath.includes('node_modules')) {
    throw new Error(`Span "${span.name}" has code.filepath pointing to node_modules: ${filepath}`);
  }
}

/**
 * Assert that no spans have error status caused by deep-trace itself.
 * Spans might have errors from the app logic (which is fine), but
 * deep-trace instrumentation should never cause errors.
 */
export function assertNoInstrumentationErrors(spans: CapturedSpan[]): void {
  for (const span of spans) {
    // Status code 2 = ERROR in OpenTelemetry
    if (span.status?.code === 2) {
      const msg = span.status.message || '';
      // If the error mentions deep-trace internals, it's a bug
      if (msg.includes('deep-trace') || msg.includes('probe-wrapper') || msg.includes('wrapUserFunction')) {
        throw new Error(
          `Instrumentation error in span "${span.name}": ${msg}`
        );
      }
    }
  }
}
