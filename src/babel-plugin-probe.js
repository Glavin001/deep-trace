/**
 * babel-plugin-probe.js — Babel plugin for auto-wrapping user functions with tracing
 *
 * Transforms:
 *   function foo(a, b) { ... }
 * Into:
 *   function _unwrapped_foo(a, b) { ... }
 *   const foo = wrapUserFunction(_unwrapped_foo, 'foo');
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
    if (!name) return { wrap: false, isApiHandler: false };
    if (name.startsWith('_unwrapped_')) return { wrap: false, isApiHandler: false };
    if (EXCLUDE_FUNCTIONS.has(name)) return { wrap: false, isApiHandler: false };
    if (API_HANDLERS.has(name) && isExported) return { wrap: true, isApiHandler: true };
    if (/^[A-Z]/.test(name)) return { wrap: false, isApiHandler: false }; // React components
    return { wrap: true, isApiHandler: false };
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

                const isExported = state.exportedFunctions.has(name);
                const { wrap, isApiHandler } = shouldWrap(name, isExported);
                if (!wrap) return;

                const internalName = `_unwrapped_${name}`;
                path.node.id.name = internalName;

                const wrapperDeclarator = t.variableDeclarator(
                    t.identifier(name),
                    t.callExpression(
                        t.identifier('wrapUserFunction'),
                        [t.identifier(internalName), t.stringLiteral(name)]
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
            }
        }
    };
};
