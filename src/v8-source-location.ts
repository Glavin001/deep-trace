/**
 * v8-source-location.ts — Extract caller source location using V8's structured stack trace API.
 *
 * Works in any Node.js environment without build tooling. For accurate line numbers
 * with transpiled code, use Node.js --enable-source-maps flag or the source-map-support package.
 */

export interface CallerLocation {
    /** Absolute file path of the caller. */
    filePath: string;
    /** 1-indexed line number. */
    line: number;
    /** 1-indexed column number. */
    column: number;
    /** Function name at the call site, if available. */
    functionName?: string;
}

/**
 * Capture the source location of the caller using V8's structured stack trace API.
 *
 * @param skipFrames Number of stack frames to skip (default 2: this function + the direct caller).
 * @returns CallerLocation or undefined if unavailable.
 */
export function getCallerLocation(skipFrames = 2): CallerLocation | undefined {
    const originalPrepare = Error.prepareStackTrace;
    try {
        let callSites: NodeJS.CallSite[] = [];
        Error.prepareStackTrace = (_err, stack) => {
            callSites = stack;
            return stack;
        };
        const err = new Error();
        // Accessing .stack triggers prepareStackTrace
        err.stack; // eslint-disable-line @typescript-eslint/no-unused-expressions

        const site = callSites[skipFrames];
        if (!site) return undefined;

        const fileName = site.getFileName();
        if (!fileName) return undefined;

        return {
            filePath: fileName,
            line: site.getLineNumber() ?? 0,
            column: site.getColumnNumber() ?? 0,
            functionName: site.getFunctionName() ?? undefined,
        };
    } catch {
        return undefined;
    } finally {
        Error.prepareStackTrace = originalPrepare;
    }
}
