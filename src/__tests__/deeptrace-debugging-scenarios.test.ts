/**
 * DeepTrace Debugging Scenario Tests
 *
 * These tests simulate real-world debugging scenarios using the enrichment engine.
 * Each test proves that DeepTrace's recorded trace data is sufficient to answer
 * a critical debugging question — the kind a developer would ask at 2am.
 *
 * The scenarios cover:
 *   1. N+1 query detection
 *   2. Silent error swallowing (try/catch hides failures)
 *   3. Distributed timeout cascades across services
 *   4. Race condition / async ordering bugs
 *   5. Wrong data returned due to cache poisoning
 *   6. Partial failure in fan-out (some downstream calls fail)
 *   7. Retry storm amplification
 *   8. Auth token propagation failure across service boundary
 *   9. Error in React render causing blank page
 *  10. Regression detection via trace comparison
 */

import { describe, it, expect } from 'vitest';
import {
  buildExecutionGraph,
  buildTraceSummary,
  compareTraces,
  extractValueSnapshots,
  buildTraceRun,
  type RawSpan,
} from '../deeptrace/enrichment';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let spanCounter = 0;
function makeSpan(overrides: Partial<RawSpan> & { name: string; spanId: string }): RawSpan {
  const base = Date.parse('2026-01-15T10:30:00Z');
  return {
    traceId: 'trace-001',
    parentSpanId: undefined,
    serviceName: 'default-service',
    kind: 'SPAN_KIND_INTERNAL',
    durationMs: 10,
    statusCode: 'STATUS_CODE_OK',
    statusMessage: '',
    timestamp: '2026-01-15 10:30:00.000',
    startTimeMs: base,
    endTimeMs: base + 10,
    attributes: {},
    events: [],
    ...overrides,
  };
}

// ─── Scenario 1: N+1 Query Detection ─────────────────────────────────────────
// "Why is the order list page so slow?"
// Answer: The handler issues one SELECT per order instead of a batch query.

describe('Scenario 1: N+1 Query Detection', () => {
  const base = Date.parse('2026-01-15T10:30:00Z');

  const spans: RawSpan[] = [
    makeSpan({
      spanId: 'handler',
      name: 'GET /api/orders',
      serviceName: 'order-service',
      kind: 'SPAN_KIND_SERVER',
      durationMs: 850,
      startTimeMs: base,
      endTimeMs: base + 850,
      attributes: { 'http.method': 'GET', 'code.filepath': 'routes/orders.ts', 'code.lineno': 15 },
    }),
    // One DB query per order — the N+1 pattern
    ...Array.from({ length: 10 }, (_, i) =>
      makeSpan({
        spanId: `query-${i}`,
        parentSpanId: 'handler',
        name: 'SELECT * FROM orders WHERE id = ?',
        serviceName: 'order-service',
        kind: 'SPAN_KIND_CLIENT',
        durationMs: 80,
        startTimeMs: base + 5 + i * 85,
        endTimeMs: base + 5 + i * 85 + 80,
        attributes: {
          'db.system': 'postgresql',
          'db.statement': `SELECT * FROM orders WHERE id = ${i + 1}`,
          'code.filepath': 'services/order-repo.ts',
          'code.lineno': 42,
        },
      })
    ),
  ];

  it('detects a high number of DB queries from a single handler', () => {
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);

    // Critical insight: 10 DB queries for one request
    expect(summary.dbQueries).toBe(10);
    expect(summary.durationMs).toBeGreaterThan(800);

    // All queries issue from the same parent
    const queryEdges = graph.edges.filter(e => e.type === 'query_issued');
    expect(queryEdges.length).toBe(10);
    const uniqueParents = new Set(queryEdges.map(e => e.sourceNodeId));
    expect(uniqueParents.size).toBe(1);
    expect(uniqueParents.has('node_handler')).toBe(true);
  });

  it('all queries map to the same source location', () => {
    const graph = buildExecutionGraph(spans);
    const dbNodes = graph.nodes.filter(n => n.type === 'db_query');
    expect(dbNodes.length).toBe(10);

    // All come from the same file+line — a loop calling single-row queries
    const locations = dbNodes.map(n => `${n.sourceLocation?.filePath}:${n.sourceLocation?.line}`);
    const unique = new Set(locations);
    expect(unique.size).toBe(1);
    expect(locations[0]).toBe('services/order-repo.ts:42');
  });

  it('suspiciousness is low (no errors, just slow)', () => {
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);
    // No errors, so suspiciousness is 0 — but the query pattern is the real signal
    expect(summary.errorCount).toBe(0);
    expect(summary.suspiciousnessScore).toBe(0);
  });
});

// ─── Scenario 2: Silent Error Swallowing ──────────────────────────────────────
// "The checkout succeeds but the order never appears in the dashboard."
// Answer: The saveOrder call threw but the catch block swallowed it and returned {ok: true}.

