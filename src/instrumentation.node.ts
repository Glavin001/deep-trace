/**
 * Local Debug Probe — instrumentation.node.ts
 *
 * Simplified local instrumentation for development.
 * Spans can flow to:
 *   1. In-memory ring buffer (queryable via HTTP on port 43210)
 *   2. JSONL file at .debug/traces.jsonl (persistent)
 *   3. An OTLP HTTP collector endpoint (optional)
 *
 * Usage:
 *   node --import ./lib/debug-probe/instrumentation.node.ts your-app.ts
 *   # or via tsx:
 *   tsx --import ./lib/debug-probe/instrumentation.node.ts your-app.ts
 *
 * Adapted from https://github.com/Syncause/ts-agent-file (MIT License)
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
import {
    BatchSpanProcessor,
    ReadableSpan,
    SimpleSpanProcessor,
    SpanExporter,
    SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { ExportResultCode } from '@opentelemetry/core';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { trace, context, SpanStatusCode, propagation } from '@opentelemetry/api';
import * as fs from 'fs';
import { inspect } from 'util';
import express, { Request, Response } from 'express';
import { buildRuntimeConfig, isInternalSpanRequest, RuntimeConfig } from './runtime-config';
import type { SourceMetadata, CachedSpan } from './types';
import { getCallerLocation } from './v8-source-location';

// ===== Configuration (env vars) =====
const runtimeConfig = buildRuntimeConfig();
const ENABLE_DEBUG_LOG = runtimeConfig.debugLogEnabled;
const ENABLE_CONSOLE_EXPORTER = runtimeConfig.consoleExporterEnabled;
const ENABLE_LOCAL_EXPORTER = runtimeConfig.localExporterEnabled;
const ENABLE_JSONL = runtimeConfig.jsonlEnabled;
const JSONL_DIR = runtimeConfig.jsonlDir;
const JSONL_FILE = runtimeConfig.jsonlFile;
const LOG_FILE = runtimeConfig.logFile;
const MAX_SPANS = runtimeConfig.maxSpans;
const SERVER_PORT = runtimeConfig.serverPort;
const isDevelopment = runtimeConfig.isDevelopment;

// ===== Logging (writes to .debug/probe.log, not stdout) =====
function ensureDir(dir: string): void {
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch {}
}

function writeLog(level: string, ...args: any[]): void {
    if (!ENABLE_DEBUG_LOG) return;
    try {
        ensureDir(JSONL_DIR);
        const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [${level}] ${msg}\n`);
    } catch {}
}

const log = {
    log: (...a: any[]) => writeLog('LOG', ...a),
    error: (...a: any[]) => writeLog('ERROR', ...a),
    warn: (...a: any[]) => writeLog('WARN', ...a),
    info: (...a: any[]) => writeLog('INFO', ...a),
    debug: (...a: any[]) => writeLog('DEBUG', ...a),
};

// ===== Span Cache (in-memory ring buffer) =====

class SpanCache {
    private spans = new Map<string, CachedSpan>();
    private maxSpans: number;

    constructor(maxSpans: number) {
        this.maxSpans = maxSpans;
    }

    addSpan(span: ReadableSpan): void {
        const start = span.startTime[0] * 1_000_000 + span.startTime[1] / 1000;
        const end = span.endTime[0] * 1_000_000 + span.endTime[1] / 1000;
        const rec: CachedSpan = {
            traceId: span.spanContext().traceId,
            spanId: span.spanContext().spanId,
            parentSpanId: (span as any).parentSpanId,
            name: span.name,
            kind: String(span.kind),
            startTime: start,
            endTime: end,
            duration: end - start,
            status: { code: span.status.code, message: span.status.message },
            attributes: { ...span.attributes },
            events: (span.events || []).map(e => ({
                name: e.name,
                timestamp: e.time[0] * 1_000_000 + e.time[1] / 1000,
                attributes: { ...e.attributes },
            })),
            links: (span.links || []).map(l => ({
                traceId: l.context.traceId,
                spanId: l.context.spanId,
                attributes: { ...l.attributes },
            })),
        };
        this.spans.set(rec.spanId, rec);
        if (this.spans.size > this.maxSpans * 0.85) this.cleanup();
    }

    addCachedSpan(span: CachedSpan): void {
        this.spans.set(span.spanId, span);
        if (this.spans.size > this.maxSpans * 0.85) this.cleanup();
    }

    getAllSpans(limit?: number): CachedSpan[] {
        const arr = Array.from(this.spans.values()).sort((a, b) => a.startTime - b.startTime);
        return typeof limit === 'number' ? arr.slice(-limit) : arr;
    }

    getByTraceId(traceId: string): CachedSpan[] {
        return this.getAllSpans().filter(s => s.traceId === traceId);
    }

    getByFunctionName(name: string): CachedSpan[] {
        return this.getAllSpans().filter(s => s.attributes['function.name'] === name);
    }

    getByTimeRange(startTime: number, endTime: number): CachedSpan[] {
        return this.getAllSpans().filter(s => s.startTime >= startTime && s.endTime <= endTime);
    }

    getTraceIds(limit?: number): string[] {
        const spans = this.getAllSpans();
        const ids = [...new Set(spans.map(s => s.traceId))];
        // newest first
        ids.sort((a, b) => {
            const aMin = Math.min(...spans.filter(s => s.traceId === a).map(s => s.startTime));
            const bMin = Math.min(...spans.filter(s => s.traceId === b).map(s => s.startTime));
            return bMin - aMin;
        });
        return typeof limit === 'number' ? ids.slice(0, limit) : ids;
    }

    getTracesWithSpans(startTime?: number, endTime?: number, limit?: number) {
        let filtered = this.getAllSpans();
        if (startTime !== undefined) filtered = filtered.filter(s => s.startTime >= startTime);
        if (endTime !== undefined) filtered = filtered.filter(s => s.startTime <= endTime);

        const groups = new Map<string, CachedSpan[]>();
        for (const s of filtered) {
            if (!groups.has(s.traceId)) groups.set(s.traceId, []);
            groups.get(s.traceId)!.push(s);
        }

        const traces = [...groups.entries()].map(([traceId, spans]) => {
            const formattedSpans = spans
                .filter(s => !!s.attributes['function.name'])
                .map(s => {
                    const d: any = {
                        attributes: s.attributes,
                        name: s.name,
                        endEpochNanos: s.endTime,
                        startEpochNanos: s.startTime,
                        traceId: s.traceId,
                        spanId: s.spanId,
                    };
                    if (s.parentSpanId) d.parentSpanId = s.parentSpanId;
                    if (s.attributes['function.caller.name']) d.callerName = s.attributes['function.caller.name'];
                    return d;
                });
            return {
                traceId,
                type: 'ts',
                spans: formattedSpans,
                startTimeMilli: Math.floor(Math.min(...spans.map(s => s.startTime)) / 1000),
            };
        });

        traces.sort((a, b) => b.startTimeMilli - a.startTimeMilli);
        return typeof limit === 'number' ? traces.slice(0, limit) : traces;
    }

    statistics() {
        const spans = [...this.spans.values()];
        const traceIds = new Set(spans.map(s => s.traceId));
        const fnNames = new Set(spans.map(s => s.attributes['function.name']).filter(Boolean));
        const durations = spans.map(s => s.duration);
        return {
            totalSpans: spans.length,
            totalTraces: traceIds.size,
            totalFunctions: fnNames.size,
            oldestSpan: spans.length ? Math.min(...spans.map(s => s.startTime)) : 0,
            newestSpan: spans.length ? Math.max(...spans.map(s => s.startTime)) : 0,
            averageDuration: spans.length ? durations.reduce((a, b) => a + b, 0) / spans.length : 0,
        };
    }

    clear(): void { this.spans.clear(); }

    private cleanup(): void {
        const arr = this.getAllSpans();
        const drop = Math.floor(arr.length * 0.2);
        for (let i = 0; i < drop; i++) this.spans.delete(arr[i].spanId);
    }
}

const spanCache = new SpanCache(MAX_SPANS);

// ===== JSONL File Writer =====

export function appendToJsonl(span: CachedSpan): void {
    if (!ENABLE_JSONL) return;
    try {
        ensureDir(JSONL_DIR);
        const line = JSON.stringify({
            ts: new Date().toISOString(),
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
            name: span.name,
            duration: span.duration,
            status: span.status.code === 0 ? 'UNSET' : span.status.code === 1 ? 'OK' : 'ERROR',
            statusMessage: span.status.message,
            attributes: span.attributes,
            events: span.events.length > 0 ? span.events : undefined,
        }) + '\n';
        fs.appendFileSync(JSONL_FILE, line);
    } catch (err) {
        log.error('Failed to write JSONL:', err);
    }
}

// ===== Custom Span Exporter =====

class LocalSpanExporter implements SpanExporter {
    private consoleEnabled: boolean;
    private localExporterEnabled: boolean;
    private consoleExporter?: ConsoleSpanExporter;
    private config: RuntimeConfig;

    constructor(config: RuntimeConfig = runtimeConfig) {
        this.config = config;
        this.consoleEnabled = config.consoleExporterEnabled;
        this.localExporterEnabled = config.localExporterEnabled;
        this.consoleExporter = this.consoleEnabled ? new ConsoleSpanExporter() : undefined;
    }

    private isOwnSpan(span: ReadableSpan): boolean {
        return isInternalSpanRequest(
            {
                url: span.attributes['http.url'] as string | undefined,
                host: span.attributes['http.host'] as string | undefined,
                target: span.attributes['http.target'] as string | undefined,
            },
            this.config,
        );
    }

    export(spans: ReadableSpan[], resultCallback: (result: { code: number }) => void): void {
        try {
            const filtered = spans.filter(s => !this.isOwnSpan(s));
            if (this.localExporterEnabled) {
                for (const s of filtered) {
                    spanCache.addSpan(s);
                    const cached = spanCache.getAllSpans().find(
                        c => c.spanId === s.spanContext().spanId,
                    );
                    if (cached) appendToJsonl(cached);
                }
            }

            if (this.consoleEnabled && this.consoleExporter) {
                this.consoleExporter.export(filtered, resultCallback);
            } else {
                resultCallback?.({ code: ExportResultCode.SUCCESS });
            }
        } catch (error) {
            log.error('Failed to export spans locally:', error);
            resultCallback?.({ code: ExportResultCode.FAILED });
        }
    }

    async shutdown(): Promise<void> {
        await this.consoleExporter?.shutdown();
    }

    async forceFlush(): Promise<void> {
        await this.consoleExporter?.forceFlush?.();
    }
}

// ===== Function Wrapping =====

const tracer = trace.getTracer('debug-probe');
const WRAPPED = Symbol('probe_wrapped');

// SpanId -> FunctionName for caller tracking
const spanNameMap = new Map<string, string>();
const SPAN_MAP_MAX = 10000;

function recordSpanName(spanId: string, name: string): void {
    spanNameMap.set(spanId, name);
    if (spanNameMap.size > SPAN_MAP_MAX) {
        const keys = [...spanNameMap.keys()].slice(0, 1000);
        keys.forEach(k => spanNameMap.delete(k));
    }
}

function cleanupSpanName(spanId: string): void {
    setTimeout(() => spanNameMap.delete(spanId), 5000);
}

function toStr(v: any): string {
    try {
        if (v === undefined) return '';
        if (v === null) return 'null';
        if (typeof v === 'string') return v.length > 4000 ? v.slice(0, 4000) + '...' : v;
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        const seen = new WeakSet<object>();
        const replacer = (_key: string, value: any) => {
            if (typeof value === 'bigint') return value.toString();
            if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
            if (typeof value === 'symbol') return value.toString();
            if (value instanceof Date) return value.toISOString();
            if (value instanceof Map) return { __type: 'Map', entries: [...value.entries()] };
            if (value instanceof Set) return { __type: 'Set', values: [...value.values()] };
            if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
            if (typeof Buffer !== 'undefined' && Buffer.isBuffer?.(value)) {
                return { __type: 'Buffer', length: value.length };
            }
            if (value && typeof value === 'object') {
                if (seen.has(value)) return '[Circular]';
                seen.add(value);
            }
            return value;
        };
        let s = JSON.stringify(v, replacer);
        if (typeof s !== 'string') s = String(s);
        return s.length > 4000 ? s.slice(0, 4000) + '...' : s;
    } catch {
        try {
            const s = inspect(v, { depth: 2, maxArrayLength: 50, breakLength: 120 });
            return s.length > 4000 ? s.slice(0, 4000) + '...' : s;
        } catch {
            return '[unserializable]';
        }
    }
}

/**
 * For HTTP handlers (GET, POST, etc.), extract W3C trace context from the
 * incoming Request headers so server spans join the browser's trace.
 */
