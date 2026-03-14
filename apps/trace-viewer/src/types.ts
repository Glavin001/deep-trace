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