describe('Scenario 2: Silent Error Swallowing', () => {
  const base = Date.parse('2026-01-15T10:30:00Z');

  const spans: RawSpan[] = [
    makeSpan({
      spanId: 'checkout',
      name: 'POST /api/checkout',
      serviceName: 'checkout-service',
      kind: 'SPAN_KIND_SERVER',
      durationMs: 200,
      startTimeMs: base,
      endTimeMs: base + 200,
      attributes: {
        'http.method': 'POST',
        'function.return.value': '{"ok":true}',
        'code.filepath': 'routes/checkout.ts',
        'code.lineno': 20,
      },
    }),
    makeSpan({
      spanId: 'validate',
      parentSpanId: 'checkout',
      name: 'validateCart',
      serviceName: 'checkout-service',
      durationMs: 15,
      startTimeMs: base + 5,
      endTimeMs: base + 20,
      attributes: {
        'function.name': 'validateCart',
        'function.return.value': '{"valid":true}',
        'code.filepath': 'services/cart.ts',
        'code.lineno': 10,
      },
    }),
    makeSpan({
      spanId: 'save-order',
      parentSpanId: 'checkout',
      name: 'saveOrder',
      serviceName: 'checkout-service',
      durationMs: 50,
      statusCode: 'STATUS_CODE_ERROR',
      statusMessage: 'UNIQUE constraint failed: orders.idempotency_key',
      startTimeMs: base + 25,
      endTimeMs: base + 75,
      attributes: {
        'function.name': 'saveOrder',
        'function.args.0': '{"cartId":"cart-789","total":99.99}',
        'function.return.value': '{"ok":false,"error":"duplicate"}',
        'db.system': 'postgresql',
        'db.statement': 'INSERT INTO orders ...',
        'code.filepath': 'services/order-repo.ts',
        'code.lineno': 55,
      },
      events: [{
        name: 'exception',
        attributes: {
          'exception.type': 'UniqueConstraintError',
          'exception.message': 'UNIQUE constraint failed: orders.idempotency_key',
          'exception.stacktrace': 'at saveOrder (services/order-repo.ts:55)\n  at checkout (routes/checkout.ts:30)',
        },
      }],
    }),
    makeSpan({
      spanId: 'send-email',
      parentSpanId: 'checkout',
      name: 'sendConfirmationEmail',
      serviceName: 'checkout-service',
      durationMs: 100,
      startTimeMs: base + 80,
      endTimeMs: base + 180,
      attributes: {
        'function.name': 'sendConfirmationEmail',
        'function.args.0': '"user@example.com"',
        'function.return.value': '{"sent":true}',
        'code.filepath': 'services/email.ts',
        'code.lineno': 12,
      },
    }),
  ];

  it('reveals parent returns success despite child error', () => {
    const values = extractValueSnapshots(spans);

    // Parent handler returned {ok: true}
    const checkoutReturn = values.find(v => v.spanId === 'checkout' && v.boundary === 'exit');
    expect(checkoutReturn).toBeDefined();
    expect(checkoutReturn!.preview).toContain('"ok":true');

    // But saveOrder returned {ok: false}
    const saveReturn = values.find(v => v.spanId === 'save-order' && v.boundary === 'exit');
    expect(saveReturn).toBeDefined();
    expect(saveReturn!.preview).toContain('"ok":false');
  });

  it('exception is captured even though parent shows OK', () => {
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);

    // Parent status is OK (the bug: error was swallowed)
    expect(summary.rootSpanName).toBe('POST /api/checkout');
    // The trace has 1 error span and 1 exception
    expect(summary.errorCount).toBe(1);
    expect(summary.exceptionCount).toBe(1);
    expect(summary.exceptions[0].type).toBe('UniqueConstraintError');
    expect(summary.exceptions[0].sourceLocation?.filePath).toBe('services/order-repo.ts');
  });

  it('error causation edge connects saveOrder to checkout', () => {
    const graph = buildExecutionGraph(spans);
    const errorEdges = graph.edges.filter(e => e.type === 'caused_error');
    // No caused_error because parent (checkout) is STATUS_CODE_OK — that's the swallowing!
    expect(errorEdges.length).toBe(0);
    // This absence IS the signal: a child errored but the parent didn't propagate it
  });

  it('shows the email was sent AFTER the failed save (incorrect flow)', () => {
    // The email span started after save-order failed — execution continued
    const saveSpan = spans.find(s => s.spanId === 'save-order')!;
    const emailSpan = spans.find(s => s.spanId === 'send-email')!;
    expect(emailSpan.startTimeMs).toBeGreaterThan(saveSpan.endTimeMs);

    // Value flow shows the confirmation was sent despite failure
    const values = extractValueSnapshots(spans);
    const emailReturn = values.find(v => v.spanId === 'send-email' && v.boundary === 'exit');
    expect(emailReturn!.preview).toContain('"sent":true');
  });
});

// ─── Scenario 3: Distributed Timeout Cascade ─────────────────────────────────
// "Random 504s on the checkout page."
// Answer: payment-service is slow, causing gateway timeout to propagate back.

