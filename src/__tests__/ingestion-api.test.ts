/**
 * Integration tests for the REST and WebSocket ingestion APIs.
 *
 * Tests the POST /remote-debug/spans endpoint and the
 * ws://host/remote-debug/ws WebSocket endpoint.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import express from 'express';
import WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { ingestSpans } from '../span-ingestion';
import type { CachedSpan } from '../types';

// ─── In-memory SpanCache mock ────────────────────────────────────────────────

class MockSpanCache {
    private spans = new Map<string, CachedSpan>();

    addCachedSpan(span: CachedSpan): void {
        this.spans.set(span.spanId, span);
    }

    getAllSpans(): CachedSpan[] {
        return Array.from(this.spans.values());
    }

    getByTraceId(traceId: string): CachedSpan[] {
        return this.getAllSpans().filter(s => s.traceId === traceId);
    }

    clear(): void {
        this.spans.clear();
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function validSpan(overrides: Record<string, any> = {}) {
    return {
        traceId: 'a'.repeat(32),
        spanId: randomHex16(),
        name: 'testFunction',
        startTime: 1700000000000000,
        endTime: 1700000001000000,
        ...overrides,
    };
}

function randomHex16(): string {
    return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function httpPost(port: number, path: string, body: any): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = http.request(
            `http://127.0.0.1:${port}${path}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
            (res) => {
                let chunks = '';
                res.on('data', chunk => chunks += chunk);
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode!, body: JSON.parse(chunks) });
                    } catch {
                        resolve({ status: res.statusCode!, body: chunks });
                    }
                });
            },
        );
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
        req.write(data);
        req.end();
    });
}

function httpGet(port: number, path: string): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            `http://127.0.0.1:${port}${path}`,
            { method: 'GET' },
            (res) => {
                let chunks = '';
                res.on('data', chunk => chunks += chunk);
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode!, body: JSON.parse(chunks) });
                    } catch {
                        resolve({ status: res.statusCode!, body: chunks });
                    }
                });
            },
        );
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
    });
}

function wsMessage(ws: WebSocket, message: any): Promise<any> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('ws response timeout')), 5000);
        ws.once('message', (data) => {
            clearTimeout(timeout);
            resolve(JSON.parse(String(data)));
        });
        ws.send(JSON.stringify(message));
    });
}

// ─── Test Setup ──────────────────────────────────────────────────────────────

let server: http.Server;
let port: number;
let spanCache: MockSpanCache;
const noopJsonl = () => {};

describe('Ingestion API', () => {
    beforeAll(async () => {
        spanCache = new MockSpanCache();
        const app = express();
        app.use(express.json({ limit: '1mb' }));

        // GET endpoint to verify spans were ingested
        app.get('/remote-debug/spans', (_req, res) => {
            const spans = spanCache.getAllSpans();
            res.json({ success: true, data: { spans, total: spans.length } });
        });

        // POST ingestion endpoint
        app.post('/remote-debug/spans', (req, res) => {
            try {
                const body = req.body;
                const inputs = Array.isArray(body) ? body : [body];
                const result = ingestSpans(spanCache, inputs, noopJsonl);

                if (result.accepted === 0 && result.rejected.length > 0) {
                    res.status(400).json({
                        success: false,
                        error: 'No valid spans in request',
                        rejected: result.rejected,
                    });
                } else {
                    const response: any = { success: true, accepted: result.accepted };
                    if (result.rejected.length > 0) response.rejected = result.rejected;
                    res.json(response);
                }
            } catch (error: any) {
                res.status(500).json({ success: false, error: error?.message });
            }
        });

        // WebSocket server
        const wss = new WebSocketServer({ noServer: true });

        await new Promise<void>((resolve) => {
            server = app.listen(0, () => {
                port = (server.address() as any).port;
                resolve();
            });
        });

        server.on('upgrade', (request, socket, head) => {
            const url = new URL(request.url || '/', `http://${request.headers.host}`);
            if (url.pathname === '/remote-debug/ws') {
                wss.handleUpgrade(request, socket, head, (ws) => {
                    wss.emit('connection', ws, request);
                });
            } else {
                socket.destroy();
            }
        });

        wss.on('connection', (ws) => {
            ws.on('message', (data) => {
                try {
                    const parsed = JSON.parse(String(data));
                    const inputs = Array.isArray(parsed?.batch) ? parsed.batch : [parsed];
                    const result = ingestSpans(spanCache, inputs, noopJsonl);

                    if (result.accepted === 0 && result.rejected.length > 0) {
                        ws.send(JSON.stringify({
                            ok: false,
                            error: 'validation failed',
                            details: result.rejected,
                        }));
                    } else {
                        const response: any = { ok: true, accepted: result.accepted };
                        if (result.rejected.length > 0) response.rejected = result.rejected;
                        ws.send(JSON.stringify(response));
                    }
                } catch (err: any) {
                    ws.send(JSON.stringify({ ok: false, error: err?.message || 'invalid message' }));
                }
            });
        });
    });

    afterAll(() => {
        server?.close();
    });

    // ─── REST POST Tests ─────────────────────────────────────────────────

    describe('POST /remote-debug/spans', () => {
        it('should ingest a single span', async () => {
            spanCache.clear();
            const span = validSpan();
            const { status, body } = await httpPost(port, '/remote-debug/spans', span);
            expect(status).toBe(200);
            expect(body.success).toBe(true);
            expect(body.accepted).toBe(1);

            // Verify span is in cache
            const { body: getBody } = await httpGet(port, '/remote-debug/spans');
            expect(getBody.data.total).toBe(1);
            expect(getBody.data.spans[0].name).toBe('testFunction');
        });

        it('should ingest a batch of spans', async () => {
            spanCache.clear();
            const spans = [validSpan(), validSpan({ name: 'otherFunction' })];
            const { status, body } = await httpPost(port, '/remote-debug/spans', spans);
            expect(status).toBe(200);
            expect(body.success).toBe(true);
            expect(body.accepted).toBe(2);
        });

        it('should return 400 for completely invalid data', async () => {
            spanCache.clear();
            const { status, body } = await httpPost(port, '/remote-debug/spans', { bad: 'data' });
            expect(status).toBe(400);
            expect(body.success).toBe(false);
            expect(body.rejected.length).toBe(1);
        });

        it('should return partial success for mixed valid/invalid', async () => {
            spanCache.clear();
            const { status, body } = await httpPost(port, '/remote-debug/spans', [
                validSpan(),
                { bad: 'data' },
            ]);
            expect(status).toBe(200);
            expect(body.success).toBe(true);
            expect(body.accepted).toBe(1);
            expect(body.rejected.length).toBe(1);
            expect(body.rejected[0].index).toBe(1);
        });

        it('should set language attribute', async () => {
            spanCache.clear();
            const span = validSpan({ language: 'python' });
            await httpPost(port, '/remote-debug/spans', span);
            const { body } = await httpGet(port, '/remote-debug/spans');
            expect(body.data.spans[0].attributes['language']).toBe('python');
        });

        it('should normalize ISO 8601 timestamps', async () => {
            spanCache.clear();
            const span = validSpan({
                startTime: '2023-11-14T22:13:20.000Z',
                endTime: '2023-11-14T22:13:21.000Z',
            });
            await httpPost(port, '/remote-debug/spans', span);
            const { body } = await httpGet(port, '/remote-debug/spans');
            expect(typeof body.data.spans[0].startTime).toBe('number');
            expect(typeof body.data.spans[0].endTime).toBe('number');
        });
    });

    // ─── WebSocket Tests ─────────────────────────────────────────────────

    describe('WebSocket /remote-debug/ws', () => {
        function connectWs(): Promise<WebSocket> {
            return new Promise((resolve, reject) => {
                const ws = new WebSocket(`ws://127.0.0.1:${port}/remote-debug/ws`);
                ws.on('open', () => resolve(ws));
                ws.on('error', reject);
            });
        }

        it('should accept a single span and send ack', async () => {
            spanCache.clear();
            const ws = await connectWs();
            try {
                const response = await wsMessage(ws, validSpan());
                expect(response.ok).toBe(true);
                expect(response.accepted).toBe(1);

                const { body } = await httpGet(port, '/remote-debug/spans');
                expect(body.data.total).toBe(1);
            } finally {
                ws.close();
            }
        });

        it('should accept a batch and send ack', async () => {
            spanCache.clear();
            const ws = await connectWs();
            try {
                const response = await wsMessage(ws, {
                    batch: [validSpan(), validSpan({ name: 'batchFn' })],
                });
                expect(response.ok).toBe(true);
                expect(response.accepted).toBe(2);
            } finally {
                ws.close();
            }
        });

        it('should return error for invalid span', async () => {
            spanCache.clear();
            const ws = await connectWs();
            try {
                const response = await wsMessage(ws, { bad: 'data' });
                expect(response.ok).toBe(false);
                expect(response.error).toBe('validation failed');
                expect(response.details.length).toBe(1);
            } finally {
                ws.close();
            }
        });

        it('should handle invalid JSON gracefully', async () => {
            spanCache.clear();
            const ws = await connectWs();
            try {
                const response = await new Promise<any>((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('timeout')), 5000);
                    ws.once('message', (data) => {
                        clearTimeout(timeout);
                        resolve(JSON.parse(String(data)));
                    });
                    ws.send('not valid json {{{');
                });
                expect(response.ok).toBe(false);
                expect(response.error).toBeTruthy();
            } finally {
                ws.close();
            }
        });

        it('should handle multiple sequential messages', async () => {
            spanCache.clear();
            const ws = await connectWs();
            try {
                const r1 = await wsMessage(ws, validSpan());
                expect(r1.ok).toBe(true);

                const r2 = await wsMessage(ws, validSpan({ name: 'second' }));
                expect(r2.ok).toBe(true);

                const { body } = await httpGet(port, '/remote-debug/spans');
                expect(body.data.total).toBe(2);
            } finally {
                ws.close();
            }
        });
    });
});
