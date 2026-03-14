/**
 * DeepTrace Enrichment Engine
 *
 * Derives a causal execution graph from raw OTel spans.
 * This is the core intelligence of DeepTrace — it takes flat spans
 * and produces the graph model with typed nodes and causal edges.
 */

import type {
  GraphNode, GraphEdge, ExecutionGraph, NodeType, EdgeType,
  SourceLocation, TraceSummary, RequestPathStep, ExceptionInfo,
  ValueSnapshot, TraceRun,
} from './types';

// ─── Internal Span Representation ────────────────────────────────────────────

export interface RawSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  serviceName: string;
  kind?: string;
  durationMs: number;
  statusCode: string;
  statusMessage?: string;
  timestamp: string;
  startTimeMs: number;
  endTimeMs: number;
  attributes: Record<string, any>;
  events?: Array<{ name: string; timestamp?: string; attributes?: Record<string, any> }>;
}

// ─── Node Type Classification ────────────────────────────────────────────────

function classifyNodeType(span: RawSpan): NodeType {
  const attrs = span.attributes;
  const name = span.name.toLowerCase();

  // Exception events
  if (span.events?.some(e => e.name === 'exception')) return 'exception';

  // DB queries
  if (attrs['db.system'] || attrs['db.statement'] || name.includes('query') || name.includes('database')) {
    return 'db_query';
  }

  // Network requests (HTTP)
  if (attrs['http.method'] || attrs['http.request.method'] ||
      name.startsWith('fetch ') || name.startsWith('http ') ||
      name.startsWith('GET ') || name.startsWith('POST ') ||
      name.startsWith('PUT ') || name.startsWith('DELETE ') ||
      name.startsWith('PATCH ')) {
    return 'network_request';
  }

  // Async tasks
  if (name.includes('setTimeout') || name.includes('setInterval') ||
      name.includes('promise') || name.includes('async') ||
      attrs['dt.async_type']) {
    return 'async_task';
  }

  // User actions
  if (attrs['dt.user_action'] || name.includes('click') || name.includes('submit') ||
      name.includes('input') || name.includes('navigation')) {
    return 'user_action';
  }

  // Message/job
  if (attrs['messaging.system'] || name.includes('publish') || name.includes('consume')) {
    return 'message_job';
  }

  // React components
  if (attrs['code.function.type'] === 'react_component' || attrs['component.name']) {
    return 'logical_operation';
  }

  return 'span';
}

// ─── Source Location Extraction ──────────────────────────────────────────────

function extractSourceLocation(attrs: Record<string, any>): SourceLocation | undefined {
  if (!attrs['code.filepath']) return undefined;
  return {
    filePath: attrs['code.filepath'],
    line: attrs['code.lineno'],
    column: attrs['code.column'],
    functionName: attrs['function.name'],
    gitSha: attrs['dt.git_sha'],
    buildId: attrs['dt.build_id'],
  };
}

// ─── Build Graph Nodes ───────────────────────────────────────────────────────

function spanToNode(span: RawSpan): GraphNode {
  return {
    id: `node_${span.spanId}`,
    type: classifyNodeType(span),
    traceId: span.traceId,
    spanId: span.spanId,
    name: span.name,
    serviceName: span.serviceName,
    startTime: span.startTimeMs,
    endTime: span.endTimeMs,
    durationMs: span.durationMs,
    attributes: span.attributes,
    sourceLocation: extractSourceLocation(span.attributes),
    status: span.statusCode === 'STATUS_CODE_ERROR' ? 'error'
      : span.statusCode === 'STATUS_CODE_OK' ? 'ok' : 'unset',
    statusMessage: span.statusMessage,
  };
}

// ─── Build Graph Edges ───────────────────────────────────────────────────────

let edgeCounter = 0;