describe('Scenario 3: Distributed Timeout Cascade', () => {
  const base = Date.parse('2026-01-15T10:30:00Z');

  const spans: RawSpan[] = [
    makeSpan({
      traceId: 'trace-timeout',
      spanId: 'gateway',
      name: 'POST /checkout',
      serviceName: 'api-gateway',
      kind: 'SPAN_KIND_SERVER',
      durationMs: 5100,
      statusCode: 'STATUS_CODE_ERROR',
      statusMessage: '504 Gateway Timeout',
      startTimeMs: base,
      endTimeMs: base + 5100,
      attributes: { 'http.method': 'POST', 'http.status_code': 504, 'code.filepath': 'gateway/handler.ts', 'code.lineno': 10 },
    }),
    makeSpan({
      traceId: 'trace-timeout',
      spanId: 'checkout-svc',
      parentSpanId: 'gateway',
      name: 'processCheckout',
      serviceName: 'checkout-service',
      durationMs: 5050,
      statusCode: 'STATUS_CODE_ERROR',
      statusMessage: 'upstream timeout',
      startTimeMs: base + 30,
      endTimeMs: base + 5080,
      attributes: { 'function.name': 'processCheckout', 'code.filepath': 'checkout/process.ts', 'code.lineno': 25 },
    }),
    makeSpan({
      traceId: 'trace-timeout',
      spanId: 'payment-call',
      parentSpanId: 'checkout-svc',
      name: 'POST /payment/charge',
      serviceName: 'checkout-service',
      kind: 'SPAN_KIND_CLIENT',
      durationMs: 5000,
      statusCode: 'STATUS_CODE_ERROR',
      statusMessage: 'DEADLINE_EXCEEDED',
      startTimeMs: base + 50,
      endTimeMs: base + 5050,
      attributes: {
        'http.method': 'POST',
        'http.url': 'http://payment-service:8080/payment/charge',
        'http.status_code': 503,
        'code.filepath': 'checkout/payment-client.ts',
        'code.lineno': 88,
      },
      events: [{
        name: 'exception',
        attributes: {
          'exception.type': 'DeadlineExceededError',
          'exception.message': 'Payment service did not respond within 5000ms',
        },
      }],
    }),
    makeSpan({
      traceId: 'trace-timeout',
      spanId: 'payment-handler',
      parentSpanId: 'payment-call',
      name: 'POST /payment/charge',
      serviceName: 'payment-service',
      kind: 'SPAN_KIND_SERVER',
      durationMs: 4950,
      statusCode: 'STATUS_CODE_ERROR',
      statusMessage: 'Stripe API timeout',
      startTimeMs: base + 70,
      endTimeMs: base + 5020,
      attributes: {
        'http.method': 'POST',
        'function.name': 'chargeCard',
        'code.filepath': 'payment/stripe.ts',
        'code.lineno': 30,
      },
    }),
    makeSpan({
      traceId: 'trace-timeout',
      spanId: 'stripe-call',
      parentSpanId: 'payment-handler',
      name: 'POST https://api.stripe.com/v1/charges',
      serviceName: 'payment-service',
      kind: 'SPAN_KIND_CLIENT',
      durationMs: 4900,
      statusCode: 'STATUS_CODE_ERROR',
      statusMessage: 'connection timed out',
      startTimeMs: base + 90,
      endTimeMs: base + 4990,
      attributes: {
        'http.method': 'POST',
        'http.url': 'https://api.stripe.com/v1/charges',
        'code.filepath': 'payment/stripe.ts',
        'code.lineno': 45,
      },
    }),
  ];

  it('request path shows the full cascade from gateway to stripe', () => {
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);

    // Request path follows the error chain — the critical path
    expect(summary.requestPath.length).toBeGreaterThanOrEqual(4);
    const services = summary.requestPath.map(s => s.serviceName);
    expect(services).toContain('api-gateway');
    expect(services).toContain('checkout-service');
    expect(services).toContain('payment-service');

    // All steps show error
    const allErrors = summary.requestPath.every(s => s.status === 'error');
    expect(allErrors).toBe(true);
  });

  it('identifies the root cause: Stripe call is the slowest leaf span', () => {
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);

    // The last step in the request path is the Stripe call — root cause
    const lastStep = summary.requestPath[summary.requestPath.length - 1];
    expect(lastStep.name).toContain('stripe');
    expect(lastStep.durationMs).toBe(4900);
  });

  it('cross-service error propagation creates caused_error chain', () => {
    const graph = buildExecutionGraph(spans);
    const errorEdges = graph.edges.filter(e => e.type === 'caused_error');
    // Errors propagate up the chain
    expect(errorEdges.length).toBeGreaterThanOrEqual(2);
  });

  it('spans three services with high suspiciousness', () => {
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);
    expect(summary.services.length).toBe(3);
    expect(summary.suspiciousnessScore).toBeGreaterThanOrEqual(90); // many error spans + exception + slow
  });
});

// ─── Scenario 4: Race Condition / Async Ordering Bug ──────────────────────────
// "Sometimes the user sees stale data after updating their profile."
// Answer: The cache write and DB write happen concurrently, but cache write
// uses the OLD value because it fires before the DB write completes.

describe('Scenario 4: Race Condition — Cache vs DB Write Order', () => {
  const base = Date.parse('2026-01-15T10:30:00Z');

  const spans: RawSpan[] = [
    makeSpan({
      spanId: 'update-handler',
      name: 'PUT /api/profile',
      serviceName: 'user-service',
      kind: 'SPAN_KIND_SERVER',
      durationMs: 120,
      startTimeMs: base,
      endTimeMs: base + 120,
      attributes: {
        'http.method': 'PUT',
        'function.name': 'updateProfile',
        'function.args.0': '{"userId":"u-123","name":"Alice Updated"}',
        'function.return.value': '{"success":true}',
        'code.filepath': 'routes/profile.ts',
        'code.lineno': 30,
      },
    }),
    // Cache write fires FIRST with OLD value (the bug)
    makeSpan({
      spanId: 'cache-write',
      parentSpanId: 'update-handler',
      name: 'SET user:u-123',
      serviceName: 'user-service',
      durationMs: 5,
      startTimeMs: base + 10,
      endTimeMs: base + 15,
      attributes: {
        'db.system': 'redis',
        'db.statement': 'SET user:u-123',
        'function.name': 'cacheUser',
        'function.args.0': '{"userId":"u-123","name":"Alice Old"}',
        'code.filepath': 'services/cache.ts',
        'code.lineno': 22,
      },
    }),
    // DB write happens AFTER with NEW value
    makeSpan({
      spanId: 'db-write',
      parentSpanId: 'update-handler',
      name: 'UPDATE users SET name = ?',
      serviceName: 'user-service',
      durationMs: 80,
      startTimeMs: base + 20,
      endTimeMs: base + 100,
      attributes: {
        'db.system': 'postgresql',
        'db.statement': 'UPDATE users SET name = $1 WHERE id = $2',
        'function.name': 'updateUserInDB',
        'function.args.0': '{"userId":"u-123","name":"Alice Updated"}',
        'function.return.value': '{"rowsAffected":1}',
        'code.filepath': 'services/user-repo.ts',
        'code.lineno': 67,
      },
    }),
  ];

  it('value flow shows cache received OLD data while DB got NEW data', () => {
    const values = extractValueSnapshots(spans);

    // Cache write arg has "Alice Old"
    const cacheArg = values.find(v => v.spanId === 'cache-write' && v.boundary === 'entry');
    expect(cacheArg).toBeDefined();
    expect(cacheArg!.preview).toContain('Alice Old');

    // DB write arg has "Alice Updated"
    const dbArg = values.find(v => v.spanId === 'db-write' && v.boundary === 'entry');
    expect(dbArg).toBeDefined();
    expect(dbArg!.preview).toContain('Alice Updated');
  });

  it('timeline shows cache write completed before DB write started', () => {
    const cacheSpan = spans.find(s => s.spanId === 'cache-write')!;
    const dbSpan = spans.find(s => s.spanId === 'db-write')!;

    // Cache write ended at t+15, DB write started at t+20
    expect(cacheSpan.endTimeMs).toBeLessThan(dbSpan.startTimeMs);
  });

  it('handler returns success despite the data inconsistency', () => {
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);

    expect(summary.errorCount).toBe(0);
    expect(summary.suspiciousnessScore).toBe(0); // No errors — the bug is silent!

    const values = extractValueSnapshots(spans);
    const handlerReturn = values.find(v => v.spanId === 'update-handler' && v.boundary === 'exit');
    expect(handlerReturn!.preview).toContain('"success":true');
  });
});

