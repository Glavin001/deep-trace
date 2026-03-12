# Local OTel Stack

Shared local collector and storage for all demos in this repository.

## Components

- `otel/opentelemetry-collector-contrib` receives OTLP traces on `4317` and `4318`.
- `clickhouse/clickhouse-server` stores spans and exposes SQL over `8123`.
- `grafana/grafana-oss` visualizes traces and recent spans on `3002`.
- The collector writes to ClickHouse through `host.docker.internal:9000`, which works on Docker Desktop and is mapped explicitly for Linux in `compose.yaml`.

## Start

```bash
npm run stack:up
```

`npm run stack:up` also downloads the Grafana ClickHouse plugin on the host before starting Grafana, which avoids plugin-install DNS issues inside the Docker sandbox.

Or directly:

```bash
docker compose -f stack/local-otel/compose.yaml up -d
```

On Docker Desktop you can add ClickHouse ulimits for better performance:

```bash
docker compose -f stack/local-otel/compose.yaml -f stack/local-otel/compose.desktop.yaml up -d
```

> **Note:** The base `compose.yaml` omits `ulimits` because they fail in many sandbox and CI environments. The `compose.desktop.yaml` override adds them back for local Docker Desktop usage.

## Stop

```bash
npm run stack:down
```

## Verify

```bash
docker compose -f stack/local-otel/compose.yaml ps
curl http://localhost:8123/ping
curl -u otel:otel "http://localhost:8123/" --data-binary "SHOW TABLES FROM otel"
```

The collector creates `otel.otel_traces` automatically on first insert.
Grafana is available at `http://localhost:3002`.

## Grafana trace UI

Open `http://localhost:3002/explore`. The provisioned `ClickHouse Traces` datasource is selected by default.

### Step 1 — find a trace ID (Trace Search)

Set the query panel to:

- Query Type: **Traces**
- Trace Mode: **Trace Search**

Click **Run Query**. A table of recent root spans appears with columns `traceID`, `serviceName`, `operationName`, `startTime`, `duration`. Copy a `traceID` value.

### Step 2 — inspect all spans (Trace ID)

Switch the same panel (or open a split panel with the `Split` button) to:

- Query Type: **Traces**
- Trace Mode: **Trace ID**
- Paste the trace ID into the **Trace ID** field

Click **Run Query**. The full waterfall with all nested spans renders below, showing every span in the trace across services.

> **Why two steps?** Trace Search filters to root spans only (Parent Span ID is empty), so child spans are intentionally excluded from that view. Trace ID mode fetches every span that shares the same trace ID.

### Dashboard

A starter table is provisioned at `http://localhost:3002/d/deep-trace-overview/deep-trace-overview`. It shows recent spans and respects the dashboard time picker. Grafana Explore (above) is the primary UI for waterfall inspection.

### Caveats

- If an Explore tab shows `NaNd NaNh` after a config change, open a fresh Explore tab — a simple refresh can keep stale query state.

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
