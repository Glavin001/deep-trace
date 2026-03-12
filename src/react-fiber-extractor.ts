/**
 * react-fiber-extractor.ts — Extract React component metadata from the fiber tree.
 *
 * Uses bippy (MIT, https://github.com/aidenybai/bippy) for all React internals access.
 * This module is browser-side only and provides a thin wrapper around bippy's APIs
 * to extract component information and format it as OpenTelemetry span attributes.
 *
 * Component name filtering lists adapted from react-grab (MIT, https://github.com/aidenybai/react-grab).
 *
 * IMPORTANT: bippy must be imported BEFORE React loads. In Next.js 15.3+, use
 * instrumentation-client.ts. In Vite, import at the top of your entry file.
 */

import type { Span } from '@opentelemetry/api';

// Conditionally import bippy — it may not be available in Node.js-only environments
let bippyCore: typeof import('bippy') | null = null;
try {
    // Use dynamic require to avoid bundling issues in Node.js environments
    bippyCore = require('bippy');
} catch {
    // bippy not available — all functions will gracefully return undefined
}

// ===== Recent Span Registry =====
// Tracks recently-created component spans so onCommitFiberRoot can enrich them
// with fiber hierarchy data after React commits.

interface PendingComponentSpan {
    span: Span;
    componentName: string;
    timestamp: number;
}

const pendingComponentSpans: PendingComponentSpan[] = [];
const PENDING_SPAN_TTL = 5000; // 5 seconds

/**
 * Register a component span for fiber enrichment. Called by probe-wrapper
 * when wrapping a component (isComponent: true) in browser environments.
 * The onCommitFiberRoot hook will match this span by component name and
 * add hierarchy/source data from the fiber tree.
 */
export function registerComponentSpan(span: Span, componentName: string): void {
    pendingComponentSpans.push({ span, componentName, timestamp: Date.now() });
    // Cleanup old entries
    const cutoff = Date.now() - PENDING_SPAN_TTL;
    while (pendingComponentSpans.length > 0 && pendingComponentSpans[0].timestamp < cutoff) {
        pendingComponentSpans.shift();
    }
}

// ===== Component Name Filtering =====
// Adapted from react-grab (MIT) — https://github.com/aidenybai/react-grab

/** Next.js internal component names that are not useful for tracing. */
const NEXT_INTERNAL_NAMES = new Set([
    'InnerLayoutRouter',
    'RedirectErrorBoundary',
    'RedirectBoundary',
    'HTTPAccessFallbackErrorBoundary',
    'HTTPAccessFallbackBoundary',
    'LoadingBoundary',
    'ErrorBoundary',
    'InnerScrollAndFocusHandler',
    'ScrollAndFocusHandler',
    'RenderFromTemplateContext',
    'OuterLayoutRouter',
    'body',
    'html',
    'DevRootHTTPAccessFallbackBoundary',
    'AppDevOverlayErrorBoundary',
    'AppDevOverlay',
    'HotReload',
    'Router',
    'ErrorBoundaryHandler',
    'AppRouter',
    'ServerRoot',
    'SegmentStateProvider',
    'RootErrorBoundary',
    'LoadableComponent',
    'MotionDOMComponent',
]);

/** React internal component names that are not useful for tracing. */
const REACT_INTERNAL_NAMES = new Set([
    'Suspense',
    'Fragment',
    'StrictMode',
    'Profiler',
    'SuspenseList',
]);

/** Prefixes for utility/library components to filter out. */
const NON_COMPONENT_PREFIXES = ['_', '$', 'motion.', 'styled.', 'chakra.', 'ark.', 'Primitive.', 'Slot.'];

/**
 * Check if a component name is "useful" for tracing (not an internal framework component).
 */
export function isUsefulComponentName(name: string): boolean {
    if (!name) return false;
    if (NEXT_INTERNAL_NAMES.has(name)) return false;
    if (REACT_INTERNAL_NAMES.has(name)) return false;
    for (const prefix of NON_COMPONENT_PREFIXES) {
        if (name.startsWith(prefix)) return false;
    }
    if (name === 'SlotClone' || name === 'Slot') return false;
    return true;
}

// ===== Core Types =====

export interface FiberComponentInfo {
    /** Display name of the nearest user component. */
    name: string;
    /** Source location from React _debugSource (dev builds only). */
    source?: {
        fileName: string;
        lineNumber?: number;
        columnNumber?: number;
    };
    /** Ancestor component names from nearest to root (filtered to user components). */
    hierarchy: string[];
    /** Serializable props (excluding children, functions, symbols). */
    props?: Record<string, any>;
}

