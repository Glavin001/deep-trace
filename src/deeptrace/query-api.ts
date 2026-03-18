/**
 * DeepTrace Semantic Query API
 *
 * Provides high-level debugging queries over the execution graph.
 * This is the core interface for both the human UI and agent tools.
 */

import { createClient, ClickHouseClient } from '@clickhouse/client';
import {
  buildExecutionGraph,
  buildTraceSummary,
  buildTraceRun,
  compareTraces,
  extractValueSnapshots,
  whyDidRender as whyDidRenderFromGraph,
  computeBlastRadius,
  detectEffectCascadeCycles,
  detectAsyncRaceConditions,
  type RawSpan,
} from './enrichment';
import { redactAttributes } from './redaction';
import type {
  TraceSummary, TraceRun, TraceDiff, ExecutionGraph,
  GraphNode, ValueSnapshot, ExceptionInfo,
  EvidenceRef, AgentResponse, Visibility, RedactionPolicy,
  DivergencePoint, BlastRadiusSummary, EffectCascadeCycle, AsyncRaceCondition,
} from './types';
import { DEFAULT_REDACTION_POLICY } from './types';

// ─── ClickHouse Connection ───────────────────────────────────────────────────

export interface QueryAPIConfig {
  clickhouseUrl?: string;
  clickhouseDb?: string;
  clickhouseUser?: string;
  clickhousePassword?: string;
  redactionPolicy?: RedactionPolicy;
}

export class DeepTraceQueryAPI {
  private ch: ClickHouseClient;
  private redactionPolicy: RedactionPolicy;

  constructor(config: QueryAPIConfig = {}) {
    this.ch = createClient({
      url: config.clickhouseUrl || process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123',
      database: config.clickhouseDb || process.env.CLICKHOUSE_DB || 'otel',
      username: config.clickhouseUser || process.env.CLICKHOUSE_USER || 'otel',
      password: config.clickhousePassword || process.env.CLICKHOUSE_PASSWORD || 'otel',
      request_timeout: 10_000,
    });
    this.redactionPolicy = config.redactionPolicy || DEFAULT_REDACTION_POLICY;
  }

  // ─── Span Fetching Helpers ───────────────────────────────────────────────

  private parseChTimestamp(ts: string): number {
    if (!ts) return 0;
    if (!ts.endsWith('Z') && !ts.includes('+') && !ts.includes('T')) {
      return new Date(ts.replace(' ', 'T') + 'Z').getTime();
    }
    return new Date(ts).getTime();
  }

  private parseAttributes(attrs: any): Record<string, any> {
    if (typeof attrs === 'string') {
      try { return JSON.parse(attrs); } catch { return {}; }
    }
    return attrs || {};
  }

