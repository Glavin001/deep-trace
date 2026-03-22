/**
 * WebSocket server for span ingestion.
 *
 * Separated from instrumentation.node.ts so that importing `ws` does not
 * interfere with vitest's module transformation of the main instrumentation file.
 */

import { WebSocketServer } from 'ws';
import { ingestSpans } from './span-ingestion';
import type { CachedSpan } from './types';

interface SpanCacheLike {
    addCachedSpan(span: CachedSpan): void;
}

interface Logger {
    info(...args: any[]): void;
}

export function setupWebSocket(
    server: import('http').Server,
    spanCache: SpanCacheLike,
    appendToJsonlFn: (span: CachedSpan) => void,
    log: Logger,
    runtimeConfig: { serverHost: string },
    port: number,
): void {
    const wss = new WebSocketServer({ noServer: true });

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

    // Heartbeat to detect dead connections
    const heartbeatInterval = setInterval(() => {
        for (const client of wss.clients) {
            if ((client as any)._isAlive === false) {
                client.terminate();
                continue;
            }
            (client as any)._isAlive = false;
            client.ping();
        }
    }, 30000);

    wss.on('close', () => clearInterval(heartbeatInterval));

    wss.on('connection', (ws) => {
        (ws as any)._isAlive = true;
        ws.on('pong', () => { (ws as any)._isAlive = true; });

        ws.on('message', (data) => {
            try {
                const parsed = JSON.parse(String(data));
                const inputs = Array.isArray(parsed?.batch) ? parsed.batch : [parsed];
                const result = ingestSpans(spanCache, inputs, appendToJsonlFn);

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

    log.info(`WebSocket server attached at ws://${runtimeConfig.serverHost}:${port}/remote-debug/ws`);
}
