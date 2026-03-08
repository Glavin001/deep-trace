/**
 * Tests for the JSONL file writer
 *
 * Verifies:
 * - Spans are written to .debug/traces.jsonl
 * - Each line is valid JSON
 * - Contains expected fields (traceId, spanId, name, attributes, etc.)
 * - File is append-only (multiple spans = multiple lines)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// The JSONL file gets written to the default .debug/ dir since
// instrumentation.node.ts reads JSONL_DIR at module load time.
// We verify it works with the default path.
const JSONL_DIR = path.join(process.cwd(), '.debug');
const JSONL_FILE = path.join(JSONL_DIR, 'traces.jsonl');

// Enable JSONL (it's enabled by default unless DEBUG_PROBE_JSONL=false)
// Setting these before import, but note ESM hoisting means they may run
// at the same time as the import.
process.env.DEBUG_PROBE_PORT = '0';
process.env.DEBUG_PROBE_LOG = 'false';
// Don't set DEBUG_PROBE_JSONL to 'false' — we WANT it enabled (default)

import {
    wrapUserFunction,
    flushSpans,
    clearSpans,
    sdk,
} from '../instrumentation.node';

describe('JSONL file writer', () => {
    let lineCountBefore: number;

    beforeAll(async () => {
        // Record how many lines exist before our test (other tests may have written)
        try {
            const content = fs.readFileSync(JSONL_FILE, 'utf-8').trim();
            lineCountBefore = content ? content.split('\n').length : 0;
        } catch {
            lineCountBefore = 0;
        }

        // Write a span that should appear in JSONL
        clearSpans();
        const fn = wrapUserFunction(() => 'hello', 'jsonlTest1');
        fn();
        await flushSpans();
    });

    afterAll(async () => {
        await sdk.shutdown().catch(() => {});
    });

    it('should create the .debug directory and traces.jsonl file', () => {
        expect(fs.existsSync(JSONL_DIR)).toBe(true);
        expect(fs.existsSync(JSONL_FILE)).toBe(true);
    });

    it('should have written new lines after our function call', () => {
        const content = fs.readFileSync(JSONL_FILE, 'utf-8').trim();
        const lines = content.split('\n').filter(Boolean);
        expect(lines.length).toBeGreaterThan(lineCountBefore);
    });

    it('should write valid JSON per line', () => {
        const content = fs.readFileSync(JSONL_FILE, 'utf-8').trim();
        const lines = content.split('\n').filter(Boolean);
        for (const line of lines) {
            expect(() => JSON.parse(line)).not.toThrow();
        }
    });

    it('should include expected fields in each JSONL entry', () => {
        const content = fs.readFileSync(JSONL_FILE, 'utf-8').trim();
        const lines = content.split('\n').filter(Boolean);
        // Find the entry for our test function
        const testLine = lines.find(l => {
            const parsed = JSON.parse(l);
            return parsed.attributes?.['function.name'] === 'jsonlTest1';
        });
        expect(testLine).toBeDefined();

        const entry = JSON.parse(testLine!);
        expect(entry).toHaveProperty('ts');
        expect(entry).toHaveProperty('traceId');
        expect(entry).toHaveProperty('spanId');
        expect(entry).toHaveProperty('name');
        expect(entry).toHaveProperty('duration');
        expect(entry).toHaveProperty('status');
        expect(entry).toHaveProperty('attributes');
        expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(entry.status).toBe('OK');
    });

    it('should append multiple spans (one per line)', async () => {
        const fn1 = wrapUserFunction(() => 'a', 'jsonlMulti1');
        const fn2 = wrapUserFunction(() => 'b', 'jsonlMulti2');
        fn1();
        fn2();
        await flushSpans();

        const content = fs.readFileSync(JSONL_FILE, 'utf-8').trim();
        const lines = content.split('\n').filter(Boolean);
        // Should have at least 3 new lines (1 from beforeAll + 2 from this test)
        expect(lines.length).toBeGreaterThanOrEqual(lineCountBefore + 3);
    });

    it('should capture function attributes in JSONL', async () => {
        const fn = wrapUserFunction((x: number) => x * 2, 'jsonlAttrs');
        fn(42);
        await flushSpans();

        const content = fs.readFileSync(JSONL_FILE, 'utf-8').trim();
        const lines = content.split('\n').filter(Boolean);
        const attrLine = lines.find(l => {
            const parsed = JSON.parse(l);
            return parsed.attributes?.['function.name'] === 'jsonlAttrs';
        });

        expect(attrLine).toBeDefined();
        const entry = JSON.parse(attrLine!);
        expect(entry.attributes['function.args.0']).toBe('42');
        expect(entry.attributes['function.return.value']).toBe('84');
        expect(entry.status).toBe('OK');
    });

    it('should capture error status in JSONL', async () => {
        const fn = wrapUserFunction(() => { throw new Error('jsonl-err'); }, 'jsonlError');
        try { fn(); } catch {}
        await flushSpans();

        const content = fs.readFileSync(JSONL_FILE, 'utf-8').trim();
        const lines = content.split('\n').filter(Boolean);
        const errorLine = lines.find(l => {
            const parsed = JSON.parse(l);
            return parsed.attributes?.['function.name'] === 'jsonlError';
        });

        expect(errorLine).toBeDefined();
        const entry = JSON.parse(errorLine!);
        expect(entry.status).toBe('ERROR');
        expect(entry.statusMessage).toContain('jsonl-err');
    });
});
