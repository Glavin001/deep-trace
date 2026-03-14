/**
 * Edge-case and robustness tests for the DeepTrace enrichment engine.
 *
 * These tests target boundary conditions, malformed input, and subtle
 * behaviors in the enrichment logic that the main test suite doesn't cover.
 */

import { describe, it, expect } from 'vitest';
import {
  buildExecutionGraph,
  buildTraceSummary,
  buildTraceRun,
  compareTraces,
  extractValueSnapshots,
  type RawSpan,
} from '../deeptrace/enrichment';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSpan(overrides: Partial<RawSpan> & { spanId: string }): RawSpan {
  return {
    traceId: 'trace-edge',
    parentSpanId: undefined,
    name: 'test-span',
    serviceName: 'test-service',
    kind: 'SPAN_KIND_INTERNAL',
    durationMs: 10,
    statusCode: 'STATUS_CODE_OK',
    statusMessage: '',
    timestamp: '2026-01-01 00:00:00.000',
    startTimeMs: 1000,
    endTimeMs: 1010,
    attributes: {},
    events: [],
    ...overrides,
  };
}

// ─── Classification Priority ─────────────────────────────────────────────────

describe('classifyNodeType priority', () => {
  it('exception takes priority over db.system', () => {
    const spans = [makeSpan({
      spanId: 's1',
      name: 'query users',
      attributes: { 'db.system': 'postgresql' },
      events: [{ name: 'exception', attributes: { 'exception.type': 'Error' } }],
    })];
    const graph = buildExecutionGraph(spans);
    expect(graph.nodes[0].type).toBe('exception');
  });

  it('exception takes priority over http.method', () => {
    const spans = [makeSpan({
      spanId: 's1',
      name: 'GET /api',
      attributes: { 'http.method': 'GET' },
      events: [{ name: 'exception', attributes: { 'exception.type': 'Error' } }],
    })];
    const graph = buildExecutionGraph(spans);
    expect(graph.nodes[0].type).toBe('exception');
  });

  it('db_query takes priority over async_task', () => {
    const spans = [makeSpan({
      spanId: 's1',
      name: 'async database query',
      attributes: { 'db.system': 'mysql', 'dt.async_type': 'promise' },
    })];
    const graph = buildExecutionGraph(spans);
    expect(graph.nodes[0].type).toBe('db_query');
  });

  it('network_request takes priority over user_action', () => {
    const spans = [makeSpan({
      spanId: 's1',
      name: 'POST /submit',
      attributes: { 'http.method': 'POST', 'dt.user_action': 'form_submit' },
    })];
    const graph = buildExecutionGraph(spans);
    expect(graph.nodes[0].type).toBe('network_request');
  });

  it('classifies async_task via dt.async_type attribute', () => {
    const spans = [makeSpan({
      spanId: 's1',
      name: 'background-work',
      attributes: { 'dt.async_type': 'setTimeout' },
    })];
    const graph = buildExecutionGraph(spans);
    expect(graph.nodes[0].type).toBe('async_task');
  });

  it('classifies message_job via messaging.system attribute', () => {
    const spans = [makeSpan({
      spanId: 's1',
      name: 'handle-event',
      attributes: { 'messaging.system': 'kafka' },
    })];
    const graph = buildExecutionGraph(spans);
    expect(graph.nodes[0].type).toBe('message_job');
  });

  it('falls back to span for unrecognized names and attributes', () => {
    const spans = [makeSpan({
      spanId: 's1',
      name: 'doSomething',
      attributes: { 'custom.tag': 'value' },
    })];
    const graph = buildExecutionGraph(spans);
    expect(graph.nodes[0].type).toBe('span');
  });
});

// ─── Cross-Service Edge Detection ────────────────────────────────────────────

