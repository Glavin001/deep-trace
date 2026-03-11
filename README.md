# deep-trace

Enhanced local-first OpenTelemetry instrumentation for JavaScript and TypeScript, now with a reusable local collector stack and demo apps that stream spans into ClickHouse for SQL querying.

## What is here

- `src/` — the `deep-trace` runtime, including enhanced function-level spans and a local debug API.
- `stack/local-otel/` — shared OTEL Collector + ClickHouse config for local trace collection.
- `demos/next-fullstack/` — browser + Next.js server telemetry demo.
- `demos/sql-query-cli/` — tiny query client that talks to ClickHouse like an agent would.

## Prerequisites

- **Node.js 22+** (see `.nvmrc`)
- **Docker** with Docker Compose (for the local collector stack)

## Quick start

### 1. Install and verify

```bash
npm ci
npm run build   # type-check (tsc --noEmit)
npm test        # vitest — 79 unit tests
```

### 2. Start the local collector stack

This brings up ClickHouse, the OpenTelemetry Collector, and Grafana:

```bash
npm run stack:up
```

Verify the stack is healthy:

```bash
curl http://localhost:8123/ping          # should print "Ok."
curl -u otel:otel "http://localhost:8123/" --data-binary "SHOW TABLES FROM otel"
```

> **Sandbox / CI environments:** If Docker is not running, use `bash scripts/start-docker.sh` first. Then `export DOCKER_HOST=unix:///tmp/docker.sock` before running `npm run stack:up`. See [AGENTS.md](AGENTS.md) for details.

### 3. Seed sample data

```bash
npm run stack:seed
```

This sends a multi-span trace to the collector and prints a trace ID you can inspect in Grafana.

### 4. Run the Next.js demo

```bash
npm run demo:next:install
npm run demo:next:dev
```

Open `http://127.0.0.1:3000`, click the button to emit a trace, then:

- Inspect Grafana at `http://127.0.0.1:3002`
- Query ClickHouse from the CLI:

```bash
npm run query:recent --prefix demos/next-fullstack
npm run query:services --prefix demos/next-fullstack
TRACE_ID=<trace-id> npm run query:trace --prefix demos/next-fullstack
```

### 5. Query ClickHouse directly

Ready-to-run SQL queries are in `stack/local-otel/sql/`:

```bash
curl -s -u otel:otel "http://localhost:8123/?database=otel" \
  --data-binary "$(cat stack/local-otel/sql/recent_root_spans.sql) FORMAT Pretty"
```

### 6. Tear down

```bash
npm run stack:down
```

## Runtime behavior

The Node-side runtime now supports both:

- the existing in-process cache + JSONL export for lightweight local debugging
- optional OTLP HTTP export to a collector via `DEBUG_PROBE_OTLP_ENDPOINT`

That means existing workflows stay available while local collector-backed querying is enabled when you want a proper trace backend.

## Ports

| Service              | Port  | Purpose                        |
|----------------------|-------|--------------------------------|
| Next.js demo         | 3000  | Demo app UI                    |
| Grafana              | 3002  | Dashboards and trace explorer  |
| OTEL Collector gRPC  | 4317  | Trace ingestion (gRPC)         |
| OTEL Collector HTTP  | 4318  | Trace ingestion (HTTP/OTLP)    |
| ClickHouse HTTP      | 8123  | SQL queries                    |
| ClickHouse native    | 9000  | Native protocol (collector)    |
| deep-trace debug API | 43210 | In-process span cache/debug    |
