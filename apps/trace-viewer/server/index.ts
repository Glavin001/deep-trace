import express from 'express';
import cors from 'cors';
import { createClient } from '@clickhouse/client';
import * as fs from 'fs';
import * as path from 'path';

const app = express();
app.use(cors());
app.use(express.json());

// ── ClickHouse client ──────────────────────────────────────────────────────

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123';
const CLICKHOUSE_DB = process.env.CLICKHOUSE_DB || 'otel';
const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER || 'otel';
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD || 'otel';

const ch = createClient({
  url: CLICKHOUSE_URL,
  database: CLICKHOUSE_DB,
  username: CLICKHOUSE_USER,
  password: CLICKHOUSE_PASSWORD,
  request_timeout: 10_000,
});

/** Parse ClickHouse DateTime64 (UTC, no 'Z' suffix) into epoch ms */
function parseChTimestamp(ts: string): number {
  if (!ts) return 0;
  // ClickHouse returns "2026-03-14 10:27:31.123456789" (no T, no Z) — always UTC
  if (!ts.endsWith('Z') && !ts.includes('+') && !ts.includes('T')) {
    return new Date(ts.replace(' ', 'T') + 'Z').getTime();
  }
  return new Date(ts).getTime();
}

// ── PROJECT_ROOT: resolve the deep-trace repo root for source file reading ──

const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(
  new URL('.', import.meta.url).pathname, '..', '..', '..',
);

// ── API: list recent traces ────────────────────────────────────────────────

