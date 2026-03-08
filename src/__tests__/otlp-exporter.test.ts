import { afterAll, describe, expect, it } from 'vitest';

process.env.DEBUG_PROBE_PORT = '0';
process.env.DEBUG_PROBE_JSONL = 'false';
process.env.DEBUG_PROBE_LOG = 'false';

import { createSpanProcessors, sdk } from '../instrumentation.node';
import { buildRuntimeConfig } from '../runtime-config';

describe('OTLP span processor wiring', () => {
    it('keeps only the local processor when no OTLP endpoint is configured', () => {
        const config = buildRuntimeConfig({
            DEBUG_PROBE_JSONL: 'false',
        });

        const processors = createSpanProcessors(config);
        expect(processors).toHaveLength(1);
    });

    it('adds a batch OTLP processor when an endpoint is configured', () => {
        const config = buildRuntimeConfig({
            DEBUG_PROBE_JSONL: 'false',
            DEBUG_PROBE_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
        });

        const processors = createSpanProcessors(config);
        expect(processors).toHaveLength(2);
    });
});

afterAll(async () => {
    await sdk.shutdown().catch(() => {});
});