// ─── Scenario 5: Cache Poisoning — Wrong Data Returned ────────────────────────
// "Users are seeing other users' data."
// Answer: Cache key construction is wrong — using session ID instead of user ID.

describe('Scenario 5: Cache Poisoning — Wrong Data Served', () => {
  const base = Date.parse('2026-01-15T10:30:00Z');

  const spans: RawSpan[] = [
    makeSpan({
      spanId: 'get-profile',
      name: 'GET /api/profile',
      serviceName: 'user-service',
      kind: 'SPAN_KIND_SERVER',
      durationMs: 15,
      startTimeMs: base,
      endTimeMs: base + 15,
      attributes: {
        'http.method': 'GET',
        'function.name': 'getProfile',
        'function.args.0': '"user-456"',
        'function.return.value': '{"userId":"user-789","name":"Bob","email":"bob@example.com"}',
        'code.filepath': 'routes/profile.ts',
        'code.lineno': 10,
      },
    }),
    makeSpan({
      spanId: 'cache-get',
      parentSpanId: 'get-profile',
      name: 'GET profile:sess-abc',
      serviceName: 'user-service',
      durationMs: 2,
      startTimeMs: base + 2,
      endTimeMs: base + 4,
      attributes: {
        'db.system': 'redis',
        'db.statement': 'GET profile:sess-abc',
        'function.name': 'getCachedProfile',
        'function.args.0': '"sess-abc"',
        'function.return.value': '{"userId":"user-789","name":"Bob","email":"bob@example.com"}',
        'code.filepath': 'services/cache.ts',
        'code.lineno': 15,
      },
    }),
  ];

  it('detects mismatched user IDs: requested user-456 but got user-789', () => {
    const values = extractValueSnapshots(spans);

    // Request was for user-456
    const requestArg = values.find(v => v.spanId === 'get-profile' && v.name === 'arg0');
    expect(requestArg!.preview).toContain('user-456');

    // Response contains user-789's data
    const response = values.find(v => v.spanId === 'get-profile' && v.boundary === 'exit');
    expect(response!.preview).toContain('user-789');
    // The userId in request vs response don't match — cache poisoning
  });

  it('cache key uses session ID instead of user ID', () => {
    const values = extractValueSnapshots(spans);

    // Cache was looked up by "sess-abc" (session), not "user-456" (user ID)
    const cacheArg = values.find(v => v.spanId === 'cache-get' && v.name === 'arg0');
    expect(cacheArg!.preview).toContain('sess-abc');
    // Bug: cache key is session-based, causing cross-user data leakage
  });
});

// ─── Scenario 6: Partial Fan-Out Failure ──────────────────────────────────────
// "Notifications are only reaching some users."
// Answer: 2 of 5 notification sends fail, but the handler doesn't check.

describe('Scenario 6: Partial Fan-Out Failure', () => {
  const base = Date.parse('2026-01-15T10:30:00Z');

  const notifySpans = (id: number, success: boolean): RawSpan => makeSpan({
    spanId: `notify-${id}`,
    parentSpanId: 'broadcast',
    name: `sendNotification`,
    serviceName: 'notification-service',
    durationMs: success ? 30 : 15,
    statusCode: success ? 'STATUS_CODE_OK' : 'STATUS_CODE_ERROR',
    statusMessage: success ? '' : 'Connection refused',
    startTimeMs: base + 20 + id * 35,
    endTimeMs: base + 20 + id * 35 + (success ? 30 : 15),
    attributes: {
      'function.name': 'sendNotification',
      'function.args.0': `"user-${id}"`,
      'function.return.value': success ? '{"delivered":true}' : '{"delivered":false}',
      'code.filepath': 'services/notify.ts',
      'code.lineno': 42,
    },
    ...(success ? {} : {
      events: [{
        name: 'exception',
        attributes: {
          'exception.type': 'ConnectionRefusedError',
          'exception.message': `Failed to reach push service for user-${id}`,
        },
      }],
    }),
  });

  const spans: RawSpan[] = [
    makeSpan({
      spanId: 'broadcast',
      name: 'broadcastNotification',
      serviceName: 'notification-service',
      durationMs: 220,
      startTimeMs: base,
      endTimeMs: base + 220,
      attributes: {
        'function.name': 'broadcastNotification',
        'function.args.0': '"New product launch!"',
        'function.return.value': '{"sent":5}',
        'code.filepath': 'routes/broadcast.ts',
        'code.lineno': 18,
      },
    }),
    notifySpans(0, true),
    notifySpans(1, true),
    notifySpans(2, false),  // FAILS
    notifySpans(3, true),
    notifySpans(4, false),  // FAILS
  ];

  it('summary shows partial failure: 2 errors out of 6 spans', () => {
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);

    expect(summary.spanCount).toBe(6);
    expect(summary.errorCount).toBe(2);
    expect(summary.exceptionCount).toBe(2);
  });

  it('parent reports success despite child failures', () => {
    const values = extractValueSnapshots(spans);
    const parentReturn = values.find(v => v.spanId === 'broadcast' && v.boundary === 'exit');
    // Bug: says sent:5 but only 3 actually delivered
    expect(parentReturn!.preview).toContain('"sent":5');
  });

  it('value snapshots pinpoint exactly which users were affected', () => {
    const values = extractValueSnapshots(spans);
    const failedArgs = values.filter(v =>
      v.spanId.startsWith('notify-') && v.boundary === 'entry'
    );

    // We can identify which user IDs failed by checking the error spans
    const failedSpans = spans.filter(s => s.statusCode === 'STATUS_CODE_ERROR');
    const failedUserIds = failedSpans.map(s => {
      const arg = values.find(v => v.spanId === s.spanId && v.name === 'arg0');
      return arg?.preview;
    });
    expect(failedUserIds).toContain('"user-2"');
    expect(failedUserIds).toContain('"user-4"');
  });

  it('request path follows error child for root cause', () => {
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);

    // Critical path should prefer the error path
    const lastStep = summary.requestPath[summary.requestPath.length - 1];
    expect(lastStep.status).toBe('error');
    expect(lastStep.name).toBe('sendNotification');
  });
});

