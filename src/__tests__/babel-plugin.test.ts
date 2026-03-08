/**
 * Tests for babel-plugin-probe.js — the AST transform
 *
 * Verifies that the Babel plugin correctly:
 * - Wraps regular functions with wrapUserFunction
 * - Preserves exported functions
 * - Skips React hooks, components, and excluded functions
 * - Handles API route handlers (GET, POST, etc.)
 * - Adds the import statement
 * - Respects 'use client' / 'use server' directives
 */

import { describe, it, expect } from 'vitest';
import { transformSync } from '@babel/core';

// The plugin path — require it directly
const pluginPath = require.resolve('../babel-plugin-probe.js');

function transform(code: string, filename = '/project/app/test.ts', opts: Record<string, any> = {}) {
    const result = transformSync(code, {
        filename,
        plugins: [[pluginPath, { include: ['/app/'], ...opts }]],
        parserOpts: { plugins: ['typescript', 'jsx'] },
        // Don't use presets to keep output clean
    });
    return result?.code || '';
}

describe('babel-plugin-probe', () => {
    describe('function wrapping', () => {
        it('should wrap a regular function declaration', () => {
            const input = `function calculateTotal(items) { return items.reduce((a, b) => a + b, 0); }`;
            const output = transform(input);

            expect(output).toContain('function _unwrapped_calculateTotal');
            expect(output).toMatch(/const calculateTotal = wrapUserFunction\(_unwrapped_calculateTotal, ["']calculateTotal["']\)/);
            expect(output).toContain("import { wrapUserFunction } from");
        });

        it('should wrap multiple functions', () => {
            const input = `
function foo() { return 1; }
function bar() { return 2; }
`;
            const output = transform(input);

            expect(output).toContain('_unwrapped_foo');
            expect(output).toContain('_unwrapped_bar');
            expect(output).toMatch(/wrapUserFunction\(_unwrapped_foo, ["']foo["']\)/);
            expect(output).toMatch(/wrapUserFunction\(_unwrapped_bar, ["']bar["']\)/);
        });

        it('should add import only once for multiple functions', () => {
            const input = `
function a() { return 1; }
function b() { return 2; }
`;
            const output = transform(input);
            const importCount = (output.match(/import.*wrapUserFunction/g) || []).length;
            expect(importCount).toBe(1);
        });
    });

    describe('exclusions', () => {
        it('should NOT wrap React hooks', () => {
            const input = `function useState() { return []; }`;
            const output = transform(input);
            expect(output).not.toContain('_unwrapped_useState');
        });

        it('should NOT wrap PascalCase functions (React components)', () => {
            const input = `function MyComponent() { return <div />; }`;
            const output = transform(input);
            expect(output).not.toContain('_unwrapped_MyComponent');
        });

        it('should NOT wrap constructor', () => {
            const input = `function constructor() { }`;
            const output = transform(input);
            expect(output).not.toContain('_unwrapped_constructor');
        });

        it('should NOT wrap already-wrapped functions (_unwrapped_ prefix)', () => {
            const input = `function _unwrapped_test() { return 1; }`;
            const output = transform(input);
            // Should not create _unwrapped__unwrapped_test
            expect(output).not.toContain('_unwrapped__unwrapped_');
        });

        it('should NOT wrap toString/valueOf/toJSON', () => {
            const input = `
function toString() { return ''; }
function valueOf() { return 0; }
function toJSON() { return {}; }
`;
            const output = transform(input);
            expect(output).not.toContain('_unwrapped_toString');
            expect(output).not.toContain('_unwrapped_valueOf');
            expect(output).not.toContain('_unwrapped_toJSON');
        });

        it('should NOT wrap Next.js special functions', () => {
            const input = `function generateMetadata() { return {}; }`;
            const output = transform(input);
            expect(output).not.toContain('_unwrapped_generateMetadata');
        });

        it('should skip files outside include paths', () => {
            const input = `function test() { return 1; }`;
            const output = transform(input, '/project/lib/utils.ts');
            expect(output).not.toContain('_unwrapped_test');
        });

        it('should skip node_modules', () => {
            const input = `function test() { return 1; }`;
            const output = transform(input, '/project/node_modules/something/app/index.ts');
            expect(output).not.toContain('_unwrapped_test');
        });
    });

    describe('exports', () => {
        it('should handle exported API handlers (GET, POST, etc.)', () => {
            const input = `export function GET(req) { return new Response('ok'); }`;
            const output = transform(input);

            expect(output).toContain('_unwrapped_GET');
            expect(output).toMatch(/wrapUserFunction\(_unwrapped_GET, ["']GET["']\)/);
            expect(output).toContain('export const GET');
        });

        it('should NOT wrap exported PascalCase functions (React components)', () => {
            const input = `export function HomePage() { return <div />; }`;
            const output = transform(input);
            expect(output).not.toContain('_unwrapped_HomePage');
        });
    });

    describe('directives', () => {
        it('should place import after "use server" directive', () => {
            const input = `'use server';\nfunction myAction() { return 1; }`;
            const output = transform(input);
            // The import should come after the directive
            const directiveIndex = output.indexOf("'use server'");
            const importIndex = output.indexOf('import');
            expect(directiveIndex).toBeLessThan(importIndex);
        });

        it('should place import after "use client" directive', () => {
            const input = `'use client';\nfunction helper() { return 1; }`;
            const output = transform(input);
            const directiveIndex = output.indexOf("'use client'");
            const importIndex = output.indexOf('import');
            expect(directiveIndex).toBeLessThan(importIndex);
        });
    });

    describe('custom options', () => {
        it('should use custom importPath', () => {
            const input = `function test() { return 1; }`;
            const output = transform(input, '/project/app/test.ts', {
                importPath: './my-custom-wrapper',
            });
            expect(output).toMatch(/from ["']\.\/my-custom-wrapper["']/);
        });
    });
});
