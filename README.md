# deep-trace

Enhanced local-first OpenTelemetry instrumentation for JavaScript and TypeScript, now with a reusable local collector stack and demo apps that stream spans into ClickHouse for SQL querying.

## What is here

- `src/` — the `deep-trace` runtime, including enhanced function-level spans and a local debug API.
- `stack/local-otel/` — shared OTEL Collector + ClickHouse config for local trace collection.
- `demos/next-fullstack/` — browser + Next.js server telemetry demo.
- `demos/sql-query-cli/` — tiny query client that talks to ClickHouse like an agent would.

## Quick start

Install root dependencies:

```bash
npm ci
```

Type-check and run tests:

```bash
npm run build
npm test
```

Start the local collector stack:

```bash
npm run stack:up
```

Run the Next.js demo:

```bash
npm run demo:next:install
DEBUG_PROBE_OTLP_ENDPOINT=http://127.0.0.1:4318/v1/traces \
OTEL_SERVICE_NAME=next-fullstack-api \
NEXT_PUBLIC_OTLP_HTTP_ENDPOINT=http://127.0.0.1:4318/v1/traces \
NEXT_PUBLIC_OTEL_SERVICE_NAME=next-fullstack-web \
npm run dev --prefix demos/next-fullstack
```

Then open `http://127.0.0.1:3000`, emit a trace, and query ClickHouse:

```bash
npm run query:recent --prefix demos/next-fullstack
TRACE_ID=<trace-id> npm run query:trace --prefix demos/next-fullstack
```

## Runtime behavior

The Node-side runtime now supports both:

- the existing in-process cache + JSONL export for lightweight local debugging
- optional OTLP HTTP export to a collector via `DEBUG_PROBE_OTLP_ENDPOINT`

That means existing workflows stay available while local collector-backed querying is enabled when you want a proper trace backend.