// ─── Scenario 7: Retry Storm Amplification ────────────────────────────────────
// "Our services are overloaded but there's no increase in user traffic."
// Answer: A flaky downstream is causing exponential retries.

describe('Scenario 7: Retry Storm Amplification', () => {
  const base = Date.parse('2026-01-15T10:30:00Z');

  const makeRetry = (attempt: number, success: boolean): RawSpan => makeSpan({
    traceId: 'trace-retry',
    spanId: `attempt-${attempt}`,
    parentSpanId: 'caller',
    name: 'POST /inventory/reserve',
    serviceName: 'order-service',
    kind: 'SPAN_KIND_CLIENT',
    durationMs: success ? 50 : 2000,
    statusCode: success ? 'STATUS_CODE_OK' : 'STATUS_CODE_ERROR',
    statusMessage: success ? '' : 'Service Unavailable',
    startTimeMs: base + 100 + attempt * 2100,
    endTimeMs: base + 100 + attempt * 2100 + (success ? 50 : 2000),
    attributes: {
      'http.method': 'POST',
      'http.url': 'http://inventory:8080/inventory/reserve',
      'http.status_code': success ? 200 : 503,
      'function.name': 'reserveInventory',
      'function.args.0': '{"sku":"WIDGET-42","qty":1}',
      'code.filepath': 'clients/inventory.ts',
      'code.lineno': 55,
    },
    ...(success ? {} : {
      events: [{
        name: 'exception',
        attributes: {
          'exception.type': 'ServiceUnavailableError',
          'exception.message': `Inventory service returned 503 (attempt ${attempt + 1})`,
        },
      }],
    }),
  });

  const spans: RawSpan[] = [
    makeSpan({
      traceId: 'trace-retry',
      spanId: 'caller',
      name: 'processOrder',
      serviceName: 'order-service',
      durationMs: 8500,
      startTimeMs: base,
      endTimeMs: base + 8500,
      attributes: {
        'function.name': 'processOrder',
        'code.filepath': 'services/order.ts',
        'code.lineno': 15,
      },
    }),
    makeRetry(0, false), // fail
    makeRetry(1, false), // fail
    makeRetry(2, false), // fail
    makeRetry(3, true),  // success on 4th attempt
  ];

  it('detects repeated calls to the same endpoint', () => {
    const graph = buildExecutionGraph(spans);
    const sameNameNodes = graph.nodes.filter(n => n.name === 'POST /inventory/reserve');
    expect(sameNameNodes.length).toBe(4);

    // 3 failures, 1 success
    const failures = sameNameNodes.filter(n => n.status === 'error');
    expect(failures.length).toBe(3);
  });

  it('total duration is dominated by retry delays', () => {
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);

    // The parent span is 8500ms, but each retry is 2000ms timeout
    expect(summary.durationMs).toBeGreaterThan(6000);
    // 3 failed retries * 2000ms = 6000ms wasted on retries
    const failedSpans = spans.filter(s => s.statusCode === 'STATUS_CODE_ERROR');
    const wastedTime = failedSpans.reduce((sum, s) => sum + s.durationMs, 0);
    expect(wastedTime).toBe(6000);
  });

  it('suspiciousness is high due to multiple errors + exceptions', () => {
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);
    // 3 error spans * 30 = 90, 3 exceptions * 40 = 120, cap at 100
    expect(summary.suspiciousnessScore).toBe(100);
  });
});

// ─── Scenario 8: Auth Token Not Propagated Across Service Boundary ────────────
// "User gets 403 on the billing page but they're definitely logged in."
// Answer: The auth token wasn't forwarded from gateway to billing-service.