  private rowToRawSpan(row: any): RawSpan {
    const attrs = this.parseAttributes(row.SpanAttributes);
    const startMs = this.parseChTimestamp(row.Timestamp);
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
        attributes: row.EventAttributes?.[i] ? (() => {
          try { return JSON.parse(row.EventAttributes[i]); } catch { return {}; }
        })() : {},
      })),
    };
  }

  private async fetchSpansForTrace(traceId: string): Promise<RawSpan[]> {
    const result = await this.ch.query({
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
    return rows.map(r => this.rowToRawSpan(r));
  }

  // ─── Redaction Helper ──────────────────────────────────────────────────

  private redact(attrs: Record<string, any>, visibility: Visibility = 'visible_to_human'): Record<string, any> {
    return redactAttributes(attrs, visibility, this.redactionPolicy);
  }

  private redactSpans(spans: RawSpan[], visibility: Visibility = 'visible_to_human'): RawSpan[] {
    return spans.map(s => ({
      ...s,
      attributes: this.redact(s.attributes, visibility),
    }));
  }

  // ─── API Methods ───────────────────────────────────────────────────────

  /**
   * List recent trace runs.
   */
  async listRuns(options: {
    limit?: number;
    service?: string;
    search?: string;
    status?: 'success' | 'error';
    visibility?: Visibility;
  } = {}): Promise<AgentResponse<TraceRun[]>> {
    try {
      const limit = Math.min(options.limit || 50, 200);

      let where = "ParentSpanId = ''";
      const params: Record<string, any> = {};

      if (options.service) {
        where += ' AND ServiceName = {service:String}';
        params.service = options.service;
      }
      if (options.search) {
        where += ' AND (SpanName ILIKE {search:String} OR TraceId ILIKE {search:String})';
        params.search = `%${options.search}%`;
      }

      const result = await this.ch.query({
        query: `
          SELECT
            TraceId, SpanName, ServiceName,
            Duration / 1000000 AS duration_ms,
            StatusCode, Timestamp, SpanAttributes
          FROM otel.otel_traces
          WHERE ${where}
          ORDER BY Timestamp DESC
          LIMIT {limit:UInt32}
        `,
        query_params: { ...params, limit },
        format: 'JSONEachRow',
      });

      const rows: any[] = await result.json();

      // Get span counts per trace
      const traceIds = rows.map((r: any) => r.TraceId);
      let spanCounts: Record<string, number> = {};
      let errorCounts: Record<string, number> = {};

      if (traceIds.length > 0) {
        const countResult = await this.ch.query({
          query: `
            SELECT
              TraceId,
              count() AS span_count,
              countIf(StatusCode = 'STATUS_CODE_ERROR') AS error_count
            FROM otel.otel_traces
            WHERE TraceId IN ({traceIds:Array(String)})
            GROUP BY TraceId
          `,
          query_params: { traceIds },
          format: 'JSONEachRow',
        });
        const countRows: any[] = await countResult.json();
        spanCounts = Object.fromEntries(countRows.map(r => [r.TraceId, Number(r.span_count)]));
        errorCounts = Object.fromEntries(countRows.map(r => [r.TraceId, Number(r.error_count)]));
      }

      const runs: TraceRun[] = rows.map(row => {
        const startMs = this.parseChTimestamp(row.Timestamp);
        const durationMs = Number(row.duration_ms);
        const ec = errorCounts[row.TraceId] || 0;

        return {
          id: `run_${row.TraceId}`,
          traceId: row.TraceId,
          tags: [],
          startTime: startMs,
          endTime: startMs + durationMs,
          durationMs,
          serviceName: row.ServiceName,
          services: [row.ServiceName],
          rootSpanName: row.SpanName,
          spanCount: spanCounts[row.TraceId] || 1,
          errorCount: ec,
          hasExceptions: ec > 0,
          status: ec > 0 ? 'error' : 'success' as const,
          suspiciousnessScore: ec > 0 ? Math.min(ec * 30, 100) : 0,
        };
      });

      // Filter by status if requested
      const filtered = options.status
        ? runs.filter(r => r.status === options.status)
        : runs;

      return { success: true, data: filtered };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get a full trace summary with causal analysis.
   */
  async getTraceSummary(traceId: string, visibility: Visibility = 'visible_to_human'): Promise<AgentResponse<TraceSummary>> {
    try {
      const rawSpans = await this.fetchSpansForTrace(traceId);
      if (rawSpans.length === 0) {
        return { success: false, error: 'Trace not found' };
      }

      const spans = this.redactSpans(rawSpans, visibility);
      const graph = buildExecutionGraph(spans);
      const summary = buildTraceSummary(spans, graph);

      const evidence: EvidenceRef[] = summary.exceptions.map(e => ({
        traceId,
        spanId: e.spanId,
        sourceLocation: e.sourceLocation,
        valuePreview: e.message,
      }));

      return { success: true, data: summary, evidence };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get the full execution graph for a trace.
   */
  async getTraceGraph(traceId: string, filters?: {
    nodeTypes?: string[];
    services?: string[];
    visibility?: Visibility;
  }): Promise<AgentResponse<ExecutionGraph>> {
    try {
      const rawSpans = await this.fetchSpansForTrace(traceId);
      if (rawSpans.length === 0) {
        return { success: false, error: 'Trace not found' };
      }

      const visibility = filters?.visibility || 'visible_to_human';
      const spans = this.redactSpans(rawSpans, visibility);
      let graph = buildExecutionGraph(spans);

      // Apply filters
      if (filters?.nodeTypes) {
        graph = {
          ...graph,
          nodes: graph.nodes.filter(n => filters.nodeTypes!.includes(n.type)),
          edges: graph.edges.filter(e =>
            graph.nodes.some(n => filters.nodeTypes!.includes(n.type) && (n.id === e.sourceNodeId || n.id === e.targetNodeId))
          ),
        };
      }
      if (filters?.services) {
        graph = {
          ...graph,
          nodes: graph.nodes.filter(n => !n.serviceName || filters.services!.includes(n.serviceName)),
        };
      }

      return { success: true, data: graph };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get detailed information about a specific span.
   */
  async getSpanDetails(spanId: string, visibility: Visibility = 'visible_to_human'): Promise<AgentResponse<GraphNode & { values: ValueSnapshot[] }>> {
    try {
      const result = await this.ch.query({
        query: `
          SELECT
            TraceId, SpanId, ParentSpanId, SpanName, ServiceName, SpanKind,
            Duration / 1000000 AS duration_ms,
            StatusCode, StatusMessage, Timestamp, SpanAttributes,
            Events.Name AS EventNames,
            Events.Timestamp AS EventTimestamps,
            Events.Attributes AS EventAttributes
          FROM otel.otel_traces
          WHERE SpanId = {spanId:String}
          LIMIT 1
        `,
        query_params: { spanId },
        format: 'JSONEachRow',
      });

      const rows: any[] = await result.json();
      if (rows.length === 0) {
        return { success: false, error: 'Span not found' };
      }

      const span = this.rowToRawSpan(rows[0]);
      const redacted: RawSpan = { ...span, attributes: this.redact(span.attributes, visibility) };
      const graph = buildExecutionGraph([redacted]);
      const node = graph.nodes[0];
      const values = extractValueSnapshots([redacted]);

      const evidence: EvidenceRef[] = [{
        traceId: span.traceId,
        spanId: span.spanId,
        sourceLocation: node.sourceLocation,
      }];

      return { success: true, data: { ...node, values }, evidence };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Find all exceptions in a trace.
   */
  async findExceptions(traceId: string, visibility: Visibility = 'visible_to_human'): Promise<AgentResponse<ExceptionInfo[]>> {
    try {
      const rawSpans = await this.fetchSpansForTrace(traceId);
      if (rawSpans.length === 0) {
        return { success: false, error: 'Trace not found' };
      }

      const spans = this.redactSpans(rawSpans, visibility);
      const graph = buildExecutionGraph(spans);
      const summary = buildTraceSummary(spans, graph);

      const evidence: EvidenceRef[] = summary.exceptions.map(e => ({
        traceId,
        spanId: e.spanId,
        sourceLocation: e.sourceLocation,
        valuePreview: `${e.type}: ${e.message}`,
      }));

      return { success: true, data: summary.exceptions, evidence };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Find where a value was last written/set in a trace.
   */
  async findLastWriter(traceId: string, valueSelector: string, visibility: Visibility = 'visible_to_human'): Promise<AgentResponse<{ span: GraphNode; value: ValueSnapshot } | null>> {
    try {
      const rawSpans = await this.fetchSpansForTrace(traceId);
      if (rawSpans.length === 0) {
        return { success: false, error: 'Trace not found' };
      }

      const spans = this.redactSpans(rawSpans, visibility);
      const values = extractValueSnapshots(spans);

      // Search for matching value by name or content
      const lowerSelector = valueSelector.toLowerCase();
      const matching = values.filter(v =>
        v.name.toLowerCase().includes(lowerSelector) ||
        v.preview.toLowerCase().includes(lowerSelector) ||
        (v.fullValue && v.fullValue.toLowerCase().includes(lowerSelector))
      );

      if (matching.length === 0) {
        return { success: true, data: null };
      }

      // Return the last one (most recent writer)
      const lastValue = matching[matching.length - 1];
      const span = spans.find(s => s.spanId === lastValue.spanId);
      if (!span) {
        return { success: true, data: null };
      }

      const graph = buildExecutionGraph([span]);
      const node = graph.nodes[0];

      const evidence: EvidenceRef[] = [{
        traceId,
        spanId: lastValue.spanId,
        sourceLocation: node.sourceLocation,
        valuePreview: lastValue.preview,
      }];

      return { success: true, data: { span: node, value: lastValue }, evidence };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Find the first divergence between a good trace and a bad trace.
   */
  async findFirstDivergence(goodTraceId: string, badTraceId: string, visibility: Visibility = 'visible_to_human'): Promise<AgentResponse<TraceDiff>> {
    try {
      const [goodSpans, badSpans] = await Promise.all([
        this.fetchSpansForTrace(goodTraceId),
        this.fetchSpansForTrace(badTraceId),
      ]);

      if (goodSpans.length === 0) {
        return { success: false, error: 'Good trace not found' };
      }
      if (badSpans.length === 0) {
        return { success: false, error: 'Bad trace not found' };
      }

      const redactedGood = this.redactSpans(goodSpans, visibility);
      const redactedBad = this.redactSpans(badSpans, visibility);

      const comparison = compareTraces(redactedGood, redactedBad);

      const diff: TraceDiff = {
        goodTraceId,
        badTraceId,
        firstDivergence: comparison.firstDivergence,
        divergences: comparison.divergences,
        summary: comparison.summary,
        missingSpans: comparison.missingSpans,
        extraSpans: comparison.extraSpans,
        changedSpans: comparison.changedSpans,
      };

      const evidence: EvidenceRef[] = comparison.divergences.slice(0, 5).map(d => ({
        traceId: d.badSpanId ? badTraceId : goodTraceId,
        spanId: d.badSpanId || d.goodSpanId || '',
        valuePreview: d.description,
      }));

      return { success: true, data: diff, evidence };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Trace the flow of a value through a trace.
   */
  async traceValueFlow(traceId: string, valueSelector: string, visibility: Visibility = 'visible_to_human'): Promise<AgentResponse<ValueSnapshot[]>> {
    try {
      const rawSpans = await this.fetchSpansForTrace(traceId);
      if (rawSpans.length === 0) {
        return { success: false, error: 'Trace not found' };
      }

      const spans = this.redactSpans(rawSpans, visibility);
      const values = extractValueSnapshots(spans);

      const lowerSelector = valueSelector.toLowerCase();
      const matching = values.filter(v =>
        v.name.toLowerCase().includes(lowerSelector) ||
        v.preview.toLowerCase().includes(lowerSelector) ||
        (v.fullValue && v.fullValue.toLowerCase().includes(lowerSelector))
      );

      const evidence: EvidenceRef[] = matching.map(v => ({
        traceId,
        spanId: v.spanId,
        valuePreview: v.preview,
      }));

      return { success: true, data: matching, evidence };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Follow the request path through a trace.
   */
  async followRequestPath(traceId: string, requestSelector?: string, visibility: Visibility = 'visible_to_human'): Promise<AgentResponse<import('./types').RequestPathStep[]>> {
    try {
      const rawSpans = await this.fetchSpansForTrace(traceId);
      if (rawSpans.length === 0) {
        return { success: false, error: 'Trace not found' };
      }

      const spans = this.redactSpans(rawSpans, visibility);
      const graph = buildExecutionGraph(spans);
      const summary = buildTraceSummary(spans, graph);

      let path = summary.requestPath;
      if (requestSelector) {
        const lower = requestSelector.toLowerCase();
        // Filter to steps matching the selector
        const startIdx = path.findIndex(s =>
          s.name.toLowerCase().includes(lower) ||
          s.serviceName.toLowerCase().includes(lower)
        );
        if (startIdx >= 0) {
          path = path.slice(startIdx);
        }
      }

      const evidence: EvidenceRef[] = path.map(step => ({
        traceId,
        spanId: step.spanId,
        valuePreview: `${step.name} (${step.serviceName}) - ${step.durationMs.toFixed(1)}ms`,
      }));

      return { success: true, data: path, evidence };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Summarize suspicious transitions in a trace.
   */
  async summarizeSuspiciousTransitions(traceId: string, visibility: Visibility = 'visible_to_human'): Promise<AgentResponse<{
    score: number;
    findings: Array<{ severity: string; description: string; spanId: string; evidence: EvidenceRef }>;
  }>> {
    try {
      const rawSpans = await this.fetchSpansForTrace(traceId);
      if (rawSpans.length === 0) {
        return { success: false, error: 'Trace not found' };
      }

      const spans = this.redactSpans(rawSpans, visibility);
      const graph = buildExecutionGraph(spans);
      const summary = buildTraceSummary(spans, graph);

      const findings: Array<{ severity: string; description: string; spanId: string; evidence: EvidenceRef }> = [];

      // Error spans
      for (const span of spans) {
        if (span.statusCode === 'STATUS_CODE_ERROR') {
          findings.push({
            severity: 'critical',
            description: `Error in "${span.name}" (${span.serviceName}): ${span.statusMessage || 'unknown error'}`,
            spanId: span.spanId,
            evidence: { traceId, spanId: span.spanId, sourceLocation: extractSourceLoc(span.attributes) },
          });
        }
      }

      // Slow spans (>500ms)
      for (const span of spans) {
        if (span.durationMs > 500) {
          findings.push({
            severity: 'warning',
            description: `Slow span "${span.name}": ${span.durationMs.toFixed(1)}ms`,
            spanId: span.spanId,
            evidence: { traceId, spanId: span.spanId, sourceLocation: extractSourceLoc(span.attributes) },
          });
        }
      }

      // Orphan spans (missing parent)
      for (const span of spans) {
        if (span.parentSpanId && !spans.some(s => s.spanId === span.parentSpanId)) {
          findings.push({
            severity: 'info',
            description: `Orphan span "${span.name}" — parent ${span.parentSpanId} not in trace`,
            spanId: span.spanId,
            evidence: { traceId, spanId: span.spanId },
          });
        }
      }

      // Sort by severity
      const order: Record<string, number> = { critical: 0, warning: 1, info: 2 };
      findings.sort((a, b) => (order[a.severity] || 9) - (order[b.severity] || 9));

      const evidence = findings.map(f => f.evidence);

      return {
        success: true,
        data: { score: summary.suspiciousnessScore, findings },
        evidence,
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Search for executed code in a trace.
   */
  async searchExecutedCode(traceId: string, query: string, visibility: Visibility = 'visible_to_human'): Promise<AgentResponse<GraphNode[]>> {
    try {
      const rawSpans = await this.fetchSpansForTrace(traceId);
      if (rawSpans.length === 0) {
        return { success: false, error: 'Trace not found' };
      }

      const spans = this.redactSpans(rawSpans, visibility);
      const graph = buildExecutionGraph(spans);

      const lower = query.toLowerCase();
      const matching = graph.nodes.filter(n =>
        n.name.toLowerCase().includes(lower) ||
        n.sourceLocation?.filePath?.toLowerCase().includes(lower) ||
        n.sourceLocation?.functionName?.toLowerCase().includes(lower) ||
        n.serviceName?.toLowerCase().includes(lower)
      );

      const evidence: EvidenceRef[] = matching.map(n => ({
        traceId,
        spanId: n.spanId || '',
        sourceLocation: n.sourceLocation,
        valuePreview: n.name,
      }));

      return { success: true, data: matching, evidence };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Compare segments of two traces.
   */
  async compareTraceSegments(
    traceAId: string,
    traceBId: string,
    selector?: string,
    visibility: Visibility = 'visible_to_human',
  ): Promise<AgentResponse<TraceDiff>> {
    try {
      let [spansA, spansB] = await Promise.all([
        this.fetchSpansForTrace(traceAId),
        this.fetchSpansForTrace(traceBId),
      ]);

      if (spansA.length === 0 || spansB.length === 0) {
        return { success: false, error: 'One or both traces not found' };
      }

      // Filter by selector if provided
      if (selector) {
        const lower = selector.toLowerCase();
        spansA = spansA.filter(s =>
          s.name.toLowerCase().includes(lower) ||
          s.serviceName.toLowerCase().includes(lower)
        );
        spansB = spansB.filter(s =>
          s.name.toLowerCase().includes(lower) ||
          s.serviceName.toLowerCase().includes(lower)
        );
      }

      const redactedA = this.redactSpans(spansA, visibility);
      const redactedB = this.redactSpans(spansB, visibility);
      const comparison = compareTraces(redactedA, redactedB);

      const diff: TraceDiff = {
        goodTraceId: traceAId,
        badTraceId: traceBId,
        firstDivergence: comparison.firstDivergence,
        divergences: comparison.divergences,
        summary: comparison.summary,
        missingSpans: comparison.missingSpans,
        extraSpans: comparison.extraSpans,
        changedSpans: comparison.changedSpans,
      };

      return { success: true, data: diff };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  // ─── React Causal Query Methods (Phase 2) ─────────────────────────────

  /**
   * Explain why a React component re-rendered.
   */
  async whyDidRender(traceId: string, options: {
    spanId?: string;
    componentName?: string;
    renderIndex?: number;
    visibility?: Visibility;
  }): Promise<AgentResponse> {
    try {
      const rawSpans = await this.fetchSpansForTrace(traceId);
      if (rawSpans.length === 0) {
        return { success: false, error: 'Trace not found' };
      }

      const visibility = options.visibility || 'visible_to_human';
      const spans = this.redactSpans(rawSpans, visibility);
      const graph = buildExecutionGraph(spans);

      let targetSpanId = options.spanId;
      if (!targetSpanId && options.componentName) {
        // Find the render span for this component
        const renderSpans = spans.filter(s =>
          (s.attributes['component.name'] === options.componentName || s.name === options.componentName) &&
          s.attributes['dt.react.render_cause']
        );
        const idx = options.renderIndex !== undefined ? options.renderIndex : renderSpans.length - 1;
        if (renderSpans[idx]) {
          targetSpanId = renderSpans[idx].spanId;
        }
      }

      if (!targetSpanId) {
        return { success: false, error: 'Render span not found. Provide span_id or component_name.' };
      }

      const chain = whyDidRenderFromGraph(graph, targetSpanId);
      const targetSpan = spans.find(s => s.spanId === targetSpanId);
      const renderCause = targetSpan?.attributes['dt.react.render_cause'];

      const evidence: EvidenceRef[] = chain.map(c => ({
        traceId,
        spanId: c.nodeId.replace('node_', ''),
        valuePreview: `${c.edgeType}: ${c.nodeName}`,
      }));

      return {
        success: true,
        data: {
          spanId: targetSpanId,
          componentName: targetSpan?.attributes['component.name'] || targetSpan?.name,
          renderCause,
          changedProps: targetSpan?.attributes['dt.react.changed_props'],
          changedStateHooks: targetSpan?.attributes['dt.react.changed_state_hooks'],
          stateBefore: targetSpan?.attributes['dt.react.state_before'],
          stateAfter: targetSpan?.attributes['dt.react.state_after'],
          causalChain: chain,
        },
        evidence,
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Find the blast radius of a state change.
   */
  async blastRadius(traceId: string, stateKey: string, options?: {
    componentName?: string;
    visibility?: Visibility;
  }): Promise<AgentResponse<BlastRadiusSummary>> {
    try {
      const rawSpans = await this.fetchSpansForTrace(traceId);
      if (rawSpans.length === 0) {
        return { success: false, error: 'Trace not found' };
      }

      const visibility = options?.visibility || 'visible_to_human';
      const spans = this.redactSpans(rawSpans, visibility);
      const graph = buildExecutionGraph(spans);
      const result = computeBlastRadius(graph, stateKey);

      const evidence: EvidenceRef[] = result.affectedComponents.map(c => ({
        traceId,
        spanId: '',
        valuePreview: `Component ${c} affected by state "${stateKey}"`,
      }));

      return { success: true, data: result, evidence };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Detect render → effect → setState → render cycles.
   */
  async detectEffectCascades(traceId: string, visibility: Visibility = 'visible_to_human'): Promise<AgentResponse<EffectCascadeCycle[]>> {
    try {
      const rawSpans = await this.fetchSpansForTrace(traceId);
      if (rawSpans.length === 0) {
        return { success: false, error: 'Trace not found' };
      }

      const spans = this.redactSpans(rawSpans, visibility);
      const graph = buildExecutionGraph(spans);
      const cycles = detectEffectCascadeCycles(spans, graph);

      const evidence: EvidenceRef[] = cycles.flatMap(c =>
        c.sourceLocations.map(loc => ({
          traceId,
          spanId: '',
          sourceLocation: loc,
          valuePreview: `Effect cascade: ${c.cycle.join(' → ')}`,
        }))
      );

      return { success: true, data: cycles, evidence };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Detect async race conditions in state writes.
   */
  async detectAsyncRaces(traceId: string, visibility: Visibility = 'visible_to_human'): Promise<AgentResponse<AsyncRaceCondition[]>> {
    try {
      const rawSpans = await this.fetchSpansForTrace(traceId);
      if (rawSpans.length === 0) {
        return { success: false, error: 'Trace not found' };
      }

      const spans = this.redactSpans(rawSpans, visibility);
      const graph = buildExecutionGraph(spans);
      const races = detectAsyncRaceConditions(spans, graph);

      const evidence: EvidenceRef[] = races.flatMap(r =>
        r.writers.map(w => ({
          traceId,
          spanId: w.spanId,
          valuePreview: `Async write to "${r.stateKey}" from ${w.fetchUrl || 'unknown'}`,
        }))
      );

      return { success: true, data: races, evidence };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get list of services seen in recent traces.
   */
  async getServices(): Promise<AgentResponse<Array<{ name: string; spanCount: number; errorCount: number }>>> {
    try {
      const result = await this.ch.query({
        query: `
          SELECT
            ServiceName AS name,
            count() AS span_count,
            countIf(StatusCode = 'STATUS_CODE_ERROR') AS error_count
          FROM otel.otel_traces
          WHERE Timestamp >= now() - INTERVAL 24 HOUR
          GROUP BY ServiceName
          ORDER BY span_count DESC
        `,
        format: 'JSONEachRow',
      });

      const rows: any[] = await result.json();
      const services = rows.map(r => ({
        name: r.name,
        spanCount: Number(r.span_count),
        errorCount: Number(r.error_count),
      }));

      return { success: true, data: services };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Close the ClickHouse connection.
   */
  async close(): Promise<void> {
    await this.ch.close();
  }
}

function extractSourceLoc(attrs: Record<string, any>) {
  if (!attrs['code.filepath']) return undefined;
  return {
    filePath: attrs['code.filepath'],
    line: attrs['code.lineno'],
    column: attrs['code.column'],
    functionName: attrs['function.name'],
  };
}