describe('cross-service edge detection', () => {
  it('creates request_sent_to and request_handled_by for matching HTTP spans', () => {
    const spans = [
      makeSpan({
        spanId: 'client',
        name: 'GET /api/data',
        serviceName: 'frontend',
        startTimeMs: 1000,
        endTimeMs: 1200,
        attributes: { 'http.method': 'GET', 'http.url': '/api/data' },
      }),
      makeSpan({
        spanId: 'server',
        name: 'GET /api/data',
        serviceName: 'backend',
        startTimeMs: 1020,
        endTimeMs: 1180,
        attributes: { 'http.method': 'GET', 'http.url': '/api/data' },
      }),
    ];

    const graph = buildExecutionGraph(spans);
    const sentTo = graph.edges.filter(e => e.type === 'request_sent_to');
    const handledBy = graph.edges.filter(e => e.type === 'request_handled_by');

    expect(sentTo.length).toBeGreaterThanOrEqual(1);
    expect(handledBy.length).toBeGreaterThanOrEqual(1);
    expect(sentTo[0].sourceNodeId).toBe('node_client');
    expect(sentTo[0].targetNodeId).toBe('node_server');
  });

  it('does NOT create cross-service edges for same service', () => {
    const spans = [
      makeSpan({
        spanId: 'a',
        name: 'GET /api/data',
        serviceName: 'same-service',
        startTimeMs: 1000,
        endTimeMs: 1200,
        attributes: { 'http.method': 'GET', 'http.url': '/api/data' },
      }),
      makeSpan({
        spanId: 'b',
        name: 'GET /api/data',
        serviceName: 'same-service',
        startTimeMs: 1020,
        endTimeMs: 1180,
        attributes: { 'http.method': 'GET', 'http.url': '/api/data' },
      }),
    ];

    const graph = buildExecutionGraph(spans);
    const sentTo = graph.edges.filter(e => e.type === 'request_sent_to');
    expect(sentTo.length).toBe(0);
  });

  it('does NOT create cross-service edges when timing does not overlap', () => {
    const spans = [
      makeSpan({
        spanId: 'client',
        name: 'GET /api/data',
        serviceName: 'frontend',
        startTimeMs: 1000,
        endTimeMs: 1100,
        attributes: { 'http.method': 'GET', 'http.url': '/api/data' },
      }),
      makeSpan({
        spanId: 'server',
        name: 'GET /api/data',
        serviceName: 'backend',
        startTimeMs: 5000, // way after client finished
        endTimeMs: 5100,
        attributes: { 'http.method': 'GET', 'http.url': '/api/data' },
      }),
    ];

    const graph = buildExecutionGraph(spans);
    const sentTo = graph.edges.filter(e => e.type === 'request_sent_to');
    expect(sentTo.length).toBe(0);
  });

  it('does NOT create cross-service edges when URLs do not match', () => {
    const spans = [
      makeSpan({
        spanId: 'client',
        name: 'GET /api/orders',
        serviceName: 'frontend',
        startTimeMs: 1000,
        endTimeMs: 1200,
        attributes: { 'http.method': 'GET', 'http.url': '/api/orders' },
      }),
      makeSpan({
        spanId: 'server',
        name: 'GET /api/users',
        serviceName: 'backend',
        startTimeMs: 1020,
        endTimeMs: 1180,
        attributes: { 'http.method': 'GET', 'http.url': '/api/users' },
      }),
    ];

    const graph = buildExecutionGraph(spans);
    const sentTo = graph.edges.filter(e => e.type === 'request_sent_to');
    expect(sentTo.length).toBe(0);
  });

  it('matches URLs ignoring query strings', () => {
    const spans = [
      makeSpan({
        spanId: 'client',
        name: 'GET /api/data',
        serviceName: 'frontend',
        startTimeMs: 1000,
        endTimeMs: 1200,
        attributes: { 'http.method': 'GET', 'http.url': '/api/data?page=1&limit=10' },
      }),
      makeSpan({
        spanId: 'server',
        name: 'GET /api/data',
        serviceName: 'backend',
        startTimeMs: 1020,
        endTimeMs: 1180,
        attributes: { 'http.method': 'GET', 'http.url': '/api/data' },
      }),
    ];

    const graph = buildExecutionGraph(spans);
    const sentTo = graph.edges.filter(e => e.type === 'request_sent_to');
    expect(sentTo.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Async Edge Detection ────────────────────────────────────────────────────

describe('async edge detection', () => {
  it('creates async_scheduled_by when caller ended before callee started', () => {
    const spans = [
      makeSpan({ spanId: 'caller', name: 'dispatch', startTimeMs: 1000, endTimeMs: 1050 }),
      makeSpan({
        spanId: 'callee',
        name: 'handleAsync',
        startTimeMs: 1200, // started 150ms after caller ended
        endTimeMs: 1300,
        attributes: { 'function.caller.spanId': 'caller' },
      }),
    ];

    const graph = buildExecutionGraph(spans);
    const asyncEdges = graph.edges.filter(e => e.type === 'async_scheduled_by');
    expect(asyncEdges.length).toBe(1);
    expect(asyncEdges[0].sourceNodeId).toBe('node_caller');
    expect(asyncEdges[0].targetNodeId).toBe('node_callee');
  });

  it('does NOT create async edge if caller and callee overlap (synchronous)', () => {
    const spans = [
      makeSpan({ spanId: 'caller', name: 'dispatch', startTimeMs: 1000, endTimeMs: 1100 }),
      makeSpan({
        spanId: 'callee',
        name: 'handleSync',
        startTimeMs: 1020, // started while caller was still running
        endTimeMs: 1080,
        attributes: { 'function.caller.spanId': 'caller' },
      }),
    ];

    const graph = buildExecutionGraph(spans);
    const asyncEdges = graph.edges.filter(e => e.type === 'async_scheduled_by');
    expect(asyncEdges.length).toBe(0);
  });

  it('does NOT create async edge if gap is ≤5ms (considered synchronous)', () => {
    const spans = [
      makeSpan({ spanId: 'caller', name: 'dispatch', startTimeMs: 1000, endTimeMs: 1050 }),
      makeSpan({
        spanId: 'callee',
        name: 'handleNext',
        startTimeMs: 1054, // only 4ms gap — within the 5ms threshold
        endTimeMs: 1100,
        attributes: { 'function.caller.spanId': 'caller' },
      }),
    ];

    const graph = buildExecutionGraph(spans);
    const asyncEdges = graph.edges.filter(e => e.type === 'async_scheduled_by');
    expect(asyncEdges.length).toBe(0);
  });

  it('does NOT create async edge if caller span is missing from trace', () => {
    const spans = [
      makeSpan({
        spanId: 'callee',
        name: 'orphanedCallback',
        startTimeMs: 2000,
        endTimeMs: 2100,
        attributes: { 'function.caller.spanId': 'missing-caller' },
      }),
    ];

    const graph = buildExecutionGraph(spans);
    const asyncEdges = graph.edges.filter(e => e.type === 'async_scheduled_by');
    expect(asyncEdges.length).toBe(0);
  });
});

// ─── Error Causation Edge Cases ──────────────────────────────────────────────

describe('error causation edges', () => {
  it('no caused_error edge when child errors but parent is OK', () => {
    const spans = [
      makeSpan({ spanId: 'parent', name: 'handler', statusCode: 'STATUS_CODE_OK' }),
      makeSpan({ spanId: 'child', parentSpanId: 'parent', name: 'task', statusCode: 'STATUS_CODE_ERROR' }),
    ];

    const graph = buildExecutionGraph(spans);
    const errorEdges = graph.edges.filter(e => e.type === 'caused_error');
    expect(errorEdges.length).toBe(0);
  });

  it('no caused_error edge for error root span (no parent)', () => {
    const spans = [
      makeSpan({ spanId: 'root', name: 'root', statusCode: 'STATUS_CODE_ERROR' }),
    ];

    const graph = buildExecutionGraph(spans);
    const errorEdges = graph.edges.filter(e => e.type === 'caused_error');
    expect(errorEdges.length).toBe(0);
  });

  it('creates caused_error chain for multi-level error propagation', () => {
    const spans = [
      makeSpan({ spanId: 'grandparent', name: 'gp', statusCode: 'STATUS_CODE_ERROR' }),
      makeSpan({ spanId: 'parent', parentSpanId: 'grandparent', name: 'p', statusCode: 'STATUS_CODE_ERROR' }),
      makeSpan({ spanId: 'child', parentSpanId: 'parent', name: 'c', statusCode: 'STATUS_CODE_ERROR' }),
    ];

    const graph = buildExecutionGraph(spans);
    const errorEdges = graph.edges.filter(e => e.type === 'caused_error');
    expect(errorEdges.length).toBe(2); // child→parent and parent→grandparent
  });
});

// ─── Degenerate Input ────────────────────────────────────────────────────────

describe('degenerate and edge-case input', () => {
  it('handles a single span with no parent', () => {
    const spans = [makeSpan({ spanId: 'solo', name: 'GET /' })];
    const graph = buildExecutionGraph(spans);

    expect(graph.nodes.length).toBe(1);
    expect(graph.edges.filter(e => e.type === 'parent_child').length).toBe(0);
  });

  it('handles spans with empty attributes object', () => {
    const spans = [makeSpan({ spanId: 's1', name: 'bare', attributes: {} })];
    const graph = buildExecutionGraph(spans);
    expect(graph.nodes[0].type).toBe('span');
    expect(graph.nodes[0].sourceLocation).toBeUndefined();
  });

  it('handles spans with no events array', () => {
    const span = makeSpan({ spanId: 's1', name: 'no-events' });
    delete (span as any).events;
    const snapshots = extractValueSnapshots([span]);
    // Should not crash, just return no exception snapshots
    expect(snapshots.filter(s => s.boundary === 'exception').length).toBe(0);
  });

  it('handles span where parentSpanId references non-existent span', () => {
    const spans = [
      makeSpan({ spanId: 'orphan', parentSpanId: 'ghost', name: 'orphan-span' }),
    ];
    const graph = buildExecutionGraph(spans);
    // No parent_child edge since the parent doesn't exist
    expect(graph.edges.filter(e => e.type === 'parent_child').length).toBe(0);
  });

  it('summary uses first span as root if none has empty parentSpanId', () => {
    const spans = [
      makeSpan({ spanId: 'a', parentSpanId: 'ghost', name: 'first-span', startTimeMs: 1000, endTimeMs: 1100 }),
      makeSpan({ spanId: 'b', parentSpanId: 'ghost', name: 'second-span', startTimeMs: 1050, endTimeMs: 1150 }),
    ];
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);
    expect(summary.rootSpanName).toBe('first-span');
  });

  it('buildTraceRun handles empty spans array', () => {
    const run = buildTraceRun([]);
    expect(run.id).toBe('');
    expect(run.status).toBe('partial');
    expect(run.spanCount).toBe(0);
  });

  it('buildTraceSummary handles empty spans array', () => {
    const graph = buildExecutionGraph([]);
    const summary = buildTraceSummary([], graph);
    expect(summary.traceId).toBe('');
    expect(summary.spanCount).toBe(0);
    expect(summary.requestPath).toEqual([]);
  });
});

// ─── Value Snapshot Edge Cases ───────────────────────────────────────────────

describe('extractValueSnapshots edge cases', () => {
  it('truncates preview to 200 characters', () => {
    const longValue = 'x'.repeat(500);
    const spans = [makeSpan({
      spanId: 's1',
      attributes: { 'function.args.0': longValue },
    })];

    const snapshots = extractValueSnapshots(spans);
    expect(snapshots[0].preview.length).toBe(200);
    expect(snapshots[0].fullValue).toBe(longValue);
  });

  it('skips empty string arguments', () => {
    const spans = [makeSpan({
      spanId: 's1',
      attributes: { 'function.args.0': '', 'function.args.1': 'real' },
    })];

    const snapshots = extractValueSnapshots(spans);
    const args = snapshots.filter(s => s.boundary === 'entry');
    expect(args.length).toBe(1);
    expect(args[0].name).toBe('arg1');
  });

  it('skips empty string return value', () => {
    const spans = [makeSpan({
      spanId: 's1',
      attributes: { 'function.return.value': '' },
    })];

    const snapshots = extractValueSnapshots(spans);
    expect(snapshots.filter(s => s.boundary === 'exit').length).toBe(0);
  });

  it('captures numeric zero as a valid argument', () => {
    const spans = [makeSpan({
      spanId: 's1',
      attributes: { 'function.args.0': 0 },
    })];

    const snapshots = extractValueSnapshots(spans);
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].preview).toBe('0');
  });

  it('captures boolean false as a valid argument', () => {
    const spans = [makeSpan({
      spanId: 's1',
      attributes: { 'function.args.0': false },
    })];

    const snapshots = extractValueSnapshots(spans);
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].preview).toBe('false');
  });

  it('handles exception event with no attributes', () => {
    const spans = [makeSpan({
      spanId: 's1',
      events: [{ name: 'exception' }],
    })];

    const snapshots = extractValueSnapshots(spans);
    const exc = snapshots.find(s => s.boundary === 'exception');
    expect(exc).toBeDefined();
    expect(exc!.preview).toBe('Unknown');
  });

  it('captures multiple exception events from one span', () => {
    const spans = [makeSpan({
      spanId: 's1',
      events: [
        { name: 'exception', attributes: { 'exception.message': 'first error' } },
        { name: 'exception', attributes: { 'exception.message': 'second error' } },
      ],
    })];

    const snapshots = extractValueSnapshots(spans);
    const exceptions = snapshots.filter(s => s.boundary === 'exception');
    expect(exceptions.length).toBe(2);
    expect(exceptions[0].preview).toBe('first error');
    expect(exceptions[1].preview).toBe('second error');
  });

  it('captures up to 10 arguments (args.0 through args.9)', () => {
    const attrs: Record<string, any> = {};
    for (let i = 0; i < 12; i++) {
      attrs[`function.args.${i}`] = `val-${i}`;
    }
    const spans = [makeSpan({ spanId: 's1', attributes: attrs })];
    const snapshots = extractValueSnapshots(spans);
    const args = snapshots.filter(s => s.boundary === 'entry');
    // Only args.0 through args.9 are captured (10 total)
    expect(args.length).toBe(10);
    expect(args[9].name).toBe('arg9');
  });
});