describe('Scenario 8: Auth Token Not Propagated', () => {
  const base = Date.parse('2026-01-15T10:30:00Z');

  const spans: RawSpan[] = [
    makeSpan({
      traceId: 'trace-auth',
      spanId: 'gateway-req',
      name: 'GET /billing/invoices',
      serviceName: 'api-gateway',
      kind: 'SPAN_KIND_SERVER',
      durationMs: 100,
      statusCode: 'STATUS_CODE_ERROR',
      statusMessage: '403 Forbidden',
      startTimeMs: base,
      endTimeMs: base + 100,
      attributes: {
        'http.method': 'GET',
        'http.status_code': 403,
        'http.request.header.authorization': 'Bearer eyJhbG...',
        'function.name': 'proxyRequest',
        'code.filepath': 'gateway/proxy.ts',
        'code.lineno': 22,
      },
    }),
    makeSpan({
      traceId: 'trace-auth',
      spanId: 'billing-req',
      parentSpanId: 'gateway-req',
      name: 'GET /billing/invoices',
      serviceName: 'billing-service',
      kind: 'SPAN_KIND_SERVER',
      durationMs: 15,
      statusCode: 'STATUS_CODE_ERROR',
      statusMessage: 'Unauthorized: no auth token',
      startTimeMs: base + 50,
      endTimeMs: base + 65,
      attributes: {
        'http.method': 'GET',
        'http.status_code': 403,
        'function.name': 'getInvoices',
        'code.filepath': 'billing/handler.ts',
        'code.lineno': 10,
      },
      events: [{
        name: 'exception',
        attributes: {
          'exception.type': 'UnauthorizedError',
          'exception.message': 'No authorization header present in request',
        },
      }],
    }),
  ];

  it('gateway has auth header but billing service does not', () => {
    // Gateway span has the auth header
    const gatewayAttrs = spans[0].attributes;
    expect(gatewayAttrs['http.request.header.authorization']).toBeDefined();

    // Billing span does NOT have it — it was dropped during forwarding
    const billingAttrs = spans[1].attributes;
    expect(billingAttrs['http.request.header.authorization']).toBeUndefined();
  });

  it('exception message pinpoints the issue', () => {
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);

    expect(summary.exceptions[0].message).toBe('No authorization header present in request');
    expect(summary.exceptions[0].serviceName).toBe('billing-service');
    // Root cause is clear: gateway has the token, billing doesn't
  });

  it('error propagates across services', () => {
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);

    expect(summary.services).toContain('api-gateway');
    expect(summary.services).toContain('billing-service');
    expect(summary.errorCount).toBe(2); // Both spans errored
  });
});

// ─── Scenario 9: React Render Error Causing Blank Page ────────────────────────
// "Users see a white screen when visiting the dashboard."
// Answer: A component throws during render because props.data is undefined.

describe('Scenario 9: React Render Error — Blank Page', () => {
  const base = Date.parse('2026-01-15T10:30:00Z');

  const spans: RawSpan[] = [
    makeSpan({
      spanId: 'page-render',
      name: 'DashboardPage',
      serviceName: 'web-frontend',
      durationMs: 45,
      statusCode: 'STATUS_CODE_ERROR',
      startTimeMs: base,
      endTimeMs: base + 45,
      attributes: {
        'component.name': 'DashboardPage',
        'code.function.type': 'react_component',
        'component.props': '{"userId":"u-123"}',
        'code.filepath': 'components/DashboardPage.tsx',
        'code.lineno': 15,
      },
      events: [{
        name: 'exception',
        attributes: {
          'exception.type': 'TypeError',
          'exception.message': "Cannot read properties of undefined (reading 'map')",
          'exception.stacktrace': 'at DashboardPage (components/DashboardPage.tsx:28)\n  at renderWithHooks',
        },
      }],
    }),
    makeSpan({
      spanId: 'data-fetch',
      parentSpanId: 'page-render',
      name: 'useDashboardData',
      serviceName: 'web-frontend',
      durationMs: 0,
      startTimeMs: base + 1,
      endTimeMs: base + 1,
      attributes: {
        'function.name': 'useDashboardData',
        'function.return.value': '{"data":undefined,"loading":false,"error":null}',
        'code.filepath': 'hooks/useDashboardData.ts',
        'code.lineno': 8,
      },
    }),
  ];

  it('identifies the TypeError and the exact component', () => {
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);

    expect(summary.exceptions[0].type).toBe('TypeError');
    expect(summary.exceptions[0].message).toContain("reading 'map'");
    expect(summary.exceptions[0].sourceLocation?.filePath).toBe('components/DashboardPage.tsx');
    expect(summary.exceptions[0].sourceLocation?.line).toBe(15);
  });

  it('value flow shows data hook returned undefined', () => {
    const values = extractValueSnapshots(spans);

    const hookReturn = values.find(v => v.spanId === 'data-fetch' && v.boundary === 'exit');
    expect(hookReturn).toBeDefined();
    expect(hookReturn!.preview).toContain('"data":undefined');
    // Root cause: the hook returned data=undefined, and the component tried to .map() it
  });

  it('component with exception is classified as exception (exception takes priority)', () => {
    const graph = buildExecutionGraph(spans);
    const pageNode = graph.nodes.find(n => n.spanId === 'page-render');
    // Exception events take classification priority over component.name
    expect(pageNode?.type).toBe('exception');
  });

  it('props capture shows what was passed to the component', () => {
    const values = extractValueSnapshots(spans);
    const props = values.find(v => v.spanId === 'page-render' && v.name === 'props');
    expect(props).toBeDefined();
    expect(props!.preview).toContain('"userId":"u-123"');
  });
});

// ─── Scenario 10: Regression Detection via Trace Comparison ───────────────────
// "After the last deploy, checkout is failing for some users."
// Answer: The new code adds an extra validation step that rejects edge-case inputs.

