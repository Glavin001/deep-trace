# Syncause ts-agent-file Analysis

## Overview

Syncause provides deep function-level instrumentation for Node.js/TypeScript that goes **beyond standard OpenTelemetry**. Their key innovation is automatic function wrapping via Babel/Webpack transforms that captures:
- Function arguments (up to 10 args, serialized)
- Return values
- Exceptions with stack traces
- Caller/callee relationships (parent span tracking)
- Console.log interception (captures log calls as spans)

All of this data flows into an in-memory **ring buffer** (SpanCache, max 10,000 spans) and is queryable via a local Express HTTP server on port 43210.

## Architecture (3 layers)

### Layer 1: AST Transform (compile-time)
**Files:** `babel-plugin-probe.js` (for Next.js/Babel) + `probe-loader.js` (for Webpack)

These rename user functions and wrap them:
```js
// Before transform:
function calculateTotal(items) { ... }

// After transform:
function _unwrapped_calculateTotal(items) { ... }
const calculateTotal = wrapUserFunction(_unwrapped_calculateTotal, 'calculateTotal');
```

Smart exclusions:
- React hooks (useState, useEffect, etc.)
- React components (PascalCase)
- Next.js internals (generateMetadata, headers, cookies, etc.)
- Constructors, toString, valueOf, etc.
- Only processes files matching `/app/` include pattern
- Excludes node_modules, .next, instrumentation files

### Layer 2: Runtime Wrapping (`probe-wrapper.ts` + `instrumentation.node.ts`)
**`probe-wrapper.ts`** - Lightweight wrapper for Babel plugin output:
- Creates OTel spans per function call
- Records args, return values, exceptions
- Handles async/Promise returns
- Exports: `wrapUserFunction`, `wrapUserModule`, `traced`

**`instrumentation.node.ts`** - Full runtime with richer wrapping:
- Same wrapping logic but also handles class prototypes
- Tracks caller chains via `spanNameMap` (spanId -> functionName)
- Console.log/error/warn interception (creates spans for log calls)
- Has `wrapRequireCache()` for monkey-patching require'd modules (currently disabled due to HMR conflicts)

### Layer 3: Data Storage + API

**SpanCache (in-memory ring buffer):**
- Max 10,000 spans
- Auto-cleanup at 85% capacity (drops oldest 20%)
- Query by: traceId, functionName, timeRange, limit
- Statistics: totalSpans, totalTraces, totalFunctions, avgDuration

**CachedSpanExporter (custom OTel exporter):**
- Extends ConsoleSpanExporter
- Filters out self-referencing spans (instrumentation's own HTTP/WS traffic)
- Routes all spans into SpanCache

**Local Express Server (port 43210):**
- `GET /remote-debug/spans` — query spans (by time, traceId, function, limit)
- `GET /remote-debug/traces` — get traces with full span data grouped by traceId
- `GET /remote-debug/spans/stats` — cache statistics
- `DELETE /remote-debug/spans` — clear cache

**WebSocket connection to cloud (what we strip):**
- Connects to `wss://api.syn-cause.com/codeproxy/ws`
- Registers with APP_ID, sends heartbeats every 30s
- Responds to remote data queries (get_spans, get_traces, get_stats)
- Auto-reconnects on disconnect (5s delay)

## Output Format

The `.syncause/span.log` shows the trace output format:
```json
{
  "timestamp": "2026-01-23T09:59:26.145Z",
  "spans": [
    {
      "traceId": "grgow7n47fsd6ikkfr55d7",
      "spanId": "opfhlxyi15863hvm40rr89",
      "name": "outerFunction",
      "location": "test-probe-demo.js:3",
      "startTime": 1769162366143,
      "endTime": 1769162366144,
      "duration": 1,
      "status": "ok",
      "args": ["5"],
      "returnValue": "121"
    }
  ],
  "traces": [
    {
      "traceId": "grgow7n47fsd6ikkfr55d7",
      "spanCount": 2,
      "callTree": "outerFunction (1ms) args: [5] => 121\n`-middleFunction (0ms) args: [10] => 121"
    }
  ]
}
```

## What to Keep vs Strip

### Keep
1. **SpanCache** — the ring buffer with query methods
2. **CachedSpanExporter** — custom OTel exporter routing to SpanCache
3. **wrapFunction / probe-wrapper.ts** — the function wrapping runtime
4. **babel-plugin-probe.js** — the AST transform
5. **Local Express server** — HTTP API for querying traces
6. **Console interception** — capturing logs as spans
7. **Caller chain tracking** — spanNameMap for parent-child relationships

### Strip
1. **WebSocket to api.syn-cause.com** — `connectToProxyServer()`, heartbeat loop
2. **API_KEY, APP_ID, PROJECT_ID** — cloud identifiers
3. **handleProxyMessage / handleDataRequest** — remote query handler (duplicate of HTTP API)
4. **.syncause/ config directory** — replace with simple local config

### Simplify
1. **Add JSONL file export** — append spans to `.debug/traces.jsonl` for persistent storage
2. **Remove cloud connection entirely** — no WebSocket, no auth
3. **Single entry point** — merge probe-wrapper into instrumentation.node.ts or keep separate but simpler
4. **Configurable via env vars only** — no config files needed

## Dependencies (all needed)

**Core:**
- `@opentelemetry/sdk-node`
- `@opentelemetry/api`
- `@opentelemetry/auto-instrumentations-node`
- `@opentelemetry/sdk-trace-node`
- `@opentelemetry/core`
- `express` + `ws` (for local API server)

**For Next.js/Babel transform:**
- `@babel/parser`
- `@babel/traverse`
- `magic-string`

**TypeScript:**
- `@types/express`, `@types/ws`, `@types/node`
- `tsx` (for running .ts files via --import)
