#!/usr/bin/env bash
#
# patch-app.sh — Inject deep-trace instrumentation into a Next.js example app.
#
# Usage: bash patch-app.sh <deep-trace-root> <app-dir>
#
# Does:
# 1. Writes .babelrc with deep-trace babel plugin
# 2. Writes instrumentation.ts (server-side)
# 3. Writes instrumentation-client.ts (browser-side)
# 4. Replaces next.config with one that enables externalDir + transpilePackages
# 5. Installs deep-trace + peer deps
#
set -euo pipefail

DEEP_TRACE_ROOT="${1:?Usage: patch-app.sh <deep-trace-root> <app-dir>}"
APP_DIR="${2:?Usage: patch-app.sh <deep-trace-root> <app-dir>}"
APP_NAME=$(basename "$APP_DIR")

echo "==> Patching $APP_NAME in $APP_DIR..."

# 1. Write .babelrc
cat > "$APP_DIR/.babelrc" << 'BABELRC'
{
  "presets": ["next/babel"],
  "plugins": [
    ["deep-trace/babel-plugin", {
      "include": ["/app/", "/pages/", "/components/", "/src/", "/lib/"],
      "exclude": ["/node_modules/", "/.next/"]
    }]
  ]
}
BABELRC

# 2. Write instrumentation.ts (server-side)
# Determine the app directory structure: does it use /app or /src/app?
if [ -d "$APP_DIR/src/app" ]; then
  INSTRUMENTATION_DIR="$APP_DIR/src"
elif [ -d "$APP_DIR/app" ]; then
  INSTRUMENTATION_DIR="$APP_DIR"
else
  # Pages router or flat structure — put in root
  INSTRUMENTATION_DIR="$APP_DIR"
fi

cat > "$INSTRUMENTATION_DIR/instrumentation.ts" << 'INSTR'
export { register } from 'deep-trace/instrumentation';
INSTR

# 3. Write instrumentation-client.ts (browser-side)
cat > "$INSTRUMENTATION_DIR/instrumentation-client.ts" << 'INSTR_CLIENT'
import 'deep-trace/browser';
INSTR_CLIENT

# 4. Replace next.config with a comprehensive config
# Remove any existing config files first
rm -f "$APP_DIR"/next.config.{ts,mjs,js}

cat > "$APP_DIR/next.config.ts" << 'NEXTCFG'
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    externalDir: true,
  },
  // Ensure deep-trace (linked via file:) is transpiled properly
  transpilePackages: ['deep-trace'],
  webpack: (config) => {
    // Resolve symlinks so file: dependencies work correctly
    config.resolve = config.resolve || {};
    config.resolve.symlinks = true;
    return config;
  },
};

export default nextConfig;
NEXTCFG
echo "    Wrote next.config.ts"

# 5. Install dependencies
echo "    Installing deep-trace + peer deps..."
cd "$APP_DIR"

# Use pre-packed tarball if available (from run-all.sh), otherwise pack now
if [ -n "${DEEP_TRACE_TARBALL:-}" ] && [ -f "${DEEP_TRACE_TARBALL}" ]; then
  TARBALL="$DEEP_TRACE_TARBALL"
else
  TARBALL_DIR="$APP_DIR/.deep-trace-pkg"
  mkdir -p "$TARBALL_DIR"
  if [ -z "$(ls "$TARBALL_DIR"/deep-trace-*.tgz 2>/dev/null)" ]; then
    echo "    Packing deep-trace..."
    (cd "$DEEP_TRACE_ROOT" && npm pack --pack-destination "$TARBALL_DIR" 2>/dev/null)
  fi
  TARBALL=$(ls "$TARBALL_DIR"/deep-trace-*.tgz | head -1)
fi

# Add deep-trace from the tarball (proper install, no symlinks)
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.dependencies = pkg.dependencies || {};
  pkg.dependencies['deep-trace'] = 'file:${TARBALL}';

  // Ensure Next.js 15+ for instrumentation support
  if (pkg.dependencies.next && !pkg.dependencies.next.includes('file:')) {
    const major = parseInt(pkg.dependencies.next.replace(/[^0-9]/g, ''));
    if (major < 15) {
      pkg.dependencies.next = '^15.0.0';
    }
  }

  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

npm install --legacy-peer-deps 2>&1 | tail -5

echo "    $APP_NAME patched successfully."