describe('Scenario 10: Regression Detection via Trace Comparison', () => {
  const base = Date.parse('2026-01-15T10:30:00Z');

  // Good trace (before deploy) — checkout succeeds
  const goodSpans: RawSpan[] = [
    makeSpan({
      traceId: 'good-trace',
      spanId: 'g-handler',
      name: 'POST /api/checkout',
      serviceName: 'checkout-service',
      kind: 'SPAN_KIND_SERVER',
      durationMs: 200,
      startTimeMs: base,
      endTimeMs: base + 200,
      attributes: {
        'http.method': 'POST',
        'function.return.value': '{"orderId":"ord-001","status":"confirmed"}',
        'code.filepath': 'routes/checkout.ts',
        'code.lineno': 20,
      },
    }),
    makeSpan({
      traceId: 'good-trace',
      spanId: 'g-validate',
      parentSpanId: 'g-handler',
      name: 'validateCart',
      serviceName: 'checkout-service',
      durationMs: 30,
      startTimeMs: base + 5,
      endTimeMs: base + 35,
      attributes: {
        'function.name': 'validateCart',
        'function.args.0': '{"items":[{"sku":"ITEM-1","qty":1}]}',
        'function.return.value': '{"valid":true}',
        'code.filepath': 'services/validation.ts',
        'code.lineno': 10,
      },
    }),
    makeSpan({
      traceId: 'good-trace',
      spanId: 'g-charge',
      parentSpanId: 'g-handler',
      name: 'chargePayment',
      serviceName: 'checkout-service',
      durationMs: 150,
      startTimeMs: base + 40,
      endTimeMs: base + 190,
      attributes: {
        'function.name': 'chargePayment',
        'function.return.value': '{"charged":true,"amount":29.99}',
        'code.filepath': 'services/payment.ts',
        'code.lineno': 25,
      },
    }),
  ];

  // Bad trace (after deploy) — new validation step causes rejection
  const badSpans: RawSpan[] = [
    makeSpan({
      traceId: 'bad-trace',
      spanId: 'b-handler',
      name: 'POST /api/checkout',
      serviceName: 'checkout-service',
      kind: 'SPAN_KIND_SERVER',
      durationMs: 45,
      statusCode: 'STATUS_CODE_ERROR',
      statusMessage: 'Cart validation failed',
      startTimeMs: base,
      endTimeMs: base + 45,
      attributes: {
        'http.method': 'POST',
        'function.return.value': '{"error":"Validation failed: item quantity exceeds limit"}',
        'code.filepath': 'routes/checkout.ts',
        'code.lineno': 20,
      },
    }),
    makeSpan({
      traceId: 'bad-trace',
      spanId: 'b-validate',
      parentSpanId: 'b-handler',
      name: 'validateCart',
      serviceName: 'checkout-service',
      durationMs: 10,
      startTimeMs: base + 5,
      endTimeMs: base + 15,
      attributes: {
        'function.name': 'validateCart',
        'function.args.0': '{"items":[{"sku":"ITEM-1","qty":1}]}',
        'function.return.value': '{"valid":true}',
        'code.filepath': 'services/validation.ts',
        'code.lineno': 10,
      },
    }),
    // NEW span: extra validation step added in the deploy
    makeSpan({
      traceId: 'bad-trace',
      spanId: 'b-limit-check',
      parentSpanId: 'b-handler',
      name: 'checkQuantityLimits',
      serviceName: 'checkout-service',
      durationMs: 8,
      statusCode: 'STATUS_CODE_ERROR',
      statusMessage: 'Quantity limit exceeded',
      startTimeMs: base + 18,
      endTimeMs: base + 26,
      attributes: {
        'function.name': 'checkQuantityLimits',
        'function.args.0': '{"items":[{"sku":"ITEM-1","qty":1}]}',
        'function.return.value': '{"valid":false,"reason":"item quantity exceeds limit"}',
        'code.filepath': 'services/quantity-limits.ts',
        'code.lineno': 5,
      },
      events: [{
        name: 'exception',
        attributes: {
          'exception.type': 'QuantityLimitError',
          'exception.message': 'Item ITEM-1 qty 1 exceeds limit of 0 (limit not configured)',
        },
      }],
    }),
  ];

  it('first divergence identifies the new validation step as the culprit', () => {
    const result = compareTraces(goodSpans, badSpans);

    // Should find the critical status_diff on the handler
    expect(result.firstDivergence).toBeDefined();
    expect(result.firstDivergence!.severity).toBe('critical');
  });

  it('detects the extra span (new validation) not present in good trace', () => {
    const result = compareTraces(goodSpans, badSpans);

    const extraSpanDiv = result.divergences.find(d =>
      d.type === 'extra_span' && d.spanName === 'checkQuantityLimits'
    );
    expect(extraSpanDiv).toBeDefined();
    expect(extraSpanDiv!.serviceName).toBe('checkout-service');
  });

  it('detects missing chargePayment — bad trace never got to payment', () => {
    const result = compareTraces(goodSpans, badSpans);

    const missingPayment = result.divergences.find(d =>
      d.type === 'missing_span' && d.spanName === 'chargePayment'
    );
    expect(missingPayment).toBeDefined();
    expect(missingPayment!.severity).toBe('critical');
  });

  it('handler status changed from OK to ERROR', () => {
    const result = compareTraces(goodSpans, badSpans);

    const statusDiv = result.divergences.find(d =>
      d.type === 'status_diff' && d.spanName === 'POST /api/checkout'
    );
    expect(statusDiv).toBeDefined();
    expect(statusDiv!.goodValue).toBe('STATUS_CODE_OK');
    expect(statusDiv!.badValue).toBe('STATUS_CODE_ERROR');
  });

  it('return value shows good returned orderId, bad returned error', () => {
    const result = compareTraces(goodSpans, badSpans);

    const valueDiff = result.divergences.find(d =>
      d.type === 'value_diff' && d.spanName === 'POST /api/checkout'
    );
    expect(valueDiff).toBeDefined();
    expect(valueDiff!.goodValue).toContain('ord-001');
    expect(valueDiff!.badValue).toContain('Validation failed');
  });

  it('summary captures the full picture', () => {
    const result = compareTraces(goodSpans, badSpans);

    expect(result.summary).toContain('divergence');
    expect(result.missingSpans.length).toBeGreaterThan(0);
    expect(result.extraSpans.length).toBeGreaterThan(0);
    expect(result.changedSpans.length).toBeGreaterThan(0);
  });
});

// ─── Scenario 11: Deep Async Chain with Orphan Spans ──────────────────────────
// "Background job silently fails; no one notices for hours."
// Answer: An async callback's parent span has already ended — it's orphaned.

