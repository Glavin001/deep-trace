# AGENTS.md

## Cursor Cloud specific instructions

**deep-trace** is a local-only Node.js/TypeScript debugging/tracing library built on OpenTelemetry. It is a library, not a standalone application — there is no dev server to start.

### Quick reference

| Action | Command |
|---|---|
| Install deps | `npm ci` |
| Type check | `npm run build:check` (`tsc --noEmit`) |
| Run tests | `npm test` (`vitest run`) |
| Watch tests | `npm run test:watch` |
| Start Docker in Cursor Cloud | `bash scripts/start-docker.sh` |

### Trace Viewer (`apps/trace-viewer/`)

A local web UI for exploring OpenTelemetry traces stored in ClickHouse — no Grafana needed.

| Action | Command |
|---|---|
| Install deps | `npm run viewer:install` |
| Dev mode (client + server) | `npm run viewer:dev` |
| Build | `npm run viewer:build` |
| E2E tests (requires Docker stack) | `cd apps/trace-viewer && npm run test:e2e` |

- **Frontend**: React + Vite + Tailwind CSS on port 3005 (proxied to server).
- **Backend**: Express + `@clickhouse/client` on port 3004. Endpoints: `/api/traces`, `/api/traces/:traceId`, `/api/services`, `/api/source`, `/api/health`.
- **Source viewer**: The `/api/source` endpoint resolves `code.filepath` span attributes to actual files on disk. It searches `demos/`, `apps/`, `packages/`, and `examples/` subdirectories when the direct path isn't found. Directory traversal is blocked.
- **Timestamps**: ClickHouse DateTime64 returns `"2026-03-14 10:27:31.123"` (no `Z` suffix). The shared `parseTimestamp()` in `src/utils.ts` normalizes these to proper UTC Date objects.

### Browser Instrumentation (`src/browser-init.ts`)

Key architectural details for anyone modifying the browser tracing:

- **Fetch patch**: `globalThis.fetch` is patched to create visible spans (`fetch GET /path`) and inject W3C `traceparent` headers. OTLP exporter URLs (`/v1/traces`, `/v1/metrics`, `/v1/logs`) are **excluded** to prevent an infinite feedback loop (export → span → export → …).
- **Async context stack**: Browsers lose `context.active()` after `await`. `probe-wrapper.ts` maintains a `_browserCtxStack` so that fetch calls and inner functions find their parent span across async gaps.
- **Wrap-time context capture**: `wrapFunction()` captures `context.active()` when the wrapper is created (e.g., during a component render). When the wrapped function fires later (e.g., a click handler) with no active span, it falls back to this captured context, linking event handlers to the component that defined them.

### Demo App (`demos/next-fullstack/`)

A Next.js app demonstrating full-stack distributed tracing. Zero tracing imports in application code — everything is auto-instrumented by the Babel plugin and browser-init.

- **Frontend flow**: `DemoPanel` render → `runDemo` click → `validateInput` → `buildSearchContext` → fetch `/api/analyze` → `processAnalysisResults` → fetch `/api/enrich` → `mergeAndFormat`. Produces ~20 spans per trace across browser and server.
- **Server routes**: `/api/analyze` (6 spans) and `/api/enrich` (5 spans), each with multiple helper functions.
- Run with `npm run dev` from `demos/next-fullstack/`. Requires the Docker collector stack (`stack/local-otel/compose.yaml`).

### Notes

- **Node.js 22** is required (matches CI and `@types/node` version).
- Tests use **Vitest** with `pool: 'forks'` for OTel global provider isolation. Each test file runs in its own forked process — this is intentional, not a misconfiguration.
- `npm run build` compiles TypeScript to `dist/` with declarations. `npm run build:check` runs type-checks only (`tsc --noEmit`). Vitest handles TS transpilation internally for tests.
- The embedded Express HTTP API (port 43210) auto-starts when `instrumentation.node.ts` is imported. Tests that exercise HTTP endpoints start/stop this server within the test process — no manual server startup needed.
- The `punycode` deprecation warning from Node.js 22 is benign and comes from an OpenTelemetry transitive dependency; it does not affect functionality.
- Docker is optional for the library tests, but required for the local collector/ClickHouse stack and demos.

### Docker in Cursor Cloud

- Cursor Cloud sandboxes here do **not** use `systemd`, so Docker must be started manually.
- Install and start Docker with:

  ```bash
  bash scripts/start-docker.sh
  ```

- The working daemon settings in this sandbox are:
  - socket: `unix:///tmp/docker.sock`
  - storage driver: `vfs`
  - `--iptables=false`
  - `--ip6tables=false`
- After startup, use one of:

  ```bash
  export DOCKER_HOST=unix:///tmp/docker.sock && sudo -E docker ps
  sg docker -c 'export DOCKER_HOST=unix:///tmp/docker.sock && docker ps'
  ```

- `docker compose` works through the same socket:

  ```bash
  export DOCKER_HOST=unix:///tmp/docker.sock && sudo -E docker compose version
  export DOCKER_HOST=unix:///tmp/docker.sock && sudo -E docker compose -f stack/local-otel/compose.yaml up -d
  ```

- Do **not** rely on Compose `mem_limit` in this sandbox. Nested cgroup delegation here does not expose the memory controller, so container-level memory limits fail even though Docker itself works.