function extractHttpTraceContext(args: any[], metadata?: SourceMetadata) {
    if (!metadata?.isHttpHandler || args.length === 0) return context.active();
    try {
        const request = args[0];
        if (!request || typeof request !== 'object') return context.active();
        const headers = request.headers;
        if (!headers) return context.active();

        // Support both Headers API (.get()) and plain object
        const carrier: Record<string, string> = {};
        if (typeof headers.get === 'function') {
            const tp = headers.get('traceparent');
            if (tp) carrier.traceparent = tp;
            const ts = headers.get('tracestate');
            if (ts) carrier.tracestate = ts;
        } else if (typeof headers === 'object') {
            if (headers.traceparent) carrier.traceparent = headers.traceparent;
            if (headers.tracestate) carrier.tracestate = headers.tracestate;
        }

        if (!carrier.traceparent) return context.active();
        return propagation.extract(context.active(), carrier);
    } catch {
        return context.active();
    }
}

function wrapFunction(fn: Function, spanName: string, type: 'user_function' | 'class_method' = 'user_function', metadata?: SourceMetadata): Function {
    if ((fn as any)[WRAPPED]) return fn;

    // Skip generators — wrapping breaks the generator/async-generator protocol
    const ctorName = fn.constructor?.name;
    if (ctorName === 'GeneratorFunction' || ctorName === 'AsyncGeneratorFunction') return fn;
    const wrapped = function (this: any, ...args: any[]) {
        // For HTTP handlers, extract trace context from request headers
        const parentCtx = extractHttpTraceContext(args, metadata);
        const parentSpan = trace.getSpan(parentCtx);
        const parentSpanId = parentSpan?.spanContext()?.spanId;
        const callerName = parentSpanId ? spanNameMap.get(parentSpanId) : undefined;

        const span = tracer.startSpan(spanName, undefined, parentCtx);
        const spanId = span.spanContext().spanId;
        recordSpanName(spanId, spanName);

        // Only serialize/set attributes when the span is actually recording.
        // This avoids triggering side effects (getters, Proxy traps, .toJSON())
        // on function arguments when tracing is disabled or sampled out.
        if (span.isRecording()) {
            span.setAttribute('function.name', spanName);
            span.setAttribute('function.type', type);
            span.setAttribute('function.args.count', args.length);
            if (callerName) span.setAttribute('function.caller.name', callerName);
            if (parentSpanId) span.setAttribute('function.caller.spanId', parentSpanId);

            // Source location metadata (from Babel plugin or V8 stack traces)
            if (metadata?.filePath) span.setAttribute('code.filepath', metadata.filePath);
            if (metadata?.line != null) span.setAttribute('code.lineno', metadata.line);
            if (metadata?.column != null) span.setAttribute('code.column', metadata.column);

            // React component metadata
            if (metadata?.isComponent) {
                span.setAttribute('code.function.type', 'react_component');
                span.setAttribute('component.name', spanName);
                if (args.length > 0 && args[0] && typeof args[0] === 'object') {
                    try {
                        const props = args[0];
                        const serializable: Record<string, any> = {};
                        for (const key of Object.keys(props)) {
                            const val = props[key];
                            if (key === 'children' || typeof val === 'function' || typeof val === 'symbol') continue;
                            serializable[key] = val;
                        }
                        if (Object.keys(serializable).length > 0) {
                            span.setAttribute('component.props', toStr(serializable));
                        }
                    } catch { /* props serialization is best-effort */ }
                }
            }

            const maxArgs = Math.min(args.length, 10);
            for (let i = 0; i < maxArgs; i++) {
                span.setAttribute(`function.args.${i}`, toStr(args[i]));
            }
        }

        const ctx = trace.setSpan(parentCtx, span);
        try {
            const res = context.with(ctx, () => fn.apply(this, args));
            if (res && typeof res === 'object' && typeof res.then === 'function') {
                return res
                    .then((val: any) => {
                        if (span.isRecording()) span.setAttribute('function.return.value', toStr(val));
                        span.setStatus({ code: SpanStatusCode.OK });
                        span.end();
                        cleanupSpanName(spanId);
                        return val;
                    })
                    .catch((err: any) => {
                        span.recordException(err);
                        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err?.message || err) });
                        span.end();
                        cleanupSpanName(spanId);
                        throw err;
                    });
            }
            if (span.isRecording()) span.setAttribute('function.return.value', toStr(res));
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            cleanupSpanName(spanId);
            return res;
        } catch (err: any) {
            span.recordException(err);
            span.setStatus({ code: SpanStatusCode.ERROR, message: String(err?.message || err) });
            span.end();
            cleanupSpanName(spanId);
            throw err;
        }
    };
    (wrapped as any)[WRAPPED] = true;

    // Preserve fn.length (arity) and fn.name to avoid breaking frameworks
    // that inspect these (e.g. Express checks fn.length to distinguish middleware from error handlers)
    try {
        Object.defineProperty(wrapped, 'length', { value: fn.length, configurable: true });
        Object.defineProperty(wrapped, 'name', { value: fn.name || spanName, configurable: true });
    } catch { /* best-effort */ }

    // Copy custom properties (e.g. displayName, defaultProps) from original to wrapper
    try {
        const descriptors = Object.getOwnPropertyDescriptors(fn);
        for (const key of Object.keys(descriptors)) {
            if (key === 'length' || key === 'name' || key === 'prototype' || key === 'arguments' || key === 'caller') continue;
            try { Object.defineProperty(wrapped, key, descriptors[key]); } catch { /* skip non-configurable */ }
        }
    } catch { /* best-effort */ }

    return wrapped;
}