// ===== Public API =====

/**
 * Initialize React instrumentation via bippy. Must be called BEFORE React loads.
 * Safe to call multiple times or when bippy is not available.
 */
export function initReactInstrumentation(): void {
    try {
        if (!bippyCore) return;
        const bippy = bippyCore;
        bippyCore.instrument({
            onCommitFiberRoot(_rendererID: number, root: any) {
                // Enrich pending component spans with fiber hierarchy data.
                // This runs after React commits, so the fiber tree is fully formed.
                if (pendingComponentSpans.length === 0) return;

                try {
                    // Walk the committed fiber tree looking for components that match pending spans
                    const current = root?.current;
                    if (!current) return;

                    // Collect all composite fibers in this commit
                    const compositeFibers: Array<{ name: string; fiber: any }> = [];
                    bippy.traverseFiber(current, (fiber: any) => {
                        if (bippy.isCompositeFiber(fiber)) {
                            const name = bippy.getDisplayName(fiber.type);
                            if (name && isUsefulComponentName(name)) {
                                compositeFibers.push({ name, fiber });
                            }
                        }
                        return false; // continue traversal
                    });

                    // Match pending spans to fibers by component name
                    const cutoff = Date.now() - PENDING_SPAN_TTL;
                    const remaining: PendingComponentSpan[] = [];

                    for (const pending of pendingComponentSpans) {
                        if (pending.timestamp < cutoff) continue; // expired

                        const match = compositeFibers.find(f => f.name === pending.componentName);
                        if (match) {
                            // Add hierarchy
                            const hierarchy: string[] = [];
                            let ancestor = match.fiber.return;
                            while (ancestor) {
                                if (bippy.isCompositeFiber(ancestor)) {
                                    const ancestorName = bippy.getDisplayName(ancestor.type);
                                    if (ancestorName && isUsefulComponentName(ancestorName)) {
                                        hierarchy.push(ancestorName);
                                    }
                                }
                                ancestor = ancestor.return;
                            }
                            if (hierarchy.length > 0) {
                                pending.span.setAttribute('component.hierarchy', hierarchy.join(' > '));
                            }

                            // Add debug source if available
                            const source = getDebugSource(match.fiber);
                            if (source) {
                                // Only set source from fiber if not already set by Babel
                                // (Babel source is more accurate, fiber source is fallback)
                                pending.span.setAttribute('component.fiber.source', source.fileName);
                            }
                            // Don't add to remaining — consumed
                        } else {
                            remaining.push(pending);
                        }
                    }

                    // Replace pending list with unconsumed entries
                    pendingComponentSpans.length = 0;
                    pendingComponentSpans.push(...remaining);
                } catch {
                    // Fiber enrichment is best-effort — never crash React
                }
            },
        });
    } catch {
        // No React present or bippy initialization failed — graceful degradation
    }
}

/**
 * Check if React instrumentation is currently active.
 */
export function isReactInstrumentationActive(): boolean {
    try {
        if (!bippyCore) return false;
        return bippyCore.isInstrumentationActive();
    } catch {
        return false;
    }
}

/**
 * Get the React fiber for a DOM element using bippy.
 */
export function getReactFiber(element: Element): any | undefined {
    try {
        if (!bippyCore) return undefined;
        return bippyCore.getFiberFromHostInstance(element) ?? undefined;
    } catch {
        return undefined;
    }
}

/**
 * Get the component hierarchy (ancestor chain) for a DOM element.
 * Returns an array of component names from nearest to root, filtered to user components.
 */
export function getComponentHierarchy(element: Element): string[] {
    try {
        if (!bippyCore) return [];
        const fiber = bippyCore.getFiberFromHostInstance(element);
        if (!fiber) return [];

        const names: string[] = [];
        bippyCore.traverseFiber(
            fiber,
            (currentFiber: any) => {
                if (bippyCore!.isCompositeFiber(currentFiber)) {
                    const name = bippyCore!.getDisplayName(currentFiber.type);
                    if (name && isUsefulComponentName(name)) {
                        names.push(name);
                    }
                }
                return false; // continue traversal
            },
            true, // ascending (walk toward root)
        );
        return names;
    } catch {
        return [];
    }
}

/**
 * Get the nearest useful component display name for a DOM element.
 */
