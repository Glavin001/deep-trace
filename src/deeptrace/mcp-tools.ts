/**
 * DeepTrace MCP-Compatible Agent Tool Interface
 *
 * Provides structured debugging tools for AI agents.
 * Each tool returns evidence-backed, deterministic responses.
 *
 * Can be used standalone via HTTP or integrated into MCP servers.
 */

import { DeepTraceQueryAPI } from './query-api';
import type { MCPToolDefinition, AgentResponse, Visibility } from './types';

// ─── Tool Definitions ────────────────────────────────────────────────────────

export const TOOL_DEFINITIONS: MCPToolDefinition[] = [
  {
    name: 'list_runs',
    description: 'List recent trace runs with status, duration, and error summaries. Use to find traces to investigate.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max runs to return (default 20, max 200)' },
        service: { type: 'string', description: 'Filter by service name' },
        search: { type: 'string', description: 'Search by span name or trace ID' },
        status: { type: 'string', enum: ['success', 'error'], description: 'Filter by run status' },
      },
    },
  },
  {
    name: 'get_trace_summary',
    description: 'Get a high-level summary of a trace: what happened, errors, request path, async hops, services involved. Start here when investigating a trace.',
    inputSchema: {
      type: 'object',
      properties: {
        trace_id: { type: 'string', description: 'The trace ID to summarize' },
      },
      required: ['trace_id'],
    },
  },
  {
    name: 'get_trace_graph',
    description: 'Get the causal execution graph for a trace. Shows nodes (spans) and causal edges (parent-child, async, cross-service).',
    inputSchema: {
      type: 'object',
      properties: {
        trace_id: { type: 'string', description: 'The trace ID' },
        node_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by node types: span, network_request, db_query, exception, async_task, user_action',
        },
        services: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by service names',
        },
      },
      required: ['trace_id'],
    },
  },
  {
    name: 'get_span_details',
    description: 'Get detailed information about a specific span: attributes, values, source location, events.',
    inputSchema: {
      type: 'object',
      properties: {
        span_id: { type: 'string', description: 'The span ID' },
      },
      required: ['span_id'],
    },
  },
  {
    name: 'find_exceptions',
    description: 'Find all exceptions in a trace with their stack traces, source locations, and ancestor span chains.',
    inputSchema: {
      type: 'object',
      properties: {
        trace_id: { type: 'string', description: 'The trace ID' },
      },
      required: ['trace_id'],
    },
  },
  {
    name: 'find_last_writer',
    description: 'Find where a value was last written/set in a trace. Useful for data provenance questions like "where did this value come from?"',
    inputSchema: {
      type: 'object',
      properties: {
        trace_id: { type: 'string', description: 'The trace ID' },
        value_selector: { type: 'string', description: 'Search term for the value (matches name, preview, or content)' },
      },
      required: ['trace_id', 'value_selector'],
    },
  },
  {
    name: 'find_first_divergence',
    description: 'Compare a good trace to a bad trace and find the first meaningful divergence. Essential for "what changed?" debugging.',
    inputSchema: {
      type: 'object',
      properties: {
        good_trace_id: { type: 'string', description: 'The trace ID of the known-good run' },
        bad_trace_id: { type: 'string', description: 'The trace ID of the failing run' },
      },
      required: ['good_trace_id', 'bad_trace_id'],
    },
  },
  {
    name: 'trace_value_flow',
    description: 'Trace how a value flows through a trace — shows all snapshots where the value appears at boundaries.',
    inputSchema: {
      type: 'object',
      properties: {
        trace_id: { type: 'string', description: 'The trace ID' },
        value_selector: { type: 'string', description: 'Search term for the value' },
      },
      required: ['trace_id', 'value_selector'],
    },
  },
  {
    name: 'follow_request_path',
    description: 'Follow the request path through a trace from root to leaf, showing the critical path across services.',
    inputSchema: {
      type: 'object',
      properties: {
        trace_id: { type: 'string', description: 'The trace ID' },
        request_selector: { type: 'string', description: 'Optional: filter to a specific request/service name' },
      },
      required: ['trace_id'],
    },
  },
  {
    name: 'summarize_suspicious_transitions',
    description: 'Analyze a trace for suspicious patterns: errors, slow spans, orphan async hops, anomalies.',
    inputSchema: {
      type: 'object',
      properties: {
        trace_id: { type: 'string', description: 'The trace ID' },
      },
      required: ['trace_id'],
    },
  },
  {
    name: 'search_executed_code',
    description: 'Search for executed code in a trace by function name, file path, or service name.',
    inputSchema: {
      type: 'object',
      properties: {
        trace_id: { type: 'string', description: 'The trace ID' },
        query: { type: 'string', description: 'Search query (function name, file path, or service)' },
      },
      required: ['trace_id', 'query'],
    },
  },
  {
    name: 'compare_trace_segments',
    description: 'Compare specific segments of two traces, optionally filtered by a selector.',
    inputSchema: {
      type: 'object',
      properties: {
        trace_a: { type: 'string', description: 'First trace ID' },
        trace_b: { type: 'string', description: 'Second trace ID' },
        selector: { type: 'string', description: 'Optional filter by span/service name' },
      },
      required: ['trace_a', 'trace_b'],
    },
  },
  // ─── React Causal Query Tools (Phase 2) ──────────────────────────────────
  {
    name: 'why_did_render',
    description: 'Explain why a React component re-rendered by walking backward through causal edges. Returns the full chain: which state changed, which prop, or if the parent re-rendered unnecessarily.',
    inputSchema: {
      type: 'object',
      properties: {
        trace_id: { type: 'string', description: 'The trace ID' },
        span_id: { type: 'string', description: 'The span ID of the render to investigate' },
        component_name: { type: 'string', description: 'Alternative: component name to find' },
        render_index: { type: 'number', description: 'Which render of this component (0-indexed, default: last)' },
      },
      required: ['trace_id'],
    },
  },
  {
    name: 'blast_radius',
    description: 'Find all events transitively caused by changes to a specific piece of state. Shows total renders, affected components, unnecessary re-renders (memoization candidates), effect executions, and fetch calls.',
    inputSchema: {
      type: 'object',
      properties: {
        trace_id: { type: 'string', description: 'The trace ID' },
        state_key: { type: 'string', description: 'State key or hook index to trace (e.g. "userId" or "0")' },
        component_name: { type: 'string', description: 'Optional: filter to a specific component' },
      },
      required: ['trace_id', 'state_key'],
    },
  },
  {
    name: 'detect_effect_cascades',
    description: 'Scan a trace for render → useEffect → setState → re-render cycles. These are often bugs (state derived from props should use computed values instead). Returns cycles with source locations and fix recommendations.',
    inputSchema: {
      type: 'object',
      properties: {
        trace_id: { type: 'string', description: 'The trace ID to scan' },
      },
      required: ['trace_id'],
    },
  },
  {
    name: 'detect_async_races',
    description: 'Scan a trace for multiple async operations (fetches, promises) that write to the same state, flagging potential race conditions where resolution order determines which data wins.',
    inputSchema: {
      type: 'object',
      properties: {
        trace_id: { type: 'string', description: 'The trace ID to scan' },
      },
      required: ['trace_id'],
    },
  },
];

