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

import { context, propagation, trace, SpanStatusCode } from '@opentelemetry/api';
import type { Context } from '@opentelemetry/api';
import { initReactInstrumentation } from './react-fiber-extractor';
import { getActiveBrowserContext } from './probe-wrapper';

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
            // Determine the URL and method for the fetch span
            const url = input instanceof Request ? input.url : String(input);
            const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
            // Parse out just the pathname for the span name
            let pathname: string;
            try { pathname = new URL(url, window.location.origin).pathname; } catch { pathname = url; }

            // Resolve parent context: OTel active > browser async stack > root
            const otelCtx = context.active();
            const browserCtx = getActiveBrowserContext();
            const parentCtx: Context = trace.getSpan(otelCtx)
                ? otelCtx
                : (browserCtx || otelCtx);

            // Create a fetch span visible in the waterfall
            const fetchTracer = trace.getTracer('browser-fetch');
            const span = fetchTracer.startSpan(`fetch ${method} ${pathname}`, {
                attributes: {
                    'http.method': method,
                    'http.url': url.length > 500 ? url.slice(0, 500) : url,
                    'fetch.type': 'xmlhttprequest',
                },
            }, parentCtx);

            // Merge headers from both Request object and init to avoid dropping any
            const existingHeaders = input instanceof Request ? input.headers : undefined;
            const headers = new Headers(init?.headers ?? existingHeaders);
            if (init?.headers && existingHeaders) {
                existingHeaders.forEach((value, key) => {
                    if (!headers.has(key)) headers.set(key, value);
                });
            }

            // Inject traceparent from the fetch span's context
            const fetchCtx = trace.setSpan(parentCtx, span);
            propagation.inject(fetchCtx, headers, {
                set(carrier, key, value) {
                    carrier.set(key, value);
                },
            });

            return originalFetch.call(this, input, { ...init, headers })
                .then((response: Response) => {
                    span.setAttribute('http.status_code', response.status);
                    span.setStatus({
                        code: response.ok ? SpanStatusCode.OK : SpanStatusCode.ERROR,
                        message: response.ok ? undefined : `HTTP ${response.status}`,
                    });
                    span.end();
                    return response;
                })
                .catch((err: Error) => {
                    span.recordException(err);
                    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
                    span.end();
                    throw err;
                });
        } catch {
            // If span creation or header injection fails, call original fetch unmodified
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
