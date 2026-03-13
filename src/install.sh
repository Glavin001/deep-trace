#!/bin/bash
# install.sh — Install deep-trace into a Node.js/TypeScript/Next.js project
#
# Usage:
#   cd your-project
#   bash /path/to/deep-trace/src/install.sh
#
# What it does:
#   1. Detects project type (Next.js, TypeScript, JavaScript)
#   2. Installs deep-trace and required peer dependencies
#   3. Creates instrumentation hook files (zero-code pattern)
#   4. Configures Babel plugin for auto-wrapping
#
# After installation, NO tracing imports are needed in your application code.
# The Babel plugin auto-wraps functions/components, and framework hooks
# handle initialization.
#
# Environment:
#   DEBUG_PROBE_PORT=43210     — HTTP API port (default: 43210)
#   DEBUG_PROBE_JSONL=true     — Enable JSONL file output (default: true)
#   DEBUG_PROBE_DIR=.debug     — Output directory (default: .debug)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo_step() { echo -e "\033[1;34m==>\033[0m $1"; }
echo_ok()   { echo -e "\033[1;32m OK:\033[0m $1"; }
echo_err()  { echo -e "\033[1;31mERR:\033[0m $1"; }

# 1. Detect package manager
if [ -f "pnpm-lock.yaml" ]; then
    PKG="pnpm"
    if [ -f "pnpm-workspace.yaml" ]; then
        INSTALL="pnpm add -w"
        DEV_INSTALL="pnpm add -D -w"
    else
        INSTALL="pnpm add"
        DEV_INSTALL="pnpm add -D"
    fi
elif [ -f "yarn.lock" ]; then
    PKG="yarn"
    INSTALL="yarn add"
    DEV_INSTALL="yarn add -D"
else
    PKG="npm"
    INSTALL="npm install"
    DEV_INSTALL="npm install -D"
fi
echo_step "Package manager: $PKG"

# 2. Detect project type
if [ ! -f "package.json" ]; then
    echo_err "No package.json found. Run this from your project root."
    exit 1
fi

if grep -q '"next"' package.json; then
    TYPE="next"
elif grep -qE '"(typescript|@types/node)"' package.json || [ -f "tsconfig.json" ]; then
    TYPE="ts"
else
    TYPE="js"
fi
echo_step "Project type: $TYPE"

# 3. Install deep-trace from local path
echo_step "Installing deep-trace..."
$INSTALL "${PROJECT_ROOT}"

# 4. Install required peer dependencies
PEER_DEPS=(
    "@opentelemetry/api"
    "@opentelemetry/core"
    "@opentelemetry/exporter-trace-otlp-http"
    "@opentelemetry/resources"
    "@opentelemetry/sdk-trace-base"
    "@opentelemetry/semantic-conventions"
)

if [ "$TYPE" = "next" ] || [ "$TYPE" = "ts" ]; then
    # Server-side deps
    PEER_DEPS+=(
        "@opentelemetry/sdk-node"
        "@opentelemetry/sdk-trace-node"
        "@opentelemetry/auto-instrumentations-node"
        "express"
    )
fi

echo_step "Installing OpenTelemetry peer dependencies..."
$INSTALL "${PEER_DEPS[@]}"

if [ "$TYPE" = "next" ]; then
    # Browser-side deps
    echo_step "Installing browser tracing dependencies..."
    $INSTALL "@opentelemetry/sdk-trace-web" "bippy"
fi

if [ "$TYPE" = "ts" ] || [ "$TYPE" = "next" ]; then
    echo_step "Installing TypeScript dev dependencies..."
    $DEV_INSTALL "@types/express" "@types/node"
fi

# 5. Create instrumentation hooks (zero-code pattern)
if [ "$TYPE" = "next" ]; then
    # Next.js: create instrumentation.ts and instrumentation-client.ts
    if [ ! -f "instrumentation.ts" ]; then
        cat > instrumentation.ts << 'HOOK'
export { register } from 'deep-trace/instrumentation';
HOOK
        echo_ok "Created instrumentation.ts (server-side hook)"
    fi

    if [ ! -f "instrumentation-client.ts" ]; then
        cat > instrumentation-client.ts << 'HOOK'
import 'deep-trace/browser';
HOOK
        echo_ok "Created instrumentation-client.ts (client-side hook)"
    fi

    # Create .babelrc if it doesn't exist
    if [ ! -f ".babelrc" ]; then
        cat > .babelrc << 'BABELRC'
{
  "presets": ["next/babel"],
  "plugins": [
    ["deep-trace/babel-plugin", {
      "include": ["/app/", "/components/"],
      "exclude": ["/node_modules/", "/.next/"]
    }]
  ]
}
BABELRC
        echo_ok "Created .babelrc with deep-trace Babel plugin"
    fi
elif [ "$TYPE" = "ts" ]; then
    # TypeScript: patch dev/start scripts to use --import
    echo_step "Configuring --import for server-side instrumentation..."
    node -e '
    const fs = require("fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    const keys = ["dev", "start", "serve"];
    let patched = false;
    for (const key of keys) {
        if (pkg.scripts?.[key] && !pkg.scripts[key].includes("--import")) {
            const cmd = pkg.scripts[key];
            if (cmd.startsWith("tsx ")) {
                pkg.scripts[key] = cmd.replace(/^tsx\s+/, "tsx --import deep-trace/node ");
                patched = true; break;
            } else if (cmd.startsWith("node ")) {
                pkg.scripts[key] = cmd.replace(/^node\s+/, "node --import deep-trace/node ");
                patched = true; break;
            }
        }
    }
    if (patched) {
        fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2));
        console.log("  Patched script to use --import deep-trace/node");
    } else {
        console.log("  Could not auto-patch scripts. Add manually:");
        console.log("    node --import deep-trace/node your-app.ts");
    }
    '
fi

# 6. Add .debug to .gitignore
if [ -f ".gitignore" ]; then
    if ! grep -q "^\.debug" .gitignore; then
        echo ".debug/" >> .gitignore
        echo_ok "Added .debug/ to .gitignore"
    fi
fi

echo ""
echo_ok "deep-trace installed!"
echo ""
if [ "$TYPE" = "next" ]; then
    echo "  Zero-code setup complete. No imports needed in your components or routes."
    echo ""
    echo "  Created files:"
    echo "    - instrumentation.ts        (server-side OTel initialization)"
    echo "    - instrumentation-client.ts  (browser-side: telemetry + bippy + fetch patching)"
    echo "    - .babelrc                   (auto-wraps functions and components)"
    echo ""
fi
echo "  Set these env vars before starting your app:"
echo "    OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318"
echo "    OTEL_SERVICE_NAME=my-app"
echo ""
echo "  Spans are written to:"
echo "    - In-memory buffer (queryable at http://localhost:${DEBUG_PROBE_PORT:-43210}/remote-debug/spans)"
echo "    - .debug/traces.jsonl (JSONL file, persistent)"
echo ""
echo "  To query traces:"
echo "    curl http://localhost:${DEBUG_PROBE_PORT:-43210}/remote-debug/traces"
echo "    curl http://localhost:${DEBUG_PROBE_PORT:-43210}/remote-debug/spans?functionName=myFunc"
echo "    curl http://localhost:${DEBUG_PROBE_PORT:-43210}/remote-debug/spans/stats"
echo ""
