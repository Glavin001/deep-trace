#!/usr/bin/env bash
#
# run-all.sh — Orchestrator for real-world Next.js app e2e tests.
#
# Single source of truth: runs in Docker, CI, or locally.
# Steps: build tarball → clone → patch → boot all apps → run Playwright → teardown.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEEP_TRACE_ROOT="$(cd "$E2E_DIR/../.." && pwd)"

# Work directory for cloned/patched apps
WORK_DIR="${E2E_REALWORLD_WORK_DIR:-/tmp/deep-trace-e2e-realworld}"
mkdir -p "$WORK_DIR"

# PID file tracking for cleanup
PID_FILE="$WORK_DIR/.server-pids"
> "$PID_FILE"

cleanup() {
  echo ""
  echo "==> Cleaning up..."
  if [ -f "$PID_FILE" ]; then
    while read -r pid; do
      if kill -0 "$pid" 2>/dev/null; then
        echo "    Stopping PID $pid..."
        kill "$pid" 2>/dev/null || true
      fi
    done < "$PID_FILE"
    sleep 2
    while read -r pid; do
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    done < "$PID_FILE"
    rm -f "$PID_FILE"
  fi
  # Also kill by port in case PIDs changed
  for port in 3901 3902 3903 3904 43901 43902 43903 43904; do
    fuser -k "$port/tcp" 2>/dev/null || true
  done
  echo "==> Cleanup complete."
}

trap cleanup EXIT INT TERM

# Read app configs
APP_CONFIGS_DIR="$E2E_DIR/app-configs"
PINNED_VERSIONS="$E2E_DIR/pinned-versions.json"

echo "==========================================="
echo "  Deep-Trace Real-World E2E Tests"
echo "==========================================="
echo ""
echo "Work directory: $WORK_DIR"
echo "Deep-trace root: $DEEP_TRACE_ROOT"
echo ""

# Step 0: Pre-pack deep-trace tarball (once, shared by all apps)
echo "=== Step 0: Pack deep-trace ==="
TARBALL_DIR="$WORK_DIR/.deep-trace-pkg"
mkdir -p "$TARBALL_DIR"
if [ -z "$(ls "$TARBALL_DIR"/deep-trace-*.tgz 2>/dev/null)" ]; then
  echo "    Packing deep-trace into tarball..."
  (cd "$DEEP_TRACE_ROOT" && npm pack --pack-destination "$TARBALL_DIR" 2>/dev/null)
else
  echo "    Tarball already exists, reusing."
fi
export DEEP_TRACE_TARBALL=$(ls "$TARBALL_DIR"/deep-trace-*.tgz | head -1)
echo "    Tarball: $DEEP_TRACE_TARBALL"
echo ""

# Step 1: Clone and extract apps
echo "=== Step 1: Clone & Extract ==="
bash "$SCRIPT_DIR/setup-app.sh" "$DEEP_TRACE_ROOT" "$WORK_DIR"
echo ""

# Step 2: Patch each app with deep-trace
echo "=== Step 2: Patch Apps ==="
EXAMPLES=$(node -e "require('$PINNED_VERSIONS').examples.forEach(e => console.log(e))")
for example in $EXAMPLES; do
  APP_DIR="$WORK_DIR/$example"
  if [ -d "$APP_DIR" ]; then
    bash "$SCRIPT_DIR/patch-app.sh" "$DEEP_TRACE_ROOT" "$APP_DIR"
  else
    echo "WARNING: $APP_DIR not found, skipping"
  fi
done
echo ""

# Step 3: Boot all app servers
echo "=== Step 3: Boot Servers ==="

wait_for_server() {
  local url="$1"
  local name="$2"
  local timeout="${3:-120}"
  local start=$(date +%s)

  while true; do
    local elapsed=$(( $(date +%s) - start ))
    if [ "$elapsed" -ge "$timeout" ]; then
      echo "    TIMEOUT: $name did not start within ${timeout}s"
      return 1
    fi
    if curl -s -f -o /dev/null "$url" 2>/dev/null; then
      echo "    $name is ready (${elapsed}s)"
      return 0
    fi
    sleep 2
  done
}

