/**
 * Integration test for distributed trace context propagation.
 *
 * Verifies that when an HTTP request arrives with a W3C traceparent header
 * (as injected by the browser's patched fetch), the server-side wrapped
 * functions produce spans that belong to the same trace.
 *
 * This simulates the full flow:
 *   Browser (traceparent header) → HTTP server → wrapped user functions
 *   → spans share the browser's trace ID
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';

// Must set env before import so the SDK doesn't start its debug server
process.env.DEBUG_PROBE_PORT = '0';
process.env.DEBUG_PROBE_JSONL = 'false';
process.env.DEBUG_PROBE_LOG = 'false';

import {
    wrapUserFunction,
    flushSpans,
    clearSpans,
    getSpans,
    sdk,
} from '../instrumentation.node';

let server: http.Server;
let port: number;

// Simulate the demo API route's functions (like app/api/demo/route.ts)
const lookupRecommendation = wrapUserFunction(async (term: string) => {
    await new Promise(resolve => setTimeout(resolve, 10));
    return { confidence: 0.98, source: 'mock-model-cache' };
}, 'lookupRecommendation');

const buildNarrative = wrapUserFunction((term: string, confidence: number) => {
    return `Tracing "${term}" with ${Math.round(confidence * 100)}% confidence.`;
}, 'buildNarrative');

// Simulate the GET handler (like the Babel-wrapped export)
// The Babel plugin passes isHttpHandler: true for exported GET/POST/etc.
const handleGet = wrapUserFunction(async (request: any) => {
    const url = new URL(request.url, 'http://localhost');
    const term = url.searchParams.get('term') || 'test';
    const recommendation = await lookupRecommendation(term);
    const narrative = buildNarrative(term, recommendation.confidence);
    return { term, narrative, confidence: recommendation.confidence };
}, 'GET', { isHttpHandler: true });

function httpRequest(
    method: string,
    path: string,
    headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            `http://127.0.0.1:${port}${path}`,
            { method, headers },
            (res) => {
                let data = '';
                res.on('data', chunk => (data += chunk));
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode!, body: JSON.parse(data) });
                    } catch {
                        resolve({ status: res.statusCode!, body: data });
                    }
                });
            },
        );
        req.on('error', reject);
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('timeout'));
        });
        req.end();
    });
}

describe('Distributed trace context propagation', () => {
    beforeAll(async () => {
        // Create an HTTP server that calls our wrapped functions
        // (mirrors what Next.js does: incoming request → route handler)
        await new Promise<void>((resolve) => {
            server = http.createServer(async (req, res) => {
                try {
                    // Build a Request-like object matching what Next.js provides,
                    // with a Headers API (like the Fetch API Headers class)
                    const headerMap = req.headers as Record<string, string>;
                    const requestObj = {
                        url: `http://127.0.0.1${req.url}`,
                        headers: {
                            get(key: string) { return headerMap[key.toLowerCase()] ?? null; },
                        },
                    };
                    const result = await handleGet(requestObj);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } catch (err: any) {
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: err.message }));
                }
            });
            server.listen(0, '127.0.0.1', () => {
                port = (server.address() as any).port;
                resolve();
            });
        });
    }, 15000);

    afterAll(async () => {
        server?.close();
        await sdk.shutdown().catch(() => {});
    });

    beforeEach(() => {
        clearSpans();
    });

    it('should propagate trace context from traceparent header to user function spans', async () => {
        // This is the trace ID that the browser would generate
        const browserTraceId = 'abcdef1234567890abcdef1234567890';
        const browserSpanId = '1234567890abcdef';
        const traceparent = `00-${browserTraceId}-${browserSpanId}-01`;

        // Send a request with the traceparent header (simulating browser's patched fetch)
        const { status, body } = await httpRequest('GET', '/api/demo?term=distributed-test', {
            traceparent,
        });
        expect(status).toBe(200);

        // Flush to ensure all spans are exported to the cache
        await flushSpans();
        // Small delay to let SimpleSpanProcessor finish
        await new Promise(resolve => setTimeout(resolve, 200));

        const spans = getSpans();

        // Find our user function spans
        const getSpan = spans.find(s => s.attributes['function.name'] === 'GET');
        const lookupSpan = spans.find(s => s.attributes['function.name'] === 'lookupRecommendation');
        const narrativeSpan = spans.find(s => s.attributes['function.name'] === 'buildNarrative');

        // All three wrapped functions should have produced spans
        expect(getSpan).toBeDefined();
        expect(lookupSpan).toBeDefined();
        expect(narrativeSpan).toBeDefined();

        // CRITICAL: All spans must share the browser's trace ID
        // This is the whole point of distributed tracing — the server continues
        // the trace that the browser started, not a separate one.
        expect(getSpan!.traceId).toBe(browserTraceId);
        expect(lookupSpan!.traceId).toBe(browserTraceId);
        expect(narrativeSpan!.traceId).toBe(browserTraceId);
    });

    it('should create independent traces when no traceparent header is provided', async () => {
        // Without traceparent, each request gets its own trace
        const { status } = await httpRequest('GET', '/api/demo?term=no-parent');
        expect(status).toBe(200);

        await flushSpans();
        await new Promise(resolve => setTimeout(resolve, 100));

        const spans = getSpans();
        const getSpan = spans.find(s => s.attributes['function.name'] === 'GET');
        expect(getSpan).toBeDefined();

        // Should NOT have the browser trace ID (it should be auto-generated)
        // This confirms the test above isn't a false positive
        expect(getSpan!.traceId).not.toBe('abcdef1234567890abcdef1234567890');
    });

    it('should keep all nested function spans within the same trace', async () => {
        const browserTraceId = 'fedcba0987654321fedcba0987654321';
        const browserSpanId = 'fedcba0987654321';
        const traceparent = `00-${browserTraceId}-${browserSpanId}-01`;

        await httpRequest('GET', '/api/demo?term=hierarchy-test', { traceparent });
        await flushSpans();
        await new Promise(resolve => setTimeout(resolve, 200));

        const spans = getSpans();
        const traceSpans = spans.filter(s => s.traceId === browserTraceId);

        // Should have all three function spans in this trace
        expect(traceSpans.length).toBeGreaterThanOrEqual(3);

        const getSpan = traceSpans.find(s => s.attributes['function.name'] === 'GET');
        const lookupSpan = traceSpans.find(s => s.attributes['function.name'] === 'lookupRecommendation');
        const narrativeSpan = traceSpans.find(s => s.attributes['function.name'] === 'buildNarrative');

        // All functions called within the handler share the browser's trace
        expect(getSpan).toBeDefined();
        expect(lookupSpan).toBeDefined();
        expect(narrativeSpan).toBeDefined();

        // Each nested span should have distinct span IDs (they're separate operations)
        const spanIds = new Set([getSpan!.spanId, lookupSpan!.spanId, narrativeSpan!.spanId]);
        expect(spanIds.size).toBe(3);
    });

    it('should handle multiple concurrent requests with different trace contexts', async () => {
        const traceId1 = '11111111111111111111111111111111';
        const traceId2 = '22222222222222222222222222222222';

        // Fire two requests concurrently with different trace IDs
        const [res1, res2] = await Promise.all([
            httpRequest('GET', '/api/demo?term=concurrent-1', {
                traceparent: `00-${traceId1}-aaaaaaaaaaaaaaaa-01`,
            }),
            httpRequest('GET', '/api/demo?term=concurrent-2', {
                traceparent: `00-${traceId2}-bbbbbbbbbbbbbbbb-01`,
            }),
        ]);

        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);

        await flushSpans();
        await new Promise(resolve => setTimeout(resolve, 100));

        const spans = getSpans();

        // Each request's spans should belong to its own trace
        const trace1Spans = spans.filter(
            s => s.traceId === traceId1 && s.attributes['function.name'],
        );
        const trace2Spans = spans.filter(
            s => s.traceId === traceId2 && s.attributes['function.name'],
        );

        expect(trace1Spans.length).toBeGreaterThanOrEqual(3);
        expect(trace2Spans.length).toBeGreaterThanOrEqual(3);

        // Verify no cross-contamination
        for (const s of trace1Spans) expect(s.traceId).toBe(traceId1);
        for (const s of trace2Spans) expect(s.traceId).toBe(traceId2);
    });
});
