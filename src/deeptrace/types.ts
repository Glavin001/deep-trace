/**
 * DeepTrace Runtime Context Debugging Platform — Core Types
 *
 * Defines the execution graph model, capture tiers, redaction policies,
 * and all shared interfaces for the DeepTrace platform.
 */

// ─── Node Types ──────────────────────────────────────────────────────────────

export type NodeType =
  | 'trace_run'
  | 'span'
  | 'logical_operation'
  | 'async_task'
  | 'network_request'
  | 'db_query'
  | 'message_job'
  | 'exception'
  | 'value_snapshot'
  | 'source_location'
  | 'user_action'
  | 'react_render'
  | 'effect_execution'
  | 'dom_event';

// ─── Edge Types ──────────────────────────────────────────────────────────────

export type EdgeType =
  | 'parent_child'
  | 'async_scheduled_by'
  | 'async_resumed_from'
  | 'request_sent_to'
  | 'request_handled_by'
  | 'query_issued'
  | 'response_produced'
  | 'state_read_from'
  | 'state_written_by'
  | 'caused_error'
  | 'source_mapped_to'
  | 'state_changed'
  | 'prop_changed'
  | 'parent_rerendered'
  | 'context_changed'
  | 'dep_changed'
  | 'effect_caused'
  | 'dom_event_triggered'
  | 'set_state'
  | 'async_resolved';

// ─── Capture Tiers ───────────────────────────────────────────────────────────

export type CaptureTier = 1 | 2 | 3;

export interface CaptureConfig {
  tier: CaptureTier;
  label?: string;
  includeModules?: string[];
  excludeModules?: string[];
  includeRoutes?: string[];
  maxValueSize?: number;
  captureRequestBodies?: boolean;
  captureResponseBodies?: boolean;
  captureStateActions?: boolean;
}

export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  tier: 1,
  maxValueSize: 4096,
  captureRequestBodies: false,
  captureResponseBodies: false,
  captureStateActions: false,
};

// ─── Redaction ───────────────────────────────────────────────────────────────

export type Visibility = 'visible_to_human' | 'visible_to_agent' | 'visible_to_export';

export interface RedactionRule {
  /** Pattern to match attribute keys (glob or regex string) */
  pattern: string;
  /** Action: remove the value entirely, hash it, or replace with placeholder */
  action: 'remove' | 'hash' | 'placeholder';
  /** Which visibility levels this rule applies to */
  appliesTo: Visibility[];
}

export interface RedactionPolicy {
  rules: RedactionRule[];
  /** Default visibility for values without explicit tagging */
  defaultVisibility: Visibility[];
}

export const DEFAULT_REDACTION_POLICY: RedactionPolicy = {
  rules: [
    { pattern: '*password*', action: 'remove', appliesTo: ['visible_to_agent', 'visible_to_export'] },
    { pattern: '*secret*', action: 'remove', appliesTo: ['visible_to_agent', 'visible_to_export'] },
    { pattern: '*token*', action: 'hash', appliesTo: ['visible_to_agent', 'visible_to_export'] },
    { pattern: '*cookie*', action: 'remove', appliesTo: ['visible_to_agent', 'visible_to_export'] },
    { pattern: '*authorization*', action: 'hash', appliesTo: ['visible_to_agent', 'visible_to_export'] },
    { pattern: '*api_key*', action: 'remove', appliesTo: ['visible_to_agent', 'visible_to_export'] },
    { pattern: '*apikey*', action: 'remove', appliesTo: ['visible_to_agent', 'visible_to_export'] },
    { pattern: '*credit_card*', action: 'remove', appliesTo: ['visible_to_human', 'visible_to_agent', 'visible_to_export'] },
    { pattern: '*ssn*', action: 'remove', appliesTo: ['visible_to_human', 'visible_to_agent', 'visible_to_export'] },
  ],
  defaultVisibility: ['visible_to_human', 'visible_to_agent'],
};

// ─── Graph Model ─────────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  type: NodeType;
  traceId: string;
  spanId?: string;
  name: string;
  serviceName?: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  attributes: Record<string, any>;
  sourceLocation?: SourceLocation;
  status?: 'ok' | 'error' | 'unset';
  statusMessage?: string;
}

export interface GraphEdge {
  id: string;
  type: EdgeType;
  sourceNodeId: string;
  targetNodeId: string;
  traceId: string;
  attributes?: Record<string, any>;
}