/** Wrap a function for tracing. Use from user code or from the Babel plugin. */
export function wrapUserFunction<T extends (...args: any[]) => any>(fn: T, name?: string, metadata?: SourceMetadata): T {
    // V8 stack trace fallback: capture source location at registration time (not invocation time)
    if (!metadata && runtimeConfig.v8SourceEnabled) {
        try {
            const loc = getCallerLocation(2);
            if (loc) {
                metadata = { filePath: loc.filePath, line: loc.line, column: loc.column };
            }
        } catch { /* V8 source location is best-effort */ }
    }
    return wrapFunction(fn, name || fn.name || 'anonymous', 'user_function', metadata) as T;
}

/** Wrap all methods on an object */
export function wrapUserModule<T extends object>(obj: T, prefix?: string): T {
    const moduleName = prefix || 'module';
    for (const key of Object.keys(obj)) {
        const val = (obj as any)[key];
        if (typeof val === 'function' && !(val as any)[WRAPPED]) {
            (obj as any)[key] = wrapFunction(val, `${moduleName}.${key}`);
        }
    }
    return obj;
}

/** Wrap an async function for tracing */
export function traced<T extends (...args: any[]) => Promise<any>>(fn: T, name?: string): T {
    return wrapFunction(fn, name || fn.name || 'tracedAsync') as T;
}

