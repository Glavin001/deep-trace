/**
 * probe-wrapper.ts — Lightweight function wrapping for the Babel plugin
 *
 * This file is imported by user code (via the Babel transform) to wrap functions.
 * It does NOT initialize the OTel SDK — that happens in instrumentation.node.ts
 * which is loaded separately via --import.
 *
 * Adapted from https://github.com/Syncause/ts-agent-file (MIT License)
 */

import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import type { SourceMetadata } from './types';

const tracer = trace.getTracer('probe-wrapper');
const WRAPPED = Symbol('probe_wrapped');

function isPromiseLike(val: any): val is Promise<any> {
    return val && typeof val === 'object' && typeof val.then === 'function';
}

function toStr(val: any): string {
    if (val === undefined) return '';
    if (val === null) return 'null';
    if (typeof val === 'string') return val.length > 1000 ? val.slice(0, 1000) + '...' : val;
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    try {
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
        let s = JSON.stringify(val, replacer);
        if (typeof s !== 'string') s = String(s);
        return s.length > 1000 ? s.slice(0, 1000) + '...' : s;
    } catch {
        return '[unserializable]';
    }
}

function wrapFunction(fn: Function, spanName: string, metadata?: SourceMetadata): Function {
    if ((fn as any)[WRAPPED]) return fn;

    // Skip generators — wrapping breaks the generator/async-generator protocol
    const ctorName = fn.constructor?.name;
    if (ctorName === 'GeneratorFunction' || ctorName === 'AsyncGeneratorFunction') return fn;
    const wrapped = function (this: any, ...args: any[]) {
        const span = tracer.startSpan(spanName);

        // Only serialize/set attributes when the span is actually recording.
        // This avoids triggering side effects (getters, Proxy traps, .toJSON())
        // on function arguments when tracing is disabled or sampled out.
        if (span.isRecording()) {
            span.setAttribute('function.name', spanName);
            span.setAttribute('function.type', 'user_function');
            span.setAttribute('function.args.count', args.length);

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

        const ctx = trace.setSpan(context.active(), span);
        try {
            const res = context.with(ctx, () => fn.apply(this, args));
            if (isPromiseLike(res)) {
                return res
                    .then((val) => {
                        if (span.isRecording()) span.setAttribute('function.return.value', toStr(val));
                        span.setStatus({ code: SpanStatusCode.OK });
                        span.end();
                        return val;
                    })
                    .catch((err) => {
                        span.recordException(err);
                        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err?.message || err) });
                        span.end();
                        throw err;
                    });
            }
            if (span.isRecording()) span.setAttribute('function.return.value', toStr(res));
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            return res;
        } catch (err: any) {
            span.recordException(err);
            span.setStatus({ code: SpanStatusCode.ERROR, message: String(err?.message || err) });
            span.end();
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

/** Wrap a single function for tracing */
export function wrapUserFunction<T extends (...args: any[]) => any>(fn: T, name?: string, metadata?: SourceMetadata): T {
    return wrapFunction(fn, name || fn.name || 'anonymous', metadata) as T;
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

/** Convenience wrapper for async functions */
export function traced<T extends (...args: any[]) => Promise<any>>(fn: T, name?: string): T {
    return wrapFunction(fn, name || fn.name || 'tracedAsync') as T;
}
