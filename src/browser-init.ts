/**
 * browser-init.ts — Zero-code browser instrumentation entry point.
 *
 * Import this single file to automatically:
 *  1. Initialize OpenTelemetry browser tracing (WebTracerProvider)
 *  2. Initialize React fiber instrumentation via bippy (must load before React)
 *  3. Patch globalThis.fetch to auto-inject trace context headers (W3C traceparent)
 *
 * Usage in Next.js 15.3+ (instrumentation-client.ts):
 *   import 'deep-trace/browser';
 *
 * Usage in Vite (top of main entry):
 *   import 'deep-trace/browser';
 *
 * No other imports or API calls needed in application code.
 */

import { context, propagation, trace } from '@opentelemetry/api';
import { initReactInstrumentation } from './react-fiber-extractor';

// ===== Configuration (env vars / globals) =====

declare global {
    interface Window {
        __deepTraceInitialized?: boolean;
        __deepTraceConfig?: {
            otlpEndpoint?: string;
            serviceName?: string;
            environment?: string;
        };
    }
}

// Support Next.js NEXT_PUBLIC_ env vars and direct config
function getConfig() {
    const windowConfig = typeof window !== 'undefined' ? window.__deepTraceConfig : undefined;
    return {
        otlpEndpoint:
            windowConfig?.otlpEndpoint
            || (typeof process !== 'undefined' ? process.env?.NEXT_PUBLIC_OTLP_HTTP_ENDPOINT : undefined)
            || 'http://127.0.0.1:4318/v1/traces',
        serviceName:
            windowConfig?.serviceName
            || (typeof process !== 'undefined' ? process.env?.NEXT_PUBLIC_OTEL_SERVICE_NAME : undefined)
            || 'deep-trace-web',
        environment:
            windowConfig?.environment
            || 'local-dev',
    };
}

// ===== 1. React Fiber Instrumentation (must happen before React loads) =====

initReactInstrumentation();

// ===== 2. Browser Telemetry Initialization =====

let providerInitialized = false;

async function initBrowserTelemetry(): Promise<void> {
    if (typeof window === 'undefined') return;
    if (window.__deepTraceInitialized) return;

    try {
        // Dynamic imports — these packages may not be installed in all environments
        const [
            { WebTracerProvider },
            { SimpleSpanProcessor },
            { OTLPTraceExporter },
            { resourceFromAttributes },
            { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_DEPLOYMENT_ENVIRONMENT },
        ] = await Promise.all([
            import('@opentelemetry/sdk-trace-web'),
            import('@opentelemetry/sdk-trace-base'),
            import('@opentelemetry/exporter-trace-otlp-http'),
            import('@opentelemetry/resources'),
            import('@opentelemetry/semantic-conventions'),
        ]);

        const config = getConfig();

        const provider = new WebTracerProvider({
            resource: resourceFromAttributes({
                [SEMRESATTRS_SERVICE_NAME]: config.serviceName,
                [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: config.environment,
            }),
            spanProcessors: [
                new SimpleSpanProcessor(
                    new OTLPTraceExporter({
                        url: config.otlpEndpoint,
                        timeoutMillis: 10000,
                        concurrencyLimit: 10,
                    }),
                ),
            ],
        });

        provider.register();
        providerInitialized = true;
        window.__deepTraceInitialized = true;

        if (typeof console !== 'undefined') {
            console.log(`[deep-trace] Browser telemetry initialized — exporting to ${config.otlpEndpoint}`);
        }
    } catch (err) {
        // OTel browser packages not available — tracing will be no-op
        if (typeof console !== 'undefined') {
            console.warn('[deep-trace] Browser telemetry init failed:', err);
        }
    }
}

// ===== 3. Auto-Patch fetch for Trace Context Propagation =====

let fetchPatched = false;

function patchGlobalFetch(): void {
    if (typeof globalThis === 'undefined' || typeof globalThis.fetch !== 'function') return;
    if (fetchPatched) return;

    const originalFetch = globalThis.fetch;

    globalThis.fetch = function patchedFetch(
        input: RequestInfo | URL,
        init?: RequestInit,
    ): Promise<Response> {
        // Only inject headers if telemetry is initialized
        if (!providerInitialized) {
            return originalFetch.call(this, input, init);
        }

        try {
            // Merge headers from both Request object and init to avoid dropping any
            const existingHeaders = input instanceof Request ? input.headers : undefined;
            const headers = new Headers(init?.headers ?? existingHeaders);
            // If init.headers was provided AND input is a Request, merge both
            if (init?.headers && existingHeaders) {
                existingHeaders.forEach((value, key) => {
                    if (!headers.has(key)) headers.set(key, value);
                });
            }
            propagation.inject(context.active(), headers, {
                set(carrier, key, value) {
                    carrier.set(key, value);
                },
            });
            return originalFetch.call(this, input, { ...init, headers });
        } catch {
            // If header injection fails, call original fetch unmodified
            return originalFetch.call(this, input, init);
        }
    };

    // Preserve fetch identity for frameworks that check it
    try {
        Object.defineProperty(globalThis.fetch, 'name', { value: 'fetch', configurable: true });
    } catch { /* best-effort */ }

    fetchPatched = true;
}

// Patch fetch synchronously (before any application code runs)
patchGlobalFetch();

// Initialize telemetry asynchronously (needs dynamic imports)
initBrowserTelemetry();

// ===== Re-exports for advanced usage =====

export { initReactInstrumentation } from './react-fiber-extractor';
export { initBrowserTelemetry, patchGlobalFetch };

/**
 * Get the browser tracer instance. Returns a no-op tracer if not initialized.
 */
export function getBrowserTracer() {
    const config = getConfig();
    return trace.getTracer(config.serviceName);
}
