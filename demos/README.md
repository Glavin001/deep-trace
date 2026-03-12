# Demos

This repository now separates shared observability infrastructure from runnable examples:

- `next-fullstack/` — browser + Next.js server telemetry into the shared collector stack.
- `sql-query-cli/` — tiny CLI demo for querying ClickHouse over HTTP like an agent would.

The structure is intentionally ready for more language demos later:

- future `python-*` demos can reuse `stack/local-otel/`
- future `java-*` demos can reuse `stack/local-otel/`
- agent and MCP integrations can target the same ClickHouse HTTP interface
