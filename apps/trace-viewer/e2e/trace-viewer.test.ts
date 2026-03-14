/**
 * End-to-end test for the Deep Trace Viewer.
 *
 * This test:
 * 1. Verifies the Docker stack (ClickHouse + OTel Collector) is running
 * 2. Sends test trace data via OTLP to the collector
 * 3. Waits for ClickHouse to ingest the spans
 * 4. Boots the trace-viewer API server
 * 5. Verifies the API returns the ingested traces
 * 6. Verifies the source file reading API works
 *
 * Pre-requisite: `npm run stack:up` from the repo root.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { createClient, type ClickHouseClient } from '@clickhouse/client';

const CLICKHOUSE_URL = 'http://127.0.0.1:8123';
const OTLP_ENDPOINT = 'http://127.0.0.1:4318/v1/traces';
const API_PORT = 13004; // Use non-default port to avoid conflicts
const API_BASE = `http://127.0.0.1:${API_PORT}`;

// ── Helpers ────────────────────────────────────────────────────────────────

function httpGet(url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 0, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode || 0, body: data });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function httpPost(url: string, body: any): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: responseData }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs: number = 30_000,
  intervalMs: number = 1000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return;
    } catch {}
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ── Generate unique test data ──────────────────────────────────────────────

function randomHex(bytes: number): string {
  return Array.from({ length: bytes }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0'),
  ).join('');
}

const TEST_TRACE_ID = randomHex(16);
const ROOT_SPAN_ID = randomHex(8);
const CHILD_SPAN_ID = randomHex(8);
const NOW_NS = BigInt(Date.now()) * 1_000_000n;

function buildOtlpPayload() {
  return {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'e2e-test-service' } },
        ],
      },
      scopeSpans: [{
        scope: { name: 'deep-trace-e2e' },
        spans: [
          {
            traceId: TEST_TRACE_ID,
            spanId: ROOT_SPAN_ID,
            name: 'e2e-root-handler',
            kind: 2,
            startTimeUnixNano: NOW_NS.toString(),
            endTimeUnixNano: (NOW_NS + 50_000_000n).toString(),
            status: { code: 1 },
            attributes: [
              { key: 'function.name', value: { stringValue: 'e2eRootHandler' } },
              { key: 'function.type', value: { stringValue: 'http_handler' } },
              { key: 'code.filepath', value: { stringValue: 'demos/next-fullstack/app/api/demo/route.ts' } },
              { key: 'code.lineno', value: { intValue: '29' } },
              { key: 'function.args.0', value: { stringValue: '"test-term"' } },
              { key: 'function.args.count', value: { intValue: '1' } },
              { key: 'function.return.value', value: { stringValue: '{"confidence":0.98}' } },
            ],
          },
          {
            traceId: TEST_TRACE_ID,
            spanId: CHILD_SPAN_ID,
            parentSpanId: ROOT_SPAN_ID,
            name: 'lookupRecommendation',
            kind: 1,
            startTimeUnixNano: (NOW_NS + 5_000_000n).toString(),
            endTimeUnixNano: (NOW_NS + 40_000_000n).toString(),
            status: { code: 1 },
            attributes: [
              { key: 'function.name', value: { stringValue: 'lookupRecommendation' } },
              { key: 'function.type', value: { stringValue: 'user_function' } },
              { key: 'code.filepath', value: { stringValue: 'demos/next-fullstack/app/api/demo/route.ts' } },
              { key: 'code.lineno', value: { intValue: '13' } },
              { key: 'function.caller.name', value: { stringValue: 'e2eRootHandler' } },
              { key: 'function.args.0', value: { stringValue: '"test-term"' } },
              { key: 'function.return.value', value: { stringValue: '{"confidence":0.98,"source":"mock-model-cache"}' } },
            ],
          },
        ],
      }],
    }],
  };
}

// ── Test suite ─────────────────────────────────────────────────────────────

describe('Deep Trace Viewer E2E', () => {
  let serverProcess: ReturnType<typeof import('child_process').spawn> | null = null;
  let ch: ClickHouseClient | null = null;

  beforeAll(async () => {
    // 1. Check ClickHouse is reachable
    ch = createClient({
      url: CLICKHOUSE_URL,
      database: 'otel',
      username: 'otel',
      password: 'otel',
      request_timeout: 5000,
    });

    try {
      await ch.query({ query: 'SELECT 1', format: 'JSON' });
    } catch (e: any) {
      throw new Error(
        `ClickHouse not reachable at ${CLICKHOUSE_URL}. Run 'npm run stack:up' first. Error: ${e.message}`,
      );
    }

    // 2. Send test trace via OTLP
    const payload = buildOtlpPayload();
    const sendResult = await httpPost(OTLP_ENDPOINT, payload);
    expect(sendResult.status).toBeLessThan(300);

    // 3. Wait for ClickHouse to ingest the trace
    await waitFor(async () => {
      const result = await ch!.query({
        query: `SELECT count() as cnt FROM otel.otel_traces WHERE TraceId = '${TEST_TRACE_ID}'`,
        format: 'JSONEachRow',
      });
      const rows: any[] = await result.json();
      return rows.length > 0 && Number(rows[0].cnt) >= 2;
    }, 30_000, 2000);

    // 4. Start the trace-viewer API server
    const { spawn } = await import('child_process');
    const serverCwd = new URL('..', import.meta.url).pathname;
    serverProcess = spawn('npx', ['tsx', 'server/index.ts'], {
      cwd: serverCwd,
      env: {
        ...process.env,
        TRACE_VIEWER_PORT: String(API_PORT),
        NODE_ENV: 'test',
      },
      stdio: 'pipe',
    });

    // Capture stderr for debugging
    serverProcess.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('error')) {
        console.error('[trace-viewer-server]', msg);
      }
    });

    // Wait for server to be ready
    await waitFor(async () => {
      try {
        const res = await httpGet(`${API_BASE}/api/health`);
        return res.status === 200;
      } catch {
        return false;
      }
    }, 15_000, 500);
  }, 60_000);

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
    }
    if (ch) {
      await ch.close();
    }
  });

  it('health check reports ClickHouse connected', async () => {
    const { status, body } = await httpGet(`${API_BASE}/api/health`);
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.clickhouse).toBe('connected');
  });

  it('lists traces and includes the test trace', async () => {
    const { status, body } = await httpGet(`${API_BASE}/api/traces?limit=50`);
    expect(status).toBe(200);
    expect(body.traces).toBeDefined();
    expect(Array.isArray(body.traces)).toBe(true);

    const testTrace = body.traces.find((t: any) => t.traceId === TEST_TRACE_ID);
    expect(testTrace).toBeDefined();
    expect(testTrace.rootSpanName).toBe('e2e-root-handler');
    expect(testTrace.serviceName).toBe('e2e-test-service');
    expect(testTrace.spanCount).toBe(2);
  });

  it('returns full trace detail with parent-child spans', async () => {
    const { status, body } = await httpGet(`${API_BASE}/api/traces/${TEST_TRACE_ID}`);
    expect(status).toBe(200);
    expect(body.traceId).toBe(TEST_TRACE_ID);
    expect(body.spans).toHaveLength(2);

    const root = body.spans.find((s: any) => s.spanId === ROOT_SPAN_ID);
    expect(root).toBeDefined();
    expect(root.name).toBe('e2e-root-handler');
    expect(root.parentSpanId).toBeFalsy();
    expect(root.attributes['function.type']).toBe('http_handler');
    expect(root.attributes['code.filepath']).toBe('demos/next-fullstack/app/api/demo/route.ts');

    const child = body.spans.find((s: any) => s.spanId === CHILD_SPAN_ID);
    expect(child).toBeDefined();
    expect(child.name).toBe('lookupRecommendation');
    expect(child.parentSpanId).toBe(ROOT_SPAN_ID);
    expect(child.attributes['function.caller.name']).toBe('e2eRootHandler');
  });

  it('span attributes include deep-trace specific fields', async () => {
    const { body } = await httpGet(`${API_BASE}/api/traces/${TEST_TRACE_ID}`);
    const child = body.spans.find((s: any) => s.name === 'lookupRecommendation');

    expect(child.attributes['function.name']).toBe('lookupRecommendation');
    expect(child.attributes['function.type']).toBe('user_function');
    expect(child.attributes['function.caller.name']).toBe('e2eRootHandler');
    expect(child.attributes['function.args.0']).toBe('"test-term"');
    expect(child.attributes['function.return.value']).toContain('confidence');
  });

  it('reads source files from the project', async () => {
    const { status, body } = await httpGet(
      `${API_BASE}/api/source?path=${encodeURIComponent('demos/next-fullstack/app/api/demo/route.ts')}`,
    );
    expect(status).toBe(200);
    expect(body.content).toContain('lookupRecommendation');
    expect(body.content).toContain('buildNarrative');
    expect(body.language).toBe('typescript');
    expect(body.lineCount).toBeGreaterThan(10);
  });

  it('blocks directory traversal attempts', async () => {
    const { status } = await httpGet(
      `${API_BASE}/api/source?path=${encodeURIComponent('../../etc/passwd')}`,
    );
    expect(status).toBe(403);
  });

  it('returns services list', async () => {
    const { status, body } = await httpGet(`${API_BASE}/api/services`);
    expect(status).toBe(200);
    expect(body.services).toBeDefined();
    expect(Array.isArray(body.services)).toBe(true);

    const testService = body.services.find((s: any) => s.ServiceName === 'e2e-test-service');
    expect(testService).toBeDefined();
    expect(Number(testService.total_spans)).toBeGreaterThanOrEqual(2);
  });

  it('search filters work on traces', async () => {
    const { body: byName } = await httpGet(`${API_BASE}/api/traces?search=e2e-root`);
    expect(byName.traces.length).toBeGreaterThanOrEqual(1);
    expect(byName.traces[0].rootSpanName).toContain('e2e-root');

    const { body: byService } = await httpGet(`${API_BASE}/api/traces?service=e2e-test-service`);
    expect(byService.traces.length).toBeGreaterThanOrEqual(1);
    expect(byService.traces.every((t: any) => t.serviceName === 'e2e-test-service')).toBe(true);
  });

  it('returns 404 for non-existent trace', async () => {
    const { status } = await httpGet(`${API_BASE}/api/traces/00000000000000000000000000000000`);
    expect(status).toBe(404);
  });
});
