/**
 * Tests for toStr edge cases (Map, Set, Error, Buffer, BigInt, circular, deep nesting)
 * and rapid-fire function wrapping (stress test)
 */

import { describe, it, expect, afterAll } from 'vitest';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

const memoryExporter = new InMemorySpanExporter();
const spanProcessor = new SimpleSpanProcessor(memoryExporter);
const sdk = new NodeSDK({
    spanProcessors: [spanProcessor],
});
sdk.start();

import { wrapUserFunction } from '../probe-wrapper';

afterAll(async () => {
    await sdk.shutdown();
});

async function flush() {
    await spanProcessor.forceFlush();
}

describe('toStr edge cases (via probe-wrapper)', () => {
    it('should serialize Date objects as ISO strings', async () => {
        memoryExporter.reset();
        const fn = wrapUserFunction(() => new Date('2024-01-15T12:00:00Z'), 'dateReturn');
        fn();
        await flush();
        const span = memoryExporter.getFinishedSpans().find(s => s.name === 'dateReturn');
        expect(span?.attributes['function.return.value']).toContain('2024-01-15');
    });

    it('should serialize Map objects', async () => {
        memoryExporter.reset();
        const wrapped = wrapUserFunction((m: Map<string, number>) => 'ok', 'mapArg');
        wrapped(new Map([['a', 1], ['b', 2]]));
        await flush();
        const span = memoryExporter.getFinishedSpans().find(s => s.name === 'mapArg');
        const argStr = span?.attributes['function.args.0'] as string;
        expect(argStr).toContain('Map');
        expect(argStr).toContain('"a"');
    });

    it('should serialize Set objects', async () => {
        memoryExporter.reset();
        const wrapped = wrapUserFunction((s: Set<number>) => 'ok', 'setArg');
        wrapped(new Set([1, 2, 3]));
        await flush();
        const span = memoryExporter.getFinishedSpans().find(s => s.name === 'setArg');
        const argStr = span?.attributes['function.args.0'] as string;
        expect(argStr).toContain('Set');
    });

    it('should serialize Error objects with name and message', async () => {
        memoryExporter.reset();
        const wrapped = wrapUserFunction((e: Error) => 'ok', 'errorArg');
        wrapped(new Error('test error'));
        await flush();
        const span = memoryExporter.getFinishedSpans().find(s => s.name === 'errorArg');
        const argStr = span?.attributes['function.args.0'] as string;
        expect(argStr).toContain('test error');
        expect(argStr).toContain('Error');
    });

    it('should serialize Buffer as type + length', async () => {
        memoryExporter.reset();
        const wrapped = wrapUserFunction((b: Buffer) => 'ok', 'bufferArg');
        wrapped(Buffer.from('hello world'));
        await flush();
        const span = memoryExporter.getFinishedSpans().find(s => s.name === 'bufferArg');
        const argStr = span?.attributes['function.args.0'] as string;
        expect(argStr).toContain('Buffer');
        expect(argStr).toContain('11');
    });

    it('should handle functions as arguments', async () => {
        memoryExporter.reset();
        const wrapped = wrapUserFunction((cb: Function) => 'ok', 'fnArg');
        wrapped(function myCallback() {});
        await flush();
        const span = memoryExporter.getFinishedSpans().find(s => s.name === 'fnArg');
        const argStr = span?.attributes['function.args.0'] as string;
        expect(argStr).toContain('Function');
        expect(argStr).toContain('myCallback');
    });

    it('should handle deeply nested objects without crashing', async () => {
        memoryExporter.reset();
        let obj: any = { value: 'leaf' };
        for (let i = 0; i < 50; i++) obj = { nested: obj };
        const wrapped = wrapUserFunction((o: any) => 'ok', 'deepNest');
        wrapped(obj);
        await flush();
        const span = memoryExporter.getFinishedSpans().find(s => s.name === 'deepNest');
        expect(span?.attributes['function.args.0']).toBeDefined();
    });

    it('should truncate very long serialized objects at 1000 chars', async () => {
        memoryExporter.reset();
        const bigObj = { data: 'x'.repeat(2000) };
        const wrapped = wrapUserFunction((o: any) => 'ok', 'bigObj');
        wrapped(bigObj);
        await flush();
        const span = memoryExporter.getFinishedSpans().find(s => s.name === 'bigObj');
        const argStr = span?.attributes['function.args.0'] as string;
        expect(argStr.length).toBeLessThanOrEqual(1004); // 1000 + "..."
        expect(argStr).toContain('...');
    });

    it('should handle circular references gracefully', async () => {
        memoryExporter.reset();
        const circular: any = { name: 'root' };
        circular.self = circular;
        const wrapped = wrapUserFunction((o: any) => 'ok', 'circularDeep');
        wrapped(circular);
        await flush();
        const span = memoryExporter.getFinishedSpans().find(s => s.name === 'circularDeep');
        const argStr = span?.attributes['function.args.0'] as string;
        expect(argStr).toContain('Circular');
    });
});

describe('Rapid-fire stress test', () => {
    it('should handle 200 rapid function calls without crashing', async () => {
        memoryExporter.reset();
        const fn = wrapUserFunction((i: number) => i * 2, 'rapidFn');

        for (let i = 0; i < 200; i++) fn(i);
        await flush();

        const spans = memoryExporter.getFinishedSpans().filter(s => s.name === 'rapidFn');
        expect(spans.length).toBe(200);
    });

    it('should handle interleaved async calls', async () => {
        memoryExporter.reset();
        const fn = wrapUserFunction(async (i: number) => {
            await new Promise(r => setTimeout(r, 1));
            return i * 3;
        }, 'asyncRapid');

        const promises = Array.from({ length: 20 }, (_, i) => fn(i));
        const results = await Promise.all(promises);

        expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i * 3));
        await flush();

        const spans = memoryExporter.getFinishedSpans().filter(s => s.name === 'asyncRapid');
        expect(spans.length).toBe(20);
    });
});
