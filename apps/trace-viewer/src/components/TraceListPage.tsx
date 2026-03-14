import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { getTraces, getServices } from '../api/client';
import type { TraceSummary, ServiceInfo } from '../types';
import { parseTimestamp } from '../utils';

function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function timeAgo(ts: string): string {
  const diff = Date.now() - parseTimestamp(ts);
  if (diff < 0) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function StatusBadge({ code }: { code: string }) {
  const isError = code === 'STATUS_CODE_ERROR';
  return (
    <span className={`badge ${isError ? 'badge-error' : 'badge-ok'}`}>
      {isError ? 'ERROR' : 'OK'}
    </span>
  );
}

function DurationBar({ ms, maxMs }: { ms: number; maxMs: number }) {
  const width = maxMs > 0 ? Math.max((ms / maxMs) * 100, 2) : 2;
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div className="flex-1 h-1.5 bg-surface-3 rounded-full overflow-hidden">
        <div
          className="h-full bg-accent-blue rounded-full transition-all"
          style={{ width: `${width}%` }}
        />
      </div>
      <span className="text-xs text-gray-400 tabular-nums w-16 text-right">
        {formatDuration(ms)}
      </span>
    </div>
  );
}

export function TraceListPage() {
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [serviceFilter, setServiceFilter] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const [traceData, serviceData] = await Promise.all([
        getTraces({
          limit: 50,
          service: serviceFilter || undefined,
          search: search || undefined,
        }),
        getServices(),
      ]);
      setTraces(traceData);
      setServices(serviceData);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [search, serviceFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(fetchData, 5000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchData]);

  const maxDuration = Math.max(...traces.map(t => t.durationMs), 1);

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      {/* Header section */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Traces</h1>
          <p className="text-sm text-gray-500 mt-1">
            {traces.length} traces · {services.length} services
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setAutoRefresh(prev => !prev)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
              autoRefresh
                ? 'border-accent-green text-accent-green bg-emerald-900/20'
                : 'border-surface-3 text-gray-400 hover:text-gray-200'
            }`}
          >
            {autoRefresh ? 'Live' : 'Auto-refresh'}
          </button>
          <button
            onClick={fetchData}
            className="px-3 py-1.5 text-xs font-medium rounded-md border border-surface-3 text-gray-400 hover:text-gray-200 transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-4">
        <input
          type="text"
          placeholder="Search by trace ID or span name..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="input-base flex-1 max-w-md"
        />
        <select
          value={serviceFilter}
          onChange={e => setServiceFilter(e.target.value)}
          className="input-base w-56"
        >
          <option value="">All services</option>
          {services.map(s => (
            <option key={s.ServiceName} value={s.ServiceName}>
              {s.ServiceName} ({s.total_spans} spans)
            </option>
          ))}
        </select>
      </div>

      {/* Service summary cards */}
      {services.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          {services.map(s => (
            <div key={s.ServiceName} className="card p-3">
              <div className="text-xs text-gray-500 mb-1">Service</div>
              <div className="text-sm font-medium text-white truncate">{s.ServiceName}</div>
              <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
                <span>{s.total_spans} spans</span>
                {Number(s.error_spans) > 0 && (
                  <span className="text-accent-red">{s.error_spans} errors</span>
                )}
                <span>p99: {formatDuration(Number(s.p99_ms))}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="card p-4 mb-4 border-accent-red/30">
          <p className="text-accent-red text-sm">{error}</p>
          <p className="text-xs text-gray-500 mt-1">
            Make sure the stack is running: npm run stack:up
          </p>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-20">
          <div className="animate-pulse text-gray-500">Loading traces...</div>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && traces.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20">
          <div className="text-4xl mb-4 opacity-30">&#x1f50d;</div>
          <p className="text-gray-400 text-lg">No traces found</p>
          <p className="text-gray-600 text-sm mt-1">
            Run the demo app to generate traces
          </p>
        </div>
      )}

      {/* Trace table */}
      {traces.length > 0 && (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-3 text-left text-xs text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3">Root Span</th>
                <th className="px-4 py-3">Service</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Spans</th>
                <th className="px-4 py-3">Duration</th>
                <th className="px-4 py-3 text-right">Time</th>
              </tr>
            </thead>
            <tbody>
              {traces.map(trace => (
                <tr
                  key={trace.traceId}
                  className="border-b border-surface-3/50 hover:bg-surface-2/50 transition-colors group"
                >
                  <td className="px-4 py-3">
                    <Link
                      to={`/traces/${trace.traceId}`}
                      className="text-accent-blue hover:text-blue-300 font-medium group-hover:underline"
                    >
                      {trace.rootSpanName}
                    </Link>
                    <div className="text-[11px] text-gray-600 font-mono mt-0.5">
                      {trace.traceId.slice(0, 16)}...
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="badge badge-service">{trace.serviceName}</span>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge code={trace.statusCode} />
                  </td>
                  <td className="px-4 py-3 text-gray-400 tabular-nums">
                    {trace.spanCount}
                  </td>
                  <td className="px-4 py-3">
                    <DurationBar ms={trace.durationMs} maxMs={maxDuration} />
                  </td>
                  <td className="px-4 py-3 text-right text-gray-500 text-xs">
                    {timeAgo(trace.timestamp)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
