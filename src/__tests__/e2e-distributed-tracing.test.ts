/**
 * End-to-end distributed tracing test.
 *
 * This test does what a user would do:
 * 1. Starts the real Next.js demo server (with Babel transforms, real route handlers)
 * 2. Sends a request to /api/demo with a traceparent header
 *    (exactly what the browser's patched fetch does when you click the button)
 * 3. Queries the span cache HTTP API at :43210 to retrieve the trace
 * 4. Verifies the trace flows from browser → server → nested functions
 *
 * No mocks, no simulations — this is the real app running end to end.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const DEMO_DIR = path.resolve(__dirname, '../../demos/next-fullstack');
// Use a unique port for e2e tests to avoid conflicts with dev server
const APP_PORT = 3884;
const SPAN_CACHE_PORT = 43211;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;
const SPAN_CACHE_URL = `http://127.0.0.1:${SPAN_CACHE_PORT}`;

let serverProcess: ChildProcess | null = null;

async function waitForServer(url: string, timeoutMs = 60000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
            if (resp.ok || resp.status < 500) return;
        } catch {
            // Not ready yet
        }
        await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`);
}

async function clearSpanCache(): Promise<void> {
    try {
        await fetch(`${SPAN_CACHE_URL}/remote-debug/spans`, { method: 'DELETE' });
    } catch {
        // Cache might not be ready yet
    }
}

async function getTraces(): Promise<any[]> {
    const resp = await fetch(`${SPAN_CACHE_URL}/remote-debug/traces?limit=10`);
    if (!resp.ok) throw new Error(`Span cache returned ${resp.status}`);
    return resp.json();
}

async function getSpansByTraceId(traceId: string): Promise<any> {
    const resp = await fetch(`${SPAN_CACHE_URL}/remote-debug/spans?traceId=${traceId}`);
    if (!resp.ok) throw new Error(`Span cache returned ${resp.status}`);
    return resp.json();
}

describe('E2E: Distributed tracing through the real Next.js demo', () => {
    beforeAll(async () => {
        // Clean up any stale lock files from previous runs
        const lockFile = path.join(DEMO_DIR, '.next/dev/lock');
        try { fs.unlinkSync(lockFile); } catch { /* no lock file */ }

        // Kill any leftover processes on our ports
        try { execSync(`kill $(lsof -t -i :${APP_PORT}) 2>/dev/null`, { stdio: 'ignore' }); } catch { /* nothing to kill */ }
        try { execSync(`kill $(lsof -t -i :${SPAN_CACHE_PORT}) 2>/dev/null`, { stdio: 'ignore' }); } catch { /* nothing to kill */ }

        // Start the real Next.js dev server
        serverProcess = spawn(
            'npx', ['next', 'dev', '--port', String(APP_PORT)],
            {
            cwd: DEMO_DIR,
            env: {
                ...process.env,
                // Don't send spans to an external collector (it might not be running)
                DEBUG_PROBE_OTLP_ENDPOINT: '',
                OTEL_SERVICE_NAME: 'e2e-test-api',
                DEBUG_PROBE_PORT: String(SPAN_CACHE_PORT),
                NODE_ENV: 'development',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: true,
        });

        // Log server output for debugging
        serverProcess.stdout?.on('data', (data: Buffer) => {
            const line = data.toString().trim();
            if (line) console.log(`[next] ${line}`);
        });
        serverProcess.stderr?.on('data', (data: Buffer) => {
            const line = data.toString().trim();
            if (line) console.log(`[next:err] ${line}`);
        });

        // Wait for both the Next.js server and the span cache to be ready
        console.log('Waiting for Next.js dev server...');
        await waitForServer(APP_URL);
        console.log('Next.js ready. Waiting for span cache...');
        await waitForServer(`${SPAN_CACHE_URL}/remote-debug/spans/stats`);
        console.log('Span cache ready. Starting tests.');

        // Clear any spans from startup
        await clearSpanCache();
    }, 90000);

    afterAll(async () => {
        if (serverProcess && serverProcess.pid) {
            // Kill the entire process tree (Next.js spawns child processes)
            try {
                process.kill(-serverProcess.pid, 'SIGTERM');
            } catch {
                serverProcess.kill('SIGTERM');
            }
            await new Promise(r => setTimeout(r, 2000));
            try {
                if (!serverProcess.killed) process.kill(-serverProcess.pid, 'SIGKILL');
            } catch {
                if (!serverProcess.killed) serverProcess.kill('SIGKILL');
            }
        }
    });

    it('should produce a distributed trace when calling /api/demo with traceparent', async () => {
        // Generate a known trace ID (this is what the browser would create)
        const browserTraceId = 'e2e00000000000000000000000000001';
        const browserSpanId = 'e2e0000000000001';
        const traceparent = `00-${browserTraceId}-${browserSpanId}-01`;

        // Hit the real API endpoint — exactly what happens when you click the button
        // The browser's patched fetch adds the traceparent; we do the same here
        const apiResponse = await fetch(`${APP_URL}/api/demo?term=e2e-distributed-test`, {
            headers: {
                traceparent,
                'x-demo-source': 'e2e-test',
            },
        });
        expect(apiResponse.ok).toBe(true);

        const apiBody = await apiResponse.json();
        console.log('API response:', apiBody);

        // Wait for spans to be flushed to the cache
        await new Promise(r => setTimeout(r, 2000));

        // Query the span cache — this is the same data you'd see in Grafana/Jaeger
        const traceResult = await getSpansByTraceId(browserTraceId);
        console.log('Trace result:', JSON.stringify(traceResult, null, 2));

        expect(traceResult.success).toBe(true);
        const spans = traceResult.data.spans;

        // Extract the function spans
        const functionSpans = spans.filter(
            (s: any) => s.attributes['function.name'],
        );
        const functionNames = functionSpans.map(
            (s: any) => s.attributes['function.name'],
        );

        console.log('Function spans in trace:', functionNames);
        console.log('Total spans:', spans.length);

        // CRITICAL ASSERTIONS:
        // The server must have produced spans under the browser's trace ID.
        // This proves the distributed trace flows from browser → server.
        expect(spans.length).toBeGreaterThan(0);

        // The GET handler span must be present (this is the Babel-wrapped route handler)
        expect(functionNames).toContain('GET');

        // The nested function calls must also be in the same trace
        expect(functionNames).toContain('lookupRecommendation');
        expect(functionNames).toContain('buildNarrative');

        // Every span must belong to the browser's trace
        for (const span of spans) {
            expect(span.traceId).toBe(browserTraceId);
        }
    }, 30000);

    it('should produce separate traces for separate requests', async () => {
        const traceId1 = 'e2e00000000000000000000000000002';
        const traceId2 = 'e2e00000000000000000000000000003';

        // Two separate "browser sessions" hitting the API concurrently
        const [resp1, resp2] = await Promise.all([
            fetch(`${APP_URL}/api/demo?term=session-1`, {
                headers: { traceparent: `00-${traceId1}-aaaaaaaaaaaaaaaa-01` },
            }),
            fetch(`${APP_URL}/api/demo?term=session-2`, {
                headers: { traceparent: `00-${traceId2}-bbbbbbbbbbbbbbbb-01` },
            }),
        ]);

        expect(resp1.ok).toBe(true);
        expect(resp2.ok).toBe(true);

        await new Promise(r => setTimeout(r, 2000));

        const trace1 = await getSpansByTraceId(traceId1);
        const trace2 = await getSpansByTraceId(traceId2);

        // Each request should have its own trace with its own spans
        const trace1Functions = trace1.data.spans
            .filter((s: any) => s.attributes['function.name'])
            .map((s: any) => s.attributes['function.name']);
        const trace2Functions = trace2.data.spans
            .filter((s: any) => s.attributes['function.name'])
            .map((s: any) => s.attributes['function.name']);

        console.log('Trace 1 functions:', trace1Functions);
        console.log('Trace 2 functions:', trace2Functions);

        // Both traces should have the full function call chain
        expect(trace1Functions).toContain('GET');
        expect(trace1Functions).toContain('lookupRecommendation');
        expect(trace2Functions).toContain('GET');
        expect(trace2Functions).toContain('lookupRecommendation');

        // No cross-contamination
        for (const span of trace1.data.spans) {
            expect(span.traceId).toBe(traceId1);
        }
        for (const span of trace2.data.spans) {
            expect(span.traceId).toBe(traceId2);
        }
    }, 30000);

    it('should show the full span details with source location metadata', async () => {
        const browserTraceId = 'e2e00000000000000000000000000004';
        const traceparent = `00-${browserTraceId}-cccccccccccccccc-01`;

        await fetch(`${APP_URL}/api/demo?term=metadata-test`, {
            headers: { traceparent },
        });

        await new Promise(r => setTimeout(r, 2000));

        const traceResult = await getSpansByTraceId(browserTraceId);
        const spans = traceResult.data.spans;
        const getSpan = spans.find(
            (s: any) => s.attributes['function.name'] === 'GET',
        );

        expect(getSpan).toBeDefined();

        console.log('GET span details:');
        console.log('  traceId:', getSpan.traceId);
        console.log('  spanId:', getSpan.spanId);
        console.log('  name:', getSpan.name);
        console.log('  duration:', getSpan.durationMs, 'ms');
        console.log('  code.filepath:', getSpan.attributes['code.filepath']);
        console.log('  function.args.count:', getSpan.attributes['function.args.count']);

        // Should have source location from the Babel plugin
        expect(getSpan.attributes['code.filepath']).toBeDefined();
        expect(getSpan.attributes['code.filepath']).toContain('api/demo/route');

        // Should have captured the function arguments
        expect(getSpan.attributes['function.args.count']).toBeGreaterThanOrEqual(1);

        // Duration should be non-zero (span was started and ended)
        expect(getSpan.durationMs).toBeGreaterThan(0);
    }, 30000);
});
