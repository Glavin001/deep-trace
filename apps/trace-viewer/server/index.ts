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