// ─── compareTraces Edge Cases ────────────────────────────────────────────────

describe('compareTraces edge cases', () => {
  it('handles empty good and bad traces', () => {
    const result = compareTraces([], []);
    expect(result.divergences.length).toBe(0);
    expect(result.summary).toContain('No divergences');
  });

  it('handles empty good trace vs non-empty bad trace', () => {
    const bad = [makeSpan({ spanId: 's1', name: 'orphan' })];
    const result = compareTraces([], bad);
    expect(result.extraSpans.length).toBe(1);
  });

  it('handles non-empty good trace vs empty bad trace', () => {
    const good = [makeSpan({ spanId: 's1', name: 'expected' })];
    const result = compareTraces(good, []);
    expect(result.missingSpans.length).toBe(1);
  });

  it('only compares first span when multiple spans share the same name', () => {
    // This documents current behavior: groupByName creates arrays but
    // compareTraces only looks at [0] of each group
    const good = [
      makeSpan({ spanId: 'g1', name: 'retry', statusCode: 'STATUS_CODE_OK' }),
      makeSpan({ spanId: 'g2', name: 'retry', statusCode: 'STATUS_CODE_ERROR' }),
    ];
    const bad = [
      makeSpan({ spanId: 'b1', name: 'retry', statusCode: 'STATUS_CODE_OK' }),
      makeSpan({ spanId: 'b2', name: 'retry', statusCode: 'STATUS_CODE_OK' }),
    ];

    const result = compareTraces(good, bad);
    // Only first "retry" is compared (both are OK), so no status_diff
    const statusDiffs = result.divergences.filter(d => d.type === 'status_diff');
    expect(statusDiffs.length).toBe(0);
  });

  it('detects duration anomaly (>5x slower)', () => {
    const good = [makeSpan({ spanId: 'g1', name: 'query', durationMs: 10 })];
    const bad = [makeSpan({ spanId: 'b1', name: 'query', durationMs: 60 })];

    const result = compareTraces(good, bad);
    const durationDiffs = result.divergences.filter(d => d.type === 'duration_diff');
    expect(durationDiffs.length).toBe(1);
    expect(durationDiffs[0].severity).toBe('info');
  });

  it('does NOT flag duration anomaly for small ratios (<5x)', () => {
    const good = [makeSpan({ spanId: 'g1', name: 'query', durationMs: 10 })];
    const bad = [makeSpan({ spanId: 'b1', name: 'query', durationMs: 40 })]; // 4x

    const result = compareTraces(good, bad);
    const durationDiffs = result.divergences.filter(d => d.type === 'duration_diff');
    expect(durationDiffs.length).toBe(0);
  });

  it('does NOT flag duration anomaly when either duration is 0', () => {
    const good = [makeSpan({ spanId: 'g1', name: 'instant', durationMs: 0 })];
    const bad = [makeSpan({ spanId: 'b1', name: 'instant', durationMs: 100 })];

    const result = compareTraces(good, bad);
    const durationDiffs = result.divergences.filter(d => d.type === 'duration_diff');
    expect(durationDiffs.length).toBe(0);
  });

  it('sorts divergences: critical before warning before info', () => {
    const good = [
      makeSpan({ spanId: 'g1', name: 'handler', statusCode: 'STATUS_CODE_OK', durationMs: 10 }),
      makeSpan({ spanId: 'g2', name: 'extra-step' }),
    ];
    const bad = [
      makeSpan({ spanId: 'b1', name: 'handler', statusCode: 'STATUS_CODE_ERROR', durationMs: 100 }),
      // extra-step is missing → critical (missing_span)
      makeSpan({ spanId: 'b3', name: 'new-thing' }), // extra → warning
    ];

    const result = compareTraces(good, bad);
    const severities = result.divergences.map(d => d.severity);
    // All critical divergences should come before warning, which come before info
    const criticalIdx = severities.lastIndexOf('critical');
    const warningIdx = severities.indexOf('warning');
    const infoIdx = severities.indexOf('info');

    if (criticalIdx >= 0 && warningIdx >= 0) {
      expect(criticalIdx).toBeLessThan(warningIdx);
    }
    if (warningIdx >= 0 && infoIdx >= 0) {
      expect(warningIdx).toBeLessThan(infoIdx);
    }
  });
});

