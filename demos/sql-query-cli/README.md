# SQL query CLI demo

Tiny Node-based example showing how an agent can query ClickHouse directly over HTTP.

## Examples

```bash
npm run recent --prefix demos/sql-query-cli
npm run services --prefix demos/sql-query-cli
TRACE_ID=<trace-id> npm run trace --prefix demos/sql-query-cli
```

Set `CLICKHOUSE_URL` if your ClickHouse HTTP endpoint is not `http://127.0.0.1:8123/`.
The scripts default to `CLICKHOUSE_USER=otel` and `CLICKHOUSE_PASSWORD=otel`.