// ─── Tool Executor ───────────────────────────────────────────────────────────

export class MCPToolExecutor {
  private api: DeepTraceQueryAPI;
  private visibility: Visibility;

  constructor(api: DeepTraceQueryAPI, visibility: Visibility = 'visible_to_agent') {
    this.api = api;
    this.visibility = visibility;
  }

  /**
   * Get all tool definitions for MCP registration.
   */
  getToolDefinitions(): MCPToolDefinition[] {
    return TOOL_DEFINITIONS;
  }

  /**
   * Execute a tool by name with given arguments.
   */
  async executeTool(name: string, args: Record<string, any>): Promise<AgentResponse> {
    switch (name) {
      case 'list_runs':
        return this.api.listRuns({
          limit: args.limit,
          service: args.service,
          search: args.search,
          status: args.status,
          visibility: this.visibility,
        });

      case 'get_trace_summary':
        return this.api.getTraceSummary(args.trace_id, this.visibility);

      case 'get_trace_graph':
        return this.api.getTraceGraph(args.trace_id, {
          nodeTypes: args.node_types,
          services: args.services,
          visibility: this.visibility,
        });

      case 'get_span_details':
        return this.api.getSpanDetails(args.span_id, this.visibility);

      case 'find_exceptions':
        return this.api.findExceptions(args.trace_id, this.visibility);

      case 'find_last_writer':
        return this.api.findLastWriter(args.trace_id, args.value_selector, this.visibility);

      case 'find_first_divergence':
        return this.api.findFirstDivergence(args.good_trace_id, args.bad_trace_id, this.visibility);

      case 'trace_value_flow':
        return this.api.traceValueFlow(args.trace_id, args.value_selector, this.visibility);

      case 'follow_request_path':
        return this.api.followRequestPath(args.trace_id, args.request_selector, this.visibility);

      case 'summarize_suspicious_transitions':
        return this.api.summarizeSuspiciousTransitions(args.trace_id, this.visibility);

      case 'search_executed_code':
        return this.api.searchExecutedCode(args.trace_id, args.query, this.visibility);

      case 'compare_trace_segments':
        return this.api.compareTraceSegments(args.trace_a, args.trace_b, args.selector, this.visibility);

      // React Causal Query Tools (Phase 2)
      case 'why_did_render':
        return this.api.whyDidRender(args.trace_id, {
          spanId: args.span_id,
          componentName: args.component_name,
          renderIndex: args.render_index,
          visibility: this.visibility,
        });

      case 'blast_radius':
        return this.api.blastRadius(args.trace_id, args.state_key, {
          componentName: args.component_name,
          visibility: this.visibility,
        });

      case 'detect_effect_cascades':
        return this.api.detectEffectCascades(args.trace_id, this.visibility);

      case 'detect_async_races':
        return this.api.detectAsyncRaces(args.trace_id, this.visibility);

      default:
        return { success: false, error: `Unknown tool: ${name}` };
    }
  }
}