function makeEdge(type: EdgeType, sourceId: string, targetId: string, traceId: string, attrs?: Record<string, any>): GraphEdge {
  return {
    id: `edge_${++edgeCounter}`,
    type,
    sourceNodeId: sourceId,
    targetNodeId: targetId,
    traceId,
    attributes: attrs,
  };
}

function deriveEdges(spans: RawSpan[], nodes: GraphNode[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const spanMap = new Map(spans.map(s => [s.spanId, s]));
  const nodeMap = new Map(nodes.map(n => [n.spanId!, n]));

  for (const span of spans) {
    const nodeId = `node_${span.spanId}`;

    // 1. Parent-child edges
    if (span.parentSpanId && spanMap.has(span.parentSpanId)) {
      edges.push(makeEdge('parent_child', `node_${span.parentSpanId}`, nodeId, span.traceId));
    }

    // 2. Cross-service request edges (browser fetch → server handler)
    if (span.attributes['http.method'] || span.attributes['http.request.method']) {
      const url = span.attributes['http.url'] || span.attributes['http.target'] || '';

      // Find matching server span for this request
      for (const other of spans) {
        if (other.spanId === span.spanId) continue;
        if (other.serviceName === span.serviceName) continue;

        const otherIsHandler = other.attributes['http.method'] || other.attributes['http.request.method']
          || other.attributes['function.type'] === 'user_function';

        // Match by trace ID + timing overlap
        if (otherIsHandler && other.traceId === span.traceId &&
            other.startTimeMs >= span.startTimeMs - 100 &&
            other.startTimeMs <= span.endTimeMs + 100) {
          // Check if they share a URL path
          const otherUrl = other.attributes['http.url'] || other.attributes['http.target'] || other.name;
          if (otherUrl && url && (otherUrl.includes(url.split('?')[0]) || url.includes(otherUrl.split('?')[0]))) {
            edges.push(makeEdge('request_sent_to', nodeId, `node_${other.spanId}`, span.traceId));
            edges.push(makeEdge('request_handled_by', `node_${other.spanId}`, nodeId, span.traceId));
          }
        }
      }
    }

    // 3. Async edges (based on caller tracking)
    if (span.attributes['function.caller.spanId']) {
      const callerSpanId = span.attributes['function.caller.spanId'];
      if (spanMap.has(callerSpanId)) {
        const callerSpan = spanMap.get(callerSpanId)!;
        // If the caller ended before we started, this is an async hop
        if (callerSpan.endTimeMs < span.startTimeMs - 5) {
          edges.push(makeEdge('async_scheduled_by', `node_${callerSpanId}`, nodeId, span.traceId));
        }
      }
    }

    // 4. Error causation edges
    if (span.statusCode === 'STATUS_CODE_ERROR' && span.parentSpanId) {
      const parentNode = nodeMap.get(span.parentSpanId);
      if (parentNode && parentNode.status === 'error') {
        edges.push(makeEdge('caused_error', nodeId, `node_${span.parentSpanId}`, span.traceId));
      }
    }

    // 5. Source mapping edges
    if (span.attributes['code.filepath']) {
      // Source-mapped-to is an edge to a virtual source_location node
      const srcNodeId = `src_${span.attributes['code.filepath']}:${span.attributes['code.lineno'] || 0}`;
      // We only create these edges, the source_location nodes are virtual
      edges.push(makeEdge('source_mapped_to', nodeId, srcNodeId, span.traceId));
    }

    // 6. DB query edges
    if (span.attributes['db.statement'] || span.attributes['db.system']) {
      if (span.parentSpanId && spanMap.has(span.parentSpanId)) {
        edges.push(makeEdge('query_issued', `node_${span.parentSpanId}`, nodeId, span.traceId));
      }
    }
  }

  return edges;
}

// ─── Build Execution Graph ───────────────────────────────────────────────────

export function buildExecutionGraph(spans: RawSpan[]): ExecutionGraph {
  if (spans.length === 0) {
    return { traceId: '', nodes: [], edges: [] };
  }

  const traceId = spans[0].traceId;
  const nodes = spans.map(spanToNode);
  const edges = deriveEdges(spans, nodes);

  return { traceId, nodes, edges };
}

// ─── Extract Value Snapshots ─────────────────────────────────────────────────

export function extractValueSnapshots(spans: RawSpan[]): ValueSnapshot[] {
  const snapshots: ValueSnapshot[] = [];
  let counter = 0;

  for (const span of spans) {
    const attrs = span.attributes;

    // Function arguments
    for (let i = 0; i < 10; i++) {
      const argKey = `function.args.${i}`;
      if (attrs[argKey] !== undefined && attrs[argKey] !== '') {
        snapshots.push({
          id: `vs_${++counter}`,
          traceId: span.traceId,
          spanId: span.spanId,
          boundary: 'entry',
          name: `arg${i}`,
          typeClassification: typeof attrs[argKey],
          preview: String(attrs[argKey]).slice(0, 200),
          fullValue: String(attrs[argKey]),
          redactionTags: ['visible_to_human', 'visible_to_agent'],
          timestamp: span.startTimeMs,
        });
      }
    }

    // Return value
    if (attrs['function.return.value'] !== undefined && attrs['function.return.value'] !== '') {
      snapshots.push({
        id: `vs_${++counter}`,
        traceId: span.traceId,
        spanId: span.spanId,
        boundary: 'exit',
        name: 'return',
        typeClassification: typeof attrs['function.return.value'],
        preview: String(attrs['function.return.value']).slice(0, 200),
        fullValue: String(attrs['function.return.value']),
        redactionTags: ['visible_to_human', 'visible_to_agent'],
        timestamp: span.endTimeMs,
      });
    }

    // Component props
    if (attrs['component.props']) {
      snapshots.push({
        id: `vs_${++counter}`,
        traceId: span.traceId,
        spanId: span.spanId,
        boundary: 'entry',
        name: 'props',
        typeClassification: 'object',
        preview: String(attrs['component.props']).slice(0, 200),
        fullValue: String(attrs['component.props']),
        redactionTags: ['visible_to_human', 'visible_to_agent'],
        timestamp: span.startTimeMs,
      });
    }

    // Exception events
    if (span.events) {
      for (const event of span.events) {
        if (event.name === 'exception') {
          snapshots.push({
            id: `vs_${++counter}`,
            traceId: span.traceId,
            spanId: span.spanId,
            boundary: 'exception',
            name: 'exception',
            typeClassification: 'Error',
            preview: event.attributes?.['exception.message'] || event.attributes?.['exception.type'] || 'Unknown',
            fullValue: JSON.stringify(event.attributes),
            redactionTags: ['visible_to_human', 'visible_to_agent'],
            timestamp: span.startTimeMs,
          });
        }
      }
    }
  }

  return snapshots;
}

// ─── Build Trace Summary ─────────────────────────────────────────────────────

export function buildTraceSummary(spans: RawSpan[], graph: ExecutionGraph): TraceSummary {
  if (spans.length === 0) {
    return {
      traceId: '',
      rootSpanName: '',
      services: [],
      durationMs: 0,
      spanCount: 0,
      errorCount: 0,
      exceptionCount: 0,
      asyncHops: 0,
      networkRequests: 0,
      dbQueries: 0,
      requestPath: [],
      exceptions: [],
      suspiciousnessScore: 0,
      keyValues: [],
    };
  }

  const traceId = spans[0].traceId;
  const rootSpan = spans.find(s => !s.parentSpanId) || spans[0];
  const services = [...new Set(spans.map(s => s.serviceName))];

  const startTime = Math.min(...spans.map(s => s.startTimeMs));
  const endTime = Math.max(...spans.map(s => s.endTimeMs));

  const errorSpans = spans.filter(s => s.statusCode === 'STATUS_CODE_ERROR');
  const exceptionEvents = spans.flatMap(s =>
    (s.events || []).filter(e => e.name === 'exception').map(e => ({ span: s, event: e }))
  );

  const asyncEdges = graph.edges.filter(e => e.type === 'async_scheduled_by' || e.type === 'async_resumed_from');
  const networkNodes = graph.nodes.filter(n => n.type === 'network_request');
  const dbNodes = graph.nodes.filter(n => n.type === 'db_query');

  // Build request path (root → leaf following the critical path)
  const requestPath = buildRequestPath(spans, graph);

  // Build exception info
  const exceptions = exceptionEvents.map(({ span, event }) => ({
    spanId: span.spanId,
    spanName: span.name,
    serviceName: span.serviceName,
    type: event.attributes?.['exception.type'] || 'Error',
    message: event.attributes?.['exception.message'] || 'Unknown error',
    stackTrace: event.attributes?.['exception.stacktrace'],
    sourceLocation: extractSourceLocation(span.attributes),
    ancestorSpans: getAncestorChain(span.spanId, spans),
  }));

  // Key values at boundaries
  const keyValues = extractValueSnapshots(spans).slice(0, 20);

  // Suspiciousness score
  const suspiciousnessScore = computeSuspiciousness(spans, graph);

  return {
    traceId,
    rootSpanName: rootSpan.name,
    services,
    durationMs: endTime - startTime,
    spanCount: spans.length,
    errorCount: errorSpans.length,
    exceptionCount: exceptionEvents.length,
    asyncHops: asyncEdges.length,
    networkRequests: networkNodes.length,
    dbQueries: dbNodes.length,
    requestPath,
    exceptions,
    suspiciousnessScore,
    keyValues,
  };
}

function buildRequestPath(spans: RawSpan[], graph: ExecutionGraph): RequestPathStep[] {
  const path: RequestPathStep[] = [];
  const spanMap = new Map(spans.map(s => [s.spanId, s]));

  // Start from root span, follow the critical path (longest child at each level)
  const rootSpan = spans.find(s => !s.parentSpanId) || spans[0];
  if (!rootSpan) return path;

  const visited = new Set<string>();
  let current: RawSpan | undefined = rootSpan;
  let index = 0;

  while (current && !visited.has(current.spanId)) {
    visited.add(current.spanId);
    const node = graph.nodes.find(n => n.spanId === current!.spanId);

    path.push({
      index: index++,
      spanId: current.spanId,
      name: current.name,
      serviceName: current.serviceName,
      type: node?.type || 'span',
      durationMs: current.durationMs,
      status: current.statusCode === 'STATUS_CODE_ERROR' ? 'error'
        : current.statusCode === 'STATUS_CODE_OK' ? 'ok' : 'unset',
    });

    // Find children and pick the one with longest duration (critical path)
    const children = spans.filter(s => s.parentSpanId === current!.spanId);
    if (children.length === 0) break;

    // Prefer error path, then longest duration
    const errorChild = children.find(c => c.statusCode === 'STATUS_CODE_ERROR');
    current = errorChild || children.reduce((a, b) => a.durationMs >= b.durationMs ? a : b);
  }

  return path;
}

function getAncestorChain(spanId: string, spans: RawSpan[]): string[] {
  const spanMap = new Map(spans.map(s => [s.spanId, s]));
  const chain: string[] = [];
  let current = spanMap.get(spanId);

  while (current?.parentSpanId) {
    chain.push(current.parentSpanId);
    current = spanMap.get(current.parentSpanId);
  }

  return chain;
}

function computeSuspiciousness(spans: RawSpan[], graph: ExecutionGraph): number {
  let score = 0;

  // Errors are highly suspicious
  const errorCount = spans.filter(s => s.statusCode === 'STATUS_CODE_ERROR').length;
  score += errorCount * 30;

  // Exception events
  const exceptionCount = spans.flatMap(s => (s.events || []).filter(e => e.name === 'exception')).length;
  score += exceptionCount * 40;

  // Slow spans (> 1s)
  const slowSpans = spans.filter(s => s.durationMs > 1000).length;
  score += slowSpans * 10;

  // Missing async continuations (orphan spans)
  const orphanSpans = spans.filter(s =>
    s.parentSpanId && !spans.some(p => p.spanId === s.parentSpanId)
  ).length;
  score += orphanSpans * 15;

  return Math.min(score, 100);
}

// ─── Trace Comparison / First Divergence ─────────────────────────────────────

export function compareTraces(goodSpans: RawSpan[], badSpans: RawSpan[]): {
  firstDivergence: import('./types').DivergencePoint | undefined;
  divergences: import('./types').DivergencePoint[];
  missingSpans: import('./types').SpanDiffEntry[];
  extraSpans: import('./types').SpanDiffEntry[];
  changedSpans: import('./types').SpanDiffEntry[];
  summary: string;
} {
  const divergences: import('./types').DivergencePoint[] = [];
  const missingSpans: import('./types').SpanDiffEntry[] = [];
  const extraSpans: import('./types').SpanDiffEntry[] = [];
  const changedSpans: import('./types').SpanDiffEntry[] = [];
  let divIndex = 0;

  // Group spans by name for comparison
  const goodByName = groupByName(goodSpans);
  const badByName = groupByName(badSpans);

  const allNames = new Set([...goodByName.keys(), ...badByName.keys()]);

  for (const name of allNames) {
    const goodGroup = goodByName.get(name);
    const badGroup = badByName.get(name);

    if (goodGroup && !badGroup) {
      missingSpans.push({
        spanName: name,
        serviceName: goodGroup[0].serviceName,
        spanId: goodGroup[0].spanId,
        side: 'good',
        details: `Span "${name}" present in good trace but missing from bad trace`,
      });
      divergences.push({
        index: divIndex++,
        type: 'missing_span',
        description: `Span "${name}" missing in bad trace`,
        goodSpanId: goodGroup[0].spanId,
        spanName: name,
        serviceName: goodGroup[0].serviceName,
        severity: 'critical',
      });
    } else if (!goodGroup && badGroup) {
      extraSpans.push({
        spanName: name,
        serviceName: badGroup[0].serviceName,
        spanId: badGroup[0].spanId,
        side: 'bad',
        details: `Span "${name}" present in bad trace but not in good trace`,
      });
      divergences.push({
        index: divIndex++,
        type: 'extra_span',
        description: `Extra span "${name}" in bad trace`,
        badSpanId: badGroup[0].spanId,
        spanName: name,
        serviceName: badGroup[0].serviceName,
        severity: 'warning',
      });
    } else if (goodGroup && badGroup) {
      const goodSpan = goodGroup[0];
      const badSpan = badGroup[0];

      // Status difference
      if (goodSpan.statusCode !== badSpan.statusCode) {
        changedSpans.push({
          spanName: name,
          serviceName: badSpan.serviceName,
          spanId: badSpan.spanId,
          side: 'both',
          details: `Status changed from ${goodSpan.statusCode} to ${badSpan.statusCode}`,
        });
        divergences.push({
          index: divIndex++,
          type: 'status_diff',
          description: `"${name}" status changed: ${goodSpan.statusCode} → ${badSpan.statusCode}`,
          goodSpanId: goodSpan.spanId,
          badSpanId: badSpan.spanId,
          goodValue: goodSpan.statusCode,
          badValue: badSpan.statusCode,
          spanName: name,
          serviceName: badSpan.serviceName,
          severity: badSpan.statusCode === 'STATUS_CODE_ERROR' ? 'critical' : 'warning',
        });
      }

      // Return value difference
      const goodReturn = goodSpan.attributes['function.return.value'];
      const badReturn = badSpan.attributes['function.return.value'];
      if (goodReturn !== badReturn && (goodReturn || badReturn)) {
        divergences.push({
          index: divIndex++,
          type: 'value_diff',
          description: `"${name}" return value differs`,
          goodSpanId: goodSpan.spanId,
          badSpanId: badSpan.spanId,
          goodValue: String(goodReturn || '').slice(0, 200),
          badValue: String(badReturn || '').slice(0, 200),
          spanName: name,
          serviceName: badSpan.serviceName,
          severity: 'warning',
        });
      }

      // Duration anomaly (>5x slower or faster)
      if (goodSpan.durationMs > 0 && badSpan.durationMs > 0) {
        const ratio = badSpan.durationMs / goodSpan.durationMs;
        if (ratio > 5 || ratio < 0.2) {
          divergences.push({
            index: divIndex++,
            type: 'duration_diff',
            description: `"${name}" duration changed: ${goodSpan.durationMs.toFixed(1)}ms → ${badSpan.durationMs.toFixed(1)}ms (${ratio.toFixed(1)}x)`,
            goodSpanId: goodSpan.spanId,
            badSpanId: badSpan.spanId,
            goodValue: `${goodSpan.durationMs.toFixed(1)}ms`,
            badValue: `${badSpan.durationMs.toFixed(1)}ms`,
            spanName: name,
            serviceName: badSpan.serviceName,
            severity: 'info',
          });
        }
      }
    }
  }

  // Sort divergences by severity
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  divergences.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const firstDivergence = divergences[0];

  // Summary
  const parts: string[] = [];
  if (missingSpans.length > 0) parts.push(`${missingSpans.length} missing span(s)`);
  if (extraSpans.length > 0) parts.push(`${extraSpans.length} extra span(s)`);
  if (changedSpans.length > 0) parts.push(`${changedSpans.length} changed span(s)`);
  const criticalCount = divergences.filter(d => d.severity === 'critical').length;
  if (criticalCount > 0) parts.push(`${criticalCount} critical divergence(s)`);
  const summary = parts.length > 0
    ? `Found ${divergences.length} divergence(s): ${parts.join(', ')}`
    : 'No divergences found — traces are structurally identical';

  return { firstDivergence, divergences, missingSpans, extraSpans, changedSpans, summary };
}

function groupByName(spans: RawSpan[]): Map<string, RawSpan[]> {
  const map = new Map<string, RawSpan[]>();
  for (const span of spans) {
    const key = span.name;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(span);
  }
  return map;
}

// ─── Build Trace Run ─────────────────────────────────────────────────────────

export function buildTraceRun(spans: RawSpan[], label?: string, tags: string[] = []): TraceRun {
  if (spans.length === 0) {
    return {
      id: '', traceId: '', tags: [], startTime: 0, endTime: 0, durationMs: 0,
      serviceName: '', services: [], rootSpanName: '', spanCount: 0,
      errorCount: 0, hasExceptions: false, status: 'partial', suspiciousnessScore: 0,
    };
  }

  const traceId = spans[0].traceId;
  const rootSpan = spans.find(s => !s.parentSpanId) || spans[0];
  const services = [...new Set(spans.map(s => s.serviceName))];
  const startTime = Math.min(...spans.map(s => s.startTimeMs));
  const endTime = Math.max(...spans.map(s => s.endTimeMs));
  const errorCount = spans.filter(s => s.statusCode === 'STATUS_CODE_ERROR').length;
  const hasExceptions = spans.some(s => s.events?.some(e => e.name === 'exception'));

  const graph = buildExecutionGraph(spans);
  const suspiciousnessScore = computeSuspiciousness(spans, graph);

  return {
    id: `run_${traceId}`,
    traceId,
    label,
    tags,
    startTime,
    endTime,
    durationMs: endTime - startTime,
    serviceName: rootSpan.serviceName,
    services,
    rootSpanName: rootSpan.name,
    spanCount: spans.length,
    errorCount,
    hasExceptions,
    status: errorCount > 0 ? 'error' : 'success',
    suspiciousnessScore,
  };
}
