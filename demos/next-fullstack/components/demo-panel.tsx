'use client';

import { useMemo, useState } from 'react';

/**
 * Demo panel component — ZERO tracing imports.
 *
 * Tracing is handled automatically:
 * - This component is auto-wrapped by the Babel plugin (PascalCase → isComponent: true)
 * - The runDemo function is auto-wrapped by the Babel plugin (arrow function)
 * - fetch() calls auto-inject traceparent headers (via browser-init.ts fetch patch)
 * - No manual span creation, no manual header injection needed
 */

interface DemoResponse {
  term: string;
  traceId: string;
  backendService: string;
  narrative: string;
  confidence: number;
  tags: string[];
  receivedAt: string;
}

const defaultTerm = 'clickhouse trace search';

export function DemoPanel() {
  const [term, setTerm] = useState(defaultTerm);
  const [result, setResult] = useState<DemoResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const queryHint = useMemo(() => {
    if (!result?.traceId) return 'Run the demo to get a trace id.';
    return `TRACE_ID=${result.traceId} npm run query:trace`;
  }, [result?.traceId]);

  const runDemo = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/demo?term=${encodeURIComponent(term)}`, {
        cache: 'no-store',
        headers: { 'x-demo-source': 'browser-button' },
      });

      if (!response.ok) {
        throw new Error(`Demo request failed with ${response.status}`);
      }

      const body = (await response.json()) as DemoResponse;
      setResult(body);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="panel-card">
      <div className="controls">
        <input
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Describe the request you want to trace"
        />
        <button type="button" onClick={runDemo} disabled={loading}>
          {loading ? 'Sending spans...' : 'Emit frontend + backend trace'}
        </button>
      </div>

      <p className="muted">
        The browser creates a span first, injects `traceparent`, then calls the traced API route.
      </p>

      <div className="result-grid">
        <article className="result-card">
          <h3>Status</h3>
          <div className="status-pill">{result ? 'Trace stored' : 'Waiting for run'}</div>
        </article>

        <article className="result-card">
          <h3>Trace id</h3>
          <code>{result?.traceId || 'No trace yet'}</code>
        </article>

        <article className="result-card">
          <h3>Backend service</h3>
          <code>{result?.backendService || 'next-fullstack-api'}</code>
        </article>

        <article className="result-card">
          <h3>Query hint</h3>
          <code>{queryHint}</code>
        </article>
      </div>

      {result ? (
        <div className="result-grid" style={{ marginTop: 16 }}>
          <article className="result-card">
            <h3>Response narrative</h3>
            <p>{result.narrative}</p>
          </article>

          <article className="result-card">
            <h3>Confidence</h3>
            <p>{Math.round(result.confidence * 100)}%</p>
          </article>

          <article className="result-card">
            <h3>Tags</h3>
            <p>{result.tags.join(', ')}</p>
          </article>

          <article className="result-card">
            <h3>Received at</h3>
            <p>{new Date(result.receivedAt).toLocaleTimeString()}</p>
          </article>
        </div>
      ) : null}

      {error ? <div className="error-card">{error}</div> : null}
    </section>
  );
}
