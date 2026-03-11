#!/usr/bin/env bash
# -----------------------------------------------------------------------
# agent-browser e2e tests for deep-trace local stack.
#
# Uses agent-browser (https://agent-browser.dev/) for browser automation
# instead of Playwright. This is useful for AI-agent-driven testing where
# token-efficient DOM snapshots and ref-based selectors are preferred.
#
# Prerequisites:
#   npm run stack:up        — ClickHouse, OTEL Collector, Grafana
#   npm run demo:next:dev   — Next.js demo on :3000
#   npx agent-browser --version  — agent-browser CLI installed
#
# Usage:
#   bash e2e/agent-browser-e2e.sh
#   DEMO_URL=http://localhost:3000 GRAFANA_URL=http://localhost:3002 bash e2e/agent-browser-e2e.sh
# -----------------------------------------------------------------------
set -euo pipefail

DEMO_URL="${DEMO_URL:-http://127.0.0.1:3000}"
GRAFANA_URL="${GRAFANA_URL:-http://127.0.0.1:3002}"
CLICKHOUSE_URL="${CLICKHOUSE_URL:-http://127.0.0.1:8123}"

AB="npx agent-browser"
PASSED=0
FAILED=0

pass() { echo "  ✓ $1"; PASSED=$((PASSED + 1)); }
fail() { echo "  ✗ $1: $2"; FAILED=$((FAILED + 1)); }

echo "=== agent-browser e2e tests ==="
echo "Demo: $DEMO_URL | Grafana: $GRAFANA_URL | ClickHouse: $CLICKHOUSE_URL"
echo ""

# -----------------------------------------------------------------------
# Test 1: Demo app — emit a trace via the UI
# -----------------------------------------------------------------------
echo "--- Test 1: Demo app emits a trace ---"

$AB open "$DEMO_URL" && $AB wait --load networkidle

# Snapshot to find interactive elements
SNAPSHOT=$($AB snapshot -i)
echo "$SNAPSHOT"

# Fill the input and click emit
$AB fill '@input[placeholder*="Describe"]' "agent-browser e2e test" 2>/dev/null || \
  $AB fill "$(echo "$SNAPSHOT" | grep -oP '@e\d+' | head -1)" "agent-browser e2e test"

# Take annotated screenshot for debugging
$AB screenshot --annotate /tmp/demo-before-emit.png 2>/dev/null || true

# Click the emit button
$AB click "$(echo "$SNAPSHOT" | grep -i 'emit' | grep -oP '@e\d+' | head -1)" || \
  $AB click '@button:has-text("Emit")'

# Wait for the trace to be stored
sleep 5
SNAPSHOT2=$($AB snapshot -i)

if echo "$SNAPSHOT2" | grep -qi "trace stored\|trace.id\|[0-9a-f]\{32\}"; then
  pass "Demo app emitted a trace"
else
  fail "Demo app trace emission" "Could not confirm trace was stored"
fi

# -----------------------------------------------------------------------
# Test 2: Grafana dashboard — shows recent spans
# -----------------------------------------------------------------------
echo ""
echo "--- Test 2: Grafana dashboard shows span rows ---"

$AB open "$GRAFANA_URL/d/deep-trace-overview/deep-trace-overview" && \
  $AB wait --load networkidle

# Wait for dashboard to fully render
sleep 3
SNAPSHOT=$($AB snapshot -i)
echo "$SNAPSHOT"

$AB screenshot --annotate /tmp/grafana-dashboard.png 2>/dev/null || true

if echo "$SNAPSHOT" | grep -qi "recent trace spans\|seed-api\|next-fullstack"; then
  pass "Grafana dashboard loaded with span data"
else
  fail "Grafana dashboard" "Could not find span data in dashboard"
fi

# -----------------------------------------------------------------------
# Test 3: Full pipeline — emit trace, verify in Grafana Explore
# -----------------------------------------------------------------------
echo ""
echo "--- Test 3: Trace waterfall in Grafana Explore ---"

# Emit a trace via the API
TRACE_RESPONSE=$(curl -s "$DEMO_URL/api/demo?term=agent-browser-e2e" \
  -H "x-demo-source: agent-browser-e2e")
TRACE_ID=$(echo "$TRACE_RESPONSE" | grep -oP '"traceId"\s*:\s*"([0-9a-f]{32})"' | grep -oP '[0-9a-f]{32}')

if [ -z "$TRACE_ID" ]; then
  fail "Trace emission via API" "No trace ID returned"