// ===== Console Interception =====

const consoleMethods = ['log', 'error', 'warn', 'info', 'debug'] as const;
const originalConsole: Record<string, Function> = {};
const isInstrumenting = Symbol('is_instrumenting');

consoleMethods.forEach(method => {
    originalConsole[method] = (console as any)[method];
});

if (!isDevelopment) {
    consoleMethods.forEach(method => {
        const originalFn = (console as any)[method];
        if (typeof originalFn !== 'function') return;

        (console as any)[method] = function (...args: any[]) {
            if ((console as any)[isInstrumenting]) {
                return originalFn.apply(console, args);
            }
            (console as any)[isInstrumenting] = true;
            try {
                const parentSpan = trace.getSpan(context.active());
                const parentSpanId = parentSpan?.spanContext()?.spanId;
                const callerName = parentSpanId ? spanNameMap.get(parentSpanId) : undefined;

                const spanName = `console.${method}`;
                const span = tracer.startSpan(spanName);
                const spanId = span.spanContext().spanId;
                recordSpanName(spanId, spanName);

                span.setAttribute('function.name', spanName);
                span.setAttribute('function.type', 'log');
                span.setAttribute('function.args.count', args.length);
                if (callerName) span.setAttribute('function.caller.name', callerName);
                if (parentSpanId) span.setAttribute('function.caller.spanId', parentSpanId);

                const maxArgs = Math.min(args.length, 10);
                for (let i = 0; i < maxArgs; i++) {
                    span.setAttribute(`function.args.${i}`, toStr(args[i]));
                }

                const result = originalFn.apply(console, args);
                span.setStatus({ code: SpanStatusCode.OK });
                span.end();
                cleanupSpanName(spanId);
                return result;
            } finally {
                (console as any)[isInstrumenting] = false;
            }
        };
    });
}

