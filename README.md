# deep-trace

Zero-code OpenTelemetry instrumentation for JavaScript and TypeScript applications. Automatically traces every function call, React component render, and API request — without modifying your source code.

## Features

- **Zero-code instrumentation** — Babel plugin auto-wraps functions and components at build time
- **Three-layer source metadata** — V8 stack traces (runtime), Babel AST (build), React fiber tree (browser)
- **React component tracing** — Props, hierarchy, source location via [bippy](https://github.com/aidenybai/bippy)
- **Automatic fetch propagation** — W3C `traceparent` headers injected into every `fetch()` call
- **Silent observer** — Preserves `fn.length`, `fn.name`, skips generators, no side effects when tracing is disabled
- **Local debug server** — HTTP API for querying spans + JSONL file output

## Prerequisites

- **Node.js 22+** (check with `node --version`)
- **Docker Desktop** (for the local OTel collector stack) — [Install for macOS](https://www.docker.com/products/docker-desktop/) or [Linux](https://docs.docker.com/engine/install/)

## Quick Start — Run the Demo

The fastest way to see deep-trace in action. Works on macOS and Linux.

### 1. Clone and install

```bash
git clone <repo-url> deep-trace
cd deep-trace
npm ci
npm run build
```

### 2. Start the local collector stack

Requires Docker Desktop running.

```bash
npm run stack:up
```

This starts OTel Collector + ClickHouse + Grafana via Docker Compose.

### 3. Install and run the Next.js demo

```bash
npm run demo:next:install
```

Then start the demo:

```bash
npm run demo:next:dev
```

### 4. Use it

1. Open http://127.0.0.1:3000
2. Click "Emit frontend + backend trace"
3. Open Grafana at http://127.0.0.1:3002 — go to Explore, select the ClickHouse datasource, and query `otel.otel_traces`
4. Or query spans directly:

```bash
# Recent traces
curl http://127.0.0.1:43210/remote-debug/traces

# Span statistics
curl http://127.0.0.1:43210/remote-debug/spans/stats

# Spans by function name
curl 'http://127.0.0.1:43210/remote-debug/spans?functionName=DemoPanel'
```

### 5. Stop

```bash
npm run stack:down
```

---

## Add to Your Own Next.js Project

### 1. Install

```bash
npm install deep-trace
```

### 2. Add framework hooks (no source code changes)

**`instrumentation.ts`** (project root, auto-loaded by Next.js on the server):
```ts
export { register } from 'deep-trace/instrumentation';
```

**`instrumentation-client.ts`** (project root, auto-loaded before React):
```ts
import 'deep-trace/browser';
```

### 3. Add Babel plugin

Create **`.babelrc`** in your project root:
```json
{
  "presets": ["next/babel"],
  "plugins": [
    ["deep-trace/babel-plugin", {
      "include": ["/app/", "/components/"],
      "exclude": ["/node_modules/", "/.next/"]
    }]
  ]
}
```

### 4. Set environment variables

```bash
# Server-side
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
OTEL_SERVICE_NAME=my-app

# Browser-side (must be NEXT_PUBLIC_ prefixed)
NEXT_PUBLIC_OTLP_HTTP_ENDPOINT=http://127.0.0.1:4318/v1/traces
NEXT_PUBLIC_OTEL_SERVICE_NAME=my-app-web
```

That's it. No imports in your components, no `wrapUserFunction()` calls, no manual span creation.

### Or use the install script

```bash
cd your-project
bash /path/to/deep-trace/src/install.sh
```

This auto-detects your project type, installs dependencies, creates hook files, and configures Babel.

---

## How It Works

### Build Time (Babel Plugin)

The Babel plugin auto-wraps:
- Exported functions (`export function GET()`) — traced with full source metadata
- React components (`function MyComponent()`, `const Card = () => ...`) — traced with props + fiber data
- Arrow functions assigned to variables — traced with source location

It skips:
- Non-exported helper functions (preserves JavaScript hoisting semantics)
- Generator functions (wrapping breaks the generator protocol)
- React hooks (`use*` prefix)
- `React.memo()` / `forwardRef()` wrappers

### Runtime (Node.js)

- V8 stack trace API captures source file/line/column at registration time
- OTel SDK exports spans via OTLP HTTP or to local JSONL file
- In-memory span cache with HTTP query API on `127.0.0.1:43210`

### Runtime (Browser)

- `browser-init.ts` auto-initializes WebTracerProvider + OTLP exporter
- bippy intercepts React DevTools hook for fiber tree access
- `onCommitFiberRoot` enriches component spans with hierarchy data
- `globalThis.fetch` patched to inject `traceparent` headers

## Architecture

```
┌─────────────────────────────────────────────┐
│  Your Application Code (unchanged)          │
├─────────────────────────────────────────────┤
│  Babel Plugin (build-time)                  │
│  - Wraps functions + components             │
│  - Injects source metadata (file, line)     │
├─────────────────────────────────────────────┤
│  probe-wrapper.ts (runtime)                 │
│  - Creates OTel spans per function call     │
│  - Records args, return values, errors      │
│  - Registers component spans for fiber      │
├──────────────────┬──────────────────────────┤
│  Node.js Layer   │  Browser Layer           │
│  - V8 stack API  │  - bippy fiber extract   │
│  - OTLP export   │  - fetch() patching      │
│  - Span cache    │  - WebTracerProvider     │
│  - JSONL output  │  - onCommitFiberRoot     │
└──────────────────┴──────────────────────────┘
```

## Configuration

All configuration via environment variables:

| Variable | Default | Description |
|---|---|---|
| `OTEL_SERVICE_NAME` | `deep-trace-node` | Service name in traces |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OTLP collector URL (base, no path) |
| `DEBUG_PROBE_OTLP_ENDPOINT` | — | OTLP traces endpoint (with `/v1/traces` path) |
| `DEBUG_PROBE_PORT` | `43210` | Local debug HTTP API port (0 to disable) |
| `DEBUG_PROBE_HOST` | `127.0.0.1` | Debug HTTP API bind address |
| `DEBUG_PROBE_JSONL` | `true` | Write spans to `.debug/traces.jsonl` |
| `DEBUG_PROBE_V8_SOURCE` | `true` | Use V8 stack traces for source locations |
| `NEXT_PUBLIC_OTLP_HTTP_ENDPOINT` | `http://127.0.0.1:4318/v1/traces` | Browser OTLP endpoint |
| `NEXT_PUBLIC_OTEL_SERVICE_NAME` | `deep-trace-web` | Browser service name |

## Developing deep-trace

```bash
npm ci              # Install dependencies
npm run build       # Compile TypeScript to dist/
npm test            # Run 194 tests across 15 files
npm run build:check # Type-check only (no emit)
```

## Project Structure

```
src/
  index.ts                  # Public API barrel file
  browser-init.ts           # Browser entry: telemetry + bippy + fetch patch
  instrumentation.ts        # Next.js server instrumentation hook
  instrumentation.node.ts   # Node.js runtime (SDK, span cache, HTTP API)
  probe-wrapper.ts          # Function wrapping for Babel plugin
  babel-plugin-probe.js     # Babel AST transform
  react-fiber-extractor.ts  # React fiber → OTel span attributes
  v8-source-location.ts     # V8 stack trace source location extraction
  runtime-config.ts         # Environment variable configuration
  types.ts                  # Shared TypeScript types
  __tests__/                # 194 tests across 15 files
demos/
  next-fullstack/           # Zero-code Next.js demo app
stack/
  local-otel/               # Docker Compose: OTel Collector + ClickHouse + Grafana
```
