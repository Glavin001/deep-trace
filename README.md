# deep-trace

Zero-code OpenTelemetry instrumentation for JavaScript and TypeScript applications. Automatically traces every function call, React component render, and API request — without modifying your source code.

## Features

- **Zero-code instrumentation** — Babel plugin auto-wraps functions and components at build time
- **Three-layer source metadata** — V8 stack traces (runtime), Babel AST (build), React fiber tree (browser)
- **React component tracing** — Props, hierarchy, source location via [bippy](https://github.com/aidenybai/bippy)
- **Automatic fetch propagation** — W3C `traceparent` headers injected into every `fetch()` call
- **Silent observer** — Preserves `fn.length`, `fn.name`, skips generators, no side effects when tracing is disabled
- **Local debug server** — HTTP API for querying spans + JSONL file output

## Quick Start (Next.js)

### 1. Install

```bash
npm install deep-trace
```

### 2. Add framework hooks (no source code changes)

**`instrumentation.ts`** (server-side, auto-loaded by Next.js):
```ts
export { register } from 'deep-trace/instrumentation';
```

**`instrumentation-client.ts`** (client-side, auto-loaded before React):
```ts
import 'deep-trace/browser';
```

### 3. Add Babel plugin

**`babel.config.js`** or **`next.config.ts`**:
```js
// In your Babel config:
plugins: [['deep-trace/babel-plugin', { include: ['/app/', '/components/'] }]]
```

### 4. Set environment variables

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
OTEL_SERVICE_NAME=my-app
```

That's it. No imports in your components, no `wrapUserFunction()` calls, no manual span creation.

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
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OTLP collector URL |
| `DEBUG_PROBE_PORT` | `43210` | Local debug HTTP API port (0 to disable) |
| `DEBUG_PROBE_HOST` | `127.0.0.1` | Debug HTTP API bind address |
| `DEBUG_PROBE_JSONL` | `true` | Write spans to `.debug/traces.jsonl` |
| `DEBUG_PROBE_V8_SOURCE` | `true` | Use V8 stack traces for source locations |
| `NEXT_PUBLIC_OTLP_HTTP_ENDPOINT` | `http://127.0.0.1:4318/v1/traces` | Browser OTLP endpoint |
| `NEXT_PUBLIC_OTEL_SERVICE_NAME` | `deep-trace-web` | Browser service name |

## Local Development

```bash
npm ci              # Install dependencies
npm run build       # Compile TypeScript to dist/
npm test            # Run 172 tests
npm run build:check # Type-check only (no emit)
```

### Running the demo

```bash
npm run stack:up                    # Start OTel Collector + ClickHouse
npm run demo:next:install           # Install demo dependencies
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
OTEL_SERVICE_NAME=next-fullstack-api \
npm run demo:next:dev               # Start Next.js demo
```

Open `http://127.0.0.1:3000`, emit a trace, inspect Grafana at `http://127.0.0.1:3002`.

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
  __tests__/                # 172 tests across 14 files
demos/
  next-fullstack/           # Zero-code Next.js demo app
stack/
  local-otel/               # Docker Compose: OTel Collector + ClickHouse + Grafana
```
