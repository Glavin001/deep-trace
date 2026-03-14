/**
 * Tests for v8-source-location.ts — V8 structured stack trace API extraction.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { getCallerLocation, CallerLocation } from '../v8-source-location';

describe('v8-source-location', () => {
    const originalPrepare = Error.prepareStackTrace;

    afterEach(() => {
        // Ensure prepareStackTrace is always restored
        Error.prepareStackTrace = originalPrepare;
    });

    it('should return file path, line, and column for the caller', () => {
        // Call from a known location — the result should point to THIS file
        const loc = getCallerLocation(1); // skip 1 = getCallerLocation itself
        expect(loc).toBeDefined();
        expect(loc!.filePath).toContain('v8-source-location.test');
        expect(loc!.line).toBeGreaterThan(0);
        expect(loc!.column).toBeGreaterThan(0);
    });

    it('should return the correct function name when called from a named function', () => {
        function myNamedCaller(): CallerLocation | undefined {
            return getCallerLocation(1);
        }
        const loc = myNamedCaller();
        expect(loc).toBeDefined();
        expect(loc!.functionName).toBe('myNamedCaller');
    });

    it('should return undefined when skipFrames exceeds stack depth', () => {
        const loc = getCallerLocation(9999);
        expect(loc).toBeUndefined();
    });

    it('should restore Error.prepareStackTrace after use', () => {
        const customPrepare = (_err: Error, stack: NodeJS.CallSite[]) => stack;
        Error.prepareStackTrace = customPrepare;

        getCallerLocation(1);

        expect(Error.prepareStackTrace).toBe(customPrepare);
    });

    it('should handle pre-existing Error.prepareStackTrace override gracefully', () => {
        const customPrepare = (_err: Error, stack: NodeJS.CallSite[]) => 'custom' as any;
        Error.prepareStackTrace = customPrepare;

        const loc = getCallerLocation(1);
        expect(loc).toBeDefined();
        expect(loc!.filePath).toContain('v8-source-location.test');

        // Original custom handler should be restored
        expect(Error.prepareStackTrace).toBe(customPrepare);
    });

    it('should never throw', () => {
        // Even with bizarre prepareStackTrace
        Error.prepareStackTrace = () => { throw new Error('boom'); };
        expect(() => getCallerLocation(1)).not.toThrow();
    });

    it('should use default skipFrames of 2 (caller of the caller)', () => {
        function wrapper(): CallerLocation | undefined {
            return getCallerLocation(); // default skipFrames=2
        }
        const loc = wrapper();
        expect(loc).toBeDefined();
        // Should point to THIS test file (the caller of wrapper)
        expect(loc!.filePath).toContain('v8-source-location.test');
    });
});
