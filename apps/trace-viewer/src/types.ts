export interface TraceSummary {
  traceId: string;
  rootSpanName: string;
  serviceName: string;
  durationMs: number;
  statusCode: string;
  timestamp: string;
  spanCount: number;
  attributes: Record<string, string>;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  serviceName: string;
  kind: string;
  durationMs: number;
  statusCode: string;
  statusMessage: string;
  timestamp: string;
  attributes: Record<string, string>;
  events: Array<{ name: string; timestamp: string }>;
}

export interface TraceDetail {
  traceId: string;
  rootSpanName: string;
  serviceName: string;
  durationMs: number;
  spanCount: number;
  traceStart: string;
  spans: Span[];
}

export interface SourceFile {
  path: string;
  resolvedPath: string;
  content: string;
  language: string;
  lineCount: number;
}

export interface ServiceInfo {
  ServiceName: string;
  total_spans: number;
  error_spans: number;
  p99_ms: number;
  last_seen: string;
}

// ─── DeepTrace Enriched Types ────────────────────────────────────────────

export interface DTRun {
  id: string;
  traceId: string;
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
  timestamp: string;
}

export interface DTTraceSummary {
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
  requestPath: DTRequestStep[];
  exceptions: DTException[];
  suspiciousnessScore: number;
}

export interface DTRequestStep {
  index: number;
  spanId: string;
  name: string;
  serviceName: string;
  type: string;
  durationMs: number;
  status: string;
}

export interface DTException {
  spanId: string;
  spanName: string;
  serviceName: string;
  type: string;
  message: string;
  stackTrace?: string;
  sourceLocation?: { filePath: string; line?: number; functionName?: string };
}

export interface DTGraphNode {
  id: string;
  type: string;
  traceId: string;
  spanId?: string;
  name: string;
  serviceName?: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status?: string;
  statusMessage?: string;
  sourceLocation?: { filePath: string; line?: number; functionName?: string };
}

export interface DTGraphEdge {
  id: string;
  type: string;
  sourceNodeId: string;
  targetNodeId: string;
  traceId: string;
}

export interface DTGraph {
  traceId: string;
  nodes: DTGraphNode[];
  edges: DTGraphEdge[];
}

export interface DTDivergence {
  index: number;
  type: string;
  description: string;
  goodSpanId?: string;
  badSpanId?: string;
  goodValue?: string;
  badValue?: string;
  spanName?: string;
  serviceName?: string;
  severity: 'critical' | 'warning' | 'info';
}

export interface DTTraceDiff {
  goodTraceId: string;
  badTraceId: string;
  firstDivergence?: DTDivergence;
  divergences: DTDivergence[];
  summary: string;
  missingSpans: Array<{ spanName: string; serviceName: string; side: string }>;
  extraSpans: Array<{ spanName: string; serviceName: string; side: string }>;
}
