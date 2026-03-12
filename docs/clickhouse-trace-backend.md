# Plan: Local ClickHouse Trace Backend

The repository now supports a local collector-backed workflow in addition to the original in-process cache.

## Architecture

```text
browser demo / node demo / future python demo
  -> OTLP
  -> otel-collector
  -> ClickHouse
  -> SQL over HTTP for agents and app tooling
```

## Repository layout

- `stack/local-otel/` holds the shared collector + ClickHouse stack.
- `demos/next-fullstack/` exercises frontend and backend telemetry.
- `demos/sql-query-cli/` shows direct SQL querying over ClickHouse HTTP.

## Node runtime additions

`src/instrumentation.node.ts` now supports:

- local cache export
- JSONL export
- OTLP HTTP export through `DEBUG_PROBE_OTLP_ENDPOINT`
- service naming through `OTEL_SERVICE_NAME`

## Next steps

The shared stack is intentionally separate from the JS runtime so future Python, Java, and agent/MCP integrations can target the same collector and ClickHouse database without changing the storage layer.