for example in $EXAMPLES; do
  APP_DIR="$WORK_DIR/$example"
  if [ ! -d "$APP_DIR" ]; then continue; fi

  CONFIG_FILE="$APP_CONFIGS_DIR/$example.json"
  APP_PORT=$(node -e "console.log(require('$CONFIG_FILE').appPort)")
  SPAN_PORT=$(node -e "console.log(require('$CONFIG_FILE').spanCachePort)")

  echo "    Starting $example on port $APP_PORT (span cache: $SPAN_PORT)..."

  # Kill anything on these ports first
  fuser -k "$APP_PORT/tcp" 2>/dev/null || true
  fuser -k "$SPAN_PORT/tcp" 2>/dev/null || true

  # Start the dev server
  cd "$APP_DIR"
  DEBUG_PROBE_PORT="$SPAN_PORT" \
  DEBUG_PROBE_OTLP_ENDPOINT="" \
  DEBUG_PROBE_LOG="false" \
  DEBUG_PROBE_JSONL="false" \
  NODE_ENV="development" \
  NEXT_TELEMETRY_DISABLED=1 \
  npx next dev --port "$APP_PORT" > "$WORK_DIR/$example.log" 2>&1 &
  SERVER_PID=$!
  echo "$SERVER_PID" >> "$PID_FILE"
  cd "$DEEP_TRACE_ROOT"
done

# Wait for all servers and span caches to be ready
echo ""
echo "    Waiting for servers to be ready..."
ALL_READY=true
for example in $EXAMPLES; do
  APP_DIR="$WORK_DIR/$example"
  if [ ! -d "$APP_DIR" ]; then continue; fi

  CONFIG_FILE="$APP_CONFIGS_DIR/$example.json"
  APP_PORT=$(node -e "console.log(require('$CONFIG_FILE').appPort)")
  SPAN_PORT=$(node -e "console.log(require('$CONFIG_FILE').spanCachePort)")

  if ! wait_for_server "http://127.0.0.1:$APP_PORT" "$example (app)" 120; then
    ALL_READY=false
    echo "    Server logs for $example:"
    tail -20 "$WORK_DIR/$example.log" 2>/dev/null || true
    continue
  fi
  if ! wait_for_server "http://127.0.0.1:$SPAN_PORT/remote-debug/spans/stats" "$example (span cache)" 60; then
    ALL_READY=false
    echo "    Span cache logs for $example:"
    tail -20 "$WORK_DIR/$example.log" 2>/dev/null || true
    continue
  fi
done

if [ "$ALL_READY" = false ]; then
  echo ""
  echo "WARNING: Not all servers started. Some tests may fail."
fi

echo ""
echo "=== Step 4: Run Playwright Tests ==="
echo ""

# Run Playwright from the deep-trace root (so it can find node_modules)
cd "$DEEP_TRACE_ROOT"
# Find a working Chromium executable for Playwright
if [ -z "${PLAYWRIGHT_CHROMIUM_PATH:-}" ]; then
  # Try to find installed Chromium browsers
  for chromium_dir in /root/.cache/ms-playwright/chromium-*/; do
    if [ -f "$chromium_dir/chrome-linux/chrome" ]; then
      export PLAYWRIGHT_CHROMIUM_PATH="$chromium_dir/chrome-linux/chrome"
      echo "    Using Chromium: $PLAYWRIGHT_CHROMIUM_PATH"
      break
    fi
    if [ -f "$chromium_dir/chrome-linux64/chrome" ]; then
      export PLAYWRIGHT_CHROMIUM_PATH="$chromium_dir/chrome-linux64/chrome"
      echo "    Using Chromium: $PLAYWRIGHT_CHROMIUM_PATH"
      break
    fi
  done
fi

npx playwright test --config tests/e2e-realworld/playwright.config.ts
TEST_EXIT=$?

echo ""
if [ $TEST_EXIT -eq 0 ]; then
  echo "=== ALL TESTS PASSED ==="
else
  echo "=== SOME TESTS FAILED (exit code: $TEST_EXIT) ==="
  echo ""
  echo "Server logs are in $WORK_DIR/*.log"
fi

exit $TEST_EXIT
