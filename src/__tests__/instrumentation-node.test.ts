/**
 * Dedicated tests for instrumentation.node.ts
 *
 * Tests the core Node.js runtime: function wrapping, span processors,
 * runtime config integration, and the wrapUserFunction public API.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
    wrapUserFunction,
    wrapUserModule,
    traced,
    flushSpans,
    getSpans,
    clearSpans,
    getSpanStats,
    getRuntimeConfig,
    createSpanProcessors,
    createSdk,
} from '../instrumentation.node';

beforeAll(async () => {
    clearSpans();
});

describe('instrumentation.node exports', () => {
    it('should export wrapUserFunction', () => {
        expect(typeof wrapUserFunction).toBe('function');
    });

    it('should export wrapUserModule', () => {
        expect(typeof wrapUserModule).toBe('function');
    });

    it('should export traced', () => {
        expect(typeof traced).toBe('function');
    });

    it('should export flushSpans', () => {
        expect(typeof flushSpans).toBe('function');
    });

    it('should export span cache query functions', () => {
        expect(typeof getSpans).toBe('function');
        expect(typeof clearSpans).toBe('function');
        expect(typeof getSpanStats).toBe('function');
    });

    it('should export createSpanProcessors', () => {
        expect(typeof createSpanProcessors).toBe('function');
    });

    it('should export createSdk', () => {
        expect(typeof createSdk).toBe('function');
    });
});

describe('getRuntimeConfig', () => {
    it('should return a valid config object', () => {
        const config = getRuntimeConfig();
        expect(config).toBeDefined();
        expect(config.serverPort).toBeTypeOf('number');
        expect(config.serverHost).toBeTypeOf('string');
        expect(config.serviceName).toBeTypeOf('string');
    });

    it('should default serverHost to 127.0.0.1', () => {
        const config = getRuntimeConfig();
        expect(config.serverHost).toBe('127.0.0.1');
    });
});

describe('wrapUserFunction integration', () => {
    it('should wrap a sync function and produce a span', async () => {
        clearSpans();
        const add = wrapUserFunction(function add(a: number, b: number) {
            return a + b;
        }, 'test.add');

        const result = add(3, 4);
        expect(result).toBe(7);

        await flushSpans();
        const spans = getSpans();
        const span = spans.find(s => s.attributes['function.name'] === 'test.add');
        expect(span).toBeDefined();
        expect(span!.attributes['function.args.count']).toBe(2);
    });

    it('should wrap an async function and produce a span', async () => {
        clearSpans();
        const asyncFn = wrapUserFunction(async function fetchData() {
            return 'data';
        }, 'test.fetchData');

        const result = await asyncFn();
        expect(result).toBe('data');

        await flushSpans();
        const spans = getSpans();
        const span = spans.find(s => s.attributes['function.name'] === 'test.fetchData');
        expect(span).toBeDefined();
    });

    it('should skip generator functions', () => {
        function* gen() { yield 1; yield 2; }
        const wrapped = wrapUserFunction(gen, 'test.gen');
        // Generator should be returned unwrapped
        expect(wrapped).toBe(gen);
    });

    it('should preserve function arity', () => {
        function threeArgs(_a: number, _b: string, _c: boolean) { return true; }
        const wrapped = wrapUserFunction(threeArgs, 'test.threeArgs');
        expect(wrapped.length).toBe(3);
    });

    it('should preserve function name', () => {
        function mySpecialFunction() { return 42; }
        const wrapped = wrapUserFunction(mySpecialFunction, 'test.mySpecialFunction');
        expect(wrapped.name).toBe('mySpecialFunction');
    });

    it('should include V8 source location when no metadata provided', async () => {
        clearSpans();
        const fn = wrapUserFunction(function locatedFn() { return 'here'; }, 'test.locatedFn');
        fn();
        await flushSpans();

        const spans = getSpans();
        const span = spans.find(s => s.attributes['function.name'] === 'test.locatedFn');
        expect(span).toBeDefined();
        // V8 source should have captured the file path of this test file
        expect(span!.attributes['code.filepath']).toBeTypeOf('string');
        expect(String(span!.attributes['code.filepath'])).toContain('instrumentation-node.test');
    });

    it('should use explicit metadata over V8 fallback', async () => {
        clearSpans();
        const fn = wrapUserFunction(
            function explicitFn() { return 1; },
            'test.explicitFn',
            { filePath: 'custom/path.ts', line: 42, column: 10 },
        );
        fn();
        await flushSpans();

        const spans = getSpans();
        const span = spans.find(s => s.attributes['function.name'] === 'test.explicitFn');
        expect(span).toBeDefined();
        expect(span!.attributes['code.filepath']).toBe('custom/path.ts');
        expect(span!.attributes['code.lineno']).toBe(42);
        expect(span!.attributes['code.column']).toBe(10);
    });
});

describe('wrapUserModule', () => {
    it('should wrap all functions on an object', async () => {
        clearSpans();
        const mod = wrapUserModule({
            greet(name: string) { return `Hello ${name}`; },
            add(a: number, b: number) { return a + b; },
        }, 'testModule');

        expect(mod.greet('world')).toBe('Hello world');
        expect(mod.add(1, 2)).toBe(3);

        await flushSpans();
        const spans = getSpans();
        expect(spans.find(s => s.attributes['function.name'] === 'testModule.greet')).toBeDefined();
        expect(spans.find(s => s.attributes['function.name'] === 'testModule.add')).toBeDefined();
    });
});

describe('traced', () => {
    it('should wrap an async function', async () => {
        clearSpans();
        const fn = traced(async function tracedOp() { return 'ok'; }, 'test.tracedOp');
        const result = await fn();
        expect(result).toBe('ok');

        await flushSpans();
        const spans = getSpans();
        expect(spans.find(s => s.attributes['function.name'] === 'test.tracedOp')).toBeDefined();
    });
});

describe('span statistics', () => {
    it('should return statistics about spans', async () => {
        clearSpans();
        const fn = wrapUserFunction(function statsTest() { return 1; }, 'test.statsTest');
        fn();
        fn();
        fn();
        await flushSpans();

        const stats = getSpanStats();
        expect(stats.totalSpans).toBeGreaterThanOrEqual(3);
        expect(stats.totalFunctions).toBeGreaterThanOrEqual(1);
    });
});

describe('createSpanProcessors', () => {
    it('should return at least one processor (local exporter)', () => {
        const processors = createSpanProcessors();
        expect(processors.length).toBeGreaterThanOrEqual(1);
    });
});

describe('error handling', () => {
    it('should re-throw sync errors with same reference', async () => {
        const error = new Error('test error');
        const fn = wrapUserFunction(function throwSync() { throw error; }, 'test.throwSync');

        let caught: unknown;
        try { fn(); } catch (e) { caught = e; }
        expect(caught).toBe(error);
    });

    it('should re-throw async errors with same reference', async () => {
        const error = new Error('async test error');
        const fn = wrapUserFunction(async function throwAsync() { throw error; }, 'test.throwAsync');

        let caught: unknown;
        try { await fn(); } catch (e) { caught = e; }
        expect(caught).toBe(error);
    });
});
