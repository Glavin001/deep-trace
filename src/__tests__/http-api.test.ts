/**
 * Tests for the HTTP API server endpoints
 *
 * Creates an Express app that mirrors the instrumentation.node.ts routes,
 * backed by the same SpanCache instance. This avoids vitest/server binding
 * issues while testing the actual route logic.
 *
 * Verifies:
 * - GET /remote-debug/spans (with query params: traceId, functionName, limit)
 * - GET /remote-debug/traces
 * - GET /remote-debug/spans/stats
 * - DELETE /remote-debug/spans
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import express from 'express';

// Must set env before import
process.env.DEBUG_PROBE_PORT = '0'; // Don't auto-start server
process.env.DEBUG_PROBE_JSONL = 'false';
process.env.DEBUG_PROBE_LOG = 'false';

import {
    wrapUserFunction,
    flushSpans,
    clearSpans,
    getSpanCache,
    sdk,
} from '../instrumentation.node';

let server: http.Server;
let port: number;

function httpRequest(method: string, path: string): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            `http://127.0.0.1:${port}${path}`,
            { method },
            (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
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
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
    });
}

const httpGet = (path: string) => httpRequest('GET', path);
const httpDelete = (path: string) => httpRequest('DELETE', path);

describe('HTTP API endpoints', () => {
    beforeAll(async () => {
        // Create the same Express routes that instrumentation.node.ts creates
        const spanCache = getSpanCache();
        const app = express();

        function formatSpan(s: any) {
            return {
                traceId: s.traceId,
                spanId: s.spanId,
                parentSpanId: s.parentSpanId,
                name: s.name,
                kind: s.kind,
                startTime: new Date(s.startTime / 1000000).toISOString(),
                endTime: new Date(s.endTime / 1000000).toISOString(),
                durationMs: s.duration / 1000000,
                status: s.status,
                attributes: s.attributes,
                events: s.events,
                links: s.links,
            };
        }

        app.get('/remote-debug/spans', (req, res) => {
            try {
                const startTime = req.query.startTime ? parseInt(String(req.query.startTime)) : undefined;
                const endTime = req.query.endTime ? parseInt(String(req.query.endTime)) : undefined;
                const traceId = req.query.traceId ? String(req.query.traceId) : undefined;
                const functionName = req.query.functionName ? String(req.query.functionName) : undefined;
                const limit = req.query.limit ? parseInt(String(req.query.limit)) : undefined;

                let spans: any[];
                if (typeof startTime === 'number' && typeof endTime === 'number') {
                    spans = spanCache.getByTimeRange(startTime, endTime);
                } else if (traceId) {
                    spans = spanCache.getByTraceId(traceId);
                } else if (functionName) {
                    spans = spanCache.getByFunctionName(functionName);
                } else {
                    spans = spanCache.getAllSpans(limit);
                }
                res.json({ success: true, data: { spans: spans.map(formatSpan), total: spans.length } });
            } catch (error: any) {
                res.status(500).json({ success: false, error: error?.message });
            }
        });

        app.get('/remote-debug/traces', (req, res) => {
            try {
                const startTime = req.query.startTime ? parseInt(String(req.query.startTime)) : undefined;
                const endTime = req.query.endTime ? parseInt(String(req.query.endTime)) : undefined;
                const limit = req.query.limit ? parseInt(String(req.query.limit)) : undefined;
                res.json(spanCache.getTracesWithSpans(startTime, endTime, limit));
            } catch (error: any) {
                res.status(500).json({ success: false, error: error?.message });
            }
        });

        app.get('/remote-debug/spans/stats', (_req, res) => {
            try {
                const stats = spanCache.statistics();
                res.json({
                    success: true,
                    data: {
                        ...stats,
                        oldestSpan: stats.oldestSpan ? new Date(stats.oldestSpan / 1000000).toISOString() : null,
                        newestSpan: stats.newestSpan ? new Date(stats.newestSpan / 1000000).toISOString() : null,
                        averageDurationMs: stats.averageDuration / 1000000,
                    },
                });
            } catch (error: any) {
                res.status(500).json({ success: false, error: error?.message });
            }
        });

        app.delete('/remote-debug/spans', (_req, res) => {
            try {
                spanCache.clear();
                res.json({ success: true, message: 'Cache cleared' });
            } catch (error: any) {
                res.status(500).json({ success: false, error: error?.message });
            }
        });

        // Start on random port
        await new Promise<void>((resolve) => {
            server = app.listen(0, () => {
                port = (server.address() as any).port;
                resolve();
            });
        });

        // Seed some spans
        clearSpans();
        const add = wrapUserFunction((a: number, b: number) => a + b, 'httpTestAdd');
        const mul = wrapUserFunction((a: number, b: number) => a * b, 'httpTestMul');
        add(1, 2);
        add(3, 4);
        mul(5, 6);
        await flushSpans();
    }, 15000);

    afterAll(async () => {
        server?.close();
        await sdk.shutdown().catch(() => {});
    });

    describe('GET /remote-debug/spans', () => {
        it('should return all spans', async () => {
            const { status, body } = await httpGet('/remote-debug/spans');
            expect(status).toBe(200);
            expect(body.success).toBe(true);
            expect(body.data.spans.length).toBeGreaterThanOrEqual(3);
            expect(body.data.total).toBeGreaterThanOrEqual(3);
        });

        it('should filter by functionName', async () => {
            const { status, body } = await httpGet('/remote-debug/spans?functionName=httpTestAdd');
            expect(status).toBe(200);
            expect(body.success).toBe(true);
            expect(body.data.spans.length).toBe(2);
            for (const span of body.data.spans) {
                expect(span.attributes['function.name']).toBe('httpTestAdd');
            }
        });

        it('should filter by traceId', async () => {
            const allRes = await httpGet('/remote-debug/spans');
            const traceId = allRes.body.data.spans[0].traceId;

            const { status, body } = await httpGet(`/remote-debug/spans?traceId=${traceId}`);
            expect(status).toBe(200);
            expect(body.success).toBe(true);
            for (const span of body.data.spans) {
                expect(span.traceId).toBe(traceId);
            }
        });

        it('should respect limit parameter', async () => {
            const { status, body } = await httpGet('/remote-debug/spans?limit=1');
            expect(status).toBe(200);
            expect(body.data.spans.length).toBe(1);
        });

        it('should return formatted span with expected fields', async () => {
            const { body } = await httpGet('/remote-debug/spans?limit=1');
            const span = body.data.spans[0];

            expect(span).toHaveProperty('traceId');
            expect(span).toHaveProperty('spanId');
            expect(span).toHaveProperty('name');
            expect(span).toHaveProperty('startTime');
            expect(span).toHaveProperty('endTime');
            expect(span).toHaveProperty('durationMs');
            expect(span).toHaveProperty('status');
            expect(span).toHaveProperty('attributes');
            expect(typeof span.durationMs).toBe('number');
            expect(span.startTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        });
    });

    describe('GET /remote-debug/traces', () => {
        it('should return traces grouped by traceId', async () => {
            const { status, body } = await httpGet('/remote-debug/traces');
            expect(status).toBe(200);
            expect(Array.isArray(body)).toBe(true);
            expect(body.length).toBeGreaterThan(0);

            const trace = body[0];
            expect(trace).toHaveProperty('traceId');
            expect(trace).toHaveProperty('spans');
            expect(trace).toHaveProperty('startTimeMilli');
            expect(trace.type).toBe('ts');
        });
    });

    describe('GET /remote-debug/spans/stats', () => {
        it('should return statistics', async () => {
            const { status, body } = await httpGet('/remote-debug/spans/stats');
            expect(status).toBe(200);
            expect(body.success).toBe(true);
            expect(body.data.totalSpans).toBeGreaterThanOrEqual(3);
            expect(body.data.totalFunctions).toBeGreaterThanOrEqual(2);
            expect(body.data.totalTraces).toBeGreaterThanOrEqual(1);
            expect(typeof body.data.averageDurationMs).toBe('number');
        });
    });

    describe('DELETE /remote-debug/spans', () => {
        it('should clear all spans', async () => {
            const { status, body } = await httpDelete('/remote-debug/spans');
            expect(status).toBe(200);
            expect(body.success).toBe(true);
            expect(body.message).toBe('Cache cleared');

            const { body: after } = await httpGet('/remote-debug/spans');
            expect(after.data.total).toBe(0);
        });
    });
});
