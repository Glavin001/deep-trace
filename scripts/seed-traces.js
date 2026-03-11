#!/usr/bin/env node
/**
 * Sends a sample multi-span trace to the local OTel collector.
 * Requires the stack to be running: npm run stack:up
 *
 * Usage:
 *   node scripts/seed-traces.js
 *   OTLP_ENDPOINT=http://localhost:4318/v1/traces node scripts/seed-traces.js
 */
'use strict';

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { trace, context } = require('@opentelemetry/api');

const ENDPOINT = process.env.OTLP_ENDPOINT ?? 'http://localhost:4318/v1/traces';
const SERVICE = process.env.OTEL_SERVICE_NAME ?? 'seed-api';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const sdk = new NodeSDK({
        resource: resourceFromAttributes({ 'service.name': SERVICE }),
        traceExporter: new OTLPTraceExporter({ url: ENDPOINT }),
    });
    sdk.start();

    const tracer = trace.getTracer('seed');

    const rootSpan = tracer.startSpan('seed.request', {
        attributes: { 'seed.run': true, 'http.method': 'GET', 'http.route': '/api/demo' },
    });
    const traceId = rootSpan.spanContext().traceId;

    await context.with(trace.setSpan(context.active(), rootSpan), async () => {
        const authSpan = tracer.startSpan('seed.auth');
        await sleep(5);
        authSpan.end();

        const fetchSpan = tracer.startSpan('seed.fetch_data');
        await context.with(trace.setSpan(context.active(), fetchSpan), async () => {
            const dbSpan = tracer.startSpan('seed.db_query', {
                attributes: { 'db.statement': 'SELECT * FROM items LIMIT 10' },
            });
            await sleep(12);
            dbSpan.end();
        });
        fetchSpan.end();

        const renderSpan = tracer.startSpan('seed.render');
        await sleep(3);
        renderSpan.end();
    });

    rootSpan.end();
    await sdk.shutdown();

    console.log(`Seeded trace: ${traceId}`);
    console.log(`Service:      ${SERVICE}`);
    console.log(`Collector:    ${ENDPOINT}`);
    console.log();
    console.log(`── Grafana ──────────────────────────────────────────────────────`);
    console.log(`Dashboard (recent spans table):`);
    console.log(`  http://localhost:3002/d/deep-trace-overview/deep-trace-overview`);
    console.log();
    console.log(`Explore (full waterfall for this trace):`);
    console.log(`  1. Open http://localhost:3002/explore`);
    console.log(`  2. Query Type → Traces`);
    console.log(`  3. Trace Mode → Trace ID`);
    console.log(`  4. Paste: ${traceId}`);
    console.log(`  5. Run Query`);
}

main().catch((err) => { console.error(err); process.exit(1); });
