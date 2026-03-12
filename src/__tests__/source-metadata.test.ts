/**
 * Tests for source metadata flow through the instrumentation.node.ts pipeline.
 *
 * Verifies that:
 * - Babel-injected metadata (filePath, line, column, isComponent) flows to span attributes
 * - V8 fallback captures source location when no metadata provided
 * - Component-specific attributes (component.name, component.props) are set
 * - Backward compatibility: wrapping without metadata still works
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';

// Set env vars before importing — use test-specific port, disable JSONL
process.env.DEBUG_PROBE_PORT = '43291';
process.env.DEBUG_PROBE_JSONL = 'false';
process.env.DEBUG_PROBE_LOG = 'false';
process.env.DEBUG_PROBE_V8_SOURCE = 'true';

import {
    getSpans,
    clearSpans,
    wrapUserFunction,
    flushSpans,
    sdk,
} from '../instrumentation.node';

async function flush() {
    await flushSpans();
}

describe('source metadata (integration)', () => {
    beforeEach(async () => {
        clearSpans();
    });

    afterAll(async () => {
        await sdk.shutdown().catch(() => {});
    });

    it('should set code.filepath when Babel metadata provided', async () => {
        function myFn() { return 1; }
        const wrapped = wrapUserFunction(myFn, 'myFn', {
            filePath: 'src/app/page.tsx',
            line: 15,
            column: 0,
        });
        wrapped();
        await flush();

        const spans = getSpans();
        const span = spans.find(s => s.attributes['function.name'] === 'myFn');
        expect(span).toBeDefined();
        expect(span!.attributes['code.filepath']).toBe('src/app/page.tsx');
        expect(span!.attributes['code.lineno']).toBe(15);
        expect(span!.attributes['code.column']).toBe(0);
    });

    it('should set component attributes when isComponent is true', async () => {
        function MyComponent(props: any) { return props; }
        const wrapped = wrapUserFunction(MyComponent, 'MyComponent', {
            filePath: 'components/card.tsx',
            line: 8,
            column: 0,
            isComponent: true,
        });
        wrapped({ title: 'Card', size: 'large' });
        await flush();

        const spans = getSpans();
        const span = spans.find(s => s.attributes['function.name'] === 'MyComponent');
        expect(span).toBeDefined();
        expect(span!.attributes['code.function.type']).toBe('react_component');
        expect(span!.attributes['component.name']).toBe('MyComponent');
        const propsStr = span!.attributes['component.props'] as string;
        expect(propsStr).toContain('title');
        expect(propsStr).toContain('Card');
        expect(propsStr).toContain('size');
    });

    it('should capture V8 source location as fallback when no metadata provided', async () => {
        function v8TestFn() { return 'v8'; }
        const wrapped = wrapUserFunction(v8TestFn, 'v8TestFn');
        wrapped();
        await flush();

        const spans = getSpans();
        const span = spans.find(s => s.attributes['function.name'] === 'v8TestFn');
        expect(span).toBeDefined();
        // V8 fallback should populate code.filepath with the test file path
        expect(span!.attributes['code.filepath']).toBeDefined();
        const filepath = span!.attributes['code.filepath'] as string;
        expect(filepath).toContain('source-metadata.test');
        expect(span!.attributes['code.lineno']).toBeGreaterThan(0);
    });

    it('should prefer Babel metadata over V8 fallback', async () => {
        function babelPriority() { return 1; }
        const wrapped = wrapUserFunction(babelPriority, 'babelPriority', {
            filePath: 'babel/injected.ts',
            line: 99,
            column: 5,
        });
        wrapped();
        await flush();

        const spans = getSpans();
        const span = spans.find(s => s.attributes['function.name'] === 'babelPriority');
        expect(span).toBeDefined();
        // Should use the Babel-injected path, not V8 (which would be this test file)
        expect(span!.attributes['code.filepath']).toBe('babel/injected.ts');
        expect(span!.attributes['code.lineno']).toBe(99);
        expect(span!.attributes['code.column']).toBe(5);
    });

    it('should exclude children, functions, and symbols from component props', async () => {
        function MyComponent(props: any) { return null; }
        const wrapped = wrapUserFunction(MyComponent, 'MyComponent', { isComponent: true });
        wrapped({
            label: 'test',
            children: '<div />',
            onClick: () => {},
            sym: Symbol('s'),
        });
        await flush();

        const spans = getSpans();
        const span = spans.find(s => s.attributes['function.name'] === 'MyComponent');
        const propsStr = span!.attributes['component.props'] as string;
        expect(propsStr).toContain('label');
        expect(propsStr).not.toContain('children');
        expect(propsStr).not.toContain('onClick');
        expect(propsStr).not.toContain('Symbol');
    });

    it('should preserve caller tracking with metadata', async () => {
        function outer() { return inner(); }
        function inner() { return 42; }
        const wrappedOuter = wrapUserFunction(outer, 'outer', { filePath: 'test.ts', line: 1 });
        const wrappedInner = wrapUserFunction(inner, 'inner', { filePath: 'test.ts', line: 5 });
        // Replace inner reference to use wrapped version
        const outerWithInner = wrapUserFunction(
            function () { return wrappedInner(); },
            'outerWithInner',
            { filePath: 'test.ts', line: 1 },
        );
        outerWithInner();
        await flush();

        const spans = getSpans();
        const innerSpan = spans.find(s => s.attributes['function.name'] === 'inner');
        expect(innerSpan).toBeDefined();
        expect(innerSpan!.attributes['code.filepath']).toBe('test.ts');
        expect(innerSpan!.attributes['code.lineno']).toBe(5);
    });
});
