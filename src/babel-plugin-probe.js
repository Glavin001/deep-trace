/**
 * babel-plugin-probe.js — Babel plugin for auto-wrapping user functions with tracing
 *
 * Transforms:
 *   function foo(a, b) { ... }
 * Into:
 *   function _unwrapped_foo(a, b) { ... }
 *   const foo = wrapUserFunction(_unwrapped_foo, 'foo', { filePath: "app/page.tsx", line: 1, column: 0, isComponent: false });
 *
 * Also handles React components (PascalCase) and arrow function expressions:
 *   const MyComponent = (props) => <div />;
 * Into:
 *   const _unwrapped_MyComponent = (props) => <div />;
 *   const MyComponent = wrapUserFunction(_unwrapped_MyComponent, 'MyComponent', { ..., isComponent: true });
 *
 * SAFETY: Non-exported, non-component function declarations are NOT wrapped
 * because wrapping converts a hoisted `function` to a non-hoisted `const`,
 * breaking code that calls the function before its declaration. These functions
 * get source metadata via V8 stack traces at runtime instead.
 *
 * Generator functions (function*) are also skipped — wrapping them would break
 * the generator protocol since the wrapper is a plain function.
 *
 * Adapted from https://github.com/Syncause/ts-agent-file (MIT License)
 */

const nodePath = require('path');

// Functions that should NOT be wrapped
const EXCLUDE_FUNCTIONS = new Set([
    // Next.js
    'generateMetadata', 'generateStaticParams', 'generateViewport',
    'headers', 'cookies', 'draftMode', 'redirect', 'notFound', 'permanentRedirect',
    'revalidatePath', 'revalidateTag', 'unstable_cache', 'unstable_noStore',
    'useFormState', 'useFormStatus',
    // React hooks
    'use', 'useState', 'useEffect', 'useContext', 'useReducer', 'useCallback',
    'useMemo', 'useRef', 'useImperativeHandle', 'useLayoutEffect', 'useDebugValue',
    'useDeferredValue', 'useTransition', 'useId', 'useSyncExternalStore',
    'useOptimistic', 'useActionState',
    // Auth (Clerk, etc.)
    'auth', 'currentUser', 'getAuth', 'clerkClient',
    // Lifecycle / builtins
    'render', 'componentDidMount', 'componentWillUnmount',
    'constructor', 'init', 'register',
    'toString', 'valueOf', 'toJSON',
    'fetch', 'fetchAPI', 'request', 'response',
]);

// HTTP method handlers that need export preservation
const API_HANDLERS = new Set([
    'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS',
]);

function shouldWrap(name, isExported) {
    if (!name) return { wrap: false, isApiHandler: false, isComponent: false };
    if (name.startsWith('_unwrapped_')) return { wrap: false, isApiHandler: false, isComponent: false };
    if (EXCLUDE_FUNCTIONS.has(name)) return { wrap: false, isApiHandler: false, isComponent: false };
    if (API_HANDLERS.has(name) && isExported) return { wrap: true, isApiHandler: true, isComponent: false };
    if (/^[A-Z]/.test(name)) return { wrap: true, isApiHandler: false, isComponent: true };
    return { wrap: true, isApiHandler: false, isComponent: false };
}

function matches(pattern, path) {
    if (pattern instanceof RegExp) return pattern.test(path);
    if (typeof pattern === 'string') return path.includes(pattern);
    return false;
}

function hasMatch(patterns, path) {
    if (!patterns || patterns.length === 0) return false;
    return (Array.isArray(patterns) ? patterns : [patterns]).some(p => matches(p, path));
}

