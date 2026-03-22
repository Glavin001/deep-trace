/**
 * Unit tests for span ingestion: validation, normalization, and batch ingestion.
 */

import { describe, it, expect } from 'vitest';
import { validateSpanInput, normalizeSpanInput, ingestSpans } from '../span-ingestion';
import type { CachedSpan } from '../types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function validInput(overrides: Record<string, any> = {}) {
    return {
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        name: 'testFunction',
        startTime: 1700000000000000,
        endTime: 1700000001000000,
        ...overrides,
    };
}

// ─── validateSpanInput ───────────────────────────────────────────────────────

describe('validateSpanInput', () => {
    it('should accept a valid span input', () => {
        const result = validateSpanInput(validInput());
        expect(result.valid).toBe(true);
    });

    it('should accept valid input with all optional fields', () => {
        const result = validateSpanInput(validInput({
            parentSpanId: 'c'.repeat(16),
            kind: 'SERVER',
            duration: 1000000,
            status: { code: 1, message: 'OK' },
            attributes: { 'custom.key': 'value' },
            events: [{ name: 'event1', timestamp: 1700000000500000 }],
            links: [{ traceId: 'd'.repeat(32), spanId: 'e'.repeat(16) }],
            language: 'python',
        }));
        expect(result.valid).toBe(true);
    });

    it('should reject null input', () => {
        const result = validateSpanInput(null);
        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.errors).toContain('input must be a non-null object');
    });

    it('should reject non-object input', () => {
        const result = validateSpanInput('string');
        expect(result.valid).toBe(false);
    });

    it('should reject missing traceId', () => {
        const { traceId, ...rest } = validInput();
        const result = validateSpanInput(rest);
        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.errors.some(e => e.includes('traceId'))).toBe(true);
    });

    it('should reject invalid traceId (wrong length)', () => {
        const result = validateSpanInput(validInput({ traceId: 'abc' }));
        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.errors.some(e => e.includes('traceId'))).toBe(true);
    });

    it('should reject invalid traceId (non-hex)', () => {
        const result = validateSpanInput(validInput({ traceId: 'z'.repeat(32) }));
        expect(result.valid).toBe(false);
    });

    it('should reject missing spanId', () => {
        const { spanId, ...rest } = validInput();
        const result = validateSpanInput(rest);
        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.errors.some(e => e.includes('spanId'))).toBe(true);
    });

    it('should reject invalid spanId (wrong length)', () => {
        const result = validateSpanInput(validInput({ spanId: 'abc' }));
        expect(result.valid).toBe(false);
    });

    it('should reject invalid parentSpanId', () => {
        const result = validateSpanInput(validInput({ parentSpanId: 'xyz' }));
        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.errors.some(e => e.includes('parentSpanId'))).toBe(true);
    });

    it('should reject missing name', () => {
        const result = validateSpanInput(validInput({ name: '' }));
        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.errors.some(e => e.includes('name'))).toBe(true);
    });

    it('should reject missing startTime', () => {
        const { startTime, ...rest } = validInput();
        const result = validateSpanInput(rest);
        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.errors.some(e => e.includes('startTime'))).toBe(true);
    });

    it('should reject missing endTime', () => {
        const { endTime, ...rest } = validInput();
        const result = validateSpanInput(rest);
        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.errors.some(e => e.includes('endTime'))).toBe(true);
    });

    it('should accept ISO 8601 timestamps', () => {
        const result = validateSpanInput(validInput({
            startTime: '2023-11-14T22:13:20.000Z',
            endTime: '2023-11-14T22:13:21.000Z',
        }));
        expect(result.valid).toBe(true);
    });

    it('should reject invalid string timestamps', () => {
        const result = validateSpanInput(validInput({ startTime: 'not-a-date' }));
        expect(result.valid).toBe(false);
    });

    it('should collect multiple errors', () => {
        const result = validateSpanInput({ traceId: 'bad', spanId: 'bad' });
        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });
});

// ─── normalizeSpanInput ──────────────────────────────────────────────────────

