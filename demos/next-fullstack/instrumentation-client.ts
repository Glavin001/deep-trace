/**
 * Client-side instrumentation — runs before React loads.
 *
 * In Next.js 15.3+, this file is automatically loaded before React,
 * which is required for bippy to intercept the React DevTools hook.
 *
 * This single import auto-initializes:
 *  1. React fiber instrumentation (bippy)
 *  2. Browser OpenTelemetry tracing (WebTracerProvider)
 *  3. Automatic fetch() trace context propagation (W3C traceparent)
 *
 * No other imports or API calls needed in application code.
 *
 * See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

import '../../src/browser-init';
