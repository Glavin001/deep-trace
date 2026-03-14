import { useState } from 'react';
import { Link } from 'react-router-dom';
import { getDTRuns, getDTTraceDiff } from '../api/client';
import type { DTRun, DTTraceDiff, DTDivergence } from '../types';

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

function DivergenceTypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    missing_span: 'bg-red-900/30 text-red-400',
    extra_span: 'bg-amber-900/30 text-amber-400',
    status_diff: 'bg-red-900/30 text-red-400',
    value_diff: 'bg-purple-900/30 text-purple-400',
    duration_diff: 'bg-blue-900/30 text-blue-400',
    async_diff: 'bg-cyan-900/30 text-cyan-400',
  };
  return (
    <span className={`px-2 py-0.5 text-xs rounded ${colors[type] || 'bg-gray-800 text-gray-400'}`}>
      {type.replace(/_/g, ' ')}
    </span>
  );
}

export function DivergencePage() {
  const [goodTraceId, setGoodTraceId] = useState('');
  const [badTraceId, setBadTraceId] = useState('');
  const [runs, setRuns] = useState<DTRun[] | null>(null);
  const [diff, setDiff] = useState<DTTraceDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = async () => {
    setLoadingRuns(true);
    try {
      const data = await getDTRuns({ limit: 50 });
      setRuns(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingRuns(false);
    }
  };

  const compare = async () => {
    if (!goodTraceId || !badTraceId) {
      setError('Both trace IDs are required');
      return;
    }
    setLoading(true);
    setError(null);
    setDiff(null);
    try {
      const result = await getDTTraceDiff(goodTraceId, badTraceId);
      setDiff(result);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Trace Comparison</h1>
        <p className="text-sm text-gray-500 mt-1">
          Compare a good trace to a bad trace and find the first meaningful divergence
        </p>
      </div>

      {/* Trace selection */}
      <div className="card p-4 mb-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Good Trace ID (known working)</label>
            <input
              type="text"
              value={goodTraceId}
              onChange={e => setGoodTraceId(e.target.value)}
              placeholder="Enter good trace ID..."
              className="input-base w-full"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Bad Trace ID (failing)</label>
            <input
              type="text"
              value={badTraceId}
              onChange={e => setBadTraceId(e.target.value)}
              placeholder="Enter bad trace ID..."
              className="input-base w-full"
            />
          </div>
        </div>
        <div className="flex gap-3">
          <button
            onClick={compare}
            disabled={loading || !goodTraceId || !badTraceId}
            className="px-4 py-2 bg-accent-blue text-white text-sm font-medium rounded-md hover:bg-blue-600 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Comparing...' : 'Find Divergences'}
          </button>
          <button
            onClick={loadRuns}
            disabled={loadingRuns}
            className="px-4 py-2 text-sm font-medium rounded-md border border-surface-3 text-gray-400 hover:text-gray-200 transition-colors"
          >
            {loadingRuns ? 'Loading...' : 'Browse Recent Runs'}
          </button>
        </div>
      </div>

      {/* Recent runs picker */}
      {runs && (
        <div className="card p-4 mb-6">
          <h3 className="text-sm font-semibold text-gray-400 mb-3">Select Traces to Compare</h3>
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500">
                  <th className="px-2 py-1">Root Span</th>
                  <th className="px-2 py-1">Service</th>
                  <th className="px-2 py-1">Status</th>
                  <th className="px-2 py-1">Duration</th>
                  <th className="px-2 py-1">Actions</th>
                </tr>
              </thead>
              <tbody>
                {runs.map(run => (
                  <tr key={run.traceId} className="border-t border-surface-3/50 hover:bg-surface-2/50">
                    <td className="px-2 py-1.5">
                      <div className="text-white text-xs">{run.rootSpanName}</div>
                      <div className="text-[10px] text-gray-600 font-mono">{run.traceId.slice(0, 16)}...</div>
                    </td>
                    <td className="px-2 py-1.5 text-xs text-gray-400">{run.serviceName}</td>
                    <td className="px-2 py-1.5">
                      <span className={`text-xs ${run.status === 'error' ? 'text-red-400' : 'text-green-400'}`}>
                        {run.status === 'error' ? 'ERROR' : 'OK'}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-xs text-gray-400">{formatDuration(run.durationMs)}</td>
                    <td className="px-2 py-1.5">
                      <div className="flex gap-1">
                        <button
                          onClick={() => setGoodTraceId(run.traceId)}
                          className="px-2 py-0.5 text-xs rounded bg-green-900/30 text-green-400 hover:bg-green-900/50"
                        >
                          Good
                        </button>
                        <button
                          onClick={() => setBadTraceId(run.traceId)}
                          className="px-2 py-0.5 text-xs rounded bg-red-900/30 text-red-400 hover:bg-red-900/50"
                        >
                          Bad
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="card p-4 mb-4 border-accent-red/30">
          <p className="text-accent-red text-sm">{error}</p>
        </div>
      )}

      {/* Results */}
      {diff && (
        <div>
          {/* Summary */}
          <div className="card p-4 mb-4">
            <h3 className="text-sm font-semibold text-white mb-2">Comparison Summary</h3>
            <p className="text-sm text-gray-400">{diff.summary}</p>
            <div className="flex gap-4 mt-3 text-xs text-gray-500">
              <span>Good: <Link to={`/traces/${diff.goodTraceId}`} className="text-accent-blue hover:underline">{diff.goodTraceId.slice(0, 16)}...</Link></span>
              <span>Bad: <Link to={`/traces/${diff.badTraceId}`} className="text-accent-blue hover:underline">{diff.badTraceId.slice(0, 16)}...</Link></span>
            </div>
          </div>

          {/* First divergence (highlighted) */}
          {diff.firstDivergence && (
            <div className="card p-4 mb-4 border-red-700/30 bg-red-900/10">
              <h3 className="text-sm font-semibold text-red-400 mb-2">First Divergence</h3>
              <div className="flex items-center gap-2 mb-2">
                <SeverityBadge severity={diff.firstDivergence.severity} />
                <DivergenceTypeBadge type={diff.firstDivergence.type} />
                {diff.firstDivergence.spanName && (
                  <span className="text-xs text-gray-400">in {diff.firstDivergence.spanName}</span>
                )}
              </div>
              <p className="text-sm text-white">{diff.firstDivergence.description}</p>
              {diff.firstDivergence.goodValue && (
                <div className="mt-2 grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs text-green-400 mb-1">Good trace</div>
                    <pre className="text-xs text-gray-400 bg-surface-2 p-2 rounded overflow-auto max-h-24">
                      {diff.firstDivergence.goodValue}
                    </pre>
                  </div>
                  <div>
                    <div className="text-xs text-red-400 mb-1">Bad trace</div>
                    <pre className="text-xs text-gray-400 bg-surface-2 p-2 rounded overflow-auto max-h-24">
                      {diff.firstDivergence.badValue}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* All divergences */}
          {diff.divergences.length > 0 && (
            <div className="card p-4 mb-4">
              <h3 className="text-sm font-semibold text-gray-400 mb-3">
                All Divergences ({diff.divergences.length})
              </h3>
              <div className="space-y-2">
                {diff.divergences.map((d, i) => (
                  <div key={i} className="flex items-start gap-2 px-3 py-2 rounded bg-surface-2">
                    <SeverityBadge severity={d.severity} />
                    <DivergenceTypeBadge type={d.type} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white">{d.description}</p>
                      {d.spanName && (
                        <p className="text-xs text-gray-500">Span: {d.spanName}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Missing/Extra spans */}
          {(diff.missingSpans.length > 0 || diff.extraSpans.length > 0) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {diff.missingSpans.length > 0 && (
                <div className="card p-4">
                  <h3 className="text-sm font-semibold text-amber-400 mb-2">
                    Missing in Bad Trace ({diff.missingSpans.length})
                  </h3>
                  {diff.missingSpans.map((s, i) => (
                    <div key={i} className="text-xs text-gray-400 py-1 border-b border-surface-3/50">
                      {s.spanName} <span className="text-gray-600">({s.serviceName})</span>
                    </div>
                  ))}
                </div>
              )}
              {diff.extraSpans.length > 0 && (
                <div className="card p-4">
                  <h3 className="text-sm font-semibold text-amber-400 mb-2">
                    Extra in Bad Trace ({diff.extraSpans.length})
                  </h3>
                  {diff.extraSpans.map((s, i) => (
                    <div key={i} className="text-xs text-gray-400 py-1 border-b border-surface-3/50">
                      {s.spanName} <span className="text-gray-600">({s.serviceName})</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