describe('normalizeSpanInput', () => {
    it('should normalize microsecond timestamps', () => {
        const result = normalizeSpanInput(validInput() as any);
        expect(result.startTime).toBe(1700000000000000);
        expect(result.endTime).toBe(1700000001000000);
        expect(result.duration).toBe(1000000);
    });

    it('should normalize ISO 8601 timestamps to microseconds', () => {
        const result = normalizeSpanInput(validInput({
            startTime: '2023-11-14T22:13:20.000Z',
            endTime: '2023-11-14T22:13:21.000Z',
        }) as any);
        expect(typeof result.startTime).toBe('number');
        expect(typeof result.endTime).toBe('number');
        expect(result.duration).toBe(result.endTime - result.startTime);
        expect(result.duration).toBe(1000000); // 1 second in microseconds
    });

    it('should use explicit duration if provided', () => {
        const result = normalizeSpanInput(validInput({ duration: 42 }) as any);
        expect(result.duration).toBe(42);
    });

    it('should default kind to INTERNAL', () => {
        const result = normalizeSpanInput(validInput() as any);
        expect(result.kind).toBe('INTERNAL');
    });

    it('should preserve provided kind', () => {
        const result = normalizeSpanInput(validInput({ kind: 'SERVER' }) as any);
        expect(result.kind).toBe('SERVER');
    });

    it('should default status to code 0', () => {
        const result = normalizeSpanInput(validInput() as any);
        expect(result.status).toEqual({ code: 0 });
    });

    it('should set language attribute', () => {
        const result = normalizeSpanInput(validInput({ language: 'python' }) as any);
        expect(result.attributes['language']).toBe('python');
    });

    it('should default language to external', () => {
        const result = normalizeSpanInput(validInput() as any);
        expect(result.attributes['language']).toBe('external');
    });

    it('should set function.name from name if not in attributes', () => {
        const result = normalizeSpanInput(validInput() as any);
        expect(result.attributes['function.name']).toBe('testFunction');
    });

    it('should not override existing function.name in attributes', () => {
        const result = normalizeSpanInput(validInput({
            attributes: { 'function.name': 'customName' },
        }) as any);
        expect(result.attributes['function.name']).toBe('customName');
    });

    it('should lowercase traceId and spanId', () => {
        const result = normalizeSpanInput(validInput({
            traceId: 'A'.repeat(32),
            spanId: 'B'.repeat(16),
            parentSpanId: 'C'.repeat(16),
        }) as any);
        expect(result.traceId).toBe('a'.repeat(32));
        expect(result.spanId).toBe('b'.repeat(16));
        expect(result.parentSpanId).toBe('c'.repeat(16));
    });

    it('should handle empty events and links', () => {
        const result = normalizeSpanInput(validInput() as any);
        expect(result.events).toEqual([]);
        expect(result.links).toEqual([]);
    });

    it('should normalize event timestamps', () => {
        const result = normalizeSpanInput(validInput({
            events: [{ name: 'e1', timestamp: '2023-11-14T22:13:20.500Z', attributes: { key: 'val' } }],
        }) as any);
        expect(typeof result.events[0].timestamp).toBe('number');
        expect(result.events[0].attributes).toEqual({ key: 'val' });
    });
});

// ─── ingestSpans ─────────────────────────────────────────────────────────────

describe('ingestSpans', () => {
    function createMockCache() {
        const spans: CachedSpan[] = [];
        return {
            addCachedSpan(span: CachedSpan) { spans.push(span); },
            spans,
        };
    }

    const noopJsonl = () => {};

    it('should ingest valid spans', () => {
        const cache = createMockCache();
        const result = ingestSpans(cache, [validInput(), validInput({ spanId: 'c'.repeat(16) })], noopJsonl);
        expect(result.accepted).toBe(2);
        expect(result.rejected).toEqual([]);
        expect(cache.spans.length).toBe(2);
    });

    it('should reject invalid spans', () => {
        const cache = createMockCache();
        const result = ingestSpans(cache, [{ bad: 'data' }], noopJsonl);
        expect(result.accepted).toBe(0);
        expect(result.rejected.length).toBe(1);
        expect(result.rejected[0].index).toBe(0);
        expect(cache.spans.length).toBe(0);
    });

    it('should handle mixed valid and invalid spans', () => {
        const cache = createMockCache();
        const result = ingestSpans(cache, [
            validInput(),
            { bad: 'data' },
            validInput({ spanId: 'c'.repeat(16) }),
        ], noopJsonl);
        expect(result.accepted).toBe(2);
        expect(result.rejected.length).toBe(1);
        expect(result.rejected[0].index).toBe(1);
        expect(cache.spans.length).toBe(2);
    });

    it('should call appendToJsonl for each ingested span', () => {
        const cache = createMockCache();
        const jsonlCalls: CachedSpan[] = [];
        const result = ingestSpans(cache, [validInput()], (s) => jsonlCalls.push(s));
        expect(result.accepted).toBe(1);
        expect(jsonlCalls.length).toBe(1);
        expect(jsonlCalls[0].name).toBe('testFunction');
    });

    it('should not call appendToJsonl for rejected spans', () => {
        const cache = createMockCache();
        const jsonlCalls: CachedSpan[] = [];
        ingestSpans(cache, [{ bad: 'data' }], (s) => jsonlCalls.push(s));
        expect(jsonlCalls.length).toBe(0);
    });
});