// ===== HTTP API Server =====

let serverStarted = false;

function startServer() {
    if (serverStarted || SERVER_PORT <= 0) return;
    const app = express();
    app.use(express.json({ limit: '1mb' }));

    function formatSpan(s: CachedSpan) {
        return {
            traceId: s.traceId,
            spanId: s.spanId,
            parentSpanId: s.parentSpanId,
            name: s.name,
            kind: s.kind,
            startTime: new Date(s.startTime / 1000000).toISOString(),
            endTime: new Date(s.endTime / 1000000).toISOString(),
            durationMs: s.duration / 1000000,
            status: s.status,
            attributes: s.attributes,
            events: s.events,
            links: s.links,
        };
    }

    app.get('/remote-debug/spans', (req: Request, res: Response) => {
        try {
            const startTime = req.query.startTime ? parseInt(String(req.query.startTime)) : undefined;
            const endTime = req.query.endTime ? parseInt(String(req.query.endTime)) : undefined;
            const traceId = req.query.traceId ? String(req.query.traceId) : undefined;
            const functionName = req.query.functionName ? String(req.query.functionName) : undefined;
            const limit = req.query.limit ? parseInt(String(req.query.limit)) : undefined;

            let spans: CachedSpan[];
            if (typeof startTime === 'number' && typeof endTime === 'number') {
                spans = spanCache.getByTimeRange(startTime, endTime);
            } else if (traceId) {
                spans = spanCache.getByTraceId(traceId);
            } else if (functionName) {
                spans = spanCache.getByFunctionName(functionName);
            } else {
                spans = spanCache.getAllSpans(limit);
            }

            res.json({
                success: true,
                data: { spans: spans.map(formatSpan), total: spans.length },
            });
        } catch (error: any) {
            res.status(500).json({ success: false, error: error?.message });
        }
    });

    app.get('/remote-debug/traces', (req: Request, res: Response) => {
        try {
            const startTime = req.query.startTime ? parseInt(String(req.query.startTime)) : undefined;
            const endTime = req.query.endTime ? parseInt(String(req.query.endTime)) : undefined;
            const limit = req.query.limit ? parseInt(String(req.query.limit)) : undefined;
            res.json(spanCache.getTracesWithSpans(startTime, endTime, limit));
        } catch (error: any) {
            res.status(500).json({ success: false, error: error?.message });
        }
    });

    app.get('/remote-debug/spans/stats', (_req: Request, res: Response) => {
        try {
            const stats = spanCache.statistics();
            res.json({
                success: true,
                data: {
                    ...stats,
                    oldestSpan: stats.oldestSpan ? new Date(stats.oldestSpan / 1000000).toISOString() : null,
                    newestSpan: stats.newestSpan ? new Date(stats.newestSpan / 1000000).toISOString() : null,
                    averageDurationMs: stats.averageDuration / 1000000,
                },
            });
        } catch (error: any) {
            res.status(500).json({ success: false, error: error?.message });
        }
    });

    app.delete('/remote-debug/spans', (_req: Request, res: Response) => {
        try {
            spanCache.clear();
            res.json({ success: true, message: 'Cache cleared' });
        } catch (error: any) {
            res.status(500).json({ success: false, error: error?.message });
        }
    });

    // ─── Span Ingestion (POST) ─────────────────────────────────────────
    app.post('/remote-debug/spans', (req: Request, res: Response) => {
        try {
            const { ingestSpans } = require('./span-ingestion');
            const body = req.body;
            const inputs = Array.isArray(body) ? body : [body];
            const result = ingestSpans(spanCache, inputs, appendToJsonl);

            if (result.accepted === 0 && result.rejected.length > 0) {
                res.status(400).json({
                    success: false,
                    error: 'No valid spans in request',
                    rejected: result.rejected,
                });
            } else {
                const response: any = { success: true, accepted: result.accepted };
                if (result.rejected.length > 0) response.rejected = result.rejected;
                res.json(response);
            }
        } catch (error: any) {
            res.status(500).json({ success: false, error: error?.message });
        }
    });

    const SERVER_HOST = runtimeConfig.serverHost;
    const server = app.listen(SERVER_PORT, SERVER_HOST, () => {
        serverStarted = true;
        log.info(`Debug probe HTTP server listening on ${SERVER_HOST}:${SERVER_PORT}`);
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
            log.info(`Debug probe port ${SERVER_PORT} already in use, skipping server start`);
        } else {
            log.info(`Debug probe server error: ${err.message}`);
        }
    });

    // Defer WebSocket setup to next tick to avoid vitest module resolution interference.
    // The ws module patches HTTP internals which conflicts with OTel's HTTP instrumentation
    // when resolved at import-time by vitest's module transformer.
    setTimeout(() => {
        try {
            const { setupWebSocket } = require('./ws-server');
            setupWebSocket(server, spanCache, appendToJsonl, log, runtimeConfig, SERVER_PORT);
        } catch {
            log.info('WebSocket support unavailable (ws package not installed)');
        }
    }, 0);
}

