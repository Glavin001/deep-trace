'use client';

import { context, propagation, Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { SEMRESATTRS_DEPLOYMENT_ENVIRONMENT, SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { addFiberAttributesToSpan } from '../../../src/react-fiber-extractor';

declare global {
  interface Window {
    __nextFullstackTelemetryInitialized?: boolean;
  }
}

const otlpEndpoint = process.env.NEXT_PUBLIC_OTLP_HTTP_ENDPOINT || 'http://127.0.0.1:4318/v1/traces';
const serviceName = process.env.NEXT_PUBLIC_OTEL_SERVICE_NAME || 'next-fullstack-web';

export function initBrowserTelemetry() {
  if (typeof window === 'undefined' || window.__nextFullstackTelemetryInitialized) return;

  const provider = new WebTracerProvider({
    resource: resourceFromAttributes({
      [SEMRESATTRS_SERVICE_NAME]: serviceName,
      [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: 'local-demo',
    }),
    spanProcessors: [
      new SimpleSpanProcessor(
        new OTLPTraceExporter({
          url: otlpEndpoint,
          timeoutMillis: 10000,
          concurrencyLimit: 10,
        }),
      ),
    ],
  });

  provider.register();
  window.__nextFullstackTelemetryInitialized = true;
}

export function injectTraceHeaders(headersInit?: HeadersInit): Headers {
  const headers = new Headers(headersInit);

  propagation.inject(context.active(), headers, {
    set(carrier, key, value) {
      carrier.set(key, value);
    },
  });

  return headers;
}

export async function withBrowserSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  execute: (span: Span) => Promise<T>,
): Promise<T> {
  initBrowserTelemetry();

  const tracer = trace.getTracer(serviceName);
  const span = tracer.startSpan(name, { attributes });

  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await execute(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (caughtError) {
      span.recordException(caughtError as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: caughtError instanceof Error ? caughtError.message : String(caughtError),
      });
      throw caughtError;
    } finally {
      span.end();
    }
  });
}

/**
 * Create a browser span with React component fiber metadata attached.
 * Uses bippy to extract component name, hierarchy, source location, and props
 * from the React fiber tree and sets them as span attributes.
 *
 * @param name Span name
 * @param element DOM element to extract React fiber info from
 * @param attributes Additional span attributes
 * @param execute Async function to execute within the span
 */
export async function withComponentSpan<T>(
  name: string,
  element: Element,
  attributes: Record<string, string | number | boolean>,
  execute: (span: Span) => Promise<T>,
): Promise<T> {
  return withBrowserSpan(name, attributes, async (span) => {
    // Add React fiber component metadata to the span
    addFiberAttributesToSpan(span, element);
    return execute(span);
  });
}

/** Re-export for direct use in components. */
export { addFiberAttributesToSpan };
