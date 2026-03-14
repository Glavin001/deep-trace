/**
 * Tests for react-fiber-extractor.ts — React fiber metadata extraction.
 *
 * Uses mock fiber objects to test extraction logic without requiring a real React runtime.
 * Tests the component name filtering, hierarchy walking, debug source extraction,
 * and graceful degradation when data is missing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the pure utility functions that don't depend on bippy being loaded
import {
    isUsefulComponentName,
    getDebugSource,
    initReactInstrumentation,
    isReactInstrumentationActive,
    extractComponentInfo,
    getComponentHierarchy,
    addFiberAttributesToSpan,
} from '../react-fiber-extractor';

describe('react-fiber-extractor', () => {
    describe('isUsefulComponentName', () => {
        it('should return true for regular user component names', () => {
            expect(isUsefulComponentName('MyComponent')).toBe(true);
            expect(isUsefulComponentName('Card')).toBe(true);
            expect(isUsefulComponentName('DemoPanel')).toBe(true);
            expect(isUsefulComponentName('HomePage')).toBe(true);
        });

        it('should return false for Next.js internal components', () => {
            expect(isUsefulComponentName('InnerLayoutRouter')).toBe(false);
            expect(isUsefulComponentName('AppRouter')).toBe(false);
            expect(isUsefulComponentName('ServerRoot')).toBe(false);
            expect(isUsefulComponentName('ErrorBoundary')).toBe(false);
            expect(isUsefulComponentName('HotReload')).toBe(false);
            expect(isUsefulComponentName('OuterLayoutRouter')).toBe(false);
        });

        it('should return false for React internal components', () => {
            expect(isUsefulComponentName('Suspense')).toBe(false);
            expect(isUsefulComponentName('Fragment')).toBe(false);
            expect(isUsefulComponentName('StrictMode')).toBe(false);
            expect(isUsefulComponentName('Profiler')).toBe(false);
        });

        it('should return false for utility/library prefixed components', () => {
            expect(isUsefulComponentName('_InternalComponent')).toBe(false);
            expect(isUsefulComponentName('$Provider')).toBe(false);
            expect(isUsefulComponentName('motion.div')).toBe(false);
            expect(isUsefulComponentName('styled.button')).toBe(false);
            expect(isUsefulComponentName('chakra.Box')).toBe(false);
        });

        it('should return false for empty string', () => {
            expect(isUsefulComponentName('')).toBe(false);
        });

        it('should return false for Slot and SlotClone', () => {
            expect(isUsefulComponentName('Slot')).toBe(false);
            expect(isUsefulComponentName('SlotClone')).toBe(false);
        });
    });

    describe('getDebugSource', () => {
        it('should extract _debugSource from React 18 fiber', () => {
            const mockFiber = {
                _debugSource: {
                    fileName: '/src/components/Card.tsx',
                    lineNumber: 15,
                    columnNumber: 4,
                },
            };

            const source = getDebugSource(mockFiber);
            expect(source).toBeDefined();
            expect(source!.fileName).toBe('/src/components/Card.tsx');
            expect(source!.lineNumber).toBe(15);
            expect(source!.columnNumber).toBe(4);
        });

        it('should extract __source from React 19+ fiber', () => {
            const mockFiber = {
                __source: {
                    fileName: '/src/app/page.tsx',
                    lineNumber: 8,
                },
            };

            const source = getDebugSource(mockFiber);
            expect(source).toBeDefined();
            expect(source!.fileName).toBe('/src/app/page.tsx');
            expect(source!.lineNumber).toBe(8);
        });

        it('should try _source as another fallback', () => {
            const mockFiber = {
                _source: {
                    fileName: '/src/lib/Widget.tsx',
                    lineNumber: 22,
                    columnNumber: 0,
                },
            };

            const source = getDebugSource(mockFiber);
            expect(source).toBeDefined();
            expect(source!.fileName).toBe('/src/lib/Widget.tsx');
        });

        it('should try type._debugSource as last fallback', () => {
            const mockFiber = {
                type: {
                    _debugSource: {
                        fileName: '/src/components/Button.tsx',
                        lineNumber: 3,
                    },
                },
            };

            const source = getDebugSource(mockFiber);
            expect(source).toBeDefined();
            expect(source!.fileName).toBe('/src/components/Button.tsx');
        });

        it('should return undefined when no debug source available', () => {
            const mockFiber = { tag: 0, type: function MyComponent() {} };
            const source = getDebugSource(mockFiber);
            expect(source).toBeUndefined();
        });

        it('should return undefined for null/undefined fiber', () => {
            expect(getDebugSource(null)).toBeUndefined();
            expect(getDebugSource(undefined)).toBeUndefined();
        });

        it('should handle fiber with empty _debugSource gracefully', () => {
            const mockFiber = { _debugSource: {} };
            const source = getDebugSource(mockFiber);
            expect(source).toBeUndefined();
        });

        it('should never throw even with weird fiber shapes', () => {
            expect(() => getDebugSource({ _debugSource: 'not an object' })).not.toThrow();
            expect(() => getDebugSource({ _debugSource: 42 })).not.toThrow();
            expect(() => getDebugSource({ _debugSource: null })).not.toThrow();
        });
    });

    describe('graceful degradation', () => {
        it('getDebugSource should handle production fibers without debug info', () => {
            // Production builds strip _debugSource
            const prodFiber = {
                tag: 0,
                type: function MyComponent() {},
                memoizedProps: { title: 'Hello' },
                return: null,
            };
            const source = getDebugSource(prodFiber);
            expect(source).toBeUndefined();
        });
    });

    // Note: Tests for functions that depend on bippy (extractComponentInfo, getComponentHierarchy,
    // addFiberAttributesToSpan) would require either:
    // 1. A jsdom environment with mock React fiber properties on DOM elements
    // 2. Mocking the bippy module
    //
    // Since bippy uses window.__REACT_DEVTOOLS_GLOBAL_HOOK__ which is browser-only,
    // we test the pure utility functions here and rely on the demo for integration testing.
    //
    // The key safety property is that ALL functions return undefined/[] when bippy
    // is not loaded, which is tested by the fact that these tests run in Node.js
    // where bippy's browser features are not available.

    describe('module safety in Node.js environment', () => {
        it('should export all expected functions', () => {
            expect(typeof isUsefulComponentName).toBe('function');
            expect(typeof getDebugSource).toBe('function');
            expect(typeof extractComponentInfo).toBe('function');
            expect(typeof getComponentHierarchy).toBe('function');
            expect(typeof addFiberAttributesToSpan).toBe('function');
            expect(typeof initReactInstrumentation).toBe('function');
            expect(typeof isReactInstrumentationActive).toBe('function');
        });

        it('initReactInstrumentation should not throw in Node.js', () => {
            expect(() => initReactInstrumentation()).not.toThrow();
        });

        it('isReactInstrumentationActive should return false in Node.js', () => {
            expect(isReactInstrumentationActive()).toBe(false);
        });

        it('extractComponentInfo should return undefined without React', () => {
            const mockElement = {} as Element;
            expect(extractComponentInfo(mockElement)).toBeUndefined();
        });

        it('getComponentHierarchy should return empty array without React', () => {
            const mockElement = {} as Element;
            expect(getComponentHierarchy(mockElement)).toEqual([]);
        });

        it('addFiberAttributesToSpan should not throw without React', () => {
            const mockSpan = { setAttribute: vi.fn() } as any;
            const mockElement = {} as Element;
            expect(() => addFiberAttributesToSpan(mockSpan, mockElement)).not.toThrow();
            // No attributes should be set since React is not present
            expect(mockSpan.setAttribute).not.toHaveBeenCalled();
        });
    });
});
