# Plan: Add Jaeger Trace Backend for Debug Probe

## Context

The debug probe currently stores spans in two places: an in-memory ring buffer (10k max, lost on restart) and a flat `.debug/traces.jsonl` file. Both have limitations — the ring buffer evicts old data, and JSONL is append-only with no query capability. A proper trace backend would provide persistent, queryable storage with a built-in UI for exploring traces.

**Jaeger all-in-one** is the ideal choice: one Docker container, accepts OTLP natively (port 4318), built-in trace search UI (port 16686), and it preserves all custom span attributes (`function.args.*`, `function.return.value`, `function.caller.name`) as standard OTel tags — no transformation needed.

## Architecture

```
Next.js App (instrumentation.node.ts)
├── LocalSpanExporter → SpanCache (in-memory, optional)
│                     → .debug/traces.jsonl (optional)
└── OTLPTraceExporter → Jaeger (port 4318, persistent storage + UI)
```

Both exporters run in parallel via OTel's `spanProcessors` array. The in-process `spanNameMap` for caller tracking stays — it's latency-critical and must remain in-process.

## Why keep the in-memory cache too?

The `spanNameMap` (maps spanId → function name for caller-chain tracking) **must** stay in-process — it's read synchronously during function execution. The `SpanCache` itself becomes optional (defaults to on). This lets developers use the probe without Docker/Jaeger for simple local debugging.

## Changes

### 1. Install OTLP exporter dependency
- `npm install @opentelemetry/exporter-trace-otlp-http`

### 2. Modify `lib/debug-probe/instrumentation.node.ts`

Add env vars:
```
DEBUG_PROBE_OTLP_ENDPOINT  (unset = disabled, e.g. "http://jaeger:4318/v1/traces")
```

Refactor SDK init from single `traceExporter` to `spanProcessors` array:
- `SimpleSpanProcessor(LocalSpanExporter)` — always active (feeds SpanCache + JSONL)
- `BatchSpanProcessor(OTLPTraceExporter)` — active only when endpoint is configured

Update `isOwnSpan()` filter to also exclude OTLP export requests (`:4318`, `/v1/traces`).

### 3. Add Jaeger to `docker-compose.yml`

```yaml
jaeger:
  image: jaegertracing/jaeger:2
  ports:
    - "16686:16686"   # Jaeger UI
    - "4318:4318"     # OTLP HTTP receiver
```

Add `DEBUG_PROBE_OTLP_ENDPOINT=http://jaeger:4318/v1/traces` to agent-server environment.

### 4. Add tests — `lib/debug-probe/__tests__/otlp-exporter.test.ts`

- Verify OTLP exporter is created when env var is set
- Verify OTLP exporter is NOT created when env var is absent
- Verify `isOwnSpan()` filters OTLP-related spans
- Mock the OTLP exporter (no running Jaeger needed)

### Files modified
| File | Change |
|------|--------|
| `package.json` | Add `@opentelemetry/exporter-trace-otlp-http` |
| `lib/debug-probe/instrumentation.node.ts` | Add OTLP exporter, refactor SDK init, update span filter |
| `docker-compose.yml` | Add Jaeger service + env var |
| `lib/debug-probe/__tests__/otlp-exporter.test.ts` | New test file |

### Files NOT modified
- `probe-wrapper.ts` — untouched (the enhanced instrumentation layer)
- `babel-plugin-probe.js` — untouched
- All existing test files — OTLP defaults to disabled when env var is absent

## Verification

1. Run `npx vitest run lib/debug-probe/__tests__/` — all 71+ existing tests pass (OTLP not configured in test env)
2. Run `npx vitest run --exclude 'test/e2e*'` — full project tests pass
3. `docker compose up` — Jaeger starts alongside agent-server
4. Generate spans → open `http://localhost:16686` → verify spans appear with `function.name`, `function.args.*`, `function.return.value`, `function.caller.name` as tags