// ─── Suspiciousness Score Edge Cases ─────────────────────────────────────────

describe('suspiciousness score', () => {
  it('is 0 for a healthy trace', () => {
    const spans = [
      makeSpan({ spanId: 'root', name: 'GET /', durationMs: 50 }),
      makeSpan({ spanId: 'child', parentSpanId: 'root', name: 'query', durationMs: 20 }),
    ];
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);
    expect(summary.suspiciousnessScore).toBe(0);
  });

  it('caps at 100 even with many error signals', () => {
    // 5 errors (150) + 5 exceptions (200) + 5 slow (50) = 400, capped at 100
    const spans = Array.from({ length: 5 }, (_, i) => makeSpan({
      spanId: `s${i}`,
      name: `error-${i}`,
      statusCode: 'STATUS_CODE_ERROR',
      durationMs: 2000,
      events: [{ name: 'exception', attributes: { 'exception.type': 'Error' } }],
    }));
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);
    expect(summary.suspiciousnessScore).toBe(100);
  });

  it('accounts for slow spans (>1s)', () => {
    const spans = [
      makeSpan({ spanId: 'root', name: 'slow-root', durationMs: 2000 }),
    ];
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);
    expect(summary.suspiciousnessScore).toBe(10);
  });

  it('accounts for orphan spans', () => {
    const spans = [
      makeSpan({ spanId: 'root', name: 'root' }),
      makeSpan({ spanId: 'orphan', parentSpanId: 'ghost', name: 'orphan' }),
    ];
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);
    expect(summary.suspiciousnessScore).toBe(15);
  });
});

