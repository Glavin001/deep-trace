import type { TraceSummary, TraceDetail, SourceFile, ServiceInfo } from '../types';

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
