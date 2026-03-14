/**
 * Tests for the DeepTrace enrichment engine.
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

// ─── Test Data Helpers ───────────────────────────────────────────────────────

function makeSpan(overrides: Partial<RawSpan> = {}): RawSpan {
  return {
    traceId: 'trace-001',
    spanId: overrides.spanId || `span-${Math.random().toString(36).slice(2, 8)}`,
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

// ─── Execution Graph Tests ───────────────────────────────────────────────────

describe('buildExecutionGraph', () => {
  it('builds an empty graph from empty spans', () => {
    const graph = buildExecutionGraph([]);
    expect(graph.traceId).toBe('');
    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });

  it('creates nodes from spans', () => {
    const spans = [
      makeSpan({ spanId: 'root', name: 'root-span' }),
      makeSpan({ spanId: 'child', parentSpanId: 'root', name: 'child-span' }),
    ];

    const graph = buildExecutionGraph(spans);
    expect(graph.traceId).toBe('trace-001');
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes[0].name).toBe('root-span');
    expect(graph.nodes[1].name).toBe('child-span');
  });

  it('creates parent-child edges', () => {
    const spans = [
      makeSpan({ spanId: 'root', name: 'root' }),
      makeSpan({ spanId: 'child', parentSpanId: 'root', name: 'child' }),
    ];

    const graph = buildExecutionGraph(spans);
    const pcEdges = graph.edges.filter(e => e.type === 'parent_child');
    expect(pcEdges).toHaveLength(1);
    expect(pcEdges[0].sourceNodeId).toBe('node_root');
    expect(pcEdges[0].targetNodeId).toBe('node_child');
  });

  it('classifies HTTP spans as network_request', () => {
    const spans = [
      makeSpan({ spanId: 's1', name: 'GET /api/data', attributes: { 'http.method': 'GET' } }),
    ];

    const graph = buildExecutionGraph(spans);
    expect(graph.nodes[0].type).toBe('network_request');
  });

  it('classifies DB spans as db_query', () => {
    const spans = [
      makeSpan({ spanId: 's1', name: 'query', attributes: { 'db.system': 'postgresql' } }),
    ];

    const graph = buildExecutionGraph(spans);
    expect(graph.nodes[0].type).toBe('db_query');
  });

  it('classifies exception events correctly', () => {
    const spans = [
      makeSpan({
        spanId: 's1',
        name: 'failing-fn',
        statusCode: 'STATUS_CODE_ERROR',
        events: [{ name: 'exception', attributes: { 'exception.type': 'Error', 'exception.message': 'boom' } }],
      }),
    ];

    const graph = buildExecutionGraph(spans);
    expect(graph.nodes[0].type).toBe('exception');
  });

  it('creates source_mapped_to edges for spans with source locations', () => {
    const spans = [
      makeSpan({ spanId: 's1', attributes: { 'code.filepath': 'app/test.ts', 'code.lineno': 42 } }),
    ];

    const graph = buildExecutionGraph(spans);
    const srcEdges = graph.edges.filter(e => e.type === 'source_mapped_to');
    expect(srcEdges).toHaveLength(1);
    expect(srcEdges[0].targetNodeId).toBe('src_app/test.ts:42');
  });

  it('creates error causation edges', () => {
    const spans = [
      makeSpan({ spanId: 'parent', name: 'parent', statusCode: 'STATUS_CODE_ERROR' }),
      makeSpan({ spanId: 'child', parentSpanId: 'parent', name: 'child', statusCode: 'STATUS_CODE_ERROR' }),
    ];

    const graph = buildExecutionGraph(spans);
    const errorEdges = graph.edges.filter(e => e.type === 'caused_error');
    expect(errorEdges).toHaveLength(1);
  });

  it('creates query_issued edges for DB queries', () => {
    const spans = [
      makeSpan({ spanId: 'handler', name: 'handler' }),
      makeSpan({ spanId: 'query', parentSpanId: 'handler', name: 'SELECT users', attributes: { 'db.statement': 'SELECT * FROM users' } }),
    ];

    const graph = buildExecutionGraph(spans);
    const queryEdges = graph.edges.filter(e => e.type === 'query_issued');
    expect(queryEdges).toHaveLength(1);
  });

  it('extracts source location metadata', () => {
    const spans = [
      makeSpan({
        spanId: 's1',
        attributes: {
          'code.filepath': 'app/services/auth.ts',
          'code.lineno': 55,
          'code.column': 10,
          'function.name': 'authenticate',
        },
      }),
    ];

    const graph = buildExecutionGraph(spans);
    expect(graph.nodes[0].sourceLocation).toEqual({
      filePath: 'app/services/auth.ts',
      line: 55,
      column: 10,
      functionName: 'authenticate',
      gitSha: undefined,
      buildId: undefined,
    });
  });

  it('sets node status correctly', () => {
    const spans = [
      makeSpan({ spanId: 's1', statusCode: 'STATUS_CODE_ERROR', statusMessage: 'boom' }),
      makeSpan({ spanId: 's2', statusCode: 'STATUS_CODE_OK' }),
      makeSpan({ spanId: 's3', statusCode: 'STATUS_CODE_UNSET' }),
    ];

    const graph = buildExecutionGraph(spans);
    expect(graph.nodes[0].status).toBe('error');
    expect(graph.nodes[0].statusMessage).toBe('boom');
    expect(graph.nodes[1].status).toBe('ok');
    expect(graph.nodes[2].status).toBe('unset');
  });
});

// ─── Value Snapshot Tests ────────────────────────────────────────────────────

describe('extractValueSnapshots', () => {
  it('extracts function arguments', () => {
    const spans = [
      makeSpan({
        spanId: 's1',
        attributes: { 'function.args.0': 'hello', 'function.args.1': '42' },
      }),
    ];

    const snapshots = extractValueSnapshots(spans);
    const args = snapshots.filter(s => s.boundary === 'entry');
    expect(args).toHaveLength(2);
    expect(args[0].name).toBe('arg0');
    expect(args[0].preview).toBe('hello');
  });

  it('extracts return values', () => {
    const spans = [
      makeSpan({
        spanId: 's1',
        attributes: { 'function.return.value': '{"result": true}' },
      }),
    ];

    const snapshots = extractValueSnapshots(spans);
    const returns = snapshots.filter(s => s.boundary === 'exit');
    expect(returns).toHaveLength(1);
    expect(returns[0].name).toBe('return');
    expect(returns[0].preview).toBe('{"result": true}');
  });

  it('extracts component props', () => {
    const spans = [
      makeSpan({
        spanId: 's1',
        attributes: { 'component.props': '{"title":"Hello"}' },
      }),
    ];

    const snapshots = extractValueSnapshots(spans);
    const props = snapshots.filter(s => s.name === 'props');
    expect(props).toHaveLength(1);
  });

  it('extracts exception events', () => {
    const spans = [
      makeSpan({
        spanId: 's1',
        events: [{ name: 'exception', attributes: { 'exception.type': 'TypeError', 'exception.message': 'null ref' } }],
      }),
    ];

    const snapshots = extractValueSnapshots(spans);
    const exceptions = snapshots.filter(s => s.boundary === 'exception');
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0].preview).toBe('null ref');
  });
});

// ─── Trace Summary Tests ─────────────────────────────────────────────────────

describe('buildTraceSummary', () => {
  it('computes basic trace metrics', () => {
    const spans = [
      makeSpan({ spanId: 'root', name: 'GET /api', serviceName: 'web', startTimeMs: 1000, endTimeMs: 1100 }),
      makeSpan({ spanId: 'child', parentSpanId: 'root', name: 'query', serviceName: 'db', startTimeMs: 1020, endTimeMs: 1080 }),
    ];

    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);

    expect(summary.traceId).toBe('trace-001');
    expect(summary.rootSpanName).toBe('GET /api');
    expect(summary.spanCount).toBe(2);
    expect(summary.services).toContain('web');
    expect(summary.services).toContain('db');
    expect(summary.durationMs).toBe(100); // 1100 - 1000
  });

  it('counts errors and exceptions', () => {
    const spans = [
      makeSpan({ spanId: 'root', name: 'handler', statusCode: 'STATUS_CODE_ERROR' }),
      makeSpan({
        spanId: 'child', parentSpanId: 'root', name: 'failing',
        statusCode: 'STATUS_CODE_ERROR',
        events: [{ name: 'exception', attributes: { 'exception.type': 'Error', 'exception.message': 'fail' } }],
      }),
    ];

    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);

    expect(summary.errorCount).toBe(2);
    expect(summary.exceptionCount).toBe(1);
    expect(summary.exceptions).toHaveLength(1);
    expect(summary.exceptions[0].type).toBe('Error');
    expect(summary.exceptions[0].message).toBe('fail');
  });

  it('builds request path following critical path', () => {
    const spans = [
      makeSpan({ spanId: 'root', name: 'GET /', startTimeMs: 0, endTimeMs: 100, durationMs: 100 }),
      makeSpan({ spanId: 'fast', parentSpanId: 'root', name: 'fast-op', startTimeMs: 10, endTimeMs: 20, durationMs: 10 }),
      makeSpan({ spanId: 'slow', parentSpanId: 'root', name: 'slow-op', startTimeMs: 10, endTimeMs: 90, durationMs: 80 }),
      makeSpan({ spanId: 'inner', parentSpanId: 'slow', name: 'inner', startTimeMs: 20, endTimeMs: 80, durationMs: 60 }),
    ];

    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);

    // Critical path should follow: root → slow → inner (longest children)
    expect(summary.requestPath.length).toBeGreaterThanOrEqual(3);
    expect(summary.requestPath[0].name).toBe('GET /');
    expect(summary.requestPath[1].name).toBe('slow-op');
    expect(summary.requestPath[2].name).toBe('inner');
  });

  it('prefers error path over slow path', () => {
    const spans = [
      makeSpan({ spanId: 'root', name: 'root', durationMs: 100, statusCode: 'STATUS_CODE_ERROR' }),
      makeSpan({ spanId: 'ok', parentSpanId: 'root', name: 'ok-child', durationMs: 80 }),
      makeSpan({ spanId: 'err', parentSpanId: 'root', name: 'err-child', durationMs: 20, statusCode: 'STATUS_CODE_ERROR' }),
    ];

    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);

    expect(summary.requestPath[1].name).toBe('err-child');
  });

  it('computes suspiciousness score', () => {
    const spans = [
      makeSpan({ spanId: 's1', statusCode: 'STATUS_CODE_ERROR' }),
      makeSpan({
        spanId: 's2',
        events: [{ name: 'exception', attributes: { 'exception.type': 'Error', 'exception.message': 'boom' } }],
      }),
    ];

    const graph = buildExecutionGraph(spans);
    const summary = buildTraceSummary(spans, graph);

    expect(summary.suspiciousnessScore).toBeGreaterThan(0);
  });
});

// ─── Trace Comparison Tests ──────────────────────────────────────────────────

describe('compareTraces', () => {
  it('detects identical traces', () => {
    const spans = [
      makeSpan({ spanId: 's1', name: 'handler', statusCode: 'STATUS_CODE_OK' }),
      makeSpan({ spanId: 's2', name: 'query', statusCode: 'STATUS_CODE_OK' }),
    ];

    const result = compareTraces(spans, spans);
    expect(result.divergences).toHaveLength(0);
    expect(result.summary).toContain('No divergences');
  });

  it('detects missing spans', () => {
    const good = [
      makeSpan({ spanId: 's1', name: 'handler' }),
      makeSpan({ spanId: 's2', name: 'query' }),
      makeSpan({ spanId: 's3', name: 'cache-lookup' }),
    ];
    const bad = [
      makeSpan({ spanId: 's4', name: 'handler' }),
      makeSpan({ spanId: 's5', name: 'query' }),
    ];

    const result = compareTraces(good, bad);
    expect(result.missingSpans).toHaveLength(1);
    expect(result.missingSpans[0].spanName).toBe('cache-lookup');
  });

  it('detects extra spans', () => {
    const good = [makeSpan({ spanId: 's1', name: 'handler' })];
    const bad = [
      makeSpan({ spanId: 's2', name: 'handler' }),
      makeSpan({ spanId: 's3', name: 'unexpected-retry' }),
    ];

    const result = compareTraces(good, bad);
    expect(result.extraSpans).toHaveLength(1);
    expect(result.extraSpans[0].spanName).toBe('unexpected-retry');
  });

  it('detects status differences', () => {
    const good = [makeSpan({ spanId: 's1', name: 'processOrder', statusCode: 'STATUS_CODE_OK' })];
    const bad = [makeSpan({ spanId: 's2', name: 'processOrder', statusCode: 'STATUS_CODE_ERROR' })];

    const result = compareTraces(good, bad);
    const statusDiffs = result.divergences.filter(d => d.type === 'status_diff');
    expect(statusDiffs).toHaveLength(1);
    expect(statusDiffs[0].severity).toBe('critical');
  });

  it('detects return value differences', () => {
    const good = [makeSpan({
      spanId: 's1', name: 'calculate',
      attributes: { 'function.return.value': '100' },
    })];
    const bad = [makeSpan({
      spanId: 's2', name: 'calculate',
      attributes: { 'function.return.value': '0' },
    })];

    const result = compareTraces(good, bad);
    const valueDiffs = result.divergences.filter(d => d.type === 'value_diff');
    expect(valueDiffs).toHaveLength(1);
    expect(valueDiffs[0].goodValue).toBe('100');
    expect(valueDiffs[0].badValue).toBe('0');
  });

  it('identifies first divergence (critical first)', () => {
    const good = [
      makeSpan({ spanId: 's1', name: 'step1', statusCode: 'STATUS_CODE_OK' }),
      makeSpan({ spanId: 's2', name: 'step2', statusCode: 'STATUS_CODE_OK', attributes: { 'function.return.value': 'a' } }),
    ];
    const bad = [
      makeSpan({ spanId: 's3', name: 'step1', statusCode: 'STATUS_CODE_ERROR' }),
      makeSpan({ spanId: 's4', name: 'step2', statusCode: 'STATUS_CODE_OK', attributes: { 'function.return.value': 'b' } }),
    ];

    const result = compareTraces(good, bad);
    expect(result.firstDivergence).toBeDefined();
    expect(result.firstDivergence!.severity).toBe('critical');
    expect(result.firstDivergence!.type).toBe('status_diff');
  });
});

// ─── Trace Run Tests ─────────────────────────────────────────────────────────

describe('buildTraceRun', () => {
  it('builds a run from spans', () => {
    const spans = [
      makeSpan({ spanId: 'root', name: 'GET /', serviceName: 'web', startTimeMs: 1000, endTimeMs: 1100 }),
      makeSpan({ spanId: 'child', parentSpanId: 'root', name: 'query', serviceName: 'db', startTimeMs: 1020, endTimeMs: 1080 }),
    ];

    const run = buildTraceRun(spans, 'test-run', ['good']);
    expect(run.traceId).toBe('trace-001');
    expect(run.label).toBe('test-run');
    expect(run.tags).toEqual(['good']);
    expect(run.services).toContain('web');
    expect(run.services).toContain('db');
    expect(run.spanCount).toBe(2);
    expect(run.status).toBe('success');
  });

  it('marks runs with errors', () => {
    const spans = [
      makeSpan({ spanId: 'root', statusCode: 'STATUS_CODE_ERROR' }),
    ];

    const run = buildTraceRun(spans);
    expect(run.status).toBe('error');
    expect(run.errorCount).toBe(1);
  });
});
