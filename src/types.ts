/**
 * Shared types for deep-trace source metadata.
 */

/** Source location metadata injected by the Babel plugin or captured at runtime via V8 stack traces. */
export interface SourceMetadata {
    /** Relative file path (from Babel) or absolute path (from V8 stack traces). */
    filePath?: string;
    /** 1-indexed line number of the function/component declaration. */
    line?: number;
    /** 0-indexed column number of the function/component declaration. */
    column?: number;
    /** True when the wrapped function is a React component (PascalCase). */
    isComponent?: boolean;
    /** True when the function is an HTTP handler (GET, POST, etc.) that receives a Request object. */
    isHttpHandler?: boolean;
}

/** A cached span stored in the in-memory ring buffer. */
export interface CachedSpan {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    kind: string;
    startTime: number;
    endTime: number;
    duration: number;
    status: { code: number; message?: string };
    attributes: Record<string, any>;
    events: Array<{ name: string; timestamp: number; attributes: Record<string, any> }>;
    links: Array<{ traceId: string; spanId: string; attributes: Record<string, any> }>;
}