app.get('/api/traces', async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit)) || 50, 200);
    const service = req.query.service ? String(req.query.service) : null;
    const search = req.query.search ? String(req.query.search) : null;

    let where = "ParentSpanId = ''";
    const params: Record<string, string | number> = {};

    if (service) {
      where += ' AND ServiceName = {service:String}';
      params.service = service;
    }
    if (search) {
      where += ' AND (SpanName ILIKE {search:String} OR TraceId ILIKE {search:String})';
      params.search = `%${search}%`;
    }

    const result = await ch.query({
      query: `
        SELECT
          TraceId,
          SpanName,
          ServiceName,
          Duration / 1000000 AS duration_ms,
          StatusCode,
          Timestamp,
          SpanAttributes
        FROM otel.otel_traces
        WHERE ${where}
        ORDER BY Timestamp DESC
        LIMIT {limit:UInt32}
      `,
      query_params: { ...params, limit },
      format: 'JSONEachRow',
    });

    const rows = await result.json();

    // For each root span, count total spans in that trace
    const traceIds = rows.map((r: any) => r.TraceId);
    let spanCounts: Record<string, number> = {};

    if (traceIds.length > 0) {
      const countResult = await ch.query({
        query: `
          SELECT TraceId, count() AS span_count
          FROM otel.otel_traces
          WHERE TraceId IN ({traceIds:Array(String)})
          GROUP BY TraceId
        `,
        query_params: { traceIds },
        format: 'JSONEachRow',
      });
      const countRows: any[] = await countResult.json();
      spanCounts = Object.fromEntries(countRows.map((r: any) => [r.TraceId, Number(r.span_count)]));
    }

    const traces = rows.map((r: any) => ({
      traceId: r.TraceId,
      rootSpanName: r.SpanName,
      serviceName: r.ServiceName,
      durationMs: Number(r.duration_ms),
      statusCode: r.StatusCode,
      timestamp: r.Timestamp,
      spanCount: spanCounts[r.TraceId] || 1,
      attributes: typeof r.SpanAttributes === 'string' ? JSON.parse(r.SpanAttributes) : r.SpanAttributes,
    }));

    res.json({ traces });
  } catch (error: any) {
    console.error('GET /api/traces error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── API: get single trace (all spans) ──────────────────────────────────────

app.get('/api/traces/:traceId', async (req, res) => {
  try {
    const { traceId } = req.params;

    const result = await ch.query({
      query: `
        SELECT
          TraceId,
          SpanId,
          ParentSpanId,
          SpanName,
          ServiceName,
          SpanKind,
          Duration / 1000000 AS duration_ms,
          StatusCode,
          StatusMessage,
          Timestamp,
          SpanAttributes,
          Events.Name AS EventNames,
          Events.Timestamp AS EventTimestamps
        FROM otel.otel_traces
        WHERE TraceId = {traceId:String}
        ORDER BY Timestamp ASC
      `,
      query_params: { traceId },
      format: 'JSONEachRow',
    });

    const rows: any[] = await result.json();

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Trace not found' });
    }

    const spans = rows.map((r: any) => ({
      traceId: r.TraceId,
      spanId: r.SpanId,
      parentSpanId: r.ParentSpanId,
      name: r.SpanName,
      serviceName: r.ServiceName,
      kind: r.SpanKind,
      durationMs: Number(r.duration_ms),
      statusCode: r.StatusCode,
      statusMessage: r.StatusMessage,
      timestamp: r.Timestamp,
      attributes: typeof r.SpanAttributes === 'string' ? JSON.parse(r.SpanAttributes) : r.SpanAttributes,
      events: (r.EventNames || []).map((name: string, i: number) => ({
        name,
        timestamp: r.EventTimestamps?.[i],
      })),
    }));

    // Compute trace-level info
    const timestamps = spans.map((s: any) => parseChTimestamp(s.timestamp));
    const traceStart = Math.min(...timestamps);
    const traceEnd = Math.max(...timestamps.map((t: number, i: number) => t + spans[i].durationMs));
    const rootSpan = spans.find((s: any) => !s.parentSpanId) || spans[0];

    res.json({
      traceId,
      rootSpanName: rootSpan.name,
      serviceName: rootSpan.serviceName,
      durationMs: traceEnd - traceStart,
      spanCount: spans.length,
      traceStart: new Date(traceStart).toISOString(),
      spans,
    });
  } catch (error: any) {
    console.error('GET /api/traces/:traceId error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── API: service list ──────────────────────────────────────────────────────

app.get('/api/services', async (_req, res) => {
  try {
    const result = await ch.query({
      query: `
        SELECT
          ServiceName,
          count() AS total_spans,
          countIf(StatusCode = 'STATUS_CODE_ERROR') AS error_spans,
          quantile(0.99)(Duration / 1000000) AS p99_ms,
          max(Timestamp) AS last_seen
        FROM otel.otel_traces
        WHERE Timestamp >= now() - INTERVAL 24 HOUR
        GROUP BY ServiceName
        ORDER BY total_spans DESC
      `,
      format: 'JSONEachRow',
    });

    const services = await result.json();
    res.json({ services });
  } catch (error: any) {
    console.error('GET /api/services error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── API: read source file ──────────────────────────────────────────────────

app.get('/api/source', (req, res) => {
  try {
    const filePath = String(req.query.path || '');
    if (!filePath) {
      return res.status(400).json({ error: 'path query parameter required' });
    }

    // Resolve relative to project root, prevent directory traversal
    let resolved = path.resolve(PROJECT_ROOT, filePath);
    if (!resolved.startsWith(PROJECT_ROOT)) {
      return res.status(403).json({ error: 'Access denied: path outside project root' });
    }

    // If not found at repo root, search known subdirectories
    // (code.filepath from Babel plugin is often relative to the app root, not repo root)
    if (!fs.existsSync(resolved)) {
      const searchDirs = findSubprojectDirs(PROJECT_ROOT);
      let found = false;
      for (const dir of searchDirs) {
        const candidate = path.resolve(dir, filePath);
        if (candidate.startsWith(PROJECT_ROOT) && fs.existsSync(candidate)) {
          resolved = candidate;
          found = true;
          break;
        }
      }
      if (!found) {
        return res.status(404).json({ error: 'File not found', path: filePath });
      }
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is a directory' });
    }

    // Limit file size to 1MB
    if (stat.size > 1_048_576) {
      return res.status(413).json({ error: 'File too large (>1MB)' });
    }

    const content = fs.readFileSync(resolved, 'utf-8');
    const ext = path.extname(resolved).slice(1);

    res.json({
      path: filePath,
      resolvedPath: resolved,
      content,
      language: extToLanguage(ext),
      lineCount: content.split('\n').length,
    });
  } catch (error: any) {
    console.error('GET /api/source error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Find subdirectories that contain package.json (sub-projects/demos).
 * Cached after first call for performance.
 */
let _subprojectDirCache: string[] | null = null;
function findSubprojectDirs(root: string): string[] {
  if (_subprojectDirCache) return _subprojectDirCache;
  const dirs: string[] = [];
  const searchIn = ['demos', 'apps', 'packages', 'examples'];
  for (const sub of searchIn) {
    const subDir = path.join(root, sub);
    if (fs.existsSync(subDir) && fs.statSync(subDir).isDirectory()) {
      try {
        for (const entry of fs.readdirSync(subDir)) {
          const entryPath = path.join(subDir, entry);
          if (fs.statSync(entryPath).isDirectory()) {
            dirs.push(entryPath);
          }
        }
      } catch {}
    }
  }
  // Also include the root itself as last resort
  dirs.push(root);
  _subprojectDirCache = dirs;
  return dirs;
}

function extToLanguage(ext: string): string {
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', rs: 'rust', go: 'go', java: 'java',
    json: 'json', yaml: 'yaml', yml: 'yaml', sql: 'sql',
    css: 'css', html: 'html', md: 'markdown',
  };
  return map[ext] || 'plaintext';
}

// ── API: health check ──────────────────────────────────────────────────────

app.get('/api/health', async (_req, res) => {
  try {
    await ch.query({ query: 'SELECT 1', format: 'JSON' });
    res.json({ status: 'ok', clickhouse: 'connected' });
  } catch (error: any) {
    res.json({ status: 'degraded', clickhouse: error.message });
  }
});

// ── DeepTrace Enriched API ────────────────────────────────────────────────
// These endpoints use the DeepTrace enrichment engine to derive causal graphs,
// trace summaries, and divergence analysis from raw OTel spans.

interface RawSpanForEnrichment {
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

function rowToRawSpan(row: any): RawSpanForEnrichment {
  const attrs = typeof row.SpanAttributes === 'string' ? JSON.parse(row.SpanAttributes) : (row.SpanAttributes || {});
  const startMs = parseChTimestamp(row.Timestamp);
  const durationMs = Number(row.duration_ms || 0);
  return {
    traceId: row.TraceId,
    spanId: row.SpanId,
    parentSpanId: row.ParentSpanId || undefined,
    name: row.SpanName,
    serviceName: row.ServiceName,
    kind: row.SpanKind,
    durationMs,
    statusCode: row.StatusCode || 'STATUS_CODE_UNSET',
    statusMessage: row.StatusMessage,
    timestamp: row.Timestamp,
    startTimeMs: startMs,
    endTimeMs: startMs + durationMs,
    attributes: attrs,
    events: (row.EventNames || []).map((name: string, i: number) => ({
      name,
      timestamp: row.EventTimestamps?.[i],
      attributes: row.EventAttributes?.[i] ? (() => { try { return JSON.parse(row.EventAttributes[i]); } catch { return {}; } })() : {},
    })),
  };
}

async function fetchSpansForTrace(traceId: string): Promise<RawSpanForEnrichment[]> {
  const result = await ch.query({
    query: `
      SELECT
        TraceId, SpanId, ParentSpanId, SpanName, ServiceName, SpanKind,
        Duration / 1000000 AS duration_ms,
        StatusCode, StatusMessage, Timestamp, SpanAttributes,
        Events.Name AS EventNames,
        Events.Timestamp AS EventTimestamps,
        Events.Attributes AS EventAttributes
      FROM otel.otel_traces
      WHERE TraceId = {traceId:String}
      ORDER BY Timestamp ASC
    `,
    query_params: { traceId },
    format: 'JSONEachRow',
  });
  const rows: any[] = await result.json();
  return rows.map(rowToRawSpan);
}

// Inline enrichment functions to avoid import issues with ESM/CJS mismatch
function classifyNodeType(span: RawSpanForEnrichment): string {
  const attrs = span.attributes;
  const name = span.name.toLowerCase();
  if (span.events?.some(e => e.name === 'exception')) return 'exception';
  if (attrs['db.system'] || attrs['db.statement'] || name.includes('query')) return 'db_query';
  if (attrs['http.method'] || attrs['http.request.method'] || name.startsWith('fetch ') ||
      name.startsWith('GET ') || name.startsWith('POST ') || name.startsWith('PUT ') || name.startsWith('DELETE ')) return 'network_request';
  if (attrs['code.function.type'] === 'react_component') return 'logical_operation';
  return 'span';
}

function buildGraph(spans: RawSpanForEnrichment[]) {
  const nodes = spans.map(s => ({
    id: `node_${s.spanId}`,
    type: classifyNodeType(s),
    traceId: s.traceId,
    spanId: s.spanId,
    name: s.name,
    serviceName: s.serviceName,
    startTime: s.startTimeMs,
    endTime: s.endTimeMs,
    durationMs: s.durationMs,
    attributes: s.attributes,
    sourceLocation: s.attributes['code.filepath'] ? {
      filePath: s.attributes['code.filepath'],
      line: s.attributes['code.lineno'],
      column: s.attributes['code.column'],
      functionName: s.attributes['function.name'],
    } : undefined,
    status: s.statusCode === 'STATUS_CODE_ERROR' ? 'error' : s.statusCode === 'STATUS_CODE_OK' ? 'ok' : 'unset',
    statusMessage: s.statusMessage,
  }));

  let edgeCount = 0;
  const edges: any[] = [];
  const spanMap = new Map(spans.map(s => [s.spanId, s]));
  for (const span of spans) {
    if (span.parentSpanId && spanMap.has(span.parentSpanId)) {
      edges.push({ id: `edge_${++edgeCount}`, type: 'parent_child', sourceNodeId: `node_${span.parentSpanId}`, targetNodeId: `node_${span.spanId}`, traceId: span.traceId });
    }
    if (span.statusCode === 'STATUS_CODE_ERROR' && span.parentSpanId) {
      const parent = spanMap.get(span.parentSpanId);
      if (parent?.statusCode === 'STATUS_CODE_ERROR') {
        edges.push({ id: `edge_${++edgeCount}`, type: 'caused_error', sourceNodeId: `node_${span.spanId}`, targetNodeId: `node_${span.parentSpanId}`, traceId: span.traceId });
      }
    }
    if (span.attributes['code.filepath']) {
      edges.push({ id: `edge_${++edgeCount}`, type: 'source_mapped_to', sourceNodeId: `node_${span.spanId}`, targetNodeId: `src_${span.attributes['code.filepath']}:${span.attributes['code.lineno'] || 0}`, traceId: span.traceId });
    }
  }

  return { traceId: spans[0]?.traceId || '', nodes, edges };
}

function buildSummary(spans: RawSpanForEnrichment[], graph: any) {
  if (spans.length === 0) return null;
  const rootSpan = spans.find(s => !s.parentSpanId) || spans[0];
  const services = [...new Set(spans.map(s => s.serviceName))];
  const startTime = Math.min(...spans.map(s => s.startTimeMs));
  const endTime = Math.max(...spans.map(s => s.endTimeMs));
  const errorSpans = spans.filter(s => s.statusCode === 'STATUS_CODE_ERROR');
  const exceptionEvents = spans.flatMap(s => (s.events || []).filter(e => e.name === 'exception').map(e => ({ span: s, event: e })));
  const networkNodes = graph.nodes.filter((n: any) => n.type === 'network_request');
  const dbNodes = graph.nodes.filter((n: any) => n.type === 'db_query');

  // Build request path
  const path: any[] = [];
  let current: RawSpanForEnrichment | undefined = rootSpan;
  const visited = new Set<string>();
  let idx = 0;
  while (current && !visited.has(current.spanId)) {
    visited.add(current.spanId);
    const node = graph.nodes.find((n: any) => n.spanId === current!.spanId);
    path.push({ index: idx++, spanId: current.spanId, name: current.name, serviceName: current.serviceName, type: node?.type || 'span', durationMs: current.durationMs, status: current.statusCode === 'STATUS_CODE_ERROR' ? 'error' : 'ok' });
    const children = spans.filter(s => s.parentSpanId === current!.spanId);
    if (children.length === 0) break;
    const errorChild = children.find(c => c.statusCode === 'STATUS_CODE_ERROR');
    current = errorChild || children.reduce((a, b) => a.durationMs >= b.durationMs ? a : b);
  }

  const exceptions = exceptionEvents.map(({ span, event }) => ({
    spanId: span.spanId, spanName: span.name, serviceName: span.serviceName,
    type: event.attributes?.['exception.type'] || 'Error',
    message: event.attributes?.['exception.message'] || 'Unknown error',
    stackTrace: event.attributes?.['exception.stacktrace'],
    sourceLocation: span.attributes['code.filepath'] ? { filePath: span.attributes['code.filepath'], line: span.attributes['code.lineno'], functionName: span.attributes['function.name'] } : undefined,
  }));

  let score = errorSpans.length * 30 + exceptionEvents.length * 40;
  score = Math.min(score, 100);

  return {
    traceId: rootSpan.traceId, rootSpanName: rootSpan.name, services, durationMs: endTime - startTime,
    spanCount: spans.length, errorCount: errorSpans.length, exceptionCount: exceptionEvents.length,
    asyncHops: 0, networkRequests: networkNodes.length, dbQueries: dbNodes.length,
    requestPath: path, exceptions, suspiciousnessScore: score,
  };
}

// GET /api/dt/traces/:traceId/summary — enriched trace summary
app.get('/api/dt/traces/:traceId/summary', async (req, res) => {
  try {
    const spans = await fetchSpansForTrace(req.params.traceId);
    if (spans.length === 0) return res.status(404).json({ success: false, error: 'Trace not found' });
    const graph = buildGraph(spans);
    const summary = buildSummary(spans, graph);
    res.json({ success: true, data: summary });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/dt/traces/:traceId/graph — causal execution graph
app.get('/api/dt/traces/:traceId/graph', async (req, res) => {
  try {
    const spans = await fetchSpansForTrace(req.params.traceId);
    if (spans.length === 0) return res.status(404).json({ success: false, error: 'Trace not found' });
    const graph = buildGraph(spans);
    res.json({ success: true, data: graph });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/dt/diff?good=X&bad=Y — trace comparison
app.get('/api/dt/diff', async (req, res) => {
  try {
    const goodId = String(req.query.good || '');
    const badId = String(req.query.bad || '');
    if (!goodId || !badId) return res.status(400).json({ success: false, error: 'good and bad parameters required' });

    const [goodSpans, badSpans] = await Promise.all([fetchSpansForTrace(goodId), fetchSpansForTrace(badId)]);
    if (goodSpans.length === 0) return res.status(404).json({ success: false, error: 'Good trace not found' });
    if (badSpans.length === 0) return res.status(404).json({ success: false, error: 'Bad trace not found' });

    // Compare
    const goodByName = new Map<string, RawSpanForEnrichment>();
    for (const s of goodSpans) goodByName.set(s.name, s);
    const badByName = new Map<string, RawSpanForEnrichment>();
    for (const s of badSpans) badByName.set(s.name, s);

    const allNames = new Set([...goodByName.keys(), ...badByName.keys()]);
    const divergences: any[] = [];
    const missingSpans: any[] = [];
    const extraSpans: any[] = [];
    let divIdx = 0;

    for (const name of allNames) {
      const g = goodByName.get(name);
      const b = badByName.get(name);
      if (g && !b) {
        missingSpans.push({ spanName: name, serviceName: g.serviceName, side: 'good' });
        divergences.push({ index: divIdx++, type: 'missing_span', description: `Span "${name}" missing in bad trace`, spanName: name, serviceName: g.serviceName, severity: 'critical' });
      } else if (!g && b) {
        extraSpans.push({ spanName: name, serviceName: b.serviceName, side: 'bad' });
        divergences.push({ index: divIdx++, type: 'extra_span', description: `Extra span "${name}" in bad trace`, spanName: name, serviceName: b.serviceName, severity: 'warning' });
      } else if (g && b) {
        if (g.statusCode !== b.statusCode) {
          divergences.push({ index: divIdx++, type: 'status_diff', description: `"${name}" status: ${g.statusCode} → ${b.statusCode}`, goodValue: g.statusCode, badValue: b.statusCode, spanName: name, severity: b.statusCode === 'STATUS_CODE_ERROR' ? 'critical' : 'warning' });
        }
        const gr = g.attributes['function.return.value'];
        const br = b.attributes['function.return.value'];
        if (gr !== br && (gr || br)) {
          divergences.push({ index: divIdx++, type: 'value_diff', description: `"${name}" return value differs`, goodValue: String(gr || '').slice(0, 200), badValue: String(br || '').slice(0, 200), spanName: name, severity: 'warning' });
        }
      }
    }

    const sevOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
    divergences.sort((a: any, b: any) => (sevOrder[a.severity] || 9) - (sevOrder[b.severity] || 9));

    res.json({
      success: true,
      data: {
        goodTraceId: goodId, badTraceId: badId,
        firstDivergence: divergences[0] || null,
        divergences, missingSpans, extraSpans,
        summary: divergences.length > 0
          ? `Found ${divergences.length} divergence(s): ${divergences.filter((d: any) => d.severity === 'critical').length} critical`
          : 'No divergences found',
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/dt/runs — enriched runs list with suspiciousness
app.get('/api/dt/runs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit)) || 50, 200);
    let where = "ParentSpanId = ''";
    const params: Record<string, any> = {};

    if (req.query.service) {
      where += ' AND ServiceName = {service:String}';
      params.service = String(req.query.service);
    }
    if (req.query.search) {
      where += ' AND (SpanName ILIKE {search:String} OR TraceId ILIKE {search:String})';
      params.search = `%${req.query.search}%`;
    }

    const result = await ch.query({
      query: `SELECT TraceId, SpanName, ServiceName, Duration / 1000000 AS duration_ms, StatusCode, Timestamp, SpanAttributes FROM otel.otel_traces WHERE ${where} ORDER BY Timestamp DESC LIMIT {limit:UInt32}`,
      query_params: { ...params, limit },
      format: 'JSONEachRow',
    });
    const rows: any[] = await result.json();

    const traceIds = rows.map(r => r.TraceId);
    let counts: Record<string, { spans: number; errors: number }> = {};
    if (traceIds.length > 0) {
      const cr = await ch.query({
        query: `SELECT TraceId, count() AS sc, countIf(StatusCode = 'STATUS_CODE_ERROR') AS ec FROM otel.otel_traces WHERE TraceId IN ({traceIds:Array(String)}) GROUP BY TraceId`,
        query_params: { traceIds },
        format: 'JSONEachRow',
      });
      const cRows: any[] = await cr.json();
      counts = Object.fromEntries(cRows.map(r => [r.TraceId, { spans: Number(r.sc), errors: Number(r.ec) }]));
    }

    const runs = rows.map(r => {
      const c = counts[r.TraceId] || { spans: 1, errors: 0 };
      return {
        id: `run_${r.TraceId}`, traceId: r.TraceId, tags: [],
        startTime: parseChTimestamp(r.Timestamp),
        endTime: parseChTimestamp(r.Timestamp) + Number(r.duration_ms),
        durationMs: Number(r.duration_ms),
        serviceName: r.ServiceName, services: [r.ServiceName],
        rootSpanName: r.SpanName, spanCount: c.spans,
        errorCount: c.errors, hasExceptions: c.errors > 0,
        status: c.errors > 0 ? 'error' : 'success',
        suspiciousnessScore: Math.min(c.errors * 30, 100),
        timestamp: r.Timestamp,
      };
    });

    res.json({ success: true, data: runs });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── Serve static files in production ───────────────────────────────────────

const distDir = path.resolve(new URL('.', import.meta.url).pathname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// ── Start server ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.TRACE_VIEWER_PORT || '3004');
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Deep Trace Viewer API running on http://127.0.0.1:${PORT}`);
});

export { app };
