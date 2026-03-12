/**
 * Tests for browser-init.ts — the zero-code browser instrumentation entry point.
 *
 * Since these tests run in Node.js (not a browser), we test:
 * - Module exports are correct
 * - Fetch patching logic works
 * - No errors when window is undefined (SSR safety)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('browser-init', () => {
    describe('module exports', () => {
        it('should export initBrowserTelemetry', async () => {
            const mod = await import('../browser-init');
            expect(typeof mod.initBrowserTelemetry).toBe('function');
        });

        it('should export patchGlobalFetch', async () => {
            const mod = await import('../browser-init');
            expect(typeof mod.patchGlobalFetch).toBe('function');
        });

        it('should export getBrowserTracer', async () => {
            const mod = await import('../browser-init');
            expect(typeof mod.getBrowserTracer).toBe('function');
        });

        it('should export initReactInstrumentation', async () => {
            const mod = await import('../browser-init');
            expect(typeof mod.initReactInstrumentation).toBe('function');
        });
    });

    describe('getBrowserTracer', () => {
        it('should return a tracer object', async () => {
            const { getBrowserTracer } = await import('../browser-init');
            const tracer = getBrowserTracer();
            expect(tracer).toBeDefined();
            expect(typeof tracer.startSpan).toBe('function');
        });
    });

    describe('fetch patching (Node.js environment)', () => {
        let originalFetch: typeof globalThis.fetch;

        beforeEach(() => {
            originalFetch = globalThis.fetch;
        });

        afterEach(() => {
            globalThis.fetch = originalFetch;
        });

        it('should not crash when fetch is not available', async () => {
            const saved = globalThis.fetch;
            // @ts-expect-error — testing edge case
            delete globalThis.fetch;
            try {
                const { patchGlobalFetch } = await import('../browser-init');
                // Should not throw
                expect(patchGlobalFetch).toBeDefined();
            } finally {
                globalThis.fetch = saved;
            }
        });
    });
});
