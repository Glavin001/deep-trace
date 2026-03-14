/**
 * Integration tests for the DeepTrace HTTP server endpoints.
 *
 * Tests the full HTTP request/response cycle for all DeepTrace API endpoints.
 * Uses the Express app directly without starting a real server (supertest-style).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import express from 'express';
import http from 'http';

// We test the createDeepTraceServer function, but mock ClickHouse
// since we can't require a running database for unit tests.

// Mock ClickHouse client
const mockQuery = vi.fn();
const mockClose = vi.fn();
vi.mock('@clickhouse/client', () => ({
  createClient: () => ({
    query: mockQuery,
    close: mockClose,
  }),
}));

// Now import the server (after mocking)
import { createDeepTraceServer } from '../deeptrace/server';

// ─── Test Data ───────────────────────────────────────────────────────────────

const MOCK_SPANS = [
  {
    TraceId: 'abc123',
    SpanId: 'span-1',
    ParentSpanId: '',
    SpanName: 'GET /api/checkout',
    ServiceName: 'web-server',
    SpanKind: 'SPAN_KIND_SERVER',
    duration_ms: 150,
    StatusCode: 'STATUS_CODE_OK',
    StatusMessage: '',
    Timestamp: '2026-01-15 10:30:00.000',
    SpanAttributes: JSON.stringify({
      'function.name': 'GET /api/checkout',
      'http.method': 'GET',
      'code.filepath': 'app/api/checkout/route.ts',
      'code.lineno': 10,
      'function.args.0': '"order-123"',
      'function.return.value': '{"status":"ok"}',
    }),
    EventNames: [],
    EventTimestamps: [],
    EventAttributes: [],
  },
  {
    TraceId: 'abc123',
    SpanId: 'span-2',
    ParentSpanId: 'span-1',
    SpanName: 'validateOrder',
    ServiceName: 'web-server',
    SpanKind: 'SPAN_KIND_INTERNAL',
    duration_ms: 25,
    StatusCode: 'STATUS_CODE_OK',
    StatusMessage: '',
    Timestamp: '2026-01-15 10:30:00.010',
    SpanAttributes: JSON.stringify({
      'function.name': 'validateOrder',
      'code.filepath': 'app/services/orders.ts',
      'code.lineno': 42,
      'function.args.0': '"order-123"',
      'function.return.value': '{"valid":true}',
    }),
    EventNames: [],
    EventTimestamps: [],
    EventAttributes: [],
  },
  {
    TraceId: 'abc123',
    SpanId: 'span-3',
    ParentSpanId: 'span-1',
    SpanName: 'queryDatabase',
    ServiceName: 'web-server',
    SpanKind: 'SPAN_KIND_CLIENT',
    duration_ms: 80,
    StatusCode: 'STATUS_CODE_OK',
    StatusMessage: '',
    Timestamp: '2026-01-15 10:30:00.035',
    SpanAttributes: JSON.stringify({
      'function.name': 'queryDatabase',
      'db.system': 'postgresql',
      'db.statement': 'SELECT * FROM orders WHERE id = ?',
      'code.filepath': 'app/services/db.ts',
      'code.lineno': 88,
    }),
    EventNames: [],
    EventTimestamps: [],
    EventAttributes: [],
  },
];

const MOCK_ERROR_SPANS = [
  {
    TraceId: 'def456',
    SpanId: 'span-4',
    ParentSpanId: '',
    SpanName: 'GET /api/checkout',
    ServiceName: 'web-server',
    SpanKind: 'SPAN_KIND_SERVER',
    duration_ms: 90,
    StatusCode: 'STATUS_CODE_ERROR',
    StatusMessage: 'Order validation failed',
    Timestamp: '2026-01-15 10:31:00.000',
    SpanAttributes: JSON.stringify({
      'function.name': 'GET /api/checkout',
      'http.method': 'GET',
      'code.filepath': 'app/api/checkout/route.ts',
      'code.lineno': 10,
    }),
    EventNames: ['exception'],
    EventTimestamps: ['2026-01-15 10:31:00.050'],
    EventAttributes: [JSON.stringify({
      'exception.type': 'ValidationError',
      'exception.message': 'Item SKU-999 out of stock',
      'exception.stacktrace': 'at validateOrder (app/services/orders.ts:42)',
    })],
  },
  {
    TraceId: 'def456',
    SpanId: 'span-5',
    ParentSpanId: 'span-4',
    SpanName: 'validateOrder',
    ServiceName: 'web-server',
    SpanKind: 'SPAN_KIND_INTERNAL',
    duration_ms: 20,
    StatusCode: 'STATUS_CODE_ERROR',
    StatusMessage: 'Item SKU-999 out of stock',
    Timestamp: '2026-01-15 10:31:00.010',
    SpanAttributes: JSON.stringify({
      'function.name': 'validateOrder',
      'code.filepath': 'app/services/orders.ts',
      'code.lineno': 42,
      'function.return.value': '{"valid":false,"error":"Item SKU-999 out of stock"}',
    }),
    EventNames: [],
    EventTimestamps: [],
    EventAttributes: [],
  },
];

// ─── Test Helpers ────────────────────────────────────────────────────────────

function setupMockForTraceQuery(spans: any[]) {
  mockQuery.mockResolvedValueOnce({
    json: async () => spans,
  });
}

function setupMockForListRuns() {
  // First query: root spans
  mockQuery.mockResolvedValueOnce({
    json: async () => [
      {
        TraceId: 'abc123',
        SpanName: 'GET /api/checkout',
        ServiceName: 'web-server',
        duration_ms: 150,
        StatusCode: 'STATUS_CODE_OK',
        Timestamp: '2026-01-15 10:30:00.000',
        SpanAttributes: '{}',
      },
      {
        TraceId: 'def456',
        SpanName: 'GET /api/checkout',
        ServiceName: 'web-server',
        duration_ms: 90,
        StatusCode: 'STATUS_CODE_ERROR',
        Timestamp: '2026-01-15 10:31:00.000',
        SpanAttributes: '{}',
      },
    ],
  });
  // Second query: span counts
  mockQuery.mockResolvedValueOnce({
    json: async () => [
      { TraceId: 'abc123', span_count: '3', error_count: '0' },
      { TraceId: 'def456', span_count: '2', error_count: '2' },
    ],
  });
}

async function request(app: express.Express, method: string, path: string, body?: any): Promise<{
  status: number;
  body: any;
}> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      const url = `http://127.0.0.1:${addr.port}${path}`;
      const options: RequestInit = { method };
      if (body) {
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify(body);
      }
      fetch(url, options)
        .then(async res => {
          const json = await res.json().catch(() => ({}));
          server.close();
          resolve({ status: res.status, body: json });
        })
        .catch(err => {
          server.close();
          reject(err);
        });
    });
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('DeepTrace HTTP Server', () => {
  let app: express.Express;

  beforeAll(() => {
    const server = createDeepTraceServer();
    app = server.app;
  });

  beforeEach(() => {
    mockQuery.mockReset();
  });

  afterAll(() => {
    mockClose.mockResolvedValue(undefined);
  });

  describe('GET /api/health', () => {
    it('returns health status', async () => {
      // health calls api.getServices() which does 1 query
      mockQuery.mockResolvedValueOnce({ json: async () => [] });
      const res = await request(app, 'GET', '/api/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  describe('GET /api/dt/runs', () => {
    it('returns list of runs', async () => {
      setupMockForListRuns();
      const res = await request(app, 'GET', '/api/dt/runs');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].traceId).toBe('abc123');
      expect(res.body.data[1].traceId).toBe('def456');
    });

    it('returns runs with status filter', async () => {
      setupMockForListRuns();
      const res = await request(app, 'GET', '/api/dt/runs?status=error');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('GET /api/dt/traces/:traceId/summary', () => {
    it('returns enriched trace summary', async () => {
      setupMockForTraceQuery(MOCK_SPANS);
      const res = await request(app, 'GET', '/api/dt/traces/abc123/summary');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.traceId).toBe('abc123');
      expect(res.body.data.rootSpanName).toBe('GET /api/checkout');
      expect(res.body.data.spanCount).toBe(3);
      expect(res.body.data.errorCount).toBe(0);
      expect(res.body.data.services).toContain('web-server');
      expect(res.body.data.requestPath.length).toBeGreaterThan(0);
    });

    it('returns summary with exception details', async () => {
      setupMockForTraceQuery(MOCK_ERROR_SPANS);
      const res = await request(app, 'GET', '/api/dt/traces/def456/summary');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.errorCount).toBe(2);
      expect(res.body.data.exceptionCount).toBe(1);
      expect(res.body.data.exceptions[0].type).toBe('ValidationError');
      expect(res.body.data.exceptions[0].message).toBe('Item SKU-999 out of stock');
    });

    it('returns error for empty trace', async () => {
      setupMockForTraceQuery([]);
      const res = await request(app, 'GET', '/api/dt/traces/nonexistent/summary');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Trace not found');
    });
  });

  describe('GET /api/dt/traces/:traceId/graph', () => {
    it('returns causal execution graph', async () => {
      setupMockForTraceQuery(MOCK_SPANS);
      const res = await request(app, 'GET', '/api/dt/traces/abc123/graph');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.traceId).toBe('abc123');
      expect(res.body.data.nodes.length).toBe(3);
      expect(res.body.data.edges.length).toBeGreaterThan(0);

      // Check node types
      const nodeTypes = res.body.data.nodes.map((n: any) => n.type);
      expect(nodeTypes).toContain('network_request'); // HTTP span
      expect(nodeTypes).toContain('db_query'); // DB span

      // Check edges
      const edgeTypes = res.body.data.edges.map((e: any) => e.type);
      expect(edgeTypes).toContain('parent_child');
      expect(edgeTypes).toContain('source_mapped_to');
    });
  });

  describe('GET /api/dt/diff', () => {
    it('returns trace comparison with divergences', async () => {
      // Good trace
      setupMockForTraceQuery(MOCK_SPANS);
      // Bad trace
      setupMockForTraceQuery(MOCK_ERROR_SPANS);

      const res = await request(app, 'GET', '/api/dt/diff?good=abc123&bad=def456');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.goodTraceId).toBe('abc123');
      expect(res.body.data.badTraceId).toBe('def456');
      expect(res.body.data.divergences.length).toBeGreaterThan(0);

      // Should find status differences (OK vs ERROR)
      const statusDiffs = res.body.data.divergences.filter((d: any) => d.type === 'status_diff');
      expect(statusDiffs.length).toBeGreaterThan(0);
    });

    it('returns 400 without required params', async () => {
      const res = await request(app, 'GET', '/api/dt/diff');
      expect(res.status).toBe(400);
    });

    it('returns error when good trace not found', async () => {
      setupMockForTraceQuery([]); // good trace empty
      setupMockForTraceQuery(MOCK_ERROR_SPANS);
      const res = await request(app, 'GET', '/api/dt/diff?good=missing&bad=def456');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toBe('Good trace not found');
    });
  });

  describe('GET /api/dt/services', () => {
    it('returns service list', async () => {
      mockQuery.mockResolvedValueOnce({
        json: async () => [
          { name: 'web-server', span_count: '100', error_count: '5' },
          { name: 'db-service', span_count: '50', error_count: '0' },
        ],
      });
      const res = await request(app, 'GET', '/api/dt/services');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
    });
  });

  describe('POST /api/agent/execute', () => {
    it('executes list_runs tool', async () => {
      setupMockForListRuns();
      const res = await request(app, 'POST', '/api/agent/execute', {
        tool: 'list_runs',
        args: { limit: 10 },
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
    });

    it('executes get_trace_summary tool', async () => {
      setupMockForTraceQuery(MOCK_SPANS);
      const res = await request(app, 'POST', '/api/agent/execute', {
        tool: 'get_trace_summary',
        args: { trace_id: 'abc123' },
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.traceId).toBe('abc123');
      // Agent responses should include evidence
      expect(res.body.evidence).toBeDefined();
    });

    it('executes find_first_divergence tool', async () => {
      setupMockForTraceQuery(MOCK_SPANS);
      setupMockForTraceQuery(MOCK_ERROR_SPANS);
      const res = await request(app, 'POST', '/api/agent/execute', {
        tool: 'find_first_divergence',
        args: { good_trace_id: 'abc123', bad_trace_id: 'def456' },
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.divergences.length).toBeGreaterThan(0);
    });

    it('returns error for unknown tool', async () => {
      const res = await request(app, 'POST', '/api/agent/execute', {
        tool: 'nonexistent_tool',
        args: {},
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Unknown tool');
    });

    it('returns 400 without tool field', async () => {
      const res = await request(app, 'POST', '/api/agent/execute', { args: {} });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/agent/tools', () => {
    it('returns tool definitions', async () => {
      const res = await request(app, 'GET', '/api/agent/tools');
      expect(res.status).toBe(200);
      expect(res.body.tools).toHaveLength(12);
      expect(res.body.tools[0].name).toBeTruthy();
      expect(res.body.tools[0].description).toBeTruthy();
      expect(res.body.tools[0].inputSchema).toBeDefined();
    });
  });

  describe('POST /mcp/tools/list', () => {
    it('returns MCP-compatible tool list', async () => {
      const res = await request(app, 'POST', '/mcp/tools/list');
      expect(res.status).toBe(200);
      expect(res.body.tools).toHaveLength(12);
    });
  });

  describe('POST /mcp/tools/call', () => {
    it('executes MCP tool call', async () => {
      setupMockForListRuns();
      const res = await request(app, 'POST', '/mcp/tools/call', {
        name: 'list_runs',
        arguments: { limit: 5 },
      });
      expect(res.status).toBe(200);
      expect(res.body.content).toBeDefined();
      expect(res.body.content[0].type).toBe('text');
      // MCP response should be JSON string in content
      const parsed = JSON.parse(res.body.content[0].text);
      expect(parsed.success).toBe(true);
    });
  });
});