// ===== OTel SDK Init =====

export function createSpanProcessors(config: RuntimeConfig = runtimeConfig): SpanProcessor[] {
    const processors: SpanProcessor[] = [new SimpleSpanProcessor(new LocalSpanExporter(config))];

    if (config.otlpHttpEndpoint) {
        processors.push(
            new BatchSpanProcessor(
                new OTLPTraceExporter({
                    url: config.otlpHttpEndpoint,
                    headers: config.otlpHeaders,
                    concurrencyLimit: config.otlpConcurrencyLimit,
                    timeoutMillis: config.otlpTimeoutMillis,
                }),
            ),
        );
    }

    return processors;
}

export function createSdk(config: RuntimeConfig = runtimeConfig): NodeSDK {
    return new NodeSDK({
        serviceName: config.serviceName,
        spanProcessors: createSpanProcessors(config),
        // In dev mode, only enable HTTP instrumentation for trace context propagation
        // (extracts W3C traceparent from incoming requests so server spans join browser traces).
        // In production, enable all auto-instrumentations for full observability.
        instrumentations: config.isDevelopment
            ? [new HttpInstrumentation()]
            : [getNodeAutoInstrumentations()],
    });
}

const sdk = createSdk();

export { sdk };

let initialized = false;

export function init() {
    if (initialized) return;
    initialized = true;
    sdk.start();
    startServer();
    log.info('Debug probe initialized');
    log.info(`  JSONL output: ${ENABLE_JSONL ? JSONL_FILE : 'disabled'}`);
    log.info(`  HTTP API: ${SERVER_PORT > 0 ? `http://localhost:${SERVER_PORT}/remote-debug/spans` : 'disabled'}`);
    log.info(`  Console interception: ${isDevelopment ? 'disabled (dev mode)' : 'enabled'}`);
    log.info(`  Service name: ${runtimeConfig.serviceName}`);
    log.info(`  OTLP exporter: ${runtimeConfig.otlpHttpEndpoint || 'disabled'}`);
}

// Auto-init when loaded via --import or --require
init();

// ===== Exports for programmatic use =====
export function getSpanCache() { return spanCache; }
export function getSpans(limit?: number) { return spanCache.getAllSpans(limit); }
export function getSpansByTraceId(traceId: string) { return spanCache.getByTraceId(traceId); }
export function getSpansByFunctionName(name: string) { return spanCache.getByFunctionName(name); }
export function clearSpans() { spanCache.clear(); }
export function getSpanStats() { return spanCache.statistics(); }
export function getRuntimeConfig() { return runtimeConfig; }
/** Force-flush the OTel batch processor so spans are exported immediately. Useful in tests. */
export async function forceFlush() { await flushSpans(); }
/** Flush spans without restarting — for use when you just need spans exported */
export async function flushSpans() {
    const provider = trace.getTracerProvider() as any;
    if (provider?.forceFlush) await provider.forceFlush();
    else if (provider?.getDelegate?.()?.forceFlush) await provider.getDelegate().forceFlush();
}
