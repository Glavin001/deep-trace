import { describe, expect, it } from 'vitest';

import { buildRuntimeConfig, isInternalSpanRequest } from '../runtime-config';

describe('runtime config helpers', () => {
    it('normalizes a bare OTLP endpoint to the traces path', () => {
        const config = buildRuntimeConfig({
            DEBUG_PROBE_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
        });

        expect(config.otlpHttpEndpoint).toBe('http://127.0.0.1:4318/v1/traces');
    });

    it('parses OTLP headers and service name overrides', () => {
        const config = buildRuntimeConfig({
            OTEL_SERVICE_NAME: 'demo-api',
            OTEL_EXPORTER_OTLP_HEADERS: 'x-tenant=local,x-demo=true',
        });

        expect(config.serviceName).toBe('demo-api');
        expect(config.otlpHeaders).toEqual({
            'x-tenant': 'local',
            'x-demo': 'true',
        });
    });

    it('detects internal debug API spans', () => {
        const config = buildRuntimeConfig({
            DEBUG_PROBE_PORT: '43210',
        });

        expect(
            isInternalSpanRequest(
                {
                    url: 'http://127.0.0.1:43210/remote-debug/spans',
                    host: '127.0.0.1:43210',
                    target: '/remote-debug/spans',
                },
                config,
            ),
        ).toBe(true);
    });

    it('detects OTLP exporter spans aimed at the collector', () => {
        const config = buildRuntimeConfig({
            DEBUG_PROBE_OTLP_ENDPOINT: 'http://localhost:4318/v1/traces',
        });

        expect(
            isInternalSpanRequest(
                {
                    url: 'http://localhost:4318/v1/traces',
                    host: 'localhost:4318',
                    target: '/v1/traces',
                },
                config,
            ),
        ).toBe(true);
    });

    it('does not mark regular application traffic as internal', () => {
        const config = buildRuntimeConfig({
            DEBUG_PROBE_OTLP_ENDPOINT: 'http://localhost:4318/v1/traces',
            DEBUG_PROBE_PORT: '43210',
        });

        expect(
            isInternalSpanRequest(
                {
                    url: 'http://localhost:3000/api/demo',
                    host: 'localhost:3000',
                    target: '/api/demo',
                },
                config,
            ),
        ).toBe(false);
    });
});
