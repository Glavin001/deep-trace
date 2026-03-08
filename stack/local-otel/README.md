# Local OTel Stack

Shared local collector and storage for all demos in this repository.

## Components

- `otel/opentelemetry-collector-contrib` receives OTLP traces on `4317` and `4318`.
- `clickhouse/clickhouse-server` stores spans and exposes SQL over `8123`.
- The collector writes to ClickHouse through `host.docker.internal:9000`, which works on Docker Desktop and is mapped explicitly for Linux in `compose.yaml`.

## Start

```bash
npm run stack:up
```

Or directly:

```bash
docker compose -f stack/local-otel/compose.yaml up -d
```

## Stop

```bash
npm run stack:down
```

## Verify

```bash
docker compose -f stack/local-otel/compose.yaml ps
curl http://localhost:8123/ping
curl "http://localhost:8123/" --data-binary "SHOW TABLES FROM otel"
```

The collector creates `otel.otel_traces` automatically on first insert.

## Query examples

The `sql/` folder holds ready-to-run queries:

- `recent_root_spans.sql`
- `service_rollup.sql`
- `trace_waterfall.sql`

Example:

```bash
curl -s -u otel:otel "http://localhost:8123/?database=otel" \
  --data-binary "$(cat stack/local-otel/sql/recent_root_spans.sql) FORMAT Pretty"
```

## Demo wiring

The `demos/next-fullstack` app is configured to send:

- browser spans to `http://127.0.0.1:4318/v1/traces`
- server spans to `http://127.0.0.1:4318/v1/traces`
- server spans also into the existing in-process cache and JSONL writer from `deep-trace`

The stack creates a local ClickHouse user:

- user: `otel`
- password: `otel`

This stack is intentionally shared so future Python and Java demos can reuse the same collector and ClickHouse instance without changing their application layout.
