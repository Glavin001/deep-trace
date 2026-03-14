import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getTrace } from '../api/client';
import type { TraceDetail, Span } from '../types';
import { SpanWaterfall } from './SpanWaterfall';
import { SpanDetailPanel } from './SpanDetailPanel';

export function TraceDetailPage() {
  const { traceId } = useParams<{ traceId: string }>();
  const [trace, setTrace] = useState<TraceDetail | null>(null);
  const [selectedSpan, setSelectedSpan] = useState<Span | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!traceId) return;
    setLoading(true);
    getTrace(traceId)
      .then(data => {
        setTrace(data);
        // Auto-select root span
        const root = data.spans.find(s => !s.parentSpanId) || data.spans[0];
        if (root) setSelectedSpan(root);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [traceId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-pulse text-gray-500">Loading trace...</div>
      </div>
    );
  }

  if (error || !trace) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="card p-6">
          <p className="text-accent-red">{error || 'Trace not found'}</p>
          <Link to="/traces" className="text-accent-blue text-sm mt-2 inline-block hover:underline">
            &larr; Back to traces
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-57px)]">
      {/* Trace header */}
      <div className="bg-surface-1 border-b border-surface-3 px-6 py-3">
        <div className="flex items-center gap-3">
          <Link to="/traces" className="text-gray-500 hover:text-gray-300 text-sm">
            &larr; Traces
          </Link>
          <span className="text-gray-600">/</span>
          <h1 className="text-lg font-semibold text-white">{trace.rootSpanName}</h1>
          <span className="badge badge-service">{trace.serviceName}</span>
        </div>
        <div className="flex items-center gap-4 mt-1 text-xs text-gray-500">
          <span className="font-mono">{trace.traceId}</span>
          <span>{trace.spanCount} spans</span>
          <span>{formatDuration(trace.durationMs)}</span>
          <span>{new Date(trace.traceStart).toLocaleString()}</span>
        </div>
      </div>

      {/* Main content: waterfall + detail panel */}
      <div className="flex flex-1 overflow-hidden">
        {/* Waterfall view */}
        <div className="flex-1 overflow-auto p-4">
          <SpanWaterfall
            spans={trace.spans}
            traceStart={new Date(trace.traceStart).getTime()}
            traceDuration={trace.durationMs}
            selectedSpanId={selectedSpan?.spanId || null}
            onSelectSpan={setSelectedSpan}
          />
        </div>

        {/* Detail panel */}
        {selectedSpan && (
          <div className="w-[480px] border-l border-surface-3 overflow-auto">
            <SpanDetailPanel
              span={selectedSpan}
              onClose={() => setSelectedSpan(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
