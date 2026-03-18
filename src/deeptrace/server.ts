/**
 * DeepTrace HTTP API Server
 *
 * Serves the semantic query API and MCP tool interface.
 * This is the main backend for both the trace explorer UI and agent tools.
 */

import express from 'express';
// @ts-ignore — cors types are optional
import cors from 'cors';
import { DeepTraceQueryAPI } from './query-api';
import { MCPToolExecutor, TOOL_DEFINITIONS } from './mcp-tools';
import type { Visibility } from './types';

export interface ServerConfig {
  port?: number;
  host?: string;
  clickhouseUrl?: string;
  clickhouseDb?: string;
  clickhouseUser?: string;
  clickhousePassword?: string;
}

export function createDeepTraceServer(config: ServerConfig = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const api = new DeepTraceQueryAPI({
    clickhouseUrl: config.clickhouseUrl,
    clickhouseDb: config.clickhouseDb,
    clickhouseUser: config.clickhouseUser,
    clickhousePassword: config.clickhousePassword,
  });

  const agentExecutor = new MCPToolExecutor(api, 'visible_to_agent');

  // ─── Health ──────────────────────────────────────────────────────────

  app.get('/api/health', async (_req, res) => {
    try {
      const services = await api.getServices();
      res.json({ status: 'ok', services: services.data?.length || 0 });
    } catch (error: any) {
      res.json({ status: 'degraded', error: error.message });
    }
  });

  // ─── Runs (list recent traces) ──────────────────────────────────────

  app.get('/api/dt/runs', async (req, res) => {
    const result = await api.listRuns({
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      service: req.query.service ? String(req.query.service) : undefined,
      search: req.query.search ? String(req.query.search) : undefined,
      status: req.query.status as any,
    });
    res.json(result);
  });

  // ─── Trace Summary ─────────────────────────────────────────────────

  app.get('/api/dt/traces/:traceId/summary', async (req, res) => {
    const visibility = (req.query.visibility as Visibility) || 'visible_to_human';
    const result = await api.getTraceSummary(req.params.traceId, visibility);
    res.json(result);
  });

  // ─── Trace Graph ───────────────────────────────────────────────────

  app.get('/api/dt/traces/:traceId/graph', async (req, res) => {
    const visibility = (req.query.visibility as Visibility) || 'visible_to_human';
    const result = await api.getTraceGraph(req.params.traceId, {
      nodeTypes: req.query.nodeTypes ? String(req.query.nodeTypes).split(',') : undefined,
      services: req.query.services ? String(req.query.services).split(',') : undefined,
      visibility,
    });
    res.json(result);
  });

  // ─── Span Details ──────────────────────────────────────────────────

  app.get('/api/dt/spans/:spanId', async (req, res) => {
    const visibility = (req.query.visibility as Visibility) || 'visible_to_human';
    const result = await api.getSpanDetails(req.params.spanId, visibility);
    res.json(result);
  });

  // ─── Exceptions ────────────────────────────────────────────────────

  app.get('/api/dt/traces/:traceId/exceptions', async (req, res) => {
    const visibility = (req.query.visibility as Visibility) || 'visible_to_human';
    const result = await api.findExceptions(req.params.traceId, visibility);
    res.json(result);
  });

  // ─── Last Writer ───────────────────────────────────────────────────

  app.get('/api/dt/traces/:traceId/last-writer', async (req, res) => {
    const valueSelector = String(req.query.value || '');
    if (!valueSelector) {
      return res.status(400).json({ success: false, error: 'value query parameter required' });
    }
    const visibility = (req.query.visibility as Visibility) || 'visible_to_human';
    const result = await api.findLastWriter(req.params.traceId, valueSelector, visibility);
    res.json(result);
  });

  // ─── First Divergence ──────────────────────────────────────────────

  app.get('/api/dt/diff', async (req, res) => {
    const goodTraceId = String(req.query.good || '');
    const badTraceId = String(req.query.bad || '');
    if (!goodTraceId || !badTraceId) {
      return res.status(400).json({ success: false, error: 'good and bad query parameters required' });
    }
    const visibility = (req.query.visibility as Visibility) || 'visible_to_human';
    const result = await api.findFirstDivergence(goodTraceId, badTraceId, visibility);
    res.json(result);
  });

  // ─── Value Flow ────────────────────────────────────────────────────

  app.get('/api/dt/traces/:traceId/value-flow', async (req, res) => {
    const valueSelector = String(req.query.value || '');
    if (!valueSelector) {
      return res.status(400).json({ success: false, error: 'value query parameter required' });
    }
    const visibility = (req.query.visibility as Visibility) || 'visible_to_human';
    const result = await api.traceValueFlow(req.params.traceId, valueSelector, visibility);
    res.json(result);
  });

  // ─── Request Path ─────────────────────────────────────────────────

  app.get('/api/dt/traces/:traceId/request-path', async (req, res) => {
    const visibility = (req.query.visibility as Visibility) || 'visible_to_human';
    const result = await api.followRequestPath(
      req.params.traceId,
      req.query.selector ? String(req.query.selector) : undefined,
      visibility,
    );
    res.json(result);
  });

  // ─── Suspicious Transitions ────────────────────────────────────────

  app.get('/api/dt/traces/:traceId/suspicious', async (req, res) => {
    const visibility = (req.query.visibility as Visibility) || 'visible_to_human';
    const result = await api.summarizeSuspiciousTransitions(req.params.traceId, visibility);
    res.json(result);
  });

  // ─── Search Executed Code ──────────────────────────────────────────

  app.get('/api/dt/traces/:traceId/search', async (req, res) => {
    const query = String(req.query.q || '');
    if (!query) {
      return res.status(400).json({ success: false, error: 'q query parameter required' });
    }
    const visibility = (req.query.visibility as Visibility) || 'visible_to_human';
    const result = await api.searchExecutedCode(req.params.traceId, query, visibility);
    res.json(result);
  });

  // ─── Compare Segments ─────────────────────────────────────────────

  app.get('/api/dt/compare', async (req, res) => {
    const traceA = String(req.query.a || '');
    const traceB = String(req.query.b || '');
    if (!traceA || !traceB) {
      return res.status(400).json({ success: false, error: 'a and b query parameters required' });
    }
    const visibility = (req.query.visibility as Visibility) || 'visible_to_human';
    const result = await api.compareTraceSegments(traceA, traceB, req.query.selector ? String(req.query.selector) : undefined, visibility);
    res.json(result);
  });

  // ─── React Causal Queries (Phase 2) ─────────────────────────────

  app.get('/api/dt/traces/:traceId/why-render', async (req, res) => {
    const visibility = (req.query.visibility as Visibility) || 'visible_to_human';
    const result = await api.whyDidRender(req.params.traceId, {
      spanId: req.query.span_id ? String(req.query.span_id) : undefined,
      componentName: req.query.component ? String(req.query.component) : undefined,
      renderIndex: req.query.index !== undefined ? Number(req.query.index) : undefined,
      visibility,
    });
    res.json(result);
  });

  app.get('/api/dt/traces/:traceId/blast-radius', async (req, res) => {
    const stateKey = String(req.query.state_key || '');
    if (!stateKey) {
      return res.status(400).json({ success: false, error: 'state_key query parameter required' });
    }
    const visibility = (req.query.visibility as Visibility) || 'visible_to_human';
    const result = await api.blastRadius(req.params.traceId, stateKey, {
      componentName: req.query.component ? String(req.query.component) : undefined,
      visibility,
    });
    res.json(result);
  });

  app.get('/api/dt/traces/:traceId/effect-cascades', async (req, res) => {
    const visibility = (req.query.visibility as Visibility) || 'visible_to_human';
    const result = await api.detectEffectCascades(req.params.traceId, visibility);
    res.json(result);
  });

  app.get('/api/dt/traces/:traceId/async-races', async (req, res) => {
    const visibility = (req.query.visibility as Visibility) || 'visible_to_human';
    const result = await api.detectAsyncRaces(req.params.traceId, visibility);
    res.json(result);
  });

  // ─── Services ──────────────────────────────────────────────────────

  app.get('/api/dt/services', async (_req, res) => {
    const result = await api.getServices();
    res.json(result);
  });

  // ─── MCP Agent Tool Interface ──────────────────────────────────────

  app.get('/api/agent/tools', (_req, res) => {
    res.json({ tools: TOOL_DEFINITIONS });
  });

  app.post('/api/agent/execute', async (req, res) => {
    const { tool, args } = req.body;
    if (!tool) {
      return res.status(400).json({ success: false, error: 'tool field required' });
    }
    const result = await agentExecutor.executeTool(tool, args || {});
    res.json(result);
  });

  // ─── MCP Protocol Endpoints (simplified) ──────────────────────────

  app.post('/mcp/tools/list', (_req, res) => {
    res.json({
      tools: TOOL_DEFINITIONS.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  });

  app.post('/mcp/tools/call', async (req, res) => {
    const { name, arguments: args } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'name field required' });
    }
    const result = await agentExecutor.executeTool(name, args || {});
    res.json({
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    });
  });

  return { app, api, agentExecutor };
}

/**
 * Start the DeepTrace server.
 */
export function startDeepTraceServer(config: ServerConfig = {}): void {
  const port = config.port || parseInt(process.env.DEEPTRACE_PORT || '3005');
  const host = config.host || '127.0.0.1';

  const { app } = createDeepTraceServer(config);

  app.listen(port, host, () => {
    console.log(`DeepTrace API server running on http://${host}:${port}`);
    console.log(`  Query API:  http://${host}:${port}/api/dt/runs`);
    console.log(`  Agent API:  http://${host}:${port}/api/agent/tools`);
    console.log(`  MCP:        http://${host}:${port}/mcp/tools/list`);
  });
}
