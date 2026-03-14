import type {
  TraceSummary, TraceDetail, SourceFile, ServiceInfo,
  DTRun, DTTraceSummary, DTGraph, DTTraceDiff,
} from '../types';

const BASE = '/api';

async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function getTraces(params?: {
  limit?: number;
  service?: string;
  search?: string;
}): Promise<TraceSummary[]> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.service) qs.set('service', params.service);
  if (params?.search) qs.set('search', params.search);
  const { traces } = await fetchJSON<{ traces: TraceSummary[] }>(
    `${BASE}/traces?${qs}`,
  );
  return traces;
}

export async function getTrace(traceId: string): Promise<TraceDetail> {
  return fetchJSON<TraceDetail>(`${BASE}/traces/${traceId}`);
}

export async function getServices(): Promise<ServiceInfo[]> {
  const { services } = await fetchJSON<{ services: ServiceInfo[] }>(
    `${BASE}/services`,
  );
  return services;
}

export async function getSource(filePath: string): Promise<SourceFile> {
  return fetchJSON<SourceFile>(
    `${BASE}/source?path=${encodeURIComponent(filePath)}`,
  );
}

export async function getHealth(): Promise<{ status: string; clickhouse: string }> {
  return fetchJSON(`${BASE}/health`);
}

// ─── DeepTrace Enriched API ──────────────────────────────────────────────

export async function getDTRuns(params?: {
  limit?: number;
  service?: string;
  search?: string;
  status?: string;
}): Promise<DTRun[]> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.service) qs.set('service', params.service);
  if (params?.search) qs.set('search', params.search);
  if (params?.status) qs.set('status', params.status);
  const result = await fetchJSON<{ success: boolean; data: DTRun[] }>(
    `${BASE}/dt/runs?${qs}`,
  );
  return result.data || [];
}

export async function getDTTraceSummary(traceId: string): Promise<DTTraceSummary> {
  const result = await fetchJSON<{ success: boolean; data: DTTraceSummary }>(
    `${BASE}/dt/traces/${traceId}/summary`,
  );
  if (!result.data) throw new Error('Trace not found');
  return result.data;
}

export async function getDTTraceGraph(traceId: string): Promise<DTGraph> {
  const result = await fetchJSON<{ success: boolean; data: DTGraph }>(
    `${BASE}/dt/traces/${traceId}/graph`,
  );
  if (!result.data) throw new Error('Trace not found');
  return result.data;
}

export async function getDTTraceDiff(goodTraceId: string, badTraceId: string): Promise<DTTraceDiff> {
  const result = await fetchJSON<{ success: boolean; data: DTTraceDiff }>(
    `${BASE}/dt/diff?good=${encodeURIComponent(goodTraceId)}&bad=${encodeURIComponent(badTraceId)}`,
  );
  if (!result.data) throw new Error('Comparison failed');
  return result.data;
}
