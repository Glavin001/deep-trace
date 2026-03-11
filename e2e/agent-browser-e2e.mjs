#!/usr/bin/env node
/**
 * agent-browser e2e tests for deep-trace local stack.
 *
 * Uses agent-browser CLI (https://agent-browser.dev/) for browser automation.
 * This is designed for AI-agent-driven testing workflows where token-efficient
 * DOM snapshots and ref-based element selectors are preferred over full DOM queries.
 *
 * Prerequisites:
 *   npm run stack:up        — ClickHouse, OTEL Collector, Grafana
 *   npm run demo:next:dev   — Next.js demo on :3000
 *   npx agent-browser --version  — agent-browser CLI available
 *
 * Run:
 *   node e2e/agent-browser-e2e.mjs
 */
import { execSync } from 'node:child_process';

const DEMO_URL = process.env.DEMO_URL ?? 'http://127.0.0.1:3000';
const GRAFANA_URL = process.env.GRAFANA_URL ?? 'http://127.0.0.1:3002';
const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? 'http://127.0.0.1:8123';

let passed = 0;
let failed = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ab(cmd) {
  try {
    const result = execSync(`npx agent-browser ${cmd}`, {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch (err) {
    return err.stdout?.trim() ?? err.message;
  }
}

function sleep(ms) {
  execSync(`sleep ${ms / 1000}`);
}

/** Extract ref like @e1 from a snapshot line matching a pattern */
function findRef(snapshot, pattern) {
  const regex = new RegExp(pattern, 'i');
  for (const line of snapshot.split('\n')) {
    if (regex.test(line)) {
      const refMatch = line.match(/@e\d+/);
      if (refMatch) return refMatch[0];
    }
  }
  return null;
}

function pass(name) {
  console.log(`  ✓ ${name}`);
  passed++;
}

function fail(name, reason) {
  console.log(`  ✗ ${name}: ${reason}`);
  failed++;
}

async function waitForTrace(traceId, minSpans = 3, timeoutMs = 45_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${CLICKHOUSE_URL}/?database=otel`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from('otel:otel').toString('base64')}`,
          'content-type': 'text/plain',
        },
        body: `SELECT count() AS cnt FROM otel_traces WHERE TraceId = '${traceId}' FORMAT JSONEachRow`,
      });
      const text = await res.text();
      const match = text.match(/"cnt":(\d+)/) || text.match(/"cnt":"(\d+)"/);
      if (match && parseInt(match[1], 10) >= minSpans) return;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`Trace ${traceId} did not appear in ClickHouse within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
console.log('=== agent-browser e2e tests ===');
console.log(`Demo: ${DEMO_URL} | Grafana: ${GRAFANA_URL} | ClickHouse: ${CLICKHOUSE_URL}\n`);

// --- Test 1: Demo app ---
console.log('--- Test 1: Demo app emits a trace ---');
ab(`open "${DEMO_URL}"`);
ab('wait --load networkidle');

let snap = ab('snapshot -i');
let inputRef = findRef(snap, 'describe|input|textbox');
if (inputRef) {
  ab(`fill ${inputRef} "agent-browser e2e test"`);
}

// Re-snapshot after fill to find the button
snap = ab('snapshot -i');
let emitRef = findRef(snap, 'emit');
if (emitRef) {
  ab(`click ${emitRef}`);
}

sleep(5000);
snap = ab('snapshot -i');
ab('screenshot --annotate /tmp/ab-demo.png');

if (/trace.stored|[0-9a-f]{32}/i.test(snap)) {
  pass('Demo app emitted a trace');
} else {
  fail('Demo app trace emission', 'Could not confirm trace was stored');
}

// --- Test 2: Grafana dashboard ---
console.log('\n--- Test 2: Grafana dashboard shows span rows ---');
ab(`open "${GRAFANA_URL}/d/deep-trace-overview/deep-trace-overview"`);
ab('wait --load networkidle');
sleep(5000);

snap = ab('snapshot -i');
ab('screenshot --annotate /tmp/ab-dashboard.png');

if (/recent.trace.spans|seed-api|next-fullstack/i.test(snap)) {
  pass('Grafana dashboard loaded with span data');
} else {
  fail('Grafana dashboard', 'Could not find span data in dashboard');
}

// --- Test 3: Full pipeline - trace waterfall ---
console.log('\n--- Test 3: Trace waterfall in Grafana Explore ---');

let traceId;
try {
  const res = await fetch(`${DEMO_URL}/api/demo?term=agent-browser-e2e`, {
    headers: { 'x-demo-source': 'agent-browser-e2e' },
  });
  const json = await res.json();
  traceId = json.traceId;
  console.log(`  Trace ID: ${traceId}`);

  await waitForTrace(traceId, 3, 45_000);
  console.log('  Trace landed in ClickHouse');

  ab(`open "${GRAFANA_URL}/explore"`);
  ab('wait --load networkidle');
  sleep(2000);

  // Switch to Traces query type
  snap = ab('snapshot -i');
  let tracesRef = findRef(snap, 'traces');
  if (tracesRef) {
    ab(`click ${tracesRef}`);
    sleep(1000);
  }

  // Switch to Trace ID mode
  snap = ab('snapshot -i');
  let traceIdModeRef = findRef(snap, 'trace.id|option-true');
  if (traceIdModeRef) {
    ab(`click ${traceIdModeRef}`);
    sleep(1000);
  }

  // Remove default filters
  snap = ab('snapshot -i');
  let removeRef = findRef(snap, 'remove|filter.*remove');
  while (removeRef) {
    ab(`click ${removeRef}`);
    sleep(500);
    snap = ab('snapshot -i');
    removeRef = findRef(snap, 'remove|filter.*remove');
  }

  // Fill trace ID
  snap = ab('snapshot -i');
  let traceInput = findRef(snap, 'trace.*id.*input|query-builder.*input');
  if (traceInput) {
    ab(`fill ${traceInput} "${traceId}"`);
  }

  // Run query
  snap = ab('snapshot -i');
  let runRef = findRef(snap, 'run.query');
  if (runRef) {
    ab(`click ${runRef}`);
  }

  sleep(8000);
  snap = ab('snapshot -i');
  ab('screenshot --annotate /tmp/ab-waterfall.png');

  if (/demo\.lookupRecommendation|demo\.buildNarrative|demo\.api/i.test(snap)) {
    pass('Grafana Explore shows trace waterfall');
  } else {
    fail('Grafana Explore waterfall', 'Could not find expected span names');
  }
} catch (err) {
  fail('Trace pipeline', err.message);
}

// --- Test 4: Trace Search ---
console.log('\n--- Test 4: Grafana Explore Trace Search ---');
ab(`open "${GRAFANA_URL}/explore"`);
ab('wait --load networkidle');
sleep(2000);

snap = ab('snapshot -i');
let tracesRef = findRef(snap, 'traces');
if (tracesRef) {
  ab(`click ${tracesRef}`);
  sleep(1000);
}

// Default is Trace Search — run query
snap = ab('snapshot -i');
let runRef = findRef(snap, 'run.query');
if (runRef) {
  ab(`click ${runRef}`);
}

sleep(8000);
snap = ab('snapshot -i');
ab('screenshot --annotate /tmp/ab-search.png');

if (traceId && snap.includes(traceId)) {
  pass('Grafana Trace Search found the trace');
} else {
  fail('Grafana Trace Search', 'Trace ID not visible in search results');
}

// --- Cleanup ---
ab('close');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log('Screenshots saved to /tmp/ab-*.png');
  process.exit(1);
}
