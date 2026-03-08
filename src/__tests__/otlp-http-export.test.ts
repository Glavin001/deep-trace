import http from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DEBUG_PROBE_PORT = '0';
process.env.DEBUG_PROBE_JSONL = 'false';
process.env.DEBUG_PROBE_LOG = 'false';

interface CapturedRequest {
    method?: string;
    url?: string;
    bodyLength: number;
}

let server: http.Server;
let capturedRequests: CapturedRequest[] = [];
let instrumentation: typeof import('../instrumentation.node');

function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now();

    return new Promise((resolve, reject) => {
        const tick = () => {
            if (condition()) {
                resolve();
                return;
            }

            if (Date.now() - start >= timeoutMs) {
                reject(new Error('Timed out waiting for OTLP request'));
                return;
            }

            setTimeout(tick, 50);
        };

        tick();
    });
}

describe('OTLP HTTP export', () => {
    beforeAll(async () => {
        server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            req.on('end', () => {
                capturedRequests.push({
                    method: req.method,
                    url: req.url,
                    bodyLength: Buffer.concat(chunks).length,
                });
                res.writeHead(200);
                res.end();
            });
        });

        await new Promise<void>((resolve) => {
            server.listen(43181, '127.0.0.1', () => resolve());
        });

        process.env.DEBUG_PROBE_OTLP_ENDPOINT = 'http://127.0.0.1:43181/v1/traces';
        process.env.OTEL_SERVICE_NAME = 'otlp-http-export-test';

        instrumentation = await import('../instrumentation.node');
    });

    afterAll(async () => {
        await instrumentation?.sdk.shutdown().catch(() => {});
        await new Promise<void>((resolve, reject) => {
            server?.close(error => error ? reject(error) : resolve());
        });
        delete process.env.DEBUG_PROBE_OTLP_ENDPOINT;
        delete process.env.OTEL_SERVICE_NAME;
    });

    it('posts ended spans to the configured OTLP HTTP endpoint', async () => {
        capturedRequests = [];

        const wrapped = instrumentation.wrapUserFunction(() => 'ok', 'otlpHttpExported');
        wrapped();

        await instrumentation.flushSpans();
        await waitFor(() => capturedRequests.length > 0);

        expect(capturedRequests[0]?.method).toBe('POST');
        expect(capturedRequests[0]?.url).toBe('/v1/traces');
        expect(capturedRequests[0]?.bodyLength).toBeGreaterThan(0);
    });
});
