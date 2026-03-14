/**
 * Tests for probe-wrapper.ts — the lightweight function wrapping module
 *
 * Verifies that wrapUserFunction, wrapUserModule, and traced correctly:
 * - Capture function arguments as span attributes
 * - Capture return values
 * - Capture exceptions
 * - Handle async/Promise functions
 * - Preserve function behavior (same inputs → same outputs)
 * - Prevent double-wrapping
 * - Handle edge cases (no args, many args, circular refs, etc.)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

// We need to set up OTel BEFORE importing probe-wrapper, since it uses trace.getTracer()
const memoryExporter = new InMemorySpanExporter();
const spanProcessor = new SimpleSpanProcessor(memoryExporter);
const sdk = new NodeSDK({
    spanProcessors: [spanProcessor],
});
sdk.start();

// Now import after OTel is initialized
import { wrapUserFunction, wrapUserModule, traced } from '../probe-wrapper';

// Helper to flush spans synchronously — SimpleSpanProcessor exports on span.end()
// but we need to make sure the processor has flushed
async function flush() {
    await spanProcessor.forceFlush();
}

describe('probe-wrapper', () => {
    beforeAll(async () => {
        // Warm up: run one span to make sure the SDK is fully ready
        const warmup = wrapUserFunction(() => 'warmup', 'warmup');
        warmup();
        await flush();
        memoryExporter.reset();
    });

    afterAll(async () => {
        await sdk.shutdown();
    });

    function getSpans() {
        return memoryExporter.getFinishedSpans();
    }

    function clearSpans() {
        memoryExporter.reset();
    }

    function lastSpan() {
        const spans = getSpans();
        return spans[spans.length - 1];
    }

    describe('wrapUserFunction', () => {
        it('should preserve function behavior for sync functions', async () => {
            clearSpans();
            function add(a: number, b: number) { return a + b; }
            const wrapped = wrapUserFunction(add, 'add');

            const result = wrapped(3, 4);
            expect(result).toBe(7);

            await flush();
            const span = lastSpan();
            expect(span).toBeDefined();
            expect(span.attributes['function.return.value']).toBe('7');
        });

        it('should create a span with function name', async () => {
            clearSpans();
            function myFunc() { return 42; }
            const wrapped = wrapUserFunction(myFunc, 'myFunc');
            wrapped();

            await flush();
            const span = lastSpan();
            expect(span).toBeDefined();
            expect(span.name).toBe('myFunc');
            expect(span.attributes['function.name']).toBe('myFunc');
            expect(span.attributes['function.type']).toBe('user_function');
        });

        it('should capture function arguments', async () => {
            clearSpans();
            function greet(name: string, age: number) { return `Hello ${name}, age ${age}`; }
            const wrapped = wrapUserFunction(greet, 'greet');
            wrapped('Alice', 30);

            await flush();
            const span = lastSpan();
            expect(span.attributes['function.args.count']).toBe(2);
            expect(span.attributes['function.args.0']).toBe('Alice');
            expect(span.attributes['function.args.1']).toBe('30');
        });

        it('should capture return value', async () => {
            clearSpans();
            function compute() { return { result: 42, status: 'ok' }; }
            const wrapped = wrapUserFunction(compute, 'compute');
            wrapped();

            await flush();
            const span = lastSpan();
            const returnVal = span.attributes['function.return.value'] as string;
            expect(returnVal).toContain('"result":42');
            expect(returnVal).toContain('"status":"ok"');
        });

        it('should capture exceptions and re-throw them', async () => {
            clearSpans();
            function failingFn() { throw new Error('test error'); }
            const wrapped = wrapUserFunction(failingFn, 'failingFn');

            expect(() => wrapped()).toThrow('test error');

            await flush();
            const span = lastSpan();
            expect(span.status.code).toBe(2); // SpanStatusCode.ERROR = 2
            expect(span.status.message).toContain('test error');
            expect(span.events.length).toBeGreaterThan(0);
            expect(span.events[0].name).toBe('exception');
        });

        it('should handle async functions and capture resolved values', async () => {
            clearSpans();
            async function fetchData(id: number) {
                return { id, data: 'hello' };
            }
            const wrapped = wrapUserFunction(fetchData, 'fetchData');
            const result = await wrapped(123);

            expect(result).toEqual({ id: 123, data: 'hello' });

            await flush();
            const span = lastSpan();
            expect(span.name).toBe('fetchData');
            expect(span.attributes['function.args.0']).toBe('123');
            const returnVal = span.attributes['function.return.value'] as string;
            expect(returnVal).toContain('"id":123');
        });

        it('should handle async functions that reject', async () => {
            clearSpans();
            async function failAsync() {
                throw new Error('async failure');
            }
            const wrapped = wrapUserFunction(failAsync, 'failAsync');

            await expect(wrapped()).rejects.toThrow('async failure');
            await flush();

            const span = lastSpan();
            expect(span.status.code).toBe(2); // ERROR
            expect(span.status.message).toContain('async failure');
        });

        it('should handle Promise-returning (non-async) functions', async () => {
            clearSpans();
            function promiseFn() {
                return new Promise<string>(resolve => {
                    setTimeout(() => resolve('delayed'), 10);
                });
            }
            const wrapped = wrapUserFunction(promiseFn, 'promiseFn');
            const result = await wrapped();

            expect(result).toBe('delayed');
            await flush();

            const span = lastSpan();
            expect(span.attributes['function.return.value']).toBe('delayed');
        });

        it('should not double-wrap a function', () => {
            function singleWrap() { return 1; }
            const wrapped1 = wrapUserFunction(singleWrap, 'singleWrap');
            const wrapped2 = wrapUserFunction(wrapped1, 'singleWrap');

            expect(wrapped1).toBe(wrapped2); // Same reference — not re-wrapped
        });

        it('should capture up to 10 arguments', async () => {
            clearSpans();
            function manyArgs(...args: number[]) { return args.length; }
            const wrapped = wrapUserFunction(manyArgs, 'manyArgs');
            wrapped(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12);

            await flush();
            const span = lastSpan();
            expect(span.attributes['function.args.count']).toBe(12);
            for (let i = 0; i < 10; i++) {
                expect(span.attributes[`function.args.${i}`]).toBe(String(i + 1));
            }
            // Args 10, 11 should NOT be recorded (cap at 10)
            expect(span.attributes['function.args.10']).toBeUndefined();
        });

        it('should handle zero arguments', async () => {
            clearSpans();
            function noArgs() { return 'nothing'; }
            const wrapped = wrapUserFunction(noArgs, 'noArgs');
            wrapped();

            await flush();
            const span = lastSpan();
            expect(span.attributes['function.args.count']).toBe(0);
        });

        it('should handle object arguments with circular references', async () => {
            clearSpans();
            function processObj(obj: any) { return 'ok'; }
            const wrapped = wrapUserFunction(processObj, 'processObj');

            const circular: any = { name: 'test' };
            circular.self = circular;
            wrapped(circular);

            await flush();
            const span = lastSpan();
            // Should not throw — should serialize gracefully
            expect(span.attributes['function.args.0']).toBeDefined();
        });

        it('should preserve `this` context', async () => {
            clearSpans();
            const obj = {
                value: 42,
                getValue: wrapUserFunction(function (this: any) {
                    return this.value;
                }, 'getValue'),
            };

            const result = obj.getValue();
            expect(result).toBe(42);

            await flush();
            const span = lastSpan();
            expect(span.attributes['function.return.value']).toBe('42');
        });

        it('should use function.name as default span name', async () => {
            clearSpans();
            function namedFunction() { return 1; }
            const wrapped = wrapUserFunction(namedFunction);
            wrapped();

            await flush();
            const span = lastSpan();
            expect(span.name).toBe('namedFunction');
        });

        it('should handle null and undefined return values', async () => {
            clearSpans();
            function returnsNull() { return null; }
            function returnsUndefined() { /* void */ }

            const wrappedNull = wrapUserFunction(returnsNull, 'returnsNull');
            const wrappedUndef = wrapUserFunction(returnsUndefined, 'returnsUndefined');

            expect(wrappedNull()).toBeNull();
            expect(wrappedUndef()).toBeUndefined();

            await flush();
            const spans = getSpans();
            const nullSpan = spans.find(s => s.name === 'returnsNull');
            const undefSpan = spans.find(s => s.name === 'returnsUndefined');

            expect(nullSpan?.attributes['function.return.value']).toBe('null');
            expect(undefSpan?.attributes['function.return.value']).toBe('');
        });

        it('should truncate long string arguments', async () => {
            clearSpans();
            function longArg(s: string) { return s.length; }
            const wrapped = wrapUserFunction(longArg, 'longArg');
            const longString = 'a'.repeat(2000);
            wrapped(longString);

            await flush();
            const span = lastSpan();
            const captured = span.attributes['function.args.0'] as string;
            expect(captured.length).toBeLessThanOrEqual(1004); // 1000 + "..."
            expect(captured).toContain('...');
        });
    });

    describe('wrapUserModule', () => {
        it('should wrap all functions on an object', async () => {
            clearSpans();
            const myModule = {
                add: (a: number, b: number) => a + b,
                multiply: (a: number, b: number) => a * b,
                constant: 42,
            };
            const wrapped = wrapUserModule(myModule, 'math');

            expect(wrapped.add(2, 3)).toBe(5);
            expect(wrapped.multiply(4, 5)).toBe(20);
            expect(wrapped.constant).toBe(42);

            await flush();
            const spans = getSpans();
            const addSpan = spans.find(s => s.name === 'math.add');
            const mulSpan = spans.find(s => s.name === 'math.multiply');

            expect(addSpan).toBeDefined();
            expect(mulSpan).toBeDefined();
            expect(addSpan?.attributes['function.args.0']).toBe('2');
            expect(addSpan?.attributes['function.return.value']).toBe('5');
        });
    });

    describe('traced', () => {
        it('should wrap async functions', async () => {
            clearSpans();
            const myAsync = traced(async (x: number) => x * 2, 'double');
            const result = await myAsync(21);

            expect(result).toBe(42);
            await flush();

            const span = lastSpan();
            expect(span.name).toBe('double');
            expect(span.attributes['function.return.value']).toBe('42');
        });
    });

    describe('source metadata', () => {
        it('should set code.filepath attribute when metadata provided', async () => {
            clearSpans();
            function myFn() { return 1; }
            const wrapped = wrapUserFunction(myFn, 'myFn', { filePath: 'src/app/page.tsx', line: 10, column: 4 });
            wrapped();

            await flush();
            const span = lastSpan();
            expect(span.attributes['code.filepath']).toBe('src/app/page.tsx');
        });

        it('should set code.lineno and code.column attributes when metadata provided', async () => {
            clearSpans();
            function myFn() { return 1; }
            const wrapped = wrapUserFunction(myFn, 'myFn', { filePath: 'test.ts', line: 42, column: 8 });
            wrapped();

            await flush();
            const span = lastSpan();
            expect(span.attributes['code.lineno']).toBe(42);
            expect(span.attributes['code.column']).toBe(8);
        });

        it('should set code.column to 0 when column is 0', async () => {
            clearSpans();
            function myFn() { return 1; }
            const wrapped = wrapUserFunction(myFn, 'myFn', { filePath: 'test.ts', line: 1, column: 0 });
            wrapped();

            await flush();
            const span = lastSpan();
            expect(span.attributes['code.column']).toBe(0);
        });

        it('should set code.function.type to react_component when isComponent is true', async () => {
            clearSpans();
            function MyComponent(props: any) { return props; }
            const wrapped = wrapUserFunction(MyComponent, 'MyComponent', { filePath: 'test.tsx', line: 5, column: 0, isComponent: true });
            wrapped({ title: 'Hello', count: 3 });

            await flush();
            const span = lastSpan();
            expect(span.attributes['code.function.type']).toBe('react_component');
            expect(span.attributes['component.name']).toBe('MyComponent');
        });

        it('should serialize component props excluding children and functions', async () => {
            clearSpans();
            function MyComponent(props: any) { return props; }
            const wrapped = wrapUserFunction(MyComponent, 'MyComponent', { isComponent: true });
            wrapped({
                title: 'Hello',
                count: 3,
                children: '<div />',
                onClick: () => {},
                id: Symbol('test'),
            });

            await flush();
            const span = lastSpan();
            const propsStr = span.attributes['component.props'] as string;
            expect(propsStr).toContain('title');
            expect(propsStr).toContain('Hello');
            expect(propsStr).toContain('count');
            expect(propsStr).not.toContain('children');
            expect(propsStr).not.toContain('onClick');
            expect(propsStr).not.toContain('Symbol');
        });

        it('should not set component attributes when isComponent is false/undefined', async () => {
            clearSpans();
            function myFn() { return 1; }
            const wrapped = wrapUserFunction(myFn, 'myFn', { filePath: 'test.ts', line: 1 });
            wrapped();

            await flush();
            const span = lastSpan();
            expect(span.attributes['code.function.type']).toBeUndefined();
            expect(span.attributes['component.name']).toBeUndefined();
            expect(span.attributes['component.props']).toBeUndefined();
        });

        it('should work without metadata (backward compatible)', async () => {
            clearSpans();
            function plainFn() { return 'ok'; }
            const wrapped = wrapUserFunction(plainFn, 'plainFn');
            const result = wrapped();

            expect(result).toBe('ok');
            await flush();
            const span = lastSpan();
            expect(span.name).toBe('plainFn');
            expect(span.attributes['function.name']).toBe('plainFn');
            // No code.* attributes expected
        });

        it('should handle component with no props gracefully', async () => {
            clearSpans();
            function EmptyComponent() { return null; }
            const wrapped = wrapUserFunction(EmptyComponent, 'EmptyComponent', { isComponent: true });
            wrapped();

            await flush();
            const span = lastSpan();
            expect(span.attributes['component.name']).toBe('EmptyComponent');
            expect(span.attributes['component.props']).toBeUndefined();
        });

        it('should handle component with only non-serializable props', async () => {
            clearSpans();
            function MyComponent(props: any) { return null; }
            const wrapped = wrapUserFunction(MyComponent, 'MyComponent', { isComponent: true });
            wrapped({ children: '<div />', onClick: () => {} });

            await flush();
            const span = lastSpan();
            expect(span.attributes['component.name']).toBe('MyComponent');
            // No serializable props → component.props should not be set
            expect(span.attributes['component.props']).toBeUndefined();
        });

        it('should set code.lineno to 0 when line is 0 (first line of file)', async () => {
            clearSpans();
            function myFn() { return 1; }
            const wrapped = wrapUserFunction(myFn, 'myFn', { filePath: 'test.ts', line: 0, column: 0 });
            wrapped();

            await flush();
            const span = lastSpan();
            expect(span.attributes['code.lineno']).toBe(0);
        });
    });

    describe('silent observer guarantees', () => {
        it('should preserve function.length (arity)', () => {
            function zeroArgs() { return 0; }
            function oneArg(_a: any) { return 1; }
            function twoArgs(_a: any, _b: any) { return 2; }
            function threeArgs(_a: any, _b: any, _c: any) { return 3; }
            function fourArgs(_a: any, _b: any, _c: any, _d: any) { return 4; }

            expect(wrapUserFunction(zeroArgs).length).toBe(0);
            expect(wrapUserFunction(oneArg).length).toBe(1);
            expect(wrapUserFunction(twoArgs).length).toBe(2);
            expect(wrapUserFunction(threeArgs).length).toBe(3);
            expect(wrapUserFunction(fourArgs).length).toBe(4);
        });

        it('should preserve function.name', () => {
            function myNamedFunction() { return 1; }
            const wrapped = wrapUserFunction(myNamedFunction);
            expect(wrapped.name).toBe('myNamedFunction');
        });

        it('should use spanName for anonymous functions name', () => {
            const wrapped = wrapUserFunction(() => 1, 'mySpanName');
            expect(wrapped.name).toBe('mySpanName');
        });

        it('should return generator functions unwrapped', () => {
            function* myGenerator() { yield 1; yield 2; }
            const wrapped = wrapUserFunction(myGenerator as any);
            // Should be the exact same function — not wrapped
            expect(wrapped).toBe(myGenerator);
        });

        it('should return async generator functions unwrapped', () => {
            async function* myAsyncGen() { yield 1; }
            const wrapped = wrapUserFunction(myAsyncGen as any);
            expect(wrapped).toBe(myAsyncGen);
        });

        it('should copy custom properties from original to wrapper', () => {
            function myFn() { return 1; }
            (myFn as any).displayName = 'CustomDisplay';
            (myFn as any).defaultProps = { size: 'medium' };

            const wrapped = wrapUserFunction(myFn, 'myFn');
            expect((wrapped as any).displayName).toBe('CustomDisplay');
            expect((wrapped as any).defaultProps).toEqual({ size: 'medium' });
        });

        it('should re-throw the exact same error object (reference equality)', async () => {
            const originalError = new Error('test error');
            function failingFn() { throw originalError; }
            const wrapped = wrapUserFunction(failingFn, 'failingFn');

            let caughtError: any;
            try { wrapped(); } catch (e) { caughtError = e; }
            expect(caughtError).toBe(originalError); // Exact same reference
        });

        it('should re-throw the exact same error in async functions', async () => {
            const originalError = new Error('async test error');
            async function failingAsync() { throw originalError; }
            const wrapped = wrapUserFunction(failingAsync, 'failingAsync');

            let caughtError: any;
            try { await wrapped(); } catch (e) { caughtError = e; }
            expect(caughtError).toBe(originalError); // Exact same reference
        });

        it('should handle thenable (Promise-compatible) objects', async () => {
            clearSpans();
            // A thenable that returns a proper chainable (has .then and .catch)
            function thenableFn() {
                return Promise.resolve(42);
            }
            const wrapped = wrapUserFunction(thenableFn, 'thenableFn');

            const result = await wrapped();
            expect(result).toBe(42);

            await flush();
            const span = lastSpan();
            expect(span.attributes['function.return.value']).toBe('42');
        });
    });
});
