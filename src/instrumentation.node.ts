/**
 * Local Debug Probe — instrumentation.node.ts
 *
 * Simplified, local-only version of Syncause's instrumentation.
 * No cloud connection. Spans go to:
 *   1. In-memory ring buffer (queryable via HTTP on port 43210)
 *   2. JSONL file at .debug/traces.jsonl (persistent)
 *
 * Usage:
 *   node --import ./lib/debug-probe/instrumentation.node.ts your-app.ts
 *   # or via tsx:
 *   tsx --import ./lib/debug-probe/instrumentation.node.ts your-app.ts
 *
 * Adapted from https://github.com/Syncause/ts-agent-file (MIT License)
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
import { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { ExportResultCode } from '@opentelemetry/core';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import * as path from 'path';
import * as fs from 'fs';
import { inspect } from 'util';
import express, { Request, Response } from 'express';

// ===== Configuration (env vars) =====
const ENABLE_DEBUG_LOG = process.env.DEBUG_PROBE_LOG !== 'false';
const ENABLE_CONSOLE_EXPORTER = process.env.DEBUG_PROBE_CONSOLE === 'true';
const ENABLE_JSONL = process.env.DEBUG_PROBE_JSONL !== 'false';
const JSONL_DIR = process.env.DEBUG_PROBE_DIR || path.join(process.cwd(), '.debug');
const JSONL_FILE = path.join(JSONL_DIR, 'traces.jsonl');
const MAX_SPANS = parseInt(process.env.DEBUG_PROBE_MAX_SPANS || '10000', 10);
const SERVER_PORT = parseInt(process.env.DEBUG_PROBE_PORT || '43210', 10);
const isDevelopment = process.env.NODE_ENV === 'development';

// ===== Logging (writes to .debug/probe.log, not stdout) =====
const LOG_FILE = path.join(JSONL_DIR, 'probe.log');

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

interface CachedSpan {
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

function appendToJsonl(span: CachedSpan): void {
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

class LocalSpanExporter extends ConsoleSpanExporter {
    private consoleEnabled: boolean;

    constructor() {
        super();
        this.consoleEnabled = ENABLE_CONSOLE_EXPORTER;
    }

    private isOwnSpan(span: ReadableSpan): boolean {
        const attrs = span.attributes;
        const url = attrs['http.url'] as string | undefined;
        const host = attrs['http.host'] as string | undefined;
        const target = attrs['http.target'] as string | undefined;
        if (url?.includes('localhost:' + SERVER_PORT) ||
            url?.includes('127.0.0.1:' + SERVER_PORT) ||
            host?.includes('localhost:' + SERVER_PORT) ||
            host?.includes('127.0.0.1:' + SERVER_PORT) ||
            target?.includes('/remote-debug/')) {
            return true;
        }
        return false;
    }

    export(spans: ReadableSpan[], resultCallback: (result: { code: number }) => void): void {
        try {
            const filtered = spans.filter(s => !this.isOwnSpan(s));
            for (const s of filtered) {
                spanCache.addSpan(s);
                // Also get the cached version for JSONL
                const cached = spanCache.getAllSpans().find(
                    c => c.spanId === s.spanContext().spanId
                );
                if (cached) appendToJsonl(cached);
            }
            if (this.consoleEnabled) {
                super.export(filtered, resultCallback);
            } else {
                resultCallback?.({ code: ExportResultCode.SUCCESS });
            }
        } catch {
            resultCallback?.({ code: ExportResultCode.FAILED });
        }
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

function wrapFunction(fn: Function, spanName: string, type: 'user_function' | 'class_method' = 'user_function'): Function {
    if ((fn as any)[WRAPPED]) return fn;
    const wrapped = function (this: any, ...args: any[]) {
        const parentSpan = trace.getSpan(context.active());
        const parentSpanId = parentSpan?.spanContext()?.spanId;
        const callerName = parentSpanId ? spanNameMap.get(parentSpanId) : undefined;

        const span = tracer.startSpan(spanName);
        const spanId = span.spanContext().spanId;
        recordSpanName(spanId, spanName);

        span.setAttribute('function.name', spanName);
        span.setAttribute('function.type', type);
        span.setAttribute('function.args.count', args.length);
        if (callerName) span.setAttribute('function.caller.name', callerName);
        if (parentSpanId) span.setAttribute('function.caller.spanId', parentSpanId);

        const maxArgs = Math.min(args.length, 10);
        for (let i = 0; i < maxArgs; i++) {
            span.setAttribute(`function.args.${i}`, toStr(args[i]));
        }

        const ctx = trace.setSpan(context.active(), span);
        try {
            const res = context.with(ctx, () => fn.apply(this, args));
            if (res && typeof res === 'object' && typeof res.then === 'function') {
                return res
                    .then((val: any) => {
                        span.setAttribute('function.return.value', toStr(val));
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
            span.setAttribute('function.return.value', toStr(res));
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
    return wrapped;
}

/** Wrap a function for tracing. Use from user code or from the Babel plugin. */
export function wrapUserFunction<T extends (...args: any[]) => any>(fn: T, name?: string): T {
    return wrapFunction(fn, name || fn.name || 'anonymous', 'user_function') as T;
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
    if (serverStarted) return;
    const app = express();

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

    app.listen(SERVER_PORT, () => {
        serverStarted = true;
        log.info(`Debug probe HTTP server listening on port ${SERVER_PORT}`);
    });
}

// ===== OTel SDK Init =====

const sdk = new NodeSDK({
    traceExporter: new LocalSpanExporter(),
    instrumentations: isDevelopment ? [] : [getNodeAutoInstrumentations()],
});

export { sdk };

let initialized = false;

export function init() {
    if (initialized) return;
    initialized = true;
    sdk.start();
    startServer();
    log.info('Debug probe initialized');
    log.info(`  JSONL output: ${ENABLE_JSONL ? JSONL_FILE : 'disabled'}`);
    log.info(`  HTTP API: http://localhost:${SERVER_PORT}/remote-debug/spans`);
    log.info(`  Console interception: ${isDevelopment ? 'disabled (dev mode)' : 'enabled'}`);
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
/** Force-flush the OTel batch processor so spans are exported immediately. Useful in tests. */
export async function forceFlush() { await sdk.shutdown().catch(() => {}); sdk.start(); }
/** Flush spans without restarting — for use when you just need spans exported */
export async function flushSpans() {
    const provider = trace.getTracerProvider() as any;
    if (provider?.forceFlush) await provider.forceFlush();
    else if (provider?.getDelegate?.()?.forceFlush) await provider.getDelegate().forceFlush();
}
