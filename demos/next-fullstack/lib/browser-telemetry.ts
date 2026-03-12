'use client';

/**
 * browser-telemetry.ts — Legacy compatibility re-exports.
 *
 * With zero-code instrumentation (browser-init.ts), these manual APIs
 * are no longer needed. Browser telemetry is auto-initialized via
 * instrumentation-client.ts, and fetch() is auto-patched with trace headers.
 *
 * These re-exports are kept for backward compatibility only.
 */

export {
  initBrowserTelemetry,
  patchGlobalFetch as injectTraceHeaders,
  getBrowserTracer,
} from '../../../src/browser-init';

export { addFiberAttributesToSpan } from '../../../src/react-fiber-extractor';
