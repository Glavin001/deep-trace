/**
 * deep-trace — public API
 *
 * This barrel file re-exports the user-facing API surface.
 * For browser-only usage, import 'deep-trace/browser' instead.
 * For Node.js server instrumentation, import 'deep-trace/node' instead.
 */

// --- Function wrapping (works in both Node.js and browser) ---
export { wrapUserFunction } from './probe-wrapper';

// --- Types ---
export type { SourceMetadata, CachedSpan } from './types';

// --- Span ingestion (for multi-language support) ---
export { validateSpanInput, normalizeSpanInput, ingestSpans } from './span-ingestion';
export type { IngestSpanInput, IngestResult, ValidationResult } from './span-ingestion';
export { setupWebSocket } from './ws-server';

// --- React fiber extraction (browser-only, gracefully no-ops in Node.js) ---
export {
    initReactInstrumentation,
    isReactInstrumentationActive,
    extractComponentInfo,
    getComponentHierarchy,
    getComponentDisplayName,
    getDebugSource,
    addFiberAttributesToSpan,
    registerComponentSpan,
} from './react-fiber-extractor';
export type { FiberComponentInfo } from './react-fiber-extractor';

// --- V8 source location (Node.js only) ---
export { getCallerLocation } from './v8-source-location';
export type { CallerLocation } from './v8-source-location';