else
  echo "  Trace ID: $TRACE_ID"

  # Wait for trace to land in ClickHouse
  echo "  Waiting for trace in ClickHouse..."
  for i in $(seq 1 30); do
    COUNT=$(curl -s "$CLICKHOUSE_URL/?database=otel" \
      -u otel:otel \
      -d "SELECT count() AS cnt FROM otel_traces WHERE TraceId = '$TRACE_ID' FORMAT JSONEachRow" | \
      grep -oP '"cnt":(\d+)' | grep -oP '\d+' || echo "0")
    if [ "$COUNT" -ge 3 ] 2>/dev/null; then
      echo "  Found $COUNT spans in ClickHouse"
      break
    fi
    sleep 2
  done

  # Open Grafana Explore
  $AB open "$GRAFANA_URL/explore" && $AB wait --load networkidle
  sleep 2

  # Snapshot to find query type selectors
  SNAPSHOT=$($AB snapshot -i)
  echo "$SNAPSHOT"

  # Click "Traces" query type radio
  TRACES_REF=$(echo "$SNAPSHOT" | grep -i 'traces' | grep -oP '@e\d+' | head -1)
  if [ -n "$TRACES_REF" ]; then
    $AB click "$TRACES_REF"
    sleep 1
  fi

  # Re-snapshot after switching to Traces mode
  SNAPSHOT=$($AB snapshot -i)

  # Click "Trace ID" radio
  TRACEID_REF=$(echo "$SNAPSHOT" | grep -i 'trace.id\|traceid\|option-true' | grep -oP '@e\d+' | head -1)
  if [ -n "$TRACEID_REF" ]; then
    $AB click "$TRACEID_REF"
    sleep 1
  fi

  # Re-snapshot to find trace ID input
  SNAPSHOT=$($AB snapshot -i)

  # Fill trace ID input
  INPUT_REF=$(echo "$SNAPSHOT" | grep -i 'trace.*id.*input\|query-builder' | grep -oP '@e\d+' | head -1)
  if [ -n "$INPUT_REF" ]; then
    $AB fill "$INPUT_REF" "$TRACE_ID"
  fi

  # Click Run Query
  SNAPSHOT=$($AB snapshot -i)
  RUN_REF=$(echo "$SNAPSHOT" | grep -i 'run.query' | grep -oP '@e\d+' | head -1)
  if [ -n "$RUN_REF" ]; then
    $AB click "$RUN_REF"
  fi

  # Wait for results and verify
  sleep 5
  SNAPSHOT=$($AB snapshot -i)
  $AB screenshot --annotate /tmp/grafana-waterfall.png 2>/dev/null || true

  if echo "$SNAPSHOT" | grep -qi "demo.lookupRecommendation\|demo.buildNarrative\|demo.api"; then
    pass "Grafana Explore shows trace waterfall"
  else
    fail "Grafana Explore waterfall" "Could not find expected span names"
  fi
fi

# -----------------------------------------------------------------------
# Test 4: Trace Search in Grafana Explore
# -----------------------------------------------------------------------
echo ""
echo "--- Test 4: Grafana Explore Trace Search ---"

$AB open "$GRAFANA_URL/explore" && $AB wait --load networkidle
sleep 2

SNAPSHOT=$($AB snapshot -i)

# Click "Traces" query type
TRACES_REF=$(echo "$SNAPSHOT" | grep -i 'traces' | grep -oP '@e\d+' | head -1)
if [ -n "$TRACES_REF" ]; then
  $AB click "$TRACES_REF"
  sleep 1
fi

# Default mode is Trace Search — click Run Query
SNAPSHOT=$($AB snapshot -i)
RUN_REF=$(echo "$SNAPSHOT" | grep -i 'run.query' | grep -oP '@e\d+' | head -1)
if [ -n "$RUN_REF" ]; then
  $AB click "$RUN_REF"
fi

sleep 5
SNAPSHOT=$($AB snapshot -i)
$AB screenshot --annotate /tmp/grafana-search.png 2>/dev/null || true

if [ -n "$TRACE_ID" ] && echo "$SNAPSHOT" | grep -qi "$TRACE_ID"; then
  pass "Grafana Trace Search found the trace"
else
  fail "Grafana Trace Search" "Trace ID not visible in search results"
fi

# -----------------------------------------------------------------------
# Cleanup & Summary
# -----------------------------------------------------------------------
echo ""
$AB close 2>/dev/null || true

echo "=== Results: $PASSED passed, $FAILED failed ==="
if [ "$FAILED" -gt 0 ]; then
  echo "Screenshots saved to /tmp/demo-before-emit.png, /tmp/grafana-*.png"
  exit 1
fi
exit 0