module.exports = function (api, options = {}) {
    const t = api.types;

    const isServer = api.caller((caller) => caller?.isServer ?? true);
    api.cache.using(() => isServer);

    const {
        test = /\.(ts|tsx|js|jsx)$/,
        include = ['/app/'],
        exclude = ['/node_modules/', '/.next/', '/instrumentation/', '/probe-wrapper/', '/debug-probe/'],
        // Where to import wrapUserFunction from. Adjust for your project.
        importPath = '@/probe-wrapper',
    } = options;

    const finalIsServer = options.isServer !== undefined ? options.isServer : isServer;

    function shouldProcess(filename) {
        if (!filename) return false;
        const normalized = filename.replace(/\\/g, '/');
        if (finalIsServer === false) return false;
        if (test && !matches(test, normalized)) return false;
        if (exclude && hasMatch(exclude, normalized)) return false;
        if (include && include.length > 0 && !hasMatch(include, normalized)) return false;
        return true;
    }

    /**
     * Build a source metadata AST object expression:
     *   { filePath: "...", line: N, column: N, isComponent: bool }
     *
     * Line/column come from the Babel AST node.loc, which always reflects the
     * ORIGINAL source positions (not transpiled output).
     */
    function buildMetadataObject(state, node, isComponent) {
        const resourcePath = state.filename || (state.file && state.file.opts.filename);
        const relPath = resourcePath
            ? nodePath.relative(process.cwd(), resourcePath).replace(/\\/g, '/')
            : 'unknown';

        const props = [
            t.objectProperty(t.identifier('filePath'), t.stringLiteral(relPath)),
            t.objectProperty(t.identifier('line'), t.numericLiteral(node.loc?.start.line ?? 0)),
            t.objectProperty(t.identifier('column'), t.numericLiteral(node.loc?.start.column ?? 0)),
            t.objectProperty(t.identifier('isComponent'), t.booleanLiteral(isComponent)),
        ];

        return t.objectExpression(props);
    }

    return {
        visitor: {
            Program: {
                enter(path, state) {
                    const resourcePath = state.filename || (state.file && state.file.opts.filename);
                    if (!shouldProcess(resourcePath)) {
                        state.skipProcessing = true;
                        return;
                    }
                    state.wrappedFunctions = [];
                    state.exportedFunctions = new Set();

                    // Pre-pass: collect exported function names
                    path.traverse({
                        ExportNamedDeclaration(p) {
                            if (p.node.declaration) {
                                if (p.node.declaration.type === 'FunctionDeclaration' && p.node.declaration.id) {
                                    state.exportedFunctions.add(p.node.declaration.id.name);
                                } else if (p.node.declaration.type === 'VariableDeclaration') {
                                    p.node.declaration.declarations.forEach(d => {
                                        if (d.id.type === 'Identifier') state.exportedFunctions.add(d.id.name);
                                    });
                                }
                            }
                            if (p.node.specifiers) {
                                p.node.specifiers.forEach(s => {
                                    if (s.type === 'ExportSpecifier' && s.local) {
                                        state.exportedFunctions.add(s.local.name);
                                    }
                                });
                            }
                        },
                        ExportDefaultDeclaration(p) {
                            if (p.node.declaration &&
                                (p.node.declaration.type === 'FunctionDeclaration' || p.node.declaration.type === 'FunctionExpression') &&
                                p.node.declaration.id) {
                                state.exportedFunctions.add(p.node.declaration.id.name);
                            }
                        }
                    });
                },
                exit(path, state) {
                    if (state.skipProcessing || !state.wrappedFunctions?.length) return;

                    // Add import if not already present
                    let hasImport = false;
                    path.traverse({
                        ImportDeclaration(p) {
                            if (p.node.source.value.includes('probe-wrapper') ||
                                p.node.source.value.includes('wrapUserFunction') ||
                                p.node.source.value.includes('debug-probe')) {
                                hasImport = true;
                                p.stop();
                            }
                        }
                    });

                    if (!hasImport) {
                        const actualImportPath = options.importPath || importPath;
                        const importDecl = t.importDeclaration(
                            [t.importSpecifier(t.identifier('wrapUserFunction'), t.identifier('wrapUserFunction'))],
                            t.stringLiteral(actualImportPath)
                        );

                        const body = path.get('body');
                        const first = body[0];
                        if (body.length > 0 && first.isExpressionStatement() &&
                            first.get('expression').isStringLiteral() &&
                            (first.node.expression.value === 'use client' || first.node.expression.value === 'use server')) {
                            first.insertAfter(importDecl);
                        } else {
                            path.unshiftContainer('body', importDecl);
                        }
                    }

                    const resourcePath = state.filename || (state.file && state.file.opts.filename);
                    const rel = resourcePath ? nodePath.relative(process.cwd(), resourcePath).replace(/\\/g, '/') : 'unknown';
                    console.log(`[babel-plugin-probe] Wrapped in ${rel}: ${state.wrappedFunctions.join(', ')}`);
                }
            },
            FunctionDeclaration(path, state) {
                if (state.skipProcessing) return;
                const name = path.node.id?.name;
                if (!name) return;

                // Skip generators — wrapping breaks the generator protocol
                if (path.node.generator || path.node.async && path.node.generator) return;

                const isExported = state.exportedFunctions.has(name);
                const { wrap, isApiHandler, isComponent } = shouldWrap(name, isExported);
                if (!wrap) return;

                // Skip non-exported, non-component function declarations to preserve hoisting.
                // Wrapping converts hoisted `function foo(){}` to non-hoisted `const foo = wrap(...)`,
                // which breaks code that calls foo() before its declaration.
                // V8 stack traces provide source metadata for these at runtime.
                if (!isExported && !isComponent && !isApiHandler) return;

                const internalName = `_unwrapped_${name}`;
                path.node.id.name = internalName;

                const metadataObj = buildMetadataObject(state, path.node, isComponent);

                const wrapperDeclarator = t.variableDeclarator(
                    t.identifier(name),
                    t.callExpression(
                        t.identifier('wrapUserFunction'),
                        [t.identifier(internalName), t.stringLiteral(name), metadataObj]
                    )
                );

                let wrapperNode;
                if (isApiHandler || isExported) {
                    wrapperNode = t.exportNamedDeclaration(t.variableDeclaration('const', [wrapperDeclarator]));
                } else {
                    wrapperNode = t.variableDeclaration('const', [wrapperDeclarator]);
                }

                if (path.parent.type === 'ExportDefaultDeclaration') {
                    path.parentPath.insertAfter(wrapperNode);
                } else if (path.parent.type === 'ExportNamedDeclaration') {
                    path.parentPath.replaceWithMultiple([path.node, wrapperNode]);
                } else {
                    path.insertAfter(wrapperNode);
                }

                state.wrappedFunctions.push(name);
            },
            VariableDeclarator(path, state) {
                if (state.skipProcessing) return;
                const name = path.node.id?.name;
                if (!name) return;

                const init = path.node.init;
                if (!init || (init.type !== 'ArrowFunctionExpression' && init.type !== 'FunctionExpression')) return;

                // Skip generator expressions — wrapping breaks the generator protocol
                if (init.generator) return;

                const isExported = state.exportedFunctions.has(name);
                const { wrap, isComponent } = shouldWrap(name, isExported);
                if (!wrap) return;

                // Rename: const _unwrapped_MyComponent = (props) => <div />;
                const internalName = `_unwrapped_${name}`;
                path.node.id.name = internalName;

                const metadataObj = buildMetadataObject(state, init, isComponent);

                const wrapperDeclarator = t.variableDeclarator(
                    t.identifier(name),
                    t.callExpression(
                        t.identifier('wrapUserFunction'),
                        [t.identifier(internalName), t.stringLiteral(name), metadataObj]
                    )
                );

                // Insert the wrapper after the parent VariableDeclaration
                const varDeclPath = path.parentPath; // VariableDeclaration

                let wrapperNode;
                if (isExported && varDeclPath.parent.type === 'ExportNamedDeclaration') {
                    // export const MyComponent = () => ... → already in an export context
                    // We need to: remove the export wrapper, emit the unwrapped decl, then emit export const wrapper
                    wrapperNode = t.exportNamedDeclaration(t.variableDeclaration('const', [wrapperDeclarator]));
                    varDeclPath.parentPath.replaceWithMultiple([varDeclPath.node, wrapperNode]);
                } else if (isExported) {
                    wrapperNode = t.exportNamedDeclaration(t.variableDeclaration('const', [wrapperDeclarator]));
                    varDeclPath.insertAfter(wrapperNode);
                } else {
                    wrapperNode = t.variableDeclaration('const', [wrapperDeclarator]);
                    varDeclPath.insertAfter(wrapperNode);
                }

                state.wrappedFunctions.push(name);
            }
        }
    };
};
