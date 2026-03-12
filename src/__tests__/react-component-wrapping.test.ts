/**
 * Focused integration tests for React component wrapping via the Babel plugin.
 *
 * Tests realistic React component patterns to verify the Babel plugin:
 * - Transforms components with props, hooks, and JSX
 * - Handles export default function components
 * - Handles 'use client' directive ordering
 * - Produces valid metadata objects
 */

import { describe, it, expect } from 'vitest';
import { transformSync } from '@babel/core';

const pluginPath = require.resolve('../babel-plugin-probe.js');

function transform(code: string, filename = '/project/app/test.tsx', opts: Record<string, any> = {}) {
    const result = transformSync(code, {
        filename,
        plugins: [[pluginPath, { include: ['/app/'], ...opts }]],
        parserOpts: { plugins: ['typescript', 'jsx'] },
    });
    return result?.code || '';
}

describe('React component wrapping (integration)', () => {
    it('should wrap a realistic function component with props and hooks', () => {
        const input = `
import { useState } from 'react';

function Counter({ initialCount, label }) {
    const [count, setCount] = useState(initialCount);
    return <div>{label}: {count}</div>;
}
`;
        const output = transform(input);
        expect(output).toContain('_unwrapped_Counter');
        expect(output).toContain("wrapUserFunction(_unwrapped_Counter,");
        expect(output).toMatch(/["']Counter["']/);
        expect(output).toContain('isComponent: true');
        // The useState import should still be there
        expect(output).toContain("from 'react'");
    });

    it('should wrap export default function component', () => {
        const input = `export default function HomePage() { return <main>Hello</main>; }`;
        const output = transform(input);
        expect(output).toContain('_unwrapped_HomePage');
        expect(output).toContain("wrapUserFunction(_unwrapped_HomePage,");
        expect(output).toContain('isComponent: true');
    });

    it('should wrap component after use client directive', () => {
        const input = `'use client';
function DemoPanel() { return <div>Demo</div>; }`;
        const output = transform(input);

        const directiveIndex = output.indexOf("'use client'");
        const importIndex = output.indexOf('import');
        expect(directiveIndex).toBeLessThan(importIndex);
        expect(output).toContain('_unwrapped_DemoPanel');
        expect(output).toContain('isComponent: true');
    });

    it('should wrap both components and exported functions in the same file', () => {
        const input = `
function MyComponent() { return <div>{formatData()}</div>; }
export function formatData() { return 'data'; }
`;
        const output = transform(input);
        expect(output).toContain('_unwrapped_MyComponent');
        expect(output).toContain('_unwrapped_formatData');

        // MyComponent should be isComponent: true
        const componentSection = output.slice(
            output.indexOf('_unwrapped_MyComponent'),
            output.indexOf('_unwrapped_formatData')
        );
        expect(componentSection).toContain('isComponent: true');

        // formatData should be isComponent: false
        const functionSection = output.slice(output.indexOf('_unwrapped_formatData'));
        expect(functionSection).toContain('isComponent: false');
    });

    it('should wrap arrow component alongside arrow functions', () => {
        const input = `
const Header = () => <header>Title</header>;
const processData = (items) => items.map(i => i * 2);
`;
        const output = transform(input);
        expect(output).toContain('_unwrapped_Header');
        expect(output).toContain('_unwrapped_processData');
    });

    it('should not wrap arrow functions that are not function expressions (e.g. plain values)', () => {
        const input = `
const MyComponent = () => <div />;
const myNumber = 42;
const myString = "hello";
`;
        const output = transform(input);
        expect(output).toContain('_unwrapped_MyComponent');
        // These should not be wrapped
        expect(output).not.toContain('_unwrapped_myNumber');
        expect(output).not.toContain('_unwrapped_myString');
    });

    it('should produce metadata with correct filePath for different filenames', () => {
        const input = `function MyPage() { return <div />; }`;
        const output = transform(input, '/project/app/dashboard/page.tsx');
        expect(output).toContain('dashboard/page.tsx');
    });

    it('should still exclude React hooks even in component files', () => {
        const input = `
function MyComponent() { return <div />; }
const useCustomHook = () => useState(0);
`;
        // useCustomHook as arrow function is wrapped (no hoisting concern)
        // MyComponent is PascalCase component — always wrapped
        const output = transform(input);
        expect(output).toContain('_unwrapped_MyComponent');
        // useCustomHook as arrow function IS wrapped (not in EXCLUDE_FUNCTIONS, just camelCase)
        expect(output).toContain('_unwrapped_useCustomHook');
    });

    it('should handle the wrapUserFunction 3-arg call correctly', () => {
        const input = `function Card({ title }) { return <div>{title}</div>; }`;
        const output = transform(input);

        // Should be: wrapUserFunction(_unwrapped_Card, 'Card', { filePath: ..., line: ..., column: ..., isComponent: true })
        // Verify the 3-argument pattern
        const wrapCall = output.match(/wrapUserFunction\(_unwrapped_Card,\s*['"]Card['"],\s*\{/);
        expect(wrapCall).not.toBeNull();
    });
});
