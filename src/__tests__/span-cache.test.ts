/**
 * Tests for the SpanCache ring buffer and data storage
 *
 * Tests the core data layer, verifying:
 * - Spans flow from wrapped functions → OTel exporter → SpanCache
 * - Querying by traceId, functionName
 * - Statistics computation
 * - Caller-callee tracking (the "beyond OTel" feature)
 * - Complex object serialization
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';

// Set env vars before importing — disable server and JSONL for tests
process.env.DEBUG_PROBE_PORT = '43299'; // Use a test-specific port
process.env.DEBUG_PROBE_JSONL = 'false';
process.env.DEBUG_PROBE_LOG = 'false';

import {
    getSpans,
    getSpansByTraceId,
    getSpansByFunctionName,
    clearSpans,
    getSpanStats,
    wrapUserFunction,
    flushSpans,
    sdk,
} from '../instrumentation.node';

async function flush() {
    await flushSpans();
}

describe('SpanCache (integration)', () => {
    beforeEach(async () => {
        clearSpans();
    });

    afterAll(async () => {
        await sdk.shutdown().catch(() => {});
    });

    it('should start empty', () => {
        const spans = getSpans();
        expect(spans).toHaveLength(0);
    });

    it('should capture spans from wrapped function calls', async () => {
        function add(a: number, b: number) { return a + b; }
        const wrappedAdd = wrapUserFunction(add, 'testAdd');
        wrappedAdd(1, 2);

        await flush();

        const spans = getSpans();
        expect(spans.length).toBeGreaterThan(0);

        const addSpan = spans.find(s => s.attributes['function.name'] === 'testAdd');
        expect(addSpan).toBeDefined();
        expect(addSpan!.attributes['function.args.0']).toBe('1');
        expect(addSpan!.attributes['function.args.1']).toBe('2');
        expect(addSpan!.attributes['function.return.value']).toBe('3');
    });

    it('should capture exceptions in spans', async () => {
        function throwError() { throw new Error('kaboom'); }
        const wrapped = wrapUserFunction(throwError, 'testThrow');

        expect(() => wrapped()).toThrow('kaboom');

        await flush();

        const spans = getSpans();
        const errorSpan = spans.find(s => s.attributes['function.name'] === 'testThrow');
        expect(errorSpan).toBeDefined();
        expect(errorSpan!.status.code).toBe(2); // ERROR
        expect(errorSpan!.status.message).toContain('kaboom');
    });

    it('should capture async function return values', async () => {
        async function fetchUser(id: number) {
            return { id, name: 'Alice' };
        }
        const wrapped = wrapUserFunction(fetchUser, 'testFetchUser');
        const result = await wrapped(42);

        expect(result).toEqual({ id: 42, name: 'Alice' });
        await flush();

        const spans = getSpans();
        const fetchSpan = spans.find(s => s.attributes['function.name'] === 'testFetchUser');
        expect(fetchSpan).toBeDefined();
        expect(fetchSpan!.attributes['function.args.0']).toBe('42');
        const retVal = fetchSpan!.attributes['function.return.value'] as string;
        expect(retVal).toContain('"id":42');
        expect(retVal).toContain('"name":"Alice"');
    });

    it('should query spans by function name', async () => {
        function fnA() { return 'a'; }
        function fnB() { return 'b'; }
        const wrappedA = wrapUserFunction(fnA, 'queryFnA');
        const wrappedB = wrapUserFunction(fnB, 'queryFnB');

        wrappedA();
        wrappedA();
        wrappedB();

        await flush();

        const aSpans = getSpansByFunctionName('queryFnA');
        const bSpans = getSpansByFunctionName('queryFnB');

        expect(aSpans.length).toBe(2);
        expect(bSpans.length).toBe(1);
    });

    it('should query spans by traceId', async () => {
        function traced1() { return 1; }
        const wrapped = wrapUserFunction(traced1, 'byTrace');
        wrapped();

        await flush();

        const spans = getSpans();
        const span = spans.find(s => s.attributes['function.name'] === 'byTrace');
        expect(span).toBeDefined();

        const byTrace = getSpansByTraceId(span!.traceId);
        expect(byTrace.length).toBeGreaterThan(0);
        expect(byTrace[0].traceId).toBe(span!.traceId);
    });

    it('should report statistics', async () => {
        function s1() { return 1; }
        function s2() { return 2; }
        const w1 = wrapUserFunction(s1, 'stat1');
        const w2 = wrapUserFunction(s2, 'stat2');
        w1(); w1(); w2();

        await flush();

        const stats = getSpanStats();
        expect(stats.totalSpans).toBeGreaterThanOrEqual(3);
        expect(stats.totalFunctions).toBeGreaterThanOrEqual(2);
        expect(stats.totalTraces).toBeGreaterThanOrEqual(1);
    });

    it('should clear all spans', async () => {
        function clearMe() { return 1; }
        const wrapped = wrapUserFunction(clearMe, 'clearMe');
        wrapped();
        await flush();

        expect(getSpans().length).toBeGreaterThan(0);
        clearSpans();
        expect(getSpans().length).toBe(0);
    });

    it('should track caller-callee relationships', async () => {
        function inner() { return 'inner result'; }
        const wrappedInner = wrapUserFunction(inner, 'innerFn');

        function outer() { return wrappedInner(); }
        const wrappedOuter = wrapUserFunction(outer, 'outerFn');

        wrappedOuter();
        await flush();

        const spans = getSpans();
        const innerSpan = spans.find(s => s.attributes['function.name'] === 'innerFn');
        const outerSpan = spans.find(s => s.attributes['function.name'] === 'outerFn');

        expect(innerSpan).toBeDefined();
        expect(outerSpan).toBeDefined();
        // Inner should know that outer called it — this is the "beyond OTel" feature
        expect(innerSpan!.attributes['function.caller.name']).toBe('outerFn');
    });

    it('should handle complex object serialization', async () => {
        function processData(data: any) { return data; }
        const wrapped = wrapUserFunction(processData, 'processData');

        const complexObj = {
            users: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
            metadata: { total: 2, page: 1 },
            nested: { deep: { value: true } },
        };
        wrapped(complexObj);

        await flush();

        const spans = getSpans();
        const span = spans.find(s => s.attributes['function.name'] === 'processData');
        expect(span).toBeDefined();
        const argStr = span!.attributes['function.args.0'] as string;
        expect(argStr).toContain('"users"');
        expect(argStr).toContain('"Alice"');
    });

    it('should capture return value for sync functions', async () => {
        function multiply(a: number, b: number) { return a * b; }
        const wrapped = wrapUserFunction(multiply, 'multiply');
        const result = wrapped(6, 7);

        expect(result).toBe(42);
        await flush();

        const spans = getSpans();
        const span = spans.find(s => s.attributes['function.name'] === 'multiply');
        expect(span).toBeDefined();
        expect(span!.attributes['function.return.value']).toBe('42');
        expect(span!.status.code).toBe(1); // OK
    });
});