// ─── Request Path Edge Cases ─────────────────────────────────────────────────

describe('request path edge cases', () => {
  it('returns single-step path for a trace with no children', () => {
    const spans = [makeSpan({ spanId: 'root', name: 'GET /', durationMs: 50 })];
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);
    expect(summary.requestPath.length).toBe(1);
    expect(summary.requestPath[0].name).toBe('GET /');
  });

  it('picks longer child when two siblings have equal priority (no errors)', () => {
    const spans = [
      makeSpan({ spanId: 'root', name: 'root', startTimeMs: 1000, endTimeMs: 1200, durationMs: 200 }),
      makeSpan({ spanId: 'short', parentSpanId: 'root', name: 'short', durationMs: 30 }),
      makeSpan({ spanId: 'long', parentSpanId: 'root', name: 'long', durationMs: 150 }),
    ];
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);
    expect(summary.requestPath[1].name).toBe('long');
  });

  it('does not loop on cyclic parentSpanId references', () => {
    // Degenerate: two spans referencing each other as parent
    // buildRequestPath uses a visited set, so it should terminate
    const spans = [
      makeSpan({ spanId: 'a', parentSpanId: 'b', name: 'span-a' }),
      makeSpan({ spanId: 'b', parentSpanId: 'a', name: 'span-b' }),
    ];
    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);
    // Should terminate without infinite loop; path length is finite
    expect(summary.requestPath.length).toBeLessThanOrEqual(2);
  });
});

