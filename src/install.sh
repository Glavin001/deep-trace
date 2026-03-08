#!/bin/bash
# install.sh — Install the local debug probe into a Node.js/TypeScript/Next.js project
#
# Usage:
#   cd your-project
#   bash /path/to/install.sh
#
# What it does:
#   1. Detects project type (Next.js, TypeScript, JavaScript)
#   2. Copies instrumentation files to the right location
#   3. Installs OpenTelemetry + Express dependencies
#   4. Configures tsconfig paths and package.json scripts
#
# Environment:
#   DEBUG_PROBE_PORT=43210     — HTTP API port (default: 43210)
#   DEBUG_PROBE_JSONL=true     — Enable JSONL file output (default: true)
#   DEBUG_PROBE_DIR=.debug     — Output directory (default: .debug)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

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

# 3. Determine target directory
TARGET="."
[ -d "src" ] && TARGET="src"
echo_step "Target: $TARGET/"

# 4. Copy files
echo_step "Copying probe files..."
cp "$SCRIPT_DIR/instrumentation.node.ts" "$TARGET/instrumentation.node.ts"
cp "$SCRIPT_DIR/probe-wrapper.ts" "$TARGET/probe-wrapper.ts"

if [ "$TYPE" = "next" ]; then
    cp "$SCRIPT_DIR/instrumentation.ts" "$TARGET/instrumentation.ts"
    cp "$SCRIPT_DIR/babel-plugin-probe.js" "./babel-plugin-probe.js"

    # Create .babelrc if it doesn't exist
    if [ ! -f ".babelrc" ]; then
        cat > .babelrc << 'BABELRC'
{
  "presets": ["next/babel"],
  "plugins": [
    ["./babel-plugin-probe", {
      "include": ["/app/"],
      "exclude": ["/node_modules/", "/.next/", "/instrumentation/", "/probe-wrapper/", "/debug-probe/"]
    }]
  ]
}
BABELRC
        echo_ok "Created .babelrc"
    fi
fi

# 5. Install dependencies
CORE_DEPS=(
    "@opentelemetry/sdk-node"
    "@opentelemetry/api"
    "@opentelemetry/auto-instrumentations-node"
    "@opentelemetry/sdk-metrics"
    "@opentelemetry/sdk-trace-node"
    "@opentelemetry/core"
    "express"
    "ws"
)

echo_step "Installing core dependencies..."
$INSTALL "${CORE_DEPS[@]}"

if [ "$TYPE" = "ts" ] || [ "$TYPE" = "next" ]; then
    echo_step "Installing TypeScript dependencies..."
    $DEV_INSTALL "@types/express" "@types/ws" "@types/node" "tsx"
fi

if [ "$TYPE" = "next" ]; then
    echo_step "Installing Babel dependencies..."
    $DEV_INSTALL "@babel/parser" "@babel/traverse" "magic-string"
fi

# 6. Configure tsconfig paths
if [ "$TYPE" = "ts" ] || [ "$TYPE" = "next" ]; then
    if [ -f "tsconfig.json" ]; then
        echo_step "Adding @/probe-wrapper path alias to tsconfig.json..."
        node -e '
        const fs = require("fs");
        const target = "'$TARGET'";
        const probeWrapper = target === "." ? "./probe-wrapper" : "./" + target + "/probe-wrapper";
        const tsconfig = JSON.parse(fs.readFileSync("tsconfig.json", "utf8"));
        if (!tsconfig.compilerOptions) tsconfig.compilerOptions = {};
        if (!tsconfig.compilerOptions.baseUrl) tsconfig.compilerOptions.baseUrl = ".";
        if (!tsconfig.compilerOptions.paths) tsconfig.compilerOptions.paths = {};
        tsconfig.compilerOptions.paths["@/probe-wrapper"] = [probeWrapper];
        fs.writeFileSync("tsconfig.json", JSON.stringify(tsconfig, null, 2));
        console.log("  Added @/probe-wrapper ->", probeWrapper);
        '
    fi
fi

# 7. Update scripts
echo_step "Updating package.json scripts..."
node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const type = "'$TYPE'";
const target = "'$TARGET'";
const base = target === "." ? "./" : "./" + target + "/";

if (type === "next") {
    if (pkg.scripts?.dev && !pkg.scripts.dev.includes("--webpack")) {
        pkg.scripts.dev = pkg.scripts.dev.replace("next dev", "next dev --webpack");
    }
    if (pkg.scripts?.build && !pkg.scripts.build.includes("--webpack")) {
        pkg.scripts.build = pkg.scripts.build.replace("next build", "next build --webpack");
    }
} else if (type === "ts") {
    const keys = ["dev", "start", "serve"];
    let patched = false;
    for (const key of keys) {
        if (pkg.scripts?.[key] && !pkg.scripts[key].includes("--import")) {
            const cmd = pkg.scripts[key];
            if (cmd.startsWith("tsx ")) {
                pkg.scripts[key] = cmd.replace(/^tsx\s+/, "tsx --import " + base + "instrumentation.node.ts ");
                patched = true; break;
            } else if (cmd.startsWith("node ")) {
                pkg.scripts[key] = cmd.replace(/^node\s+/, "node --import " + base + "instrumentation.node.ts ");
                patched = true; break;
            }
        }
    }
}

fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2));
'

# 8. Add .debug to .gitignore
if [ -f ".gitignore" ]; then
    if ! grep -q "^\.debug" .gitignore; then
        echo ".debug/" >> .gitignore
        echo_ok "Added .debug/ to .gitignore"
    fi
fi

echo ""
echo_ok "Debug probe installed!"
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
