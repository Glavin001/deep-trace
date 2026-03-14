#!/usr/bin/env npx tsx
/**
 * DeepTrace Debugging Scenarios Demo
 *
 * This script demonstrates how DeepTrace's enrichment engine answers critical
 * debugging questions using only the recorded trace data. Each scenario generates
 * realistic trace data, runs it through the enrichment pipeline, and shows
 * how a developer (or AI agent) would extract the root cause.
 *
 * Run: npx tsx demos/deeptrace-demo/debugging-scenarios.ts
 */

// Import from compiled output (CommonJS)
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
  buildExecutionGraph,
  buildTraceSummary,
  compareTraces,
  extractValueSnapshots,
} = require('../../dist/deeptrace/enrichment');
type RawSpan = any;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BASE = Date.parse('2026-01-15T10:30:00Z');
let spanCounter = 0;

function makeSpan(overrides: Partial<RawSpan> & { name: string; spanId: string }): RawSpan {
  return {
    traceId: 'demo-trace',
    parentSpanId: undefined,
    serviceName: 'demo-service',
    kind: 'SPAN_KIND_INTERNAL',
    durationMs: 10,
    statusCode: 'STATUS_CODE_OK',
    statusMessage: '',
    timestamp: '2026-01-15 10:30:00.000',
    startTimeMs: BASE,
    endTimeMs: BASE + 10,
    attributes: {},
    events: [],
    ...overrides,
  };
}

function header(title: string) {
  console.log('\n' + '═'.repeat(80));
  console.log(`  ${title}`);
  console.log('═'.repeat(80));
}

function section(label: string) {
  console.log(`\n  ── ${label} ${'─'.repeat(60 - label.length)}`);
}

