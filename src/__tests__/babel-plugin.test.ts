/**
 * Tests for babel-plugin-probe.js — the AST transform
 *
 * Verifies that the Babel plugin correctly:
 * - Wraps exported functions and React components with wrapUserFunction + source metadata
 * - Wraps arrow function components and expressions
 * - Preserves exported functions
 * - Skips non-exported function declarations (hoisting safety)
 * - Skips generator functions
 * - Skips React hooks and excluded functions
 * - Handles API route handlers (GET, POST, etc.)
 * - Adds the import statement
 * - Respects 'use client' / 'use server' directives
 * - Injects accurate source location metadata (filePath, line, column)
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
        it('should wrap an exported function declaration', () => {
            const input = `export function calculateTotal(items) { return items.reduce((a, b) => a + b, 0); }`;
            const output = transform(input);

            expect(output).toContain('function _unwrapped_calculateTotal');
            expect(output).toContain("wrapUserFunction(_unwrapped_calculateTotal,");
            expect(output).toContain("import { wrapUserFunction } from");
        });

        it('should wrap multiple exported functions', () => {
            const input = `
export function foo() { return 1; }
export function bar() { return 2; }
`;
            const output = transform(input);

            expect(output).toContain('_unwrapped_foo');
            expect(output).toContain('_unwrapped_bar');
            expect(output).toContain("wrapUserFunction(_unwrapped_foo,");
            expect(output).toContain("wrapUserFunction(_unwrapped_bar,");
        });

        it('should add import only once for multiple functions', () => {
            const input = `
export function a() { return 1; }
export function b() { return 2; }
`;
            const output = transform(input);
            const importCount = (output.match(/import.*wrapUserFunction/g) || []).length;
            expect(importCount).toBe(1);
        });

        it('should NOT wrap non-exported function declarations (hoisting safety)', () => {
            const input = `function helperFn() { return 1; }`;
            const output = transform(input);
            expect(output).not.toContain('_unwrapped_helperFn');
            expect(output).not.toContain('wrapUserFunction');
        });

        it('should NOT wrap non-exported non-component function declarations even with complex code', () => {
            const input = `
function helper1() { return 1; }
function helper2() { return helper1() + 1; }
`;
            const output = transform(input);
            expect(output).not.toContain('_unwrapped_');
            expect(output).not.toContain('wrapUserFunction');
        });
    });

    describe('source metadata', () => {
        it('should include filePath in metadata object', () => {
            const input = `export function myFunc() { return 1; }`;
            const output = transform(input, '/project/app/page.tsx');
            // The metadata object should contain a filePath string
            expect(output).toContain('filePath:');
            expect(output).toContain('page.tsx');
        });

        it('should include line number in metadata object', () => {
            const input = `export function myFunc() { return 1; }`;
            const output = transform(input);
            expect(output).toContain('line:');
        });

        it('should include column number in metadata object', () => {
            const input = `export function myFunc() { return 1; }`;
            const output = transform(input);
            expect(output).toContain('column:');
        });

        it('should set isComponent: false for regular exported functions', () => {
            const input = `export function calculateTotal() { return 0; }`;
            const output = transform(input);
            expect(output).toContain('isComponent: false');
        });

        it('should set isComponent: true for React components', () => {
            const input = `function MyComponent() { return <div />; }`;
            const output = transform(input);
            expect(output).toContain('isComponent: true');
        });

        it('should have correct line numbers for multi-line code', () => {
            const input = `
// line 2
// line 3
export function myFunc() { return 1; }
`;
            const output = transform(input);
            // Function is on line 4 (1-indexed)
            expect(output).toContain('line: 4');
        });
    });

    describe('React component wrapping', () => {
        it('should wrap PascalCase function declarations (components)', () => {
            const input = `function MyComponent() { return <div />; }`;
            const output = transform(input);
            expect(output).toContain('_unwrapped_MyComponent');
            expect(output).toContain("wrapUserFunction(_unwrapped_MyComponent,");
        });

        it('should wrap exported PascalCase function declarations', () => {
            const input = `export function HomePage() { return <div />; }`;
            const output = transform(input);
            expect(output).toContain('_unwrapped_HomePage');
            expect(output).toContain("wrapUserFunction(_unwrapped_HomePage,");
            expect(output).toContain('export const HomePage');
        });

        it('should wrap arrow function components', () => {
            const input = `const MyComponent = (props) => <div>{props.name}</div>;`;
            const output = transform(input);
            expect(output).toContain('_unwrapped_MyComponent');
            expect(output).toContain("wrapUserFunction(_unwrapped_MyComponent,");
            expect(output).toContain('isComponent: true');
        });

        it('should wrap function expression components', () => {
            const input = `const MyComponent = function(props) { return <div />; };`;
            const output = transform(input);
            expect(output).toContain('_unwrapped_MyComponent');
            expect(output).toContain("wrapUserFunction(_unwrapped_MyComponent,");
            expect(output).toContain('isComponent: true');
        });

        it('should wrap exported arrow function components', () => {
            const input = `export const Card = (props) => <div>{props.title}</div>;`;
            const output = transform(input);
            expect(output).toContain('_unwrapped_Card');
            expect(output).toContain("wrapUserFunction(_unwrapped_Card,");
            expect(output).toContain('export const Card');
        });
    });

    describe('arrow function wrapping', () => {
        it('should wrap camelCase arrow functions with isComponent: false', () => {
            const input = `const calculateTotal = (items) => items.reduce((a, b) => a + b, 0);`;
            const output = transform(input);
            expect(output).toContain('_unwrapped_calculateTotal');
            expect(output).toContain('isComponent: false');
        });

        it('should NOT wrap excluded hook names as arrow functions', () => {
            const input = `const useState = (initial) => [initial, () => {}];`;
            const output = transform(input);
            expect(output).not.toContain('_unwrapped_useState');
        });

        it('should NOT wrap already-wrapped arrow functions', () => {
            const input = `const _unwrapped_test = () => 1;`;
            const output = transform(input);
            expect(output).not.toContain('_unwrapped__unwrapped_');
        });

        it('should ignore variable declarations without arrow/function init', () => {
            const input = `const myValue = 42;`;
            const output = transform(input);
            expect(output).not.toContain('wrapUserFunction');
        });
    });

    describe('exclusions', () => {
        it('should NOT wrap React hooks', () => {
            const input = `function useState() { return []; }`;
            const output = transform(input);
            expect(output).not.toContain('_unwrapped_useState');
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
            const input = `export function test() { return 1; }`;
            const output = transform(input, '/project/lib/utils.ts');
            expect(output).not.toContain('_unwrapped_test');
        });

        it('should skip node_modules', () => {
            const input = `export function test() { return 1; }`;
            const output = transform(input, '/project/node_modules/something/app/index.ts');
            expect(output).not.toContain('_unwrapped_test');
        });
    });

    describe('exports', () => {
        it('should handle exported API handlers (GET, POST, etc.)', () => {
            const input = `export function GET(req) { return new Response('ok'); }`;
            const output = transform(input);

            expect(output).toContain('_unwrapped_GET');
            expect(output).toContain("wrapUserFunction(_unwrapped_GET,");
            expect(output).toContain('export const GET');
        });
    });

    describe('directives', () => {
        it('should place import after "use server" directive', () => {
            const input = `'use server';\nexport function myAction() { return 1; }`;
            const output = transform(input);
            // The import should come after the directive
            const directiveIndex = output.indexOf("'use server'");
            const importIndex = output.indexOf('import');
            expect(directiveIndex).toBeLessThan(importIndex);
        });

        it('should place import after "use client" directive', () => {
            const input = `'use client';\nconst helper = () => 1;`;
            const output = transform(input);
            const directiveIndex = output.indexOf("'use client'");
            const importIndex = output.indexOf('import');
            expect(directiveIndex).toBeLessThan(importIndex);
        });
    });

    describe('custom options', () => {
        it('should use custom importPath', () => {
            const input = `export function test() { return 1; }`;
            const output = transform(input, '/project/app/test.ts', {
                importPath: './my-custom-wrapper',
            });
            expect(output).toMatch(/from ["']\.\/my-custom-wrapper["']/);
        });
    });

    describe('generator functions', () => {
        it('should NOT wrap generator function declarations', () => {
            const input = `export function* gen() { yield 1; }`;
            const output = transform(input);
            expect(output).not.toContain('_unwrapped_gen');
            expect(output).not.toContain('wrapUserFunction');
        });

        it('should NOT wrap async generator function declarations', () => {
            const input = `export async function* asyncGen() { yield 1; }`;
            const output = transform(input);
            expect(output).not.toContain('_unwrapped_asyncGen');
            expect(output).not.toContain('wrapUserFunction');
        });

        it('should NOT wrap generator function expressions', () => {
            const input = `const gen = function*() { yield 1; };`;
            const output = transform(input);
            expect(output).not.toContain('_unwrapped_gen');
            expect(output).not.toContain('wrapUserFunction');
        });
    });

    describe('hoisting safety', () => {
        it('should NOT wrap non-exported camelCase function declarations', () => {
            // These use hoisting — wrapping would break code that calls them before declaration
            const input = `function processData(data) { return data.map(x => x * 2); }`;
            const output = transform(input);
            expect(output).not.toContain('_unwrapped_processData');
            expect(output).not.toContain('wrapUserFunction');
        });

        it('should still wrap PascalCase components even when non-exported', () => {
            // Components are always called by React after mount, never before declaration
            const input = `function MyComponent() { return <div />; }`;
            const output = transform(input);
            expect(output).toContain('_unwrapped_MyComponent');
            expect(output).toContain('wrapUserFunction');
        });

        it('should still wrap exported functions', () => {
            // Exports are always used after module init
            const input = `export function processData(data) { return data.map(x => x * 2); }`;
            const output = transform(input);
            expect(output).toContain('_unwrapped_processData');
            expect(output).toContain('wrapUserFunction');
        });
    });

    describe('memo/forwardRef safety', () => {
        it('should NOT wrap React.memo() call results', () => {
            // React.memo(() => ...) has init type CallExpression, not ArrowFunctionExpression
            const input = `const Foo = React.memo(() => <div />);`;
            const output = transform(input);
            expect(output).not.toContain('_unwrapped_Foo');
            expect(output).not.toContain('wrapUserFunction');
        });

        it('should NOT wrap React.forwardRef() call results', () => {
            const input = `const Bar = React.forwardRef((props, ref) => <div ref={ref} />);`;
            const output = transform(input);
            expect(output).not.toContain('_unwrapped_Bar');
            expect(output).not.toContain('wrapUserFunction');
        });
    });

    describe('mixed file scenarios', () => {
        it('should only wrap exported functions and components in a mixed file', () => {
            const input = `
function helper() { return 1; }
export function processData(data) { return helper(); }
function MyComponent() { return <div />; }
const value = 42;
const handler = () => fetch('/api');
`;
            const output = transform(input);
            // helper: non-exported, non-component → NOT wrapped
            expect(output).not.toContain('_unwrapped_helper');
            // processData: exported → wrapped
            expect(output).toContain('_unwrapped_processData');
            // MyComponent: PascalCase component → wrapped
            expect(output).toContain('_unwrapped_MyComponent');
            // value: not a function → NOT wrapped
            expect(output).not.toContain('_unwrapped_value');
            // handler: arrow function → wrapped
            expect(output).toContain('_unwrapped_handler');
        });
    });
});