export interface ExecutionGraph {
  traceId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ─── Source Location ─────────────────────────────────────────────────────────

export interface SourceLocation {
  filePath: string;
  line?: number;
  column?: number;
  functionName?: string;
  gitSha?: string;
  buildId?: string;
}

// ─── Value Snapshot ──────────────────────────────────────────────────────────

export interface ValueSnapshot {
  id: string;
  traceId: string;
  spanId: string;
  boundary: 'entry' | 'exit' | 'exception' | 'request' | 'response' | 'query' | 'state_change' | 'state_before' | 'state_after';
  name: string;
  typeClassification: string;
  preview: string;
  fullValueHash?: string;
  fullValue?: string;
  redactionTags: Visibility[];
  timestamp: number;
}

// ─── Run / Trace Summary ─────────────────────────────────────────────────────

export interface TraceRun {
  id: string;
  traceId: string;
  label?: string;
  tags: string[];
  startTime: number;
  endTime: number;
  durationMs: number;
  serviceName: string;
  services: string[];
  rootSpanName: string;
  spanCount: number;
  errorCount: number;
  hasExceptions: boolean;
  status: 'success' | 'error' | 'partial';
  suspiciousnessScore: number;
  environment?: EnvironmentMetadata;
}

export interface EnvironmentMetadata {
  serviceName?: string;
  runtimeVersion?: string;
  browserInfo?: string;
  route?: string;
  featureFlags?: Record<string, boolean>;
  environmentMode?: string;
  sessionLabel?: string;
}

// ─── Trace Summary ───────────────────────────────────────────────────────────

export interface TraceSummary {
  traceId: string;
  rootSpanName: string;
  services: string[];
  durationMs: number;
  spanCount: number;
  errorCount: number;
  exceptionCount: number;
  asyncHops: number;
  networkRequests: number;
  dbQueries: number;
  requestPath: RequestPathStep[];
  exceptions: ExceptionInfo[];
  suspiciousnessScore: number;
  keyValues: ValueSnapshot[];
}

export interface RequestPathStep {
  index: number;
  spanId: string;
  name: string;
  serviceName: string;
  type: NodeType;
  durationMs: number;
  status: 'ok' | 'error' | 'unset';
}

export interface ExceptionInfo {
  spanId: string;
  spanName: string;
  serviceName: string;
  type: string;
  message: string;
  stackTrace?: string;
  sourceLocation?: SourceLocation;
  ancestorSpans: string[];
}

// ─── Trace Diff ──────────────────────────────────────────────────────────────

export interface TraceDiff {
  goodTraceId: string;
  badTraceId: string;
  firstDivergence?: DivergencePoint;
  divergences: DivergencePoint[];
  summary: string;
  missingSpans: SpanDiffEntry[];
  extraSpans: SpanDiffEntry[];
  changedSpans: SpanDiffEntry[];
}

export interface DivergencePoint {
  index: number;
  type: 'missing_span' | 'extra_span' | 'value_diff' | 'status_diff' | 'duration_diff' | 'async_diff';
  description: string;
  goodSpanId?: string;
  badSpanId?: string;
  goodValue?: string;
  badValue?: string;
  spanName?: string;
  serviceName?: string;
  severity: 'critical' | 'warning' | 'info';
}

export interface SpanDiffEntry {
  spanName: string;
  serviceName: string;
  spanId?: string;
  side: 'good' | 'bad' | 'both';
  details?: string;
}

// ─── Query API Types ─────────────────────────────────────────────────────────

export interface EvidenceRef {
  traceId: string;
  spanId: string;
  eventId?: string;
  sourceLocation?: SourceLocation;
  valuePreview?: string;
}

export interface AgentResponse<T = any> {
  success: boolean;
  data?: T;
  evidence?: EvidenceRef[];
  error?: string;
}

// ─── MCP Tool Definitions ────────────────────────────────────────────────────

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

// ─── Span from ClickHouse ────────────────────────────────────────────────────

export interface CHSpan {
  TraceId: string;
  SpanId: string;
  ParentSpanId: string;
  SpanName: string;
  ServiceName: string;
  SpanKind: string;
  Duration: number;
  StatusCode: string;
  StatusMessage: string;
  Timestamp: string;
  SpanAttributes: Record<string, any> | string;
  EventNames?: string[];
  EventTimestamps?: string[];
  EventAttributes?: string[];
}

// ─── React Causal Types ───────────────────────────────────────────────────

/** Render cause for a React component re-render. */
export type RenderCauseType =
  | 'initial_mount'
  | 'state_changed'
  | 'prop_changed'
  | 'parent_rerendered'
  | 'context_changed';

/** State transition record for a single hook state change. */
export interface StateTransition {
  componentName: string;
  hookIndex: number;
  before: string;
  after: string;
  causingEvent: string;
  timestamp: number;
}

/** Blast radius summary for a state key. */
export interface BlastRadiusSummary {
  stateKey: string;
  totalRenders: number;
  affectedComponents: string[];
  unnecessaryRenders: number;
  effectExecutions: number;
  fetchCalls: number;
  stateChanges: number;
}

/** An effect cascade cycle detected in a trace. */
export interface EffectCascadeCycle {
  cycle: string[];
  sourceLocations: SourceLocation[];
  recommendation: string;
  severity: 'warning' | 'critical';
}

/** An async race condition detected in a trace. */
export interface AsyncRaceCondition {
  stateKey: string;
  writers: Array<{
    spanId: string;
    fetchUrl?: string;
    resolvedAt: number;
    initiatedAt: number;
  }>;
  issue: string;
  recommendation: string;
}