function finding(emoji: string, text: string) {
  console.log(`  ${emoji} ${text}`);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SCENARIO A: "Why is checkout so slow for some users?"
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function scenarioA() {
  header('SCENARIO A: "Why is checkout so slow for some users?"');
  console.log('  Context: P95 latency jumped from 200ms to 3s after last deploy.');
  console.log('  Hypothesis: Something in the checkout flow is making too many calls.');

  const spans: RawSpan[] = [
    makeSpan({
      traceId: 'slow-checkout',
      spanId: 'handler',
      name: 'POST /api/checkout',
      serviceName: 'checkout-service',
      kind: 'SPAN_KIND_SERVER',
      durationMs: 2800,
      startTimeMs: BASE,
      endTimeMs: BASE + 2800,
      attributes: { 'http.method': 'POST', 'code.filepath': 'routes/checkout.ts', 'code.lineno': 15 },
    }),
    ...Array.from({ length: 8 }, (_, i) => makeSpan({
      traceId: 'slow-checkout',
      spanId: `inventory-${i}`,
      parentSpanId: 'handler',
      name: 'checkInventory',
      serviceName: 'checkout-service',
      durationMs: 300,
      startTimeMs: BASE + 50 + i * 340,
      endTimeMs: BASE + 50 + i * 340 + 300,
      attributes: {
        'function.name': 'checkInventory',
        'function.args.0': `"SKU-${1000 + i}"`,
        'http.method': 'GET',
        'http.url': `http://inventory:8080/check/SKU-${1000 + i}`,
        'code.filepath': 'services/inventory-client.ts',
        'code.lineno': 42,
      },
    })),
  ];

  const graph = buildExecutionGraph(spans);
  const summary = buildTraceSummary(spans, graph);

  section('Trace Summary');
  finding('🕐', `Total duration: ${summary.durationMs}ms`);
  finding('📊', `Span count: ${summary.spanCount}`);
  finding('🌐', `Network requests: ${summary.networkRequests}`);
  finding('⚠️', `Suspiciousness: ${summary.suspiciousnessScore}/100`);

  section('Root Cause Analysis');
  const httpNodes = graph.nodes.filter(n => n.type === 'network_request' && n.name === 'checkInventory');
  finding('🔍', `Found ${httpNodes.length} sequential HTTP calls to inventory service`);
  finding('📁', `All originate from: ${httpNodes[0].sourceLocation?.filePath}:${httpNodes[0].sourceLocation?.line}`);
  finding('💡', 'FIX: Batch inventory checks into a single request, or parallelize them.');

  const totalInventoryTime = httpNodes.reduce((sum, n) => sum + n.durationMs, 0);
  finding('⏱️', `Time wasted on serial calls: ${totalInventoryTime}ms (${Math.round(totalInventoryTime / summary.durationMs * 100)}% of total)`);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SCENARIO B: "User updated their email but it still shows the old one"
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function scenarioB() {
  header('SCENARIO B: "User updated email but it shows the old one"');
  console.log('  Context: User changed email to new@example.com but the');
  console.log('  profile page still shows old@example.com.');

  const spans: RawSpan[] = [
    makeSpan({
      traceId: 'stale-email',
      spanId: 'update-handler',
      name: 'PUT /api/user/email',
      serviceName: 'user-service',
      durationMs: 120,
      startTimeMs: BASE,
      endTimeMs: BASE + 120,
      attributes: {
        'http.method': 'PUT',
        'function.name': 'updateEmail',
        'function.args.0': '{"userId":"u-42","newEmail":"new@example.com"}',
        'function.return.value': '{"success":true}',
        'code.filepath': 'routes/user.ts',
        'code.lineno': 55,
      },
    }),
    makeSpan({
      traceId: 'stale-email',
      spanId: 'cache-write',
      parentSpanId: 'update-handler',
      name: 'SET user:u-42',
      serviceName: 'user-service',
      durationMs: 3,
      startTimeMs: BASE + 5,
      endTimeMs: BASE + 8,
      attributes: {
        'db.system': 'redis',
        'db.statement': 'SET user:u-42',
        'function.name': 'cacheUser',
        'function.args.0': '{"userId":"u-42","email":"old@example.com"}',
        'code.filepath': 'services/cache.ts',
        'code.lineno': 22,
      },
    }),
    makeSpan({
      traceId: 'stale-email',
      spanId: 'db-write',
      parentSpanId: 'update-handler',
      name: 'UPDATE users SET email = ?',
      serviceName: 'user-service',
      durationMs: 90,
      startTimeMs: BASE + 15,
      endTimeMs: BASE + 105,
      attributes: {
        'db.system': 'postgresql',
        'db.statement': "UPDATE users SET email = 'new@example.com' WHERE id = 'u-42'",
        'function.name': 'updateUserEmail',
        'function.args.0': '{"userId":"u-42","email":"new@example.com"}',
        'code.filepath': 'services/user-repo.ts',
        'code.lineno': 78,
      },
    }),
  ];

  const graph = buildExecutionGraph(spans);
  const summary = buildTraceSummary(spans, graph);
  const values = extractValueSnapshots(spans);

  section('Trace Summary');
  finding('✅', `Handler returned success: ${summary.errorCount} errors`);
  finding('📊', `${summary.dbQueries} DB operations detected`);

  section('Value Flow Analysis');
  const cacheArg = values.find(v => v.spanId === 'cache-write' && v.name === 'arg0');
  const dbArg = values.find(v => v.spanId === 'db-write' && v.name === 'arg0');

  finding('💾', `Cache write: ${cacheArg?.preview}`);
  finding('🗄️', `DB write: ${dbArg?.preview}`);

  section('Root Cause');
  finding('🐛', 'Cache was written BEFORE the DB update, with the OLD email!');
  finding('⏱️', `Cache write: t+5ms to t+8ms | DB write: t+15ms to t+105ms`);
  finding('💡', 'FIX: Either write cache after DB, invalidate cache instead, or use write-through pattern.');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SCENARIO C: "After deploy, some orders fail with 'limit exceeded'"
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function scenarioC() {
  header('SCENARIO C: Regression — "limit exceeded" after deploy');
  console.log('  Context: A new deploy added quantity limit checking but the');
  console.log('  limits table is empty, causing all orders to fail.');

  const goodSpans: RawSpan[] = [
    makeSpan({
      traceId: 'pre-deploy',
      spanId: 'g-handler',
      name: 'POST /api/checkout',
      serviceName: 'checkout-service',
      kind: 'SPAN_KIND_SERVER',
      durationMs: 180,
      startTimeMs: BASE,
      endTimeMs: BASE + 180,
      attributes: {
        'http.method': 'POST',
        'function.return.value': '{"orderId":"ord-1","status":"confirmed"}',
      },
    }),
    makeSpan({
      traceId: 'pre-deploy',
      spanId: 'g-validate',
      parentSpanId: 'g-handler',
      name: 'validateCart',
      serviceName: 'checkout-service',
      durationMs: 20,
      startTimeMs: BASE + 5,
      endTimeMs: BASE + 25,
      attributes: { 'function.return.value': '{"valid":true}' },
    }),
    makeSpan({
      traceId: 'pre-deploy',
      spanId: 'g-charge',
      parentSpanId: 'g-handler',
      name: 'chargePayment',
      serviceName: 'checkout-service',
      durationMs: 140,
      startTimeMs: BASE + 30,
      endTimeMs: BASE + 170,
      attributes: { 'function.return.value': '{"charged":true}' },
    }),
  ];

  const badSpans: RawSpan[] = [
    makeSpan({
      traceId: 'post-deploy',
      spanId: 'b-handler',
      name: 'POST /api/checkout',
      serviceName: 'checkout-service',
      kind: 'SPAN_KIND_SERVER',
      durationMs: 30,
      statusCode: 'STATUS_CODE_ERROR',
      startTimeMs: BASE,
      endTimeMs: BASE + 30,
      attributes: {
        'http.method': 'POST',
        'function.return.value': '{"error":"quantity limit exceeded"}',
      },
    }),
    makeSpan({
      traceId: 'post-deploy',
      spanId: 'b-validate',
      parentSpanId: 'b-handler',
      name: 'validateCart',
      serviceName: 'checkout-service',
      durationMs: 8,
      startTimeMs: BASE + 5,
      endTimeMs: BASE + 13,
      attributes: { 'function.return.value': '{"valid":true}' },
    }),
    makeSpan({
      traceId: 'post-deploy',
      spanId: 'b-limit-check',
      parentSpanId: 'b-handler',
      name: 'checkQuantityLimits',
      serviceName: 'checkout-service',
      durationMs: 5,
      statusCode: 'STATUS_CODE_ERROR',
      startTimeMs: BASE + 15,
      endTimeMs: BASE + 20,
      attributes: {
        'function.return.value': '{"valid":false,"reason":"limit not configured, defaulting to 0"}',
        'code.filepath': 'services/quantity-limits.ts',
        'code.lineno': 12,
      },
      events: [{
        name: 'exception',
        attributes: {
          'exception.type': 'QuantityLimitError',
          'exception.message': 'Quantity limit for SKU-100 is 0 (not configured)',
        },
      }],
    }),
  ];

  const diff = compareTraces(goodSpans, badSpans);

  section('Trace Comparison Results');
  finding('📋', `Summary: ${diff.summary}`);
  finding('🔢', `Total divergences: ${diff.divergences.length}`);

  if (diff.firstDivergence) {
    section('First Divergence (most critical)');
    finding('🚨', `[${diff.firstDivergence.severity.toUpperCase()}] ${diff.firstDivergence.description}`);
    if (diff.firstDivergence.goodValue) finding('✅', `Good: ${diff.firstDivergence.goodValue}`);
    if (diff.firstDivergence.badValue) finding('❌', `Bad: ${diff.firstDivergence.badValue}`);
  }

  section('All Divergences');
  for (const d of diff.divergences) {
    const icon = d.severity === 'critical' ? '🔴' : d.severity === 'warning' ? '🟡' : '🔵';
    finding(icon, `[${d.type}] ${d.description}`);
  }

  section('Root Cause');
  finding('🐛', 'New span "checkQuantityLimits" appeared in bad trace (not in good)');
  finding('🐛', '"chargePayment" is missing from bad trace (never reached)');
  finding('💡', 'FIX: The quantity limits table needs to be populated, or default to "unlimited".');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SCENARIO D: "Payments are being charged but order confirmation email never arrives"
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function scenarioD() {
  header('SCENARIO D: "Payment charged but confirmation email never arrives"');
  console.log('  Context: Customer support reports users are charged but');
  console.log('  never receive their order confirmation email.');

  const spans: RawSpan[] = [
    makeSpan({
      traceId: 'lost-email',
      spanId: 'checkout',
      name: 'POST /api/checkout',
      serviceName: 'checkout-service',
      durationMs: 250,
      startTimeMs: BASE,
      endTimeMs: BASE + 250,
      attributes: {
        'http.method': 'POST',
        'function.return.value': '{"orderId":"ord-555","status":"confirmed"}',
        'code.filepath': 'routes/checkout.ts',
        'code.lineno': 20,
      },
    }),
    makeSpan({
      traceId: 'lost-email',
      spanId: 'payment',
      parentSpanId: 'checkout',
      name: 'chargePayment',
      serviceName: 'checkout-service',
      durationMs: 150,
      startTimeMs: BASE + 10,
      endTimeMs: BASE + 160,
      attributes: {
        'function.name': 'chargePayment',
        'function.return.value': '{"charged":true,"transactionId":"txn-abc"}',
        'code.filepath': 'services/payment.ts',
        'code.lineno': 30,
      },
    }),
    makeSpan({
      traceId: 'lost-email',
      spanId: 'email-publish',
      parentSpanId: 'checkout',
      name: 'publishEmailEvent',
      serviceName: 'checkout-service',
      durationMs: 5,
      startTimeMs: BASE + 170,
      endTimeMs: BASE + 175,
      attributes: {
        'messaging.system': 'rabbitmq',
        'function.name': 'publishEmailEvent',
        'function.args.0': '{"queue":"emails","orderId":"ord-555","to":"user@example.com"}',
        'function.return.value': '{"published":true}',
        'code.filepath': 'services/events.ts',
        'code.lineno': 15,
      },
    }),
    // The email consumer received the event but failed
    makeSpan({
      traceId: 'lost-email',
      spanId: 'email-consumer',
      parentSpanId: 'email-publish',
      name: 'consumeEmailEvent',
      serviceName: 'email-service',
      durationMs: 20,
      statusCode: 'STATUS_CODE_ERROR',
      statusMessage: 'Template not found: order_confirmation_v2',
      startTimeMs: BASE + 200,
      endTimeMs: BASE + 220,
      attributes: {
        'messaging.system': 'rabbitmq',
        'function.name': 'sendOrderEmail',
        'function.args.0': '{"orderId":"ord-555","template":"order_confirmation_v2"}',
        'code.filepath': 'email/sender.ts',
        'code.lineno': 45,
      },
      events: [{
        name: 'exception',
        attributes: {
          'exception.type': 'TemplateNotFoundError',
          'exception.message': 'Email template "order_confirmation_v2" does not exist. Available: order_confirmation_v1',
          'exception.stacktrace': 'at loadTemplate (email/templates.ts:12)\n  at sendOrderEmail (email/sender.ts:50)',
        },
      }],
    }),
  ];

  const graph = buildExecutionGraph(spans);
  const summary = buildTraceSummary(spans, graph);
  const values = extractValueSnapshots(spans);

  section('Trace Summary');
  finding('🕐', `Duration: ${summary.durationMs}ms`);
  finding('📊', `Spans: ${summary.spanCount} | Errors: ${summary.errorCount} | Exceptions: ${summary.exceptionCount}`);
  finding('📬', `Message jobs: ${graph.nodes.filter(n => n.type === 'message_job').length}`);

  section('Request Path');
  for (const step of summary.requestPath) {
    const icon = step.status === 'error' ? '❌' : '✅';
    finding(icon, `${step.index}. ${step.name} (${step.serviceName}) — ${step.durationMs}ms [${step.status}]`);
  }

  section('Exception Details');
  for (const exc of summary.exceptions) {
    finding('💥', `${exc.type}: ${exc.message}`);
    finding('📁', `  in ${exc.spanName} (${exc.serviceName})`);
    if (exc.sourceLocation) finding('📍', `  at ${exc.sourceLocation.filePath}:${exc.sourceLocation.line}`);
  }

  section('Root Cause');
  finding('🐛', 'Email service references template "order_confirmation_v2" which doesn\'t exist');
  finding('🐛', 'Available template is "order_confirmation_v1" — likely a deploy mismatch');
  finding('💡', 'FIX: Deploy the new email template, or update the code to use v1.');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// RUN ALL SCENARIOS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

console.log('\n🔍 DeepTrace Debugging Scenarios Demo');
console.log('────────────────────────────────────────────────────────────────');
console.log('Each scenario demonstrates how DeepTrace\'s recorded trace data');
console.log('answers a critical debugging question.\n');

scenarioA();
scenarioB();
scenarioC();
scenarioD();

console.log('\n' + '═'.repeat(80));
console.log('  Demo complete. All 4 scenarios analyzed using only trace data.');
console.log('  No breakpoints. No log grepping. No "works on my machine."');
console.log('═'.repeat(80) + '\n');
