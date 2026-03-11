/**
 * End-to-end stack test.
 * Seeds traces into the OTel collector and verifies they land in ClickHouse.
 *
 * Requires the stack to be running: npm run stack:up
 * Run with: npm run test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { context, trace, type Tracer } from '@opentelemetry/api';

const OTLP_ENDPOINT = process.env.OTLP_ENDPOINT ?? 'http://localhost:4318/v1/traces';
const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const CLICKHOUSE_AUTH = 'Basic ' + Buffer.from('otel:otel').toString('base64');

async function queryClickHouse(sql: string): Promise<string> {
    const res = await fetch(`${CLICKHOUSE_URL}/?database=otel`, {
        method: 'POST',
        headers: { Authorization: CLICKHOUSE_AUTH, 'Content-Type': 'text/plain' },
        body: sql,
    });
    if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${await res.text()}`);
    return res.text();
}

async function pollForTrace(traceId: string, maxMs = 15000): Promise<number> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        const text = await queryClickHouse(
            `SELECT count() FROM otel_traces WHERE TraceId = '${traceId}'`,
        );
        const count = parseInt(text.trim(), 10);
        if (count > 0) return count;
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Trace ${traceId} not found in ClickHouse within ${maxMs}ms`);
}

async function emitTrace(tracer: Tracer): Promise<string> {
    const rootSpan = tracer.startSpan('e2e.root', { attributes: { 'e2e.test': true } });
    const traceId = rootSpan.spanContext().traceId;

    await context.with(trace.setSpan(context.active(), rootSpan), async () => {
        const child = tracer.startSpan('e2e.child');
        await new Promise((r) => setTimeout(r, 5));
        child.end();
    });

    rootSpan.end();
    return traceId;
}

describe('stack e2e', () => {
    let sdk: NodeSDK;
    let tracer: Tracer;

    beforeAll(async () => {
        sdk = new NodeSDK({
            resource: resourceFromAttributes({ 'service.name': 'stack-e2e-test' }),
            traceExporter: new OTLPTraceExporter({ url: OTLP_ENDPOINT }),
        });
        sdk.start();
        tracer = trace.getTracer('stack-e2e');
    });

    afterAll(async () => {
        await sdk.shutdown();
    });

    it('collector receives spans and ClickHouse stores them', async () => {
        const traceId = await emitTrace(tracer);
        const spanCount = await pollForTrace(traceId);
        // root span + child span
        expect(spanCount).toBeGreaterThanOrEqual(2);
    }, 25000);

    it('stored spans have expected parent/child structure', async () => {
        const traceId = await emitTrace(tracer);
        await pollForTrace(traceId);

        const text = await queryClickHouse(
            `SELECT ServiceName, SpanName, ParentSpanId
             FROM otel_traces
             WHERE TraceId = '${traceId}'
             ORDER BY Timestamp ASC
             FORMAT JSONEachRow`,
        );

        const rows = text
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l));

        const root = rows.find((r: any) => r.SpanName === 'e2e.root');
        const child = rows.find((r: any) => r.SpanName === 'e2e.child');

        expect(root).toBeDefined();
        expect(child).toBeDefined();
        expect(root.ParentSpanId).toBe('');
        expect(child.ParentSpanId).not.toBe('');
    }, 25000);
});
