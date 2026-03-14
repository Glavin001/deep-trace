import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getTrace, getDTTraceSummary, getDTTraceGraph } from '../api/client';
import type { TraceDetail, Span, DTTraceSummary, DTGraph, DTGraphNode, DTGraphEdge } from '../types';
import { SpanWaterfall } from './SpanWaterfall';
import { SpanDetailPanel } from './SpanDetailPanel';

function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}us`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function SeverityBadge({ severity }: { severity: string }) {
  const colors: Record<string, string> = {
    critical: 'bg-red-900/30 text-red-400 border-red-700/50',
    warning: 'bg-amber-900/30 text-amber-400 border-amber-700/50',
    info: 'bg-blue-900/30 text-blue-400 border-blue-700/50',
  };
  return (
    <span className={`px-2 py-0.5 text-xs rounded border ${colors[severity] || colors.info}`}>
      {severity}
    </span>
  );
}

function NodeTypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    network_request: 'bg-blue-900/30 text-blue-400',
    db_query: 'bg-purple-900/30 text-purple-400',
    exception: 'bg-red-900/30 text-red-400',
    async_task: 'bg-cyan-900/30 text-cyan-400',
    user_action: 'bg-green-900/30 text-green-400',
    logical_operation: 'bg-pink-900/30 text-pink-400',
    span: 'bg-gray-800/50 text-gray-400',
  };
  return (
    <span className={`px-2 py-0.5 text-xs rounded ${colors[type] || colors.span}`}>
      {type.replace(/_/g, ' ')}
    </span>
  );
}

function SummaryCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="card p-3">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="text-lg font-bold text-white">{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </div>
  );
}

export function TraceOverviewPage() {
  const { traceId } = useParams<{ traceId: string }>();
  const [trace, setTrace] = useState<TraceDetail | null>(null);
  const [summary, setSummary] = useState<DTTraceSummary | null>(null);
  const [graph, setGraph] = useState<DTGraph | null>(null);
  const [selectedSpan, setSelectedSpan] = useState<Span | null>(null);
  const [view, setView] = useState<'waterfall' | 'graph' | 'path'>('waterfall');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!traceId) return;
    setLoading(true);
    Promise.all([
      getTrace(traceId),
      getDTTraceSummary(traceId).catch(() => null),
      getDTTraceGraph(traceId).catch(() => null),
    ])
      .then(([traceData, summaryData, graphData]) => {
        setTrace(traceData);
        setSummary(summaryData);
        setGraph(graphData);
        const root = traceData.spans.find(s => !s.parentSpanId) || traceData.spans[0];
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
      {/* Header */}
      <div className="bg-surface-1 border-b border-surface-3 px-6 py-3">
        <div className="flex items-center gap-3">
          <Link to="/traces" className="text-gray-500 hover:text-gray-300 text-sm">
            &larr; Traces
          </Link>
          <span className="text-gray-600">/</span>
          <h1 className="text-lg font-semibold text-white">{trace.rootSpanName}</h1>
          <span className="badge badge-service">{trace.serviceName}</span>
          {summary && summary.suspiciousnessScore > 0 && (
            <span className={`px-2 py-0.5 text-xs rounded ${
              summary.suspiciousnessScore > 50 ? 'bg-red-900/30 text-red-400' : 'bg-amber-900/30 text-amber-400'
            }`}>
              Suspicion: {summary.suspiciousnessScore}/100
            </span>
          )}
        </div>
        <div className="flex items-center gap-4 mt-1 text-xs text-gray-500">
          <span className="font-mono">{trace.traceId}</span>
          <span>{trace.spanCount} spans</span>
          <span>{formatDuration(trace.durationMs)}</span>
          <span>{new Date(trace.traceStart).toLocaleString()}</span>
        </div>
      </div>

      {/* Summary cards */}
      {summary && (
        <div className="bg-surface-1 border-b border-surface-3 px-6 py-3">
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
            <SummaryCard label="Duration" value={formatDuration(summary.durationMs)} />
            <SummaryCard label="Spans" value={summary.spanCount} />
            <SummaryCard label="Services" value={summary.services.length} sub={summary.services.join(', ')} />
            <SummaryCard label="Errors" value={summary.errorCount} />
            <SummaryCard label="Exceptions" value={summary.exceptionCount} />
            <SummaryCard label="Network Reqs" value={summary.networkRequests} />
            <SummaryCard label="DB Queries" value={summary.dbQueries} />
            <SummaryCard label="Async Hops" value={summary.asyncHops} />
          </div>
        </div>
      )}

      {/* View tabs */}
      <div className="bg-surface-1 border-b border-surface-3 px-6 py-2 flex gap-1">
        {(['waterfall', 'graph', 'path'] as const).map(v => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              view === v ? 'bg-surface-2 text-white' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {v === 'waterfall' ? 'Waterfall' : v === 'graph' ? 'Causal Graph' : 'Request Path'}
          </button>
        ))}
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-auto p-4">
          {view === 'waterfall' && (
            <SpanWaterfall
              spans={trace.spans}
              traceStart={new Date(trace.traceStart).getTime()}
              traceDuration={trace.durationMs}
              selectedSpanId={selectedSpan?.spanId || null}
              onSelectSpan={setSelectedSpan}
            />
          )}

          {view === 'graph' && graph && (
            <CausalGraphView graph={graph} onSelectNode={(node) => {
              const span = trace.spans.find(s => s.spanId === node.spanId);
              if (span) setSelectedSpan(span);
            }} />
          )}

          {view === 'path' && summary && (
            <RequestPathView summary={summary} onSelectStep={(step) => {
              const span = trace.spans.find(s => s.spanId === step.spanId);
              if (span) setSelectedSpan(span);
            }} />
          )}
        </div>

        {selectedSpan && (
          <div className="w-[480px] border-l border-surface-3 overflow-auto">
            <SpanDetailPanel span={selectedSpan} onClose={() => setSelectedSpan(null)} />
          </div>
        )}
      </div>

      {/* Exceptions panel */}
      {summary && summary.exceptions.length > 0 && (
        <div className="bg-surface-1 border-t border-surface-3 px-6 py-3 max-h-48 overflow-auto">
          <h3 className="text-sm font-semibold text-red-400 mb-2">
            Exceptions ({summary.exceptions.length})
          </h3>
          {summary.exceptions.map((exc, i) => (
            <div key={i} className="card p-3 mb-2">
              <div className="flex items-center gap-2">
                <SeverityBadge severity="critical" />
                <span className="text-sm text-white font-medium">{exc.type}: {exc.message}</span>
              </div>
              <div className="text-xs text-gray-500 mt-1">
                in {exc.spanName} ({exc.serviceName})
                {exc.sourceLocation && (
                  <span className="ml-2 text-accent-blue">
                    {exc.sourceLocation.filePath}:{exc.sourceLocation.line}
                  </span>
                )}
              </div>
              {exc.stackTrace && (
                <pre className="text-xs text-gray-600 mt-2 max-h-20 overflow-auto whitespace-pre-wrap">
                  {exc.stackTrace.slice(0, 500)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Causal Graph View ───────────────────────────────────────────────────────

function CausalGraphView({ graph, onSelectNode }: { graph: DTGraph; onSelectNode: (n: DTGraphNode) => void }) {
  // Group nodes by service for visual layout
  const serviceGroups = new Map<string, DTGraphNode[]>();
  for (const node of graph.nodes) {
    const svc = node.serviceName || 'unknown';
    if (!serviceGroups.has(svc)) serviceGroups.set(svc, []);
    serviceGroups.get(svc)!.push(node);
  }

  const serviceColors: Record<string, string> = {};
  const colorPalette = [
    'border-blue-500 bg-blue-900/20',
    'border-purple-500 bg-purple-900/20',
    'border-green-500 bg-green-900/20',
    'border-amber-500 bg-amber-900/20',
    'border-cyan-500 bg-cyan-900/20',
    'border-pink-500 bg-pink-900/20',
  ];
  let colorIdx = 0;
  for (const svc of serviceGroups.keys()) {
    serviceColors[svc] = colorPalette[colorIdx % colorPalette.length];
    colorIdx++;
  }

  // Build edge lookup
  const edgesByTarget = new Map<string, DTGraphEdge[]>();
  for (const edge of graph.edges) {
    if (!edgesByTarget.has(edge.targetNodeId)) edgesByTarget.set(edge.targetNodeId, []);
    edgesByTarget.get(edge.targetNodeId)!.push(edge);
  }

  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-400 mb-3">
        Causal Execution Graph — {graph.nodes.length} nodes, {graph.edges.length} edges
      </h3>

      {/* Service groups */}
      {Array.from(serviceGroups.entries()).map(([svc, nodes]) => (
        <div key={svc} className="mb-4">
          <h4 className="text-xs font-medium text-gray-500 mb-2 uppercase tracking-wider">{svc}</h4>
          <div className="space-y-1">
            {nodes.map(node => {
              const inEdges = edgesByTarget.get(node.id) || [];
              return (
                <button
                  key={node.id}
                  onClick={() => onSelectNode(node)}
                  className={`w-full text-left px-3 py-2 rounded border ${serviceColors[svc]} hover:opacity-80 transition-opacity`}
                >
                  <div className="flex items-center gap-2">
                    <NodeTypeBadge type={node.type} />
                    <span className="text-sm text-white font-medium truncate">{node.name}</span>
                    {node.status === 'error' && (
                      <span className="text-xs text-red-400">ERROR</span>
                    )}
                    <span className="text-xs text-gray-500 ml-auto">
                      {node.durationMs ? formatDuration(node.durationMs) : ''}
                    </span>
                  </div>
                  {inEdges.length > 0 && (
                    <div className="text-xs text-gray-600 mt-1">
                      {inEdges.map(e => e.type.replace(/_/g, ' ')).join(', ')}
                    </div>
                  )}
                  {node.sourceLocation && (
                    <div className="text-xs text-gray-600 mt-0.5">
                      {node.sourceLocation.filePath}:{node.sourceLocation.line}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Request Path View ───────────────────────────────────────────────────────

function RequestPathView({ summary, onSelectStep }: { summary: DTTraceSummary; onSelectStep: (step: any) => void }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-400 mb-3">
        Request Path — {summary.requestPath.length} steps
      </h3>
      <div className="space-y-1">
        {summary.requestPath.map((step, i) => (
          <button
            key={i}
            onClick={() => onSelectStep(step)}
            className="w-full text-left flex items-center gap-3 px-3 py-2 rounded card hover:bg-surface-2 transition-colors"
          >
            <div className="flex items-center justify-center w-6 h-6 rounded-full bg-surface-3 text-xs text-gray-400">
              {step.index + 1}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <NodeTypeBadge type={step.type} />
                <span className="text-sm text-white truncate">{step.name}</span>
              </div>
              <div className="text-xs text-gray-500">{step.serviceName}</div>
            </div>
            <div className="text-xs text-gray-400">
              {formatDuration(step.durationMs)}
            </div>
            {step.status === 'error' && (
              <span className="text-xs text-red-400">ERROR</span>
            )}
            {i < summary.requestPath.length - 1 && (
              <div className="absolute left-[1.75rem] top-full w-px h-1 bg-surface-3" />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