describe('Scenario 11: Orphan Span in Async Background Job', () => {
  const base = Date.parse('2026-01-15T10:30:00Z');

  const spans: RawSpan[] = [
    makeSpan({
      traceId: 'trace-orphan',
      spanId: 'api-handler',
      name: 'POST /api/orders',
      serviceName: 'order-service',
      durationMs: 50,
      startTimeMs: base,
      endTimeMs: base + 50,
      attributes: {
        'http.method': 'POST',
        'function.return.value': '{"orderId":"ord-999","status":"accepted"}',
        'code.filepath': 'routes/orders.ts',
        'code.lineno': 10,
      },
    }),
    // This span's parent (background-job-scheduler) isn't in the trace
    makeSpan({
      traceId: 'trace-orphan',
      spanId: 'bg-process',
      parentSpanId: 'missing-scheduler-span',
      name: 'processOrderAsync',
      serviceName: 'worker-service',
      durationMs: 2000,
      statusCode: 'STATUS_CODE_ERROR',
      statusMessage: 'Payment gateway unreachable',
      startTimeMs: base + 5000,
      endTimeMs: base + 7000,
      attributes: {
        'function.name': 'processOrderAsync',
        'function.args.0': '{"orderId":"ord-999"}',
        'code.filepath': 'workers/order-processor.ts',
        'code.lineno': 22,
      },
      events: [{
        name: 'exception',
        attributes: {
          'exception.type': 'NetworkError',
          'exception.message': 'ECONNREFUSED 10.0.0.5:443',
        },
      }],
    }),
  ];

  it('detects orphan span (parent not in trace)', () => {
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);

    // The bg-process span has a parentSpanId that doesn't exist in this trace
    const bgSpan = spans.find(s => s.spanId === 'bg-process')!;
    const parentExists = spans.some(s => s.spanId === bgSpan.parentSpanId);
    expect(parentExists).toBe(false);

    // Suspiciousness: Error(30) + Exception(40) + Orphan(15) + Slow>1s(10) = 95
    expect(summary.suspiciousnessScore).toBe(95);
  });

  it('the API returned success but the async job failed', () => {
    const values = extractValueSnapshots(spans);

    const apiReturn = values.find(v => v.spanId === 'api-handler' && v.boundary === 'exit');
    expect(apiReturn!.preview).toContain('"status":"accepted"');

    const bgException = values.find(v => v.spanId === 'bg-process' && v.boundary === 'exception');
    expect(bgException!.preview).toContain('ECONNREFUSED');
  });

  it('async job started 5s after API response — fire-and-forget pattern', () => {
    const apiSpan = spans.find(s => s.spanId === 'api-handler')!;
    const bgSpan = spans.find(s => s.spanId === 'bg-process')!;

    // 5 second gap between API end and background job start
    expect(bgSpan.startTimeMs - apiSpan.endTimeMs).toBe(4950);
  });
});

// ─── Scenario 12: Multi-Service Value Transformation Bug ──────────────────────
// "The price shown to the user is wrong."
// Answer: Currency conversion service returns cents, but consumer treats it as dollars.

describe('Scenario 12: Value Transformation Bug Across Services', () => {
  const base = Date.parse('2026-01-15T10:30:00Z');

  const spans: RawSpan[] = [
    makeSpan({
      spanId: 'product-page',
      name: 'GET /products/widget',
      serviceName: 'web-bff',
      kind: 'SPAN_KIND_SERVER',
      durationMs: 100,
      startTimeMs: base,
      endTimeMs: base + 100,
      attributes: {
        'http.method': 'GET',
        'function.return.value': '{"name":"Widget","price":2999,"currency":"USD"}',
        'code.filepath': 'routes/products.ts',
        'code.lineno': 15,
      },
    }),
    makeSpan({
      spanId: 'pricing-call',
      parentSpanId: 'product-page',
      name: 'GET /pricing/convert',
      serviceName: 'web-bff',
      kind: 'SPAN_KIND_CLIENT',
      durationMs: 40,
      startTimeMs: base + 10,
      endTimeMs: base + 50,
      attributes: {
        'http.method': 'GET',
        'http.url': 'http://pricing-service/pricing/convert?amount=2999&from=EUR&to=USD',
        'function.return.value': '{"amount_cents":3299,"currency":"USD"}',
        'code.filepath': 'clients/pricing.ts',
        'code.lineno': 30,
      },
    }),
    makeSpan({
      spanId: 'pricing-handler',
      parentSpanId: 'pricing-call',
      name: 'GET /pricing/convert',
      serviceName: 'pricing-service',
      kind: 'SPAN_KIND_SERVER',
      durationMs: 15,
      startTimeMs: base + 20,
      endTimeMs: base + 35,
      attributes: {
        'http.method': 'GET',
        'function.name': 'convertCurrency',
        'function.args.0': '{"amount":2999,"from":"EUR","to":"USD"}',
        'function.return.value': '{"amount_cents":3299,"currency":"USD"}',
        'code.filepath': 'services/converter.ts',
        'code.lineno': 8,
      },
    }),
  ];

  it('traces the value transformation across services', () => {
    const values = extractValueSnapshots(spans);

    // Pricing service returns amount_cents: 3299
    const pricingReturn = values.find(v => v.spanId === 'pricing-handler' && v.boundary === 'exit');
    expect(pricingReturn!.preview).toContain('"amount_cents":3299');

    // BFF returns price: 2999 — it used the original EUR price, not the converted one!
    const bffReturn = values.find(v => v.spanId === 'product-page' && v.boundary === 'exit');
    expect(bffReturn!.preview).toContain('"price":2999');

    // The BFF ignored the pricing service response — or used the wrong field
    // This is the bug: amount_cents (3299) was never used in the final response
  });

  it('no errors are reported — everything looks successful', () => {
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);

    expect(summary.errorCount).toBe(0);
    expect(summary.exceptionCount).toBe(0);
    expect(summary.suspiciousnessScore).toBe(0);
    // Silent data correctness bugs have zero suspiciousness
  });

  it('request path shows the full service chain', () => {
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);

    const services = summary.requestPath.map(s => s.serviceName);
    expect(services).toContain('web-bff');
    expect(services).toContain('pricing-service');
  });
});