// ─── buildTraceRun Edge Cases ────────────────────────────────────────────────

describe('buildTraceRun edge cases', () => {
  it('detects hasExceptions flag', () => {
    const spans = [makeSpan({
      spanId: 's1',
      name: 'failing',
      events: [{ name: 'exception', attributes: { 'exception.type': 'Error' } }],
    })];
    const run = buildTraceRun(spans);
    expect(run.hasExceptions).toBe(true);
  });

  it('hasExceptions is false when no exception events', () => {
    const spans = [makeSpan({ spanId: 's1', name: 'ok' })];
    const run = buildTraceRun(spans);
    expect(run.hasExceptions).toBe(false);
  });

  it('calculates duration from min/max timestamps', () => {
    const spans = [
      makeSpan({ spanId: 'a', startTimeMs: 100, endTimeMs: 200 }),
      makeSpan({ spanId: 'b', startTimeMs: 150, endTimeMs: 500 }),
    ];
    const run = buildTraceRun(spans);
    expect(run.startTime).toBe(100);
    expect(run.endTime).toBe(500);
    expect(run.durationMs).toBe(400);
  });

  it('uses root span (no parentSpanId) for serviceName and rootSpanName', () => {
    const spans = [
      makeSpan({ spanId: 'root', name: 'entrypoint', serviceName: 'gateway' }),
      makeSpan({ spanId: 'child', parentSpanId: 'root', name: 'downstream', serviceName: 'backend' }),
    ];
    const run = buildTraceRun(spans);
    expect(run.serviceName).toBe('gateway');
    expect(run.rootSpanName).toBe('entrypoint');
  });

  it('defaults to first span when no root span exists', () => {
    const spans = [
      makeSpan({ spanId: 'a', parentSpanId: 'missing', name: 'first-orphan', serviceName: 'svc-a' }),
      makeSpan({ spanId: 'b', parentSpanId: 'missing', name: 'second-orphan', serviceName: 'svc-b' }),
    ];
    const run = buildTraceRun(spans);
    expect(run.rootSpanName).toBe('first-orphan');
    expect(run.serviceName).toBe('svc-a');
  });
});