export function getComponentDisplayName(element: Element): string | null {
    try {
        if (!bippyCore) return null;
        const fiber = bippyCore.getFiberFromHostInstance(element);
        if (!fiber) return null;

        let currentFiber = fiber.return;
        while (currentFiber) {
            if (bippyCore.isCompositeFiber(currentFiber)) {
                const name = bippyCore.getDisplayName(currentFiber.type);
                if (name && isUsefulComponentName(name)) {
                    return name;
                }
            }
            currentFiber = currentFiber.return;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Extract debug source location from a fiber (dev builds only).
 * Tries multiple property names for React 18/19 compatibility.
 */
export function getDebugSource(fiber: any): FiberComponentInfo['source'] | undefined {
    try {
        if (!fiber) return undefined;

        // React 18: fiber._debugSource
        // React 19 may vary: fiber.__source, fiber._source
        const source = fiber._debugSource ?? fiber.__source ?? fiber._source;
        if (source && source.fileName) {
            return {
                fileName: source.fileName,
                lineNumber: source.lineNumber,
                columnNumber: source.columnNumber,
            };
        }

        // Try the component type's debug source
        if (fiber.type?._debugSource) {
            const ts = fiber.type._debugSource;
            return {
                fileName: ts.fileName,
                lineNumber: ts.lineNumber,
                columnNumber: ts.columnNumber,
            };
        }

        return undefined;
    } catch {
        return undefined;
    }
}

/**
 * Serialize fiber props, excluding non-serializable values.
 */
function serializeProps(fiber: any): Record<string, any> | undefined {
    try {
        const props = fiber?.memoizedProps;
        if (!props || typeof props !== 'object') return undefined;

        const serializable: Record<string, any> = {};
        for (const key of Object.keys(props)) {
            const val = props[key];
            if (key === 'children') continue;
            if (typeof val === 'function') continue;
            if (typeof val === 'symbol') continue;
            if (val && typeof val === 'object' && val.$$typeof) continue; // React elements
            serializable[key] = val;
        }
        return Object.keys(serializable).length > 0 ? serializable : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Extract comprehensive component information for a DOM element.
 * Combines component name, hierarchy, source location, and props.
 */
export function extractComponentInfo(element: Element): FiberComponentInfo | undefined {
    try {
        if (!bippyCore || !bippyCore.isInstrumentationActive()) return undefined;

        const fiber = bippyCore.getFiberFromHostInstance(element);
        if (!fiber) return undefined;

        // Walk to nearest composite (user) component
        let componentFiber: typeof fiber | null = fiber;
        if (!bippyCore.isCompositeFiber(componentFiber)) {
            componentFiber = componentFiber.return;
            while (componentFiber) {
                if (bippyCore.isCompositeFiber(componentFiber)) {
                    const name = bippyCore.getDisplayName(componentFiber.type);
                    if (name && isUsefulComponentName(name)) break;
                }
                componentFiber = componentFiber.return;
            }
        }

        if (!componentFiber) return undefined;

        const name = bippyCore.getDisplayName(componentFiber.type);
        if (!name) return undefined;

        // Get hierarchy
        const hierarchy: string[] = [];
        let ancestor = componentFiber.return;
        while (ancestor) {
            if (bippyCore.isCompositeFiber(ancestor)) {
                const ancestorName = bippyCore.getDisplayName(ancestor.type);
                if (ancestorName && isUsefulComponentName(ancestorName)) {
                    hierarchy.push(ancestorName);
                }
            }
            ancestor = ancestor.return;
        }

        // Get debug source
        const source = getDebugSource(componentFiber);

        // Get serializable props
        const props = serializeProps(componentFiber);

        return { name, source, hierarchy, props };
    } catch {
        return undefined;
    }
}

/**
 * Add React fiber component information as OpenTelemetry span attributes.
 * Safe to call even when React is not present — silently returns if no data available.
 */
export function addFiberAttributesToSpan(span: Span, element: Element): void {
    try {
        const info = extractComponentInfo(element);
        if (!info) return;

        span.setAttribute('component.name', info.name);

        if (info.hierarchy.length > 0) {
            span.setAttribute('component.hierarchy', info.hierarchy.join(' > '));
        }

        if (info.source) {
            span.setAttribute('code.filepath', info.source.fileName);
            if (info.source.lineNumber != null) {
                span.setAttribute('code.lineno', info.source.lineNumber);
            }
            if (info.source.columnNumber != null) {
                span.setAttribute('code.column', info.source.columnNumber);
            }
        }

        if (info.props) {
            try {
                span.setAttribute('component.props', JSON.stringify(info.props));
            } catch {
                // Props serialization failed — skip
            }
        }
    } catch {
        // Never crash — fiber extraction is best-effort
    }
}
